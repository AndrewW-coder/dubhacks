// Offline selftest for media/image.ts: npx tsx src/media/image.selftest.ts
// Runs a fake Anthropic server on 127.0.0.1 and points the SDK at it via ANTHROPIC_BASE_URL.
// Exits non-zero on failure.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Ignore AI settings from a developer's .env: this test uses a fake Anthropic server.
// (dotenv never overrides variables that are already set, and claude.ts reads these lazily.)
process.env.TRANSLATE_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "";
process.env.GEMINI_API_KEY = "";

const CHILD = process.argv[2] === "--child-nokey";

interface Recorded { mediaType?: string; text?: string; tool?: string }
const requests: Recorded[] = [];
let mode: "ok" | "noText" | "error" | "suspicious" = "ok";

function handler(req: IncomingMessage, res: ServerResponse) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = JSON.parse(body || "{}");
    const content = json.messages?.[0]?.content ?? [];
    requests.push({
      mediaType: content.find((c: any) => c.type === "image")?.source?.media_type,
      text: content.find((c: any) => c.type === "text")?.text,
      tool: json.tool_choice?.name,
    });
    if (mode === "error") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }));
      return;
    }
    const input =
      mode === "noText" ? { hasText: false }
      : mode === "suspicious" ? { hasText: true, explanation: "This letter looks like a scam.", suspicious: true }
      : { hasText: true, explanation: "  Take 1 tablet twice a day.  " };
    // Small delay so concurrent callers really overlap.
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_fake", type: "message", role: "assistant", model: json.model,
        content: [{ type: "tool_use", id: "toolu_fake", name: "photo_explanation", input }],
        stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      }));
    }, 50);
  });
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), "bridge-image-"));
const file = (name: string, bytes: Buffer) => {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
};
const JPEG = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]);
const PNG = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
function ftyp(major: string, compat: string[], tag = "") {
  const size = 16 + compat.length * 4;
  const box = Buffer.alloc(size);
  box.writeUInt32BE(size, 0);
  box.write("ftyp", 4, "latin1");
  box.write(major, 8, "latin1");
  compat.forEach((c, i) => box.write(c, 16 + i * 4, "latin1"));
  return Buffer.concat([box, Buffer.from(tag)]);
}

const server = createServer(handler);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

if (CHILD) {
  // No-key run: the parent passes the port of ITS fake server and counts requests there.
  const { explainImage } = await import("./image.js");
  server.close();
  const out = await explainImage(process.env.SELFTEST_IMAGE!, "zh");
  process.stdout.write(`RESULT=${JSON.stringify(out)}\n`);
  process.exit(0);
}

process.env.ANTHROPIC_API_KEY = "fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
const img = await import("./image.js");
const { explainImage, sniffImageType, _setHeicConverterForTests, _clearImageCacheForTests } = img;

try {
  // Magic-byte sniffing
  check("sniff jpeg", sniffImageType(JPEG("x")) === "image/jpeg");
  check("sniff png", sniffImageType(PNG("x")) === "image/png");
  check("sniff gif", sniffImageType(Buffer.from("GIF89a....")) === "image/gif");
  check("sniff webp", sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")) === "image/webp");
  check("sniff heic (ftypheic)", sniffImageType(ftyp("heic", ["mif1", "heic"])) === "image/heic");
  check("sniff heif (ftypmif1)", sniffImageType(ftyp("mif1", ["heic"])) === "image/heic");
  check("sniff avif is not heic", sniffImageType(ftyp("avif", ["mif1", "avif"])) === undefined);
  check("sniff junk", sniffImageType(Buffer.from("hello world!")) === undefined);

  // jpeg/png with the right media_type
  requests.length = 0;
  const jpg = file("label.jpg", JPEG("a"));
  const r1 = await explainImage(jpg, "zh");
  check("jpeg explained + trimmed", r1 === "Take 1 tablet twice a day.", r1);
  check("jpeg media_type", requests[0]?.mediaType === "image/jpeg", requests[0]);
  check("tool forced", requests[0]?.tool === "photo_explanation", requests[0]);
  check("language name in prompt", /Simplified Chinese/.test(requests[0]?.text ?? ""), requests[0]?.text);

  requests.length = 0;
  await explainImage(file("form.png", PNG("b")), "en");
  check("png media_type", requests[0]?.mediaType === "image/png", requests[0]);

  requests.length = 0;
  await explainImage(file("IMG_0001.jpg", PNG("wrong-ext")), "en");
  check("png with .jpg name sniffed as png", requests[0]?.mediaType === "image/png", requests[0]);
  requests.length = 0;
  await explainImage(file("attachment-noext", JPEG("noext")), "en");
  check("no extension sniffed as jpeg", requests[0]?.mediaType === "image/jpeg", requests[0]);

  // HEIC converted (mocked converter)
  let conversions = 0;
  _setHeicConverterForTests(async () => {
    conversions++;
    return new Uint8Array(JPEG("converted"));
  });
  requests.length = 0;
  const heic = file("odd-name.bin", ftyp("heic", ["mif1", "heic"], "payload"));
  const h1 = await explainImage(heic, "zh");
  await explainImage(heic, "ko");
  check("heic explained", h1.length > 0, h1);
  check("heic sent as jpeg", requests.length === 2 && requests.every((r) => r.mediaType === "image/jpeg"), requests);
  check("heic converted once for two languages", conversions === 1, conversions);
  _setHeicConverterForTests(async () => { throw new Error("bad heic"); });
  check("heic conversion failure gives \"\"", (await explainImage(file("broken.heic", ftyp("heic", [], "broken")), "zh")) === "");
  _setHeicConverterForTests(undefined);

  // Cache: same language → 1 request; different language → 2
  _clearImageCacheForTests();
  requests.length = 0;
  const bill = file("bill.jpg", JPEG("bill"));
  await explainImage(bill, "zh");
  await explainImage(bill, "zh");
  check("cache: same language → 1 request", requests.length === 1, requests.length);
  await explainImage(file("bill-copy.jpeg", JPEG("bill")), "zh");
  check("cache keyed by bytes, not path", requests.length === 1, requests.length);
  await explainImage(bill, "ko");
  check("cache: different language → 2 requests", requests.length === 2, requests.length);

  // Concurrent identical calls are coalesced
  requests.length = 0;
  const letter = file("letter.jpg", JPEG("letter"));
  const outs = await Promise.all([explainImage(letter, "vi"), explainImage(letter, "vi"), explainImage(letter, "vi"), explainImage(letter, "en")]);
  check("concurrent: 3 same + 1 other → 2 requests", requests.length === 2, requests.length);
  check("concurrent: all callers get the result", outs.every((o) => o === "Take 1 tablet twice a day."), outs);

  // Ordinary photo → ""
  mode = "noText";
  requests.length = 0;
  check("hasText false → \"\"", (await explainImage(file("selfie.jpg", JPEG("selfie")), "zh")) === "" && requests.length === 1);

  // Suspicious → flagged
  mode = "suspicious";
  check("suspicious → ⚠️ prefix", (await explainImage(file("scam.jpg", JPEG("scam")), "zh")).startsWith("⚠️ "));

  // Oversize → "" and no request
  mode = "ok";
  requests.length = 0;
  const big = file("huge.jpg", Buffer.concat([JPEG("big"), Buffer.alloc(8_000_000)]));
  check("oversize → \"\"", (await explainImage(big, "zh")) === "");
  check("oversize → no request", requests.length === 0, requests.length);

  // Server error → "" (and not cached: a later call retries)
  mode = "error";
  requests.length = 0;
  const flaky = file("flaky.jpg", JPEG("flaky"));
  check("server error → \"\"", (await explainImage(flaky, "zh")) === "");
  check("server error → request was made", requests.length >= 1, requests.length);
  mode = "ok";
  check("after error, retry succeeds", (await explainImage(flaky, "zh")) === "Take 1 tablet twice a day.");

  // Missing file / unsupported type → "", never throws
  check("missing file → \"\"", (await explainImage(join(dir, "nope.jpg"), "zh")) === "");
  requests.length = 0;
  check("non-image → \"\" and no request", (await explainImage(file("notes.txt", Buffer.from("just text")), "zh")) === "" && requests.length === 0);

  // No key → "" and no request (separate process: config is read at import)
  requests.length = 0;
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--child-nokey"], {
    env: { ...process.env, ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, SELFTEST_IMAGE: jpg },
    encoding: "utf8",
    timeout: 30_000,
  });
  check("no key → \"\"", /RESULT=""/.test(child.stdout ?? ""), { stdout: child.stdout, stderr: child.stderr?.slice(0, 500) });
  check("no key → no request", requests.length === 0, requests.length);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall image checks passed");
process.exit(failures ? 1 : 0);
