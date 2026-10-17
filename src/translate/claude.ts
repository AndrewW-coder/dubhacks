// Structured AI calls for Bridge: "answer by calling this tool", so we always get JSON back
// instead of parsing prose. Owned by User 2. Used by translator.ts, payments/flow.ts,
// payments/needs.ts and media/image.ts. (The file keeps its name and the hasClaude()/callTool()
// API so no caller changes, but it now talks to several providers.)
//
// Providers (TRANSLATE_PROVIDER):
//   gemini             Google Gemini via its OpenAI-compatible endpoint. The DEFAULT when LLM_API_KEY
//                      (or GEMINI_API_KEY) is set. Free key: aistudio.google.com → "Get API key".
//   anthropic          Claude via @anthropic-ai/sdk (ANTHROPIC_API_KEY). Default if only that key is set.
//   openai-compatible  Anything that speaks OpenAI chat completions with tools: OpenAI, Groq,
//                      OpenRouter, DeepSeek, Ollama (http://127.0.0.1:11434/v1)… Set LLM_BASE_URL + LLM_MODEL.
//   (no key at all)    hasClaude() is false and callers use their placeholders, as before.
//
// Env (all optional except a key):
//   TRANSLATE_PROVIDER     gemini | anthropic | openai-compatible (auto-detected when empty)
//   LLM_API_KEY            key for gemini / openai-compatible (GEMINI_API_KEY also accepted)
//   LLM_MODEL              model id. Gemini default: gemini-3.8-flash, falling back to gemini-flash-lite-latest
//                          then gemini-flash-latest when a model is missing, overloaded (503) or out of quota (429).
//   LLM_BASE_URL           OpenAI-compatible base URL (Gemini default:
//                          https://generativelanguage.googleapis.com/v1beta/openai)
//   LLM_REASONING_EFFORT   low | medium | high | none (Gemini default "low": fast; Gemini 3 can't use "none")
//   LLM_TIMEOUT_MS         per call, default 20000
//   ANTHROPIC_API_KEY / ANTHROPIC_MODEL / ANTHROPIC_BASE_URL  for the anthropic provider.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

export type UserContent = Anthropic.Messages.MessageParam["content"];
type Tool = { name: string; description: string; input_schema: Anthropic.Messages.Tool.InputSchema };
type Provider = "gemini" | "anthropic" | "openai-compatible" | "none";

const env = (k: string) => process.env[k]?.trim() ?? "";
const llmKey = () => env("LLM_API_KEY") || env("GEMINI_API_KEY");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
// Tried in order when a model is missing, overloaded, or out of quota. Free-tier keys get a small
// daily quota PER MODEL (e.g. 20 requests/day on gemini-3.8-flash), so falling back to the lite
// model keeps the demo working when the main one runs out.
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-flash-lite-latest", "gemini-flash-latest"];
const exhaustedUntil = new Map<string, number>(); // model → time its quota resets (ms)

export function provider(): Provider {
  const p = env("TRANSLATE_PROVIDER").toLowerCase();
  if (p === "gemini" || p === "openai-compatible") return llmKey() || p === "openai-compatible" && env("LLM_BASE_URL") ? p : "none";
  if (p === "anthropic") return config.anthropicApiKey ? "anthropic" : "none";
  if (llmKey()) return "gemini";
  if (config.anthropicApiKey) return "anthropic";
  return "none";
}

let warned = false;
/** True when some AI provider is configured (name kept for existing callers). */
export function hasClaude(): boolean {
  const ok = provider() !== "none";
  if (!ok && !warned) {
    console.warn("[ai] no AI key set (LLM_API_KEY for Gemini, or ANTHROPIC_API_KEY): using placeholder translations");
    warned = true;
  }
  return ok;
}

/**
 * Asks the model to respond by calling `tool` and returns the tool input.
 * Throws on API errors, timeouts or a missing tool call: callers decide the fallback.
 */
export async function callTool<T>(opts: {
  system: string;
  content: UserContent;
  tool: Tool;
  maxTokens?: number;
  model?: string;
}): Promise<T> {
  const p = provider();
  if (p === "anthropic") return callAnthropic<T>(opts);
  if (p === "gemini" || p === "openai-compatible") return callOpenAICompatible<T>(opts, p);
  throw new Error("no AI provider configured");
}

// ── Anthropic ──────────────────────────────────────────────────────────────

let anthropic: Anthropic | undefined;

async function callAnthropic<T>(opts: { system: string; content: UserContent; tool: Tool; maxTokens?: number; model?: string }): Promise<T> {
  anthropic ??= new Anthropic({ apiKey: config.anthropicApiKey, timeout: 15_000, maxRetries: 1 });
  const res = await anthropic.messages.create({
    model: opts.model ?? config.anthropicModel,
    max_tokens: opts.maxTokens ?? 800,
    system: opts.system,
    tools: [opts.tool],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: [{ role: "user", content: opts.content }],
  });
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Claude did not call the tool");
  return block.input as T;
}

// ── OpenAI-compatible (Gemini, OpenAI, Groq, OpenRouter, DeepSeek, Ollama…) ─

let workingGeminiModel: string | undefined; // remembered after the first successful fallback

async function callOpenAICompatible<T>(
  opts: { system: string; content: UserContent; tool: Tool; maxTokens?: number; model?: string },
  p: "gemini" | "openai-compatible",
): Promise<T> {
  const configured = opts.model ?? env("LLM_MODEL");
  if (p === "openai-compatible" && !configured) throw new Error("LLM_MODEL is required for openai-compatible");
  const now = Date.now();
  const fresh = GEMINI_MODELS.filter((m) => (exhaustedUntil.get(m) ?? 0) <= now);
  const candidates = configured
    ? [configured]
    : workingGeminiModel
      ? [workingGeminiModel, ...fresh.filter((m) => m !== workingGeminiModel)]
      : fresh.length ? fresh : GEMINI_MODELS;

  let lastErr: unknown;
  for (const model of candidates) {
    try {
      const out = await chatWithTool<T>(opts, p, model);
      exhaustedUntil.delete(model);
      if (p === "gemini" && !configured) {
        workingGeminiModel = model === GEMINI_MODELS[0] ? undefined : model;
        if (workingGeminiModel) setTimeout(() => (workingGeminiModel = undefined), 5 * 60_000).unref();
      }
      return out;
    } catch (err) {
      lastErr = err;
      if (!(err instanceof ModelNotFound || err instanceof ModelBusy)) throw err; // only fall through on missing/overloaded models
      if (err instanceof ModelBusy && err.retryAfterMs > 60_000) exhaustedUntil.set(model, Date.now() + err.retryAfterMs);
      if (err instanceof ModelNotFound) exhaustedUntil.set(model, Date.now() + 24 * 3600_000);
      if (workingGeminiModel === model) workingGeminiModel = undefined;
      const why = err instanceof ModelNotFound ? "not available on this key" : /quota/.test(err.message) ? "out of free quota for now" : "overloaded right now";
      console.warn(`[ai] model ${model} is ${why}, trying the next one`);
    }
  }
  throw lastErr;
}

class ModelNotFound extends Error {}
class ModelBusy extends Error {
  constructor(message: string, readonly retryAfterMs = 0) {
    super(message);
  }
}

/** "Please retry in 1h1m17.5s" / RetryInfo "retryDelay": "3677s" → milliseconds (0 if absent). */
function parseRetryDelay(text: string): number {
  const delay = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (delay) return Number(delay[1]) * 1000;
  const m = text.match(/retry in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i);
  if (!m || !(m[1] || m[2] || m[3])) return 0;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

async function chatWithTool<T>(
  opts: { system: string; content: UserContent; tool: Tool; maxTokens?: number },
  p: "gemini" | "openai-compatible",
  model: string,
): Promise<T> {
  const base = (env("LLM_BASE_URL") || (p === "gemini" ? GEMINI_BASE : "")).replace(/\/+$/, "");
  const effort = env("LLM_REASONING_EFFORT") || (p === "gemini" ? "low" : "");
  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content: `${opts.system}\n\nAlways answer by calling the function "${opts.tool.name}" exactly once, with arguments that match its schema. Do not reply with plain text.`,
      },
      { role: "user", content: toOpenAIContent(opts.content) },
    ],
    tools: [{ type: "function", function: { name: opts.tool.name, description: opts.tool.description, parameters: opts.tool.input_schema } }],
    // Gemini's compatibility layer documents "auto"; a single tool + the instruction above makes it call it.
    tool_choice: p === "gemini" ? "auto" : { type: "function", function: { name: opts.tool.name } },
    temperature: 0.3,
  };
  if (effort) body.reasoning_effort = effort;
  // No max_tokens for Gemini: its thinking tokens count against the limit and can truncate the answer.
  if (p !== "gemini" && opts.maxTokens) body.max_tokens = opts.maxTokens;

  const res = await postJson(`${base}/chat/completions`, body);
  const msg = res?.choices?.[0]?.message;
  const call = msg?.tool_calls?.find((c: { function?: { name?: string } }) => c?.function?.name === opts.tool.name) ?? msg?.tool_calls?.[0];
  const raw: unknown = call?.function?.arguments ?? extractJson(msg?.content);
  if (raw === undefined || raw === null || raw === "") throw new Error("the model did not call the tool");
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object") throw new Error("the model returned non-object arguments");
  for (const key of (opts.tool.input_schema.required as string[] | undefined) ?? []) {
    if (!(key in parsed)) throw new Error(`the model's answer is missing "${key}"`);
  }
  return parsed as T;
}

/** Anthropic-style content blocks → OpenAI chat content (text + data-URI images). */
function toOpenAIContent(content: UserContent): unknown {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image" && block.source.type === "base64") {
      return { type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
    }
    throw new Error(`unsupported content block for this provider: ${block.type}`);
  });
}

/** Some models answer with JSON in the text instead of a tool call; accept that too. */
function extractJson(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : undefined;
}

async function postJson(url: string, body: unknown, attempt = 1): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(env("LLM_TIMEOUT_MS")) || 20_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${llmKey()}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    const retryAfterMs = parseRetryDelay(text) || Number(res.headers.get("retry-after")) * 1000 || 0;
    // Free tiers rate-limit bursts (try:translate sends ~30 calls): wait and retry once,
    // unless the provider says the quota is gone for a long time (then move to the next model now).
    if ((res.status === 429 || res.status === 503) && attempt === 1 && retryAfterMs <= 15_000) {
      const wait = Math.min(retryAfterMs || 2000, 10_000);
      console.warn(`[ai] ${res.status} from provider, retrying in ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
      return postJson(url, body, 2);
    }
    const detail = text.slice(0, 300).replace(/\s+/g, " ");
    if (res.status === 503 || res.status === 429) {
      const quota = /quota|RESOURCE_EXHAUSTED/i.test(text);
      throw new ModelBusy(`${quota ? "out of quota" : "model busy"} (${res.status}): ${detail}`, retryAfterMs);
    }
    if (res.status === 404 || (res.status === 400 && /model/i.test(detail) && /not found|not supported|invalid/i.test(detail))) {
      throw new ModelNotFound(`model not found (${res.status}): ${detail}`);
    }
    if (res.status === 401 || res.status === 403) throw new Error(`the AI key was rejected (${res.status}): ${detail}`);
    throw new Error(`AI provider error ${res.status}: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}
