// Voice notes: transcribe incoming audio and optionally reply with synthesized speech.
// Owned by User 2. Called by relay/router.ts.
//
// FROZEN SIGNATURES:
//   transcribe(audioPath, language) → transcript text in the speaker's language. NEVER throws:
//       no key        → "(voice note — transcription not set up: <file>)"
//       any error     → "(voice note — couldn't transcribe it)"
//       empty result  → "(voice note — no speech heard)"
//       too big       → "(voice note — too long to transcribe)"  (OpenAI 25 MB file; Gemini 14 MB of audio)
//   synthesize(text, language) → path to an audio file in .bridge-tmp/ (.m4a when ffmpeg exists,
//       else .mp3). MAY throw. The router doesn't call it yet; User 1 would send the result with
//       sendFile(handle, path, { asVoiceNote: true }).
//
// Which provider transcribes (decided per call):
//   1. SPEECH_PROVIDER, if set ("openai" needs SPEECH_API_KEY; "gemini" needs the Gemini AI key);
//   2. else SPEECH_API_KEY set                       → openai;
//   3. else the AI provider is Gemini (LLM_API_KEY / GEMINI_API_KEY, see translate/claude.ts) → gemini;
//   4. else the "not set up" placeholder, and no request is made.
// So with only the team's Gemini key, voice notes are transcribed by Gemini with no extra settings.
//
// openai: OpenAI audio API over plain fetch (no SDK dependency). Docs checked 2026-10:
//   https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
//   https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
//   https://developers.openai.com/api/docs/guides/speech-to-text   (25 MB limit, accepted formats)
// gemini: the audio goes as an `input_audio` part (16 kHz mono WAV, base64) through callAudio() in
//   translate/claude.ts, so it reuses LLM_BASE_URL / LLM_MODEL, the model fallback and the quota/429
//   handling there. The answer is a `submit_transcript { transcript }` tool call (plain text accepted).
//   Docs checked 2026-10:
//   https://ai.google.dev/gemini-api/docs/openai   (input_audio {data, format: "wav"} on chat completions)
//   https://ai.google.dev/gemini-api/docs/audio    (20 MB total inline request → we cap audio at 14 MB,
//                                                   which is ~7 minutes of 16 kHz WAV; 32 tokens/s)
// The PROVIDERS table below is where deepgram / elevenlabs would be added later.
//
// Settings (read from process.env at call time, so .env and tests both work):
//   SPEECH_PROVIDER   optional: "openai" | "gemini". Usually leave empty (see the order above).
//   SPEECH_API_KEY    OpenAI key for transcription and synthesize().
//   SPEECH_BASE_URL   default https://api.openai.com (point at a local fake server for tests).
//   SPEECH_MODEL      OpenAI transcription model, default "gpt-transcribe"; on a 400/404 we retry once with "whisper-1".
//                     (Gemini uses LLM_MODEL / its default model list instead.)
//   SPEECH_TTS_MODEL  text-to-speech model, default "gpt-4o-mini-tts".
//   SPEECH_VOICE      TTS voice, default "coral".
//   FFMPEG_PATH       ffmpeg binary, default "ffmpeg" on PATH.
//
// synthesize() always uses OpenAI TTS and needs SPEECH_API_KEY (Gemini isn't used for speech output).
//
// Format conversion: iPhone voice notes are .caf (Opus or AAC), which neither provider accepts. We
// convert them in .bridge-tmp/ with ffmpeg: mono 16 kHz AAC .m4a for OpenAI, mono 16 kHz 16-bit
// WAV for Gemini. Without ffmpeg, OpenAI gets the original anyway (it will probably be rejected →
// placeholder); Gemini gets .wav/.mp3 as-is, anything else → placeholder with no request.
// Windows: `winget install ffmpeg` (then open a new terminal so it's on PATH).
// macOS: `brew install ffmpeg`. Linux: `apt-get install ffmpeg`.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import "../config.js"; // loads .env into process.env
import { callAudio, provider as aiProvider } from "../translate/claude.js";
import type { LanguageCode } from "../types.js";

const TMP_DIR = resolve(".bridge-tmp");
const TIMEOUT_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 60_000;

export const PLACEHOLDER_ERROR = "(voice note — couldn't transcribe it)";
export const PLACEHOLDER_EMPTY = "(voice note — no speech heard)";
export const PLACEHOLDER_TOO_BIG = "(voice note — too long to transcribe)";
const placeholderNoKey = (path: string) => `(voice note — transcription not set up: ${basename(path)})`;

// ── Settings ───────────────────────────────────────────────────────────────

const env = (key: string) => process.env[key]?.trim() || "";

/** Speech provider for transcribe(), per the order in the header; "" = not set up. */
export function speechProvider(): string {
  const explicit = env("SPEECH_PROVIDER").toLowerCase();
  if (explicit === "openai") return env("SPEECH_API_KEY") ? "openai" : "";
  if (explicit === "gemini") return aiProvider() === "gemini" ? "gemini" : "";
  if (explicit) return explicit; // unknown name → "isn't implemented" warning
  if (env("SPEECH_API_KEY")) return "openai";
  if (aiProvider() === "gemini") return "gemini";
  return "";
}

function settings() {
  const apiKey = env("SPEECH_API_KEY");
  const provider = speechProvider();
  return {
    apiKey,
    provider,
    baseUrl: (env("SPEECH_BASE_URL") || "https://api.openai.com").replace(/\/+$/, ""),
    sttModel: env("SPEECH_MODEL") || "gpt-transcribe",
    ttsModel: env("SPEECH_TTS_MODEL") || "gpt-4o-mini-tts",
    voice: env("SPEECH_VOICE") || "coral",
  };
}
type Settings = ReturnType<typeof settings>;

// ── Provider table ─────────────────────────────────────────────────────────

interface Provider {
  /** Lowercase extensions (with dot) the provider accepts as-is. */
  accepts: string[];
  /** What other formats are converted to with ffmpeg. */
  convertTo: { ext: ".m4a" | ".wav"; codec: string[] };
  /** Without ffmpeg: send this unaccepted extension anyway (true) or give up before any request (false). */
  sendUnconverted(ext: string): boolean;
  maxBytes: number;
  transcribe(file: Buffer, fileName: string, mime: string, lang: string | undefined, s: Settings, language: LanguageCode): Promise<string>;
  /** Returns audio bytes and their extension (e.g. ".mp3"). Absent = provider can't speak. */
  synthesize?(text: string, lang: string | undefined, s: Settings): Promise<{ bytes: Buffer; ext: string }>;
}

class HttpError extends Error {
  constructor(public status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""));
    return res;
  } finally {
    clearTimeout(timer);
  }
}

const openai: Provider = {
  // From the transcription API reference's accepted list.
  accepts: [".flac", ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".ogg", ".wav", ".webm"],
  convertTo: { ext: ".m4a", codec: ["-c:a", "aac", "-b:a", "64k"] },
  sendUnconverted: () => true,
  maxBytes: 25 * 1024 * 1024,

  async transcribe(file, fileName, mime, lang, s) {
    const send = async (model: string) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(file)], { type: mime }), fileName);
      form.append("model", model);
      form.append("response_format", "json");
      if (lang) form.append("language", lang);
      const res = await fetchWithTimeout(`${s.baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.apiKey}` },
        body: form,
      });
      const json = (await res.json()) as { text?: string };
      return (json.text ?? "").trim();
    };
    try {
      return await send(s.sttModel);
    } catch (err) {
      // A model name the account/region doesn't have → fall back to whisper-1 once.
      if (err instanceof HttpError && (err.status === 400 || err.status === 404) && s.sttModel !== "whisper-1") {
        console.warn(`[voice] model ${s.sttModel} rejected (${err.status}); retrying with whisper-1`);
        return await send("whisper-1");
      }
      throw err;
    }
  },

  async synthesize(text, _lang, s) {
    // The voices are multilingual; the language comes from the text itself.
    const body: Record<string, unknown> = {
      model: s.ttsModel,
      input: text.slice(0, 4096), // API input limit
      voice: s.voice,
      response_format: "mp3",
    };
    if (s.ttsModel.startsWith("gpt-")) {
      body.instructions = "Speak warmly, clearly and a little slowly, for a grandparent listening on a phone.";
    }
    const res = await fetchWithTimeout(`${s.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { bytes: Buffer.from(await res.arrayBuffer()), ext: ".mp3" };
  },
};

/** "zh-TW" → "Chinese (Taiwan)", "yue" → "Cantonese"; undefined when unknown. */
export function languageName(language: LanguageCode | undefined): string | undefined {
  const code = language?.trim().replace(/_/g, "-");
  if (!code) return undefined;
  try {
    return new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(code) || undefined;
  } catch {
    return undefined;
  }
}

/** The instruction sent with the audio to Gemini (exported for the selftest). */
export function geminiPrompt(language: LanguageCode | undefined): string {
  const name = languageName(language);
  return (
    `Transcribe this voice note exactly, in its original language${name ? ` (likely ${name})` : ""}. ` +
    "Return only the words spoken: no translation, no description, no timestamps. " +
    'If nobody speaks, return an empty transcript.'
  );
}

const TRANSCRIPT_TOOL = {
  name: "submit_transcript",
  description: "Submit the exact transcript of the voice note.",
  input_schema: {
    type: "object" as const,
    properties: { transcript: { type: "string", description: "The words spoken, in the language they were spoken in. Empty if no speech." } },
    required: ["transcript"],
  },
};

const gemini: Provider = {
  accepts: [".wav"], // the input_audio format Google's compat docs show; everything else → 16 kHz WAV
  convertTo: { ext: ".wav", codec: ["-c:a", "pcm_s16le"] },
  sendUnconverted: (ext) => ext === ".mp3", // input_audio also defines "mp3"; only used without ffmpeg
  // 20 MB per inline request incl. prompt; base64 adds a third → keep raw audio ≤ 14 MB.
  maxBytes: 14 * 1024 * 1024,

  async transcribe(file, fileName, _mime, _lang, _s, language) {
    const format = extname(fileName).toLowerCase() === ".mp3" ? "mp3" : "wav";
    const out = await withDeadline(
      callAudio<{ transcript?: unknown }>({
        system: "You are a careful transcriber of short family voice messages.",
        prompt: geminiPrompt(language),
        audio: { data: file.toString("base64"), format },
        tool: TRANSCRIPT_TOOL,
        textKey: "transcript",
        timeoutMs: TIMEOUT_MS,
      }),
      TIMEOUT_MS,
    );
    return typeof out?.transcript === "string" ? out.transcript.trim() : "";
  },
};

/** Rejects with an AbortError after `ms` (the model fallback can make several requests). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "AbortError" })), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

const PROVIDERS: Record<string, Provider> = { openai, gemini };

// ── Language hint ──────────────────────────────────────────────────────────

// ISO-639-1 codes the transcription models recognise (Whisper's language set).
const ISO1 = new Set(
  ("af ar hy az be bs bg ca zh hr cs da nl en et fi fr gl de el he hi hu is id it ja kn kk ko lv lt mk " +
    "ms mr mi ne no fa pl pt ro ru sr sk sl es sw sv tl ta th tr uk ur vi cy").split(" "),
);
const ALIASES: Record<string, string> = {
  yue: "zh", // Cantonese has no ISO-639-1 code; "zh" still yields Chinese characters
  cmn: "zh",
  fil: "tl",
  nb: "no",
  nn: "no",
  iw: "he",
  in: "id",
};

/** Map our language codes ("zh-TW", "yue", "en-US") to an ISO-639-1 hint, or undefined if unknown. */
export function languageHint(language: LanguageCode | undefined): string | undefined {
  if (!language) return undefined;
  const primary = language.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  const code = ALIASES[primary] ?? primary;
  return ISO1.has(code) ? code : undefined;
}

// ── ffmpeg ─────────────────────────────────────────────────────────────────

const ffmpegBin = () => env("FFMPEG_PATH") || "ffmpeg";

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stderr });
    });
  });
}

let ffmpegCheck: Promise<boolean> | undefined;
/** Detects ffmpeg once per process. */
export function hasFfmpeg(): Promise<boolean> {
  ffmpegCheck ??= run(ffmpegBin(), ["-version"], 10_000)
    .then((r) => r.code === 0)
    .catch(() => false)
    .then((ok) => {
      if (!ok) console.warn("[voice] ffmpeg not found: .caf voice notes can't be converted (Windows: winget install ffmpeg)");
      return ok;
    });
  return ffmpegCheck;
}

const M4A = { ext: ".m4a", codec: ["-c:a", "aac", "-b:a", "64k"] };

async function ffmpegConvert(input: string, sampleRate: number, prefix: string, to: { ext: string; codec: string[] } = M4A): Promise<string> {
  await mkdir(TMP_DIR, { recursive: true });
  const out = join(TMP_DIR, `${prefix}-${randomUUID()}${to.ext}`);
  const r = await run(
    ffmpegBin(),
    ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", "-ac", "1", "-ar", String(sampleRate), ...to.codec, out],
    FFMPEG_TIMEOUT_MS,
  );
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.trim()}`);
  return out;
}

const MIME: Record<string, string> = {
  ".flac": "audio/flac", ".mp3": "audio/mpeg", ".mpeg": "audio/mpeg", ".mpga": "audio/mpeg",
  ".mp4": "audio/mp4", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".webm": "audio/webm", ".caf": "audio/x-caf",
};

// ── Public API ─────────────────────────────────────────────────────────────

export async function transcribe(audioPath: string, language: LanguageCode): Promise<string> {
  const s = settings();
  if (!s.provider) return placeholderNoKey(audioPath);
  const provider = PROVIDERS[s.provider];
  if (!provider) {
    console.warn(`[voice] SPEECH_PROVIDER=${s.provider} isn't implemented (only: ${Object.keys(PROVIDERS).join(", ")})`);
    return PLACEHOLDER_ERROR;
  }

  const started = Date.now();
  const lang = languageHint(language);
  let uploadPath = audioPath;
  let converted: string | undefined;
  let bytes = 0;
  try {
    const ext = extname(audioPath).toLowerCase();
    if (!provider.accepts.includes(ext)) {
      if (await hasFfmpeg()) {
        converted = await ffmpegConvert(audioPath, 16_000, "voice", provider.convertTo); // speech models resample to 16 kHz anyway
        uploadPath = converted;
      } else if (provider.sendUnconverted(ext)) {
        console.warn(`[voice] ${ext || "(no extension)"} isn't accepted by ${s.provider} and ffmpeg is missing; uploading as-is`);
      } else {
        console.warn(`[voice] ${ext || "(no extension)"} isn't accepted by ${s.provider} and ffmpeg is missing; not transcribing`);
        return PLACEHOLDER_ERROR;
      }
    }
    bytes = (await stat(uploadPath)).size;
    if (bytes > provider.maxBytes) {
      console.warn(`[voice] ${basename(uploadPath)} is ${bytes} bytes (limit ${provider.maxBytes})`);
      return PLACEHOLDER_TOO_BIG;
    }
    const file = await readFile(uploadPath);
    const uploadExt = extname(uploadPath).toLowerCase();
    const text = await provider.transcribe(file, basename(uploadPath), MIME[uploadExt] ?? "application/octet-stream", lang, s, language);
    console.log(`[voice] transcribe ok provider=${s.provider} lang=${lang ?? "auto"} bytes=${bytes}${converted ? " (converted)" : ""} ${Date.now() - started}ms`);
    return text || PLACEHOLDER_EMPTY;
  } catch (err) {
    const why = err instanceof Error ? (err.name === "AbortError" ? "timed out" : err.message) : String(err);
    console.warn(`[voice] transcribe failed provider=${s.provider} bytes=${bytes} ${Date.now() - started}ms: ${why}`);
    return PLACEHOLDER_ERROR;
  } finally {
    if (converted) await rm(converted, { force: true }).catch(() => {});
  }
}

export async function synthesize(text: string, language: LanguageCode): Promise<string> {
  const s = settings();
  if (!s.apiKey) throw new Error("synthesize needs SPEECH_API_KEY");
  // Only OpenAI speaks; SPEECH_PROVIDER=gemini (transcription) still uses OpenAI TTS here.
  const name = s.provider === "gemini" ? "openai" : s.provider;
  const provider = PROVIDERS[name];
  if (!provider?.synthesize) throw new Error(`SPEECH_PROVIDER=${s.provider} isn't implemented`);

  const started = Date.now();
  const { bytes, ext } = await provider.synthesize(text, languageHint(language), { ...s, provider: name });
  await mkdir(TMP_DIR, { recursive: true });
  const raw = join(TMP_DIR, `reply-${randomUUID()}${ext}`);
  await writeFile(raw, bytes);

  let out = raw;
  if (ext !== ".m4a" && (await hasFfmpeg())) {
    try {
      out = await ffmpegConvert(raw, 24_000, "reply"); // TTS output is 24 kHz → .m4a
      await rm(raw, { force: true });
    } catch (err) {
      console.warn(`[voice] couldn't convert speech to .m4a, keeping ${ext}: ${err instanceof Error ? err.message : err}`);
      out = raw;
    }
  }
  console.log(`[voice] synthesize ok provider=${name} chars=${text.length} bytes=${bytes.length} ${Date.now() - started}ms → ${basename(out)}`);
  return out;
}
