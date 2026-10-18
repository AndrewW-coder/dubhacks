// Offline self-test for src/media/voice.ts. Run: npx tsx src/media/voice.selftest.ts
// Starts its own fake server on 127.0.0.1 (random port) that speaks both the OpenAI audio API
// (SPEECH_BASE_URL) and Gemini's OpenAI-compatible chat completions (LLM_BASE_URL + /gemini),
// so no network or real key is needed. Exits non-zero on failure.
// The .caf conversion checks need ffmpeg; without it they are skipped with a warning.

import { createServer, type IncomingMessage } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

interface Recorded {
  path: string;
  auth?: string;
  fields: Record<string, string>;
  fileName?: string;
  fileType?: string;
  fileBytes?: number;
  json?: Record<string, unknown>;
}

const requests: Recorded[] = [];
let mode: "ok" | "500" | "empty" = "ok";
// Gemini fake: how /gemini/chat/completions answers
let gmode: "tool" | "text" | "empty" | "quota-first" | "quota-all" | "500" = "tool";
let FAKE_MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, ...new Array(400).fill(0)]); // replaced by a real mp3 when ffmpeg exists

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const rec: Recorded = { path: req.url ?? "", auth: req.headers.authorization, fields: {} };
  requests.push(rec);
  if (mode === "500") {
    res.writeHead(500, { "content-type": "application/json" }).end('{"error":{"message":"boom"}}');
    return;
  }
  if (req.url === "/gemini/chat/completions") {
    rec.json = JSON.parse(body.toString("utf8"));
    const model = rec.json?.model;
    const send = (status: number, obj: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(obj));
    const quota = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3600s" }] } };
    if (gmode === "500") return send(500, { error: { message: "boom" } });
    if (gmode === "quota-all" || (gmode === "quota-first" && model === "gemini-3.8-flash")) return send(429, quota);
    if (gmode === "text") return send(200, { choices: [{ message: { role: "assistant", content: "  Grandma misses you  " } }] });
    const transcript = gmode === "empty" ? "" : "奶奶想你了";
    return send(200, {
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "submit_transcript", arguments: JSON.stringify({ transcript }) } }] } }],
    });
  }
  if (req.url === "/v1/audio/transcriptions") {
    const form = await new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: new Uint8Array(body) }).formData();
    for (const [k, v] of form) {
      if (typeof v === "string") rec.fields[k] = v;
      else {
        rec.fileName = v.name;
        rec.fileType = v.type;
        rec.fileBytes = v.size;
      }
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: mode === "empty" ? "  " : "奶奶想你了" }));
  } else if (req.url === "/v1/audio/speech") {
    rec.json = JSON.parse(body.toString("utf8"));
    res.writeHead(200, { "content-type": "audio/mpeg" }).end(FAKE_MP3);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

// Test audio (into .bridge-tmp/selftest/, ignored by git like the rest of .bridge-tmp)
const dir = resolve(".bridge-tmp", "selftest");
mkdirSync(dir, { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const haveFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;
const wav = join(dir, "tone.wav");
const caf = join(dir, "tone.caf");
if (haveFfmpeg) {
  spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", wav]);
  // iPhone voice notes are Opus in CAF (ffmpeg can't mux AAC into CAF; fall back to ALAC)
  if (spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", "-f", "caf", caf]).status !== 0) {
    spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-i", wav, "-c:a", "alac", "-f", "caf", caf]);
  }
  const mp3 = join(dir, "speech.mp3");
  spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libmp3lame", mp3]);
  if (existsSync(mp3)) FAKE_MP3 = readFileSync(mp3);
}

const voice = await import("./voice.js");

// 1. No keys at all → placeholder, no request (set after import: config.js loads .env)
for (const k of ["SPEECH_API_KEY", "SPEECH_PROVIDER", "LLM_API_KEY", "GEMINI_API_KEY", "LLM_MODEL"]) delete process.env[k];
process.env.TRANSLATE_PROVIDER = "";
process.env.SPEECH_BASE_URL = `http://127.0.0.1:${port}`;
process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/gemini`;
{
  const out = await voice.transcribe(caf, "zh");
  check("no keys → speechProvider() is empty", voice.speechProvider() === "", voice.speechProvider());
  check("no keys → placeholder", out.startsWith("(voice note — transcription not set up"), out);
  check("no keys → no request", requests.length === 0, requests.length);
  process.env.SPEECH_PROVIDER = "gemini"; // asked for gemini but no Gemini key
  check("SPEECH_PROVIDER=gemini without a Gemini key → placeholder", (await voice.transcribe(caf, "zh")).startsWith("(voice note — transcription not set up") && requests.length === 0);
  delete process.env.SPEECH_PROVIDER;
}

// ── Gemini (only the AI key is set) ─────────────────────────────────────────
process.env.TRANSLATE_PROVIDER = "gemini";
process.env.LLM_API_KEY = "fake";
check("Gemini key only → speechProvider() is gemini", voice.speechProvider() === "gemini", voice.speechProvider());
check("prompt names the language", voice.geminiPrompt("zh-TW").includes("(likely Chinese (Taiwan))") && voice.geminiPrompt("yue").includes("Cantonese"), voice.geminiPrompt("zh-TW"));
check("prompt without a known language has no hint", !voice.geminiPrompt("xx").includes("likely"), voice.geminiPrompt("xx"));
{
  type Part = { type: string; text?: string; input_audio?: { data: string; format: string } };
  const userParts = (r?: Recorded) => ((r?.json?.messages as { role: string; content: Part[] }[] | undefined)?.find((m) => m.role === "user")?.content ?? []) as Part[];
  if (haveFfmpeg && existsSync(caf)) {
    requests.length = 0;
    gmode = "tool";
    const out = await voice.transcribe(caf, "zh-TW");
    const r = requests[0];
    const parts = userParts(r);
    const audio = parts.find((p) => p.type === "input_audio")?.input_audio;
    const wavBytes = audio ? Buffer.from(audio.data, "base64") : Buffer.alloc(0);
    check("gemini: transcript returned", out === "奶奶想你了", out);
    check("gemini: one request to /chat/completions", requests.length === 1 && r?.path === "/gemini/chat/completions", requests.map((q) => q.path));
    check("gemini: .caf converted and sent as 16 kHz mono WAV input_audio", audio?.format === "wav" && wavBytes.toString("latin1", 0, 4) === "RIFF" && wavBytes.toString("latin1", 8, 12) === "WAVE" && wavBytes.readUInt16LE(22) === 1 && wavBytes.readUInt32LE(24) === 16000, { format: audio?.format, head: wavBytes.subarray(0, 12).toString("latin1") });
    check("gemini: language hint in the prompt", !!parts.find((p) => p.type === "text")?.text?.includes("likely Chinese (Taiwan)"), parts.find((p) => p.type === "text"));
    check("gemini: asks for submit_transcript tool", (r?.json?.tools as { function: { name: string } }[] | undefined)?.[0]?.function.name === "submit_transcript");
    check("gemini: default model + bearer key", r?.json?.model === "gemini-3.8-flash" && r?.auth === "Bearer fake", { model: r?.json?.model, auth: r?.auth });

    // .wav goes as-is
    requests.length = 0;
    await voice.transcribe(wav, "en");
    const a2 = userParts(requests[0]).find((p) => p.type === "input_audio")?.input_audio;
    check("gemini: .wav sent as-is", a2?.format === "wav" && Buffer.from(a2.data, "base64").equals(readFileSync(wav)));
  } else {
    console.warn("SKIP  gemini .caf conversion checks (ffmpeg not found)");
  }
  const sampleG = haveFfmpeg ? wav : join(dir, "fake.mp3");
  if (!haveFfmpeg) writeFileSync(sampleG, FAKE_MP3);

  gmode = "text";
  check("gemini: plain-text answer accepted", (await voice.transcribe(sampleG, "en")) === "Grandma misses you");
  gmode = "empty";
  check("gemini: empty transcript → placeholder", (await voice.transcribe(sampleG, "en")) === voice.PLACEHOLDER_EMPTY);
  gmode = "500";
  check("gemini: server 500 → placeholder", (await voice.transcribe(sampleG, "en")) === voice.PLACEHOLDER_ERROR);

  // 429 quota on the main model → next model, no long wait
  gmode = "quota-first";
  requests.length = 0;
  const t0 = Date.now();
  const out = await voice.transcribe(sampleG, "zh");
  const models = requests.map((q) => q.json?.model).join(",");
  check("gemini: 429 quota → falls back to the next model", out === "奶奶想你了" && models === "gemini-3.8-flash,gemini-flash-lite-latest" && Date.now() - t0 < 3000, `${out} ${models} ${Date.now() - t0}ms`);

  // every model out of quota → placeholder, no throw
  gmode = "quota-all";
  requests.length = 0;
  check("gemini: all models 429 → placeholder", (await voice.transcribe(sampleG, "zh")) === voice.PLACEHOLDER_ERROR, requests.map((q) => q.json?.model));
  gmode = "tool";

  check("gemini: missing file → placeholder", (await voice.transcribe(join(dir, "nope.caf"), "zh")) === voice.PLACEHOLDER_ERROR);
  await voice.synthesize("hi", "en").then(
    () => check("synthesize without SPEECH_API_KEY throws (Gemini doesn't speak)", false),
    () => check("synthesize without SPEECH_API_KEY throws (Gemini doesn't speak)", true),
  );
}

// ── OpenAI (SPEECH_API_KEY set, while Gemini is still configured) ───────────
process.env.SPEECH_API_KEY = "fake";
{
  check("SPEECH_API_KEY → speechProvider() is openai", voice.speechProvider() === "openai", voice.speechProvider());
  requests.length = 0;
  const sampleO = haveFfmpeg ? wav : join(dir, "fake.mp3");
  await voice.transcribe(sampleO, "zh");
  check("with the OpenAI key set, OpenAI is used instead of Gemini", requests.length === 1 && requests[0]?.path === "/v1/audio/transcriptions", requests.map((q) => q.path));
  process.env.SPEECH_PROVIDER = "gemini";
  requests.length = 0;
  await voice.transcribe(sampleO, "zh");
  check("SPEECH_PROVIDER=gemini wins over SPEECH_API_KEY", requests[0]?.path === "/gemini/chat/completions", requests.map((q) => q.path));
}
process.env.SPEECH_PROVIDER = "openai";

// 2. language hints
check("hint zh-TW → zh", voice.languageHint("zh-TW") === "zh");
check("hint yue → zh", voice.languageHint("yue") === "zh");
check("hint en-US → en", voice.languageHint("en-US") === "en");
check("hint unknown → undefined", voice.languageHint("xx") === undefined && voice.languageHint("") === undefined);

if (haveFfmpeg && existsSync(caf)) {
  // 3. .caf converted, hint sent, transcript returned
  requests.length = 0;
  const out = await voice.transcribe(caf, "zh-TW");
  const r = requests[0];
  check("transcript returned", out === "奶奶想你了", out);
  check(".caf converted to .m4a before upload", !!r?.fileName?.endsWith(".m4a") && r?.fileType === "audio/mp4", r);
  check("language hint sent", r?.fields.language === "zh", r?.fields);
  check("model + response_format sent", r?.fields.model === "gpt-transcribe" && r?.fields.response_format === "json", r?.fields);
  check("bearer auth sent", r?.auth === "Bearer fake", r?.auth);

  // 4. accepted format uploaded as-is, unknown language → no hint
  requests.length = 0;
  await voice.transcribe(wav, "xx");
  check(".wav uploaded as-is", requests[0]?.fileName === "tone.wav" && requests[0]?.fileType === "audio/wav", requests[0]);
  check("unknown language → no hint", requests[0]?.fields.language === undefined, requests[0]?.fields);
} else {
  console.warn("SKIP  .caf conversion checks (ffmpeg not found)");
}
const sample = haveFfmpeg ? wav : join(dir, "fake.mp3");
if (!haveFfmpeg) writeFileSync(sample, FAKE_MP3);

// 5. empty transcript
mode = "empty";
check("empty transcript → placeholder", (await voice.transcribe(sample, "zh")) === voice.PLACEHOLDER_EMPTY);

// 6. server 500 → friendly placeholder (no throw)
mode = "500";
requests.length = 0;
check("server 500 → placeholder", (await voice.transcribe(sample, "zh")) === voice.PLACEHOLDER_ERROR);
check("500 is not retried with whisper-1", requests.length === 1, requests.length);

// 7. missing file → placeholder (no throw)
mode = "ok";
check("missing file → placeholder", (await voice.transcribe(join(dir, "nope.caf"), "zh")) === voice.PLACEHOLDER_ERROR);

// 8. synthesize writes a file
requests.length = 0;
const audio = await voice.synthesize("Grandma, I miss you too!", "en");
const j = requests[0]?.json ?? {};
check("synthesize writes a file", existsSync(audio) && statSync(audio).size > 0, audio);
check("synthesize → .bridge-tmp", audio.startsWith(resolve(".bridge-tmp")), audio);
check(`synthesize → ${haveFfmpeg ? ".m4a" : ".mp3"}`, audio.endsWith(haveFfmpeg ? ".m4a" : ".mp3"), audio);
check("speech request body", requests[0]?.path === "/v1/audio/speech" && j.model === "gpt-4o-mini-tts" && j.voice === "coral" && j.response_format === "mp3" && j.input === "Grandma, I miss you too!", j);

server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall voice checks passed");
process.exit(failures ? 1 : 0);
