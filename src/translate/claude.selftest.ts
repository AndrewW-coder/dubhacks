// Offline test of the multi-provider AI helper against a fake OpenAI-compatible (Gemini) server.
//   npx tsx src/translate/claude.selftest.ts      → exits 1 on any failure
import http from "node:http";
import type { AddressInfo } from "node:net";

type Req = { path: string; auth: string; body: any };
const seen: Req[] = [];
let mode: "tool" | "json-text" | "404-first" | "429-once" | "401" | "busy-first" | "quota-first" = "tool";
let n429 = 0;

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    seen.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), body });
    const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    if (mode === "401") return send(401, { error: { message: "API key not valid" } });
    if (mode === "429-once" && n429++ === 0) return send(429, { error: { message: "slow down" } }, { "retry-after": "1" });
    if (mode === "quota-first" && body.model === "gemini-3.8-flash") return send(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota... limit: 20, model: gemini-3.8-flash\nPlease retry in 1h1m17.5s." } });
    if (mode === "busy-first" && body.model === "gemini-3.8-flash") return send(503, { error: { message: "high demand" } });
    if (mode === "404-first" && body.model === "gemini-3.8-flash") return send(404, { error: { message: "models/gemini-3.8-flash is not found" } });
    const args = { text: "Have you eaten?", confidence: 0.95, notes: "caring greeting" };
    if (mode === "json-text") {
      return send(200, { choices: [{ message: { role: "assistant", content: "```json\n" + JSON.stringify(args) + "\n```" } }] });
    }
    send(200, {
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: body.tools[0].function.name, arguments: JSON.stringify(args) } }] } }],
    });
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as AddressInfo).port;

process.env.TRANSLATE_PROVIDER = "";
process.env.LLM_API_KEY = "test-key-123";
process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
process.env.LLM_MODEL = "";
const ai = await import("./claude.js");

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : "  " + extra}`);
  if (!ok) failures++;
};
const tool = {
  name: "submit_translation",
  description: "Submit the translated message.",
  input_schema: { type: "object" as const, properties: { text: { type: "string" }, confidence: { type: "number" } }, required: ["text", "confidence"] },
};
const call = (content: any = "<message>你吃饭了吗</message>") => ai.callTool<any>({ system: "Translate.", content, tool, maxTokens: 300 });

check("auto-detects gemini when LLM_API_KEY is set", ai.provider() === "gemini");
check("hasClaude() is true with a Gemini key", ai.hasClaude());

// 1. normal tool call
let r = await call();
let last = seen.at(-1)!;
check("parses tool_call arguments", r.text === "Have you eaten?" && r.confidence === 0.95, JSON.stringify(r));
check("posts to /chat/completions with Bearer key", last.path === "/chat/completions" && last.auth === "Bearer test-key-123", `${last.path} ${last.auth}`);
check("default model is gemini-3.8-flash", last.body.model === "gemini-3.8-flash", last.body.model);
check("sends the tool as an OpenAI function", last.body.tools?.[0]?.function?.name === "submit_translation" && last.body.tools[0].function.parameters.required.length === 2);
check("reasoning_effort low, no max_tokens for gemini", last.body.reasoning_effort === "low" && !("max_tokens" in last.body), JSON.stringify({ e: last.body.reasoning_effort, m: last.body.max_tokens }));
check("system prompt tells the model to call the function", /call(ing)? the function "submit_translation"/.test(last.body.messages[0].content));

// 2. JSON in text instead of a tool call
mode = "json-text";
r = await call();
check("accepts JSON in a ```json block when no tool call", r.text === "Have you eaten?", JSON.stringify(r));

// 3. model fallback on 404
mode = "404-first";
seen.length = 0;
// a fresh module copy so the remembered working model doesn't hide the fallback
const freshCopy = "./claude.js?fallback"; // query string = a new module instance at runtime
const ai2 = (await import(freshCopy)) as typeof ai;
r = await ai2.callTool<any>({ system: "x", content: "y", tool });
check("falls back to the next model on 404", seen.map((s) => s.body.model).join(",") === "gemini-3.8-flash,gemini-flash-lite-latest" && r.text === "Have you eaten?", seen.map((s) => s.body.model).join(","));
seen.length = 0;
await ai2.callTool<any>({ system: "x", content: "y", tool });
check("remembers the working model afterwards", seen.length === 1 && seen[0].body.model === "gemini-flash-lite-latest", seen.map((s) => s.body.model).join(","));

// 3b. overloaded (503 twice) → next model
mode = "busy-first";
seen.length = 0;
const ai3 = (await import(freshCopy + "2")) as typeof ai;
r = await ai3.callTool<any>({ system: "x", content: "y", tool });
check("falls back to the next model when overloaded", seen.map((s) => s.body.model).join(",") === "gemini-3.8-flash,gemini-3.8-flash,gemini-flash-lite-latest" && r.text === "Have you eaten?", seen.map((s) => s.body.model).join(","));

// 3c. daily quota gone → skip straight to the lite model (no 2s wait) and stop trying the main model
mode = "quota-first";
seen.length = 0;
const ai4 = (await import(freshCopy + "3")) as typeof ai;
const tq = Date.now();
r = await ai4.callTool<any>({ system: "x", content: "y", tool });
check("out-of-quota → next model immediately", seen.map((s) => s.body.model).join(",") === "gemini-3.8-flash,gemini-flash-lite-latest" && Date.now() - tq < 1500, `${seen.map((s) => s.body.model).join(",")} ${Date.now() - tq}ms`);
seen.length = 0;
await ai4.callTool<any>({ system: "x", content: "y", tool });
check("exhausted model is skipped on the next call", seen.length === 1 && seen[0].body.model === "gemini-flash-lite-latest", seen.map((s) => s.body.model).join(","));

// 4. 429 → one retry
mode = "429-once";
n429 = 0;
seen.length = 0;
const t0 = Date.now();
r = await call();
check("retries once after 429 (honours retry-after)", seen.length === 2 && r.text === "Have you eaten?" && Date.now() - t0 >= 900, `${seen.length} calls, ${Date.now() - t0}ms`);

// 5. 401 → clear error
mode = "401";
let err = "";
try { await call(); } catch (e) { err = String((e as Error).message); }
check("401 throws 'the AI key was rejected'", /key was rejected/.test(err), err);

// 6. images become data-URI image_url parts
mode = "tool";
await call([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }, { type: "text", text: "Explain in English." }]);
last = seen.at(-1)!;
const parts = last.body.messages[1].content;
check("images sent as image_url data URIs", Array.isArray(parts) && parts[0].type === "image_url" && parts[0].image_url.url === "data:image/png;base64,iVBORw0KGgo=" && parts[1].type === "text", JSON.stringify(parts));

// 7. missing required field → throws (so callers fall back)
// (server returns both fields; simulate by requiring a field it never sends)
err = "";
try { await ai.callTool<any>({ system: "x", content: "y", tool: { ...tool, input_schema: { ...tool.input_schema, required: ["text", "alternatives"] } } }); } catch (e) { err = String((e as Error).message); }
check("missing required field throws", /missing "alternatives"/.test(err), err);

// 8. provider selection
process.env.TRANSLATE_PROVIDER = "anthropic";
check("TRANSLATE_PROVIDER=anthropic without ANTHROPIC_API_KEY → none", ai.provider() === "none" || !!process.env.ANTHROPIC_API_KEY);
process.env.TRANSLATE_PROVIDER = "";
process.env.LLM_API_KEY = "";
check("no keys at all → none (placeholders)", ai.provider() === "none" || !!process.env.ANTHROPIC_API_KEY || !!process.env.GEMINI_API_KEY);

server.close();
console.log(failures ? `\n${failures} claude.ts check(s) FAILED` : "\nall claude.ts provider checks passed");
process.exit(failures ? 1 : 0);
