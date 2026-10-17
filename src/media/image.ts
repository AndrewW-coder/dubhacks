// Photos of letters, prescription labels, and forms: extract text, translate, and explain.
// Owned by User 2. Called by relay/router.ts for every relayed photo (once per recipient, in parallel).
//
// FROZEN SIGNATURE: explainImage(imagePath, targetLanguage) → short explanation, or "" for
// ordinary photos with no text (selfies, food) so nothing extra is sent. Never throws.
//
// - Formats: jpeg/png/gif/webp are sent as-is; HEIC/HEIF (iPhone default) is converted to JPEG
//   in memory with heic-convert. The type comes from magic bytes first, then the file extension,
//   because Photon attachments can have odd names.
// - Size: the Claude API accepts images up to 10 MB base64-encoded (5 MB on Bedrock/Vertex), max
//   8000x8000 px (platform.claude.com/docs/en/build-with-claude/vision). Images bigger than
//   IMAGE_MAX_BYTES after conversion are skipped (returns "" and logs). No resizing.
// - Cost: results are cached by (sha1 of file bytes, target language), and concurrent identical
//   calls share one in-flight request, so one photo to 3 recipients is at most one call per language.
//
// Env (all optional):
//   IMAGE_MAX_BYTES   max image size in bytes after HEIC conversion. Default 7500000
//                     (≈10 MB once base64-encoded). Set 3750000 for Bedrock/Vertex (5 MB limit).
//   ANTHROPIC_API_KEY / ANTHROPIC_MODEL / ANTHROPIC_BASE_URL  via translate/claude.ts and the SDK.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import heicConvert from "heic-convert";
import { callTool, hasClaude } from "../translate/claude.js";
import type { LanguageCode } from "../types.js";

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
type Detected = MediaType | "image/heic";

const EXT_TYPES: Record<string, Detected> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".heic": "image/heic", ".heif": "image/heic", ".hif": "image/heic",
};
const MAX_BYTES = Number(process.env.IMAGE_MAX_BYTES?.trim() || "") || 7_500_000;
const MAX_INPUT_BYTES = 40 * 1024 * 1024; // don't even read/convert files larger than this
const MAX_CACHE = 300;

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", zh: "Simplified Chinese", "zh-tw": "Traditional Chinese", "zh-hant": "Traditional Chinese",
  yue: "Cantonese (written in Traditional Chinese)", ko: "Korean", ja: "Japanese", vi: "Vietnamese",
  es: "Spanish", tl: "Tagalog", fil: "Filipino", hi: "Hindi", pa: "Punjabi", bn: "Bengali", ur: "Urdu",
  ar: "Arabic", fa: "Persian", ru: "Russian", uk: "Ukrainian", pt: "Portuguese", fr: "French", de: "German",
  it: "Italian", th: "Thai", id: "Indonesian", ms: "Malay", km: "Khmer", lo: "Lao", my: "Burmese",
  ta: "Tamil", te: "Telugu", gu: "Gujarati", am: "Amharic", so: "Somali", sw: "Swahili", pl: "Polish",
  tr: "Turkish", he: "Hebrew", ne: "Nepali", hmn: "Hmong",
};

function languageName(code: LanguageCode): string {
  const c = code.trim().toLowerCase();
  return LANGUAGE_NAMES[c] ?? LANGUAGE_NAMES[c.split(/[-_]/)[0]] ?? code;
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "heif", "mif1", "msf1", "mif2"]);

/** Sniffs the image type from magic bytes; undefined if unrecognized. Exported for the selftest. */
export function sniffImageType(buf: Uint8Array): Detected | undefined {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) return "image/gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp") {
    const boxSize = Math.min(b.readUInt32BE(0) || 0, b.length, 256);
    const major = b.toString("latin1", 8, 12);
    const compat: string[] = [];
    for (let i = 16; i + 4 <= boxSize; i += 4) compat.push(b.toString("latin1", i, i + 4));
    const brands = [major, ...compat];
    if (brands.includes("avif") || brands.includes("avis")) return undefined; // AVIF: heic-convert can't decode it
    if (brands.some((x) => HEIF_BRANDS.has(x))) return "image/heic";
  }
  return undefined;
}

type HeicConverter = (input: Uint8Array) => Promise<Uint8Array>;
let heicToJpeg: HeicConverter = (input) => heicConvert({ buffer: input, format: "JPEG", quality: 0.85 });

/** Test hook: replace the HEIC converter (the selftest uses this to run without a real HEIC file). */
export function _setHeicConverterForTests(fn: HeicConverter | undefined) {
  heicToJpeg = fn ?? ((input) => heicConvert({ buffer: input, format: "JPEG", quality: 0.85 }));
}

/** Test hook: forget cached explanations and prepared images. */
export function _clearImageCacheForTests() {
  results.clear();
  prepared.clear();
}

interface Prepared { mediaType: MediaType; data: string }

// sha1 → prepared (converted + base64) image, shared across languages; null = skip this image.
const prepared = new Map<string, Promise<Prepared | null>>();
// `${sha1}:${lang}` → explanation ("" included). Holds the in-flight promise to coalesce callers.
const results = new Map<string, Promise<string>>();

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.set(key, value);
  if (map.size > MAX_CACHE) map.delete(map.keys().next().value as string);
}

async function prepare(bytes: Buffer, imagePath: string): Promise<Prepared | null> {
  const type = sniffImageType(bytes) ?? EXT_TYPES[extname(imagePath).toLowerCase()];
  if (!type) {
    console.warn(`[image] skipped ${imagePath}: not a supported image type`);
    return null;
  }
  let out: Uint8Array = bytes;
  let mediaType: MediaType;
  if (type === "image/heic") {
    out = await heicToJpeg(bytes);
    mediaType = "image/jpeg";
  } else {
    mediaType = type;
  }
  if (out.byteLength > MAX_BYTES) {
    console.warn(`[image] skipped ${imagePath}: ${out.byteLength} bytes is over the ${MAX_BYTES}-byte limit`);
    return null;
  }
  return { mediaType, data: Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString("base64") };
}

const SYSTEM_PROMPT = `You help a multilingual family chat. Someone shared a photo, and you explain it for one relative who reads a different language than the photo.

Decide first: does this photo contain text or a document that this relative needs explained? Yes for letters, bills, medicine or prescription labels, forms, official notices, appointment cards, receipts that ask for action, signs with instructions. No for ordinary photos (people, selfies, food, pets, scenery), memes, jokes, and screenshots that need no explanation. If no, set hasText to false and leave explanation empty.

If yes, write 2-4 short, plain sentences in the reader's language that explain what matters, not a word-for-word translation:
- who it is from and what it is;
- the key facts: a medicine dose and how often, a due date or appointment time, an amount owed, a deadline;
- what action is needed, if any, and by when.
If anything is urgent (overdue, final notice, health risk) or looks suspicious (a scam, demands for gift cards, wire transfers or crypto, threats, requests for passwords, bank or Social Security numbers), say so clearly in the first sentence and set urgent or suspicious to true. For a suspicious letter, advise checking with family before paying or replying.
Keep names, numbers, dates, and amounts exactly as written. Use simple words suited to an older relative.`;

async function explain(p: Prepared, targetLanguage: LanguageCode): Promise<string> {
  const lang = languageName(targetLanguage);
  const result = await callTool<{ hasText: boolean; explanation?: string; urgent?: boolean; suspicious?: boolean }>({
    system: SYSTEM_PROMPT,
    content: [
      { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } },
      { type: "text", text: `The reader reads ${lang}. Write the explanation in ${lang}.` },
    ],
    tool: {
      name: "photo_explanation",
      description: "Report whether the photo needs explaining, and if so explain it in the reader's language.",
      input_schema: {
        type: "object",
        properties: {
          hasText: { type: "boolean", description: "true only for letters, labels, forms, bills, notices or signs that need explaining" },
          explanation: { type: "string", description: "2-4 short sentences in the reader's language; empty when hasText is false" },
          urgent: { type: "boolean", description: "something needs action soon or is a health risk" },
          suspicious: { type: "boolean", description: "looks like a scam or fraud" },
        },
        required: ["hasText"],
      },
    },
    maxTokens: 500,
  });
  if (!result || result.hasText !== true) return "";
  const text = (result.explanation ?? "").trim();
  if (!text) return "";
  return result.urgent || result.suspicious ? `⚠️ ${text}` : text;
}

export async function explainImage(imagePath: string, targetLanguage: LanguageCode): Promise<string> {
  try {
    if (!hasClaude()) return "";
    const size = (await stat(imagePath)).size;
    if (size > MAX_INPUT_BYTES) {
      console.warn(`[image] skipped ${imagePath}: ${size} bytes is too large`);
      return "";
    }
    const bytes = await readFile(imagePath);
    const sha = createHash("sha1").update(bytes).digest("hex");
    const key = `${sha}:${targetLanguage.trim().toLowerCase()}`;

    let pending = results.get(key);
    if (!pending) {
      let prep = prepared.get(sha);
      if (!prep) {
        prep = prepare(bytes, imagePath);
        remember(prepared, sha, prep);
        prep.catch(() => prepared.delete(sha)); // conversion failed: allow a retry later
      }
      pending = prep.then((p) => (p ? explain(p, targetLanguage) : ""));
      remember(results, key, pending);
      // Don't cache failures (network errors etc.): the next call may succeed.
      pending.catch(() => results.delete(key));
    }
    return await pending;
  } catch (err) {
    console.error("[image] explanation failed:", err instanceof Error ? err.message : err);
    return "";
  }
}
