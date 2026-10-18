// Shopping option cards as images: photo, name and price in the reader's language and
// currency, store and rating, why it fits, and a "Pay with Visa" footer. Owned by User 1.
//
// renderOptionCard(data) → path of a 900×1125 PNG, or undefined when images are off or
// rendering failed (the caller then sends the text card instead, so nothing breaks).
//
// Rendering drives the Edge/Chrome already installed (puppeteer-core, no browser download):
// one headless browser is started on first use and reused for every card. Cards are cached
// by content, so readers with the same language and currency share one image.
//
// Settings (read from process.env):
//   CARD_IMAGES          on | off. Default: on in live mode, off otherwise (the simulator and
//                        selftests keep text cards).
//   CARD_BROWSER_PATH    Edge/Chrome executable; default: the usual Windows/macOS install paths.
//   CARD_IMAGE_TIMEOUT_MS  per card, default 8000 (a slow product photo is dropped, not waited on).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Browser } from "puppeteer-core";

export interface CardData {
  letter: string; // "A"
  name: string; // in the reader's language
  store: string;
  rating?: number;
  reviews?: number;
  price: string; // in the reader's currency, e.g. "≈ NT$2,220"
  altPrice?: string; // the store's own price when it differs, e.g. "$68.99"
  image?: string; // https product photo
  icon?: string; // emoji shown when there's no photo
  why: string; // in the reader's language
  chips?: string[]; // short features, in the reader's language
  labels: { option: string; pay: string; vote: string }; // "Option", "Pay securely with Visa", "Tap ❤️ to vote B"
}

const OUT_DIR = resolve(".bridge-tmp", "cards");
const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

export function cardImagesEnabled(): boolean {
  const v = (process.env.CARD_IMAGES ?? "").trim().toLowerCase();
  if (v === "on") return true;
  if (v === "off") return false;
  return (process.env.PHOTON_MODE ?? "").trim().toLowerCase() === "live";
}

let browser: Promise<Browser | undefined> | undefined;
const rendering = new Map<string, Promise<string | undefined>>(); // cache key → PNG path

export function renderOptionCard(data: CardData): Promise<string | undefined> {
  if (!cardImagesEnabled()) return Promise.resolve(undefined);
  const key = createHash("sha1").update(CSS).update(JSON.stringify(data)).digest("hex").slice(0, 16); // a design change re-renders
  if (!rendering.has(key)) {
    const limit = (Number(process.env.CARD_IMAGE_TIMEOUT_MS) || 8000) + 4000;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<undefined>((r) => {
      timer = setTimeout(() => {
        console.warn(`[cards] a card took over ${limit} ms; sending text instead`);
        r(undefined);
      }, limit);
    });
    const job = Promise.race([render(data, join(OUT_DIR, `${key}.png`)), timedOut]).finally(() => clearTimeout(timer)).catch((err) => {
      console.error("[cards] couldn't render a card; sending text instead", err instanceof Error ? err.message : err);
      resetBrowser(); // a frozen Edge would fail every later card too
      return undefined;
    });
    rendering.set(key, job);
    void job.then((p) => p || rendering.delete(key)); // retry failures next time
  }
  return rendering.get(key)!;
}

async function render(data: CardData, path: string): Promise<string | undefined> {
  if (existsSync(path)) return path;
  const b = await getBrowser();
  if (!b) return undefined;
  await mkdir(OUT_DIR, { recursive: true });
  const timeout = Number(process.env.CARD_IMAGE_TIMEOUT_MS) || 8000;
  const page = await b.newPage();
  try {
    await page.setJavaScriptEnabled(false); // our own static HTML; product text is escaped
    await page.setViewport({ width: 900, height: 1125, deviceScaleFactor: 1 });
    await page.setContent(cardHtml(data), { waitUntil: "load", timeout }).catch(() => {
      // A slow product photo: shoot what's there rather than fail the card.
    });
    await page.screenshot({ path: path as `${string}.png`, type: "png" });
    return path;
  } finally {
    await page.close().catch(() => {});
  }
}

/** Drop the current browser so the next card starts a fresh one. */
function resetBrowser() {
  const old = browser;
  browser = undefined;
  void old?.then((b) => b?.close()).catch(() => {});
}

function getBrowser(): Promise<Browser | undefined> {
  browser ??= (async () => {
    const exe = [process.env.CARD_BROWSER_PATH?.trim(), ...BROWSERS].find((p) => p && existsSync(p));
    if (!exe) {
      console.warn("[cards] no Edge/Chrome found (set CARD_BROWSER_PATH); sending text cards");
      return undefined;
    }
    const { launch } = await import("puppeteer-core");
    // protocolTimeout: a frozen screenshot fails in 15 s instead of puppeteer's default 3 minutes.
    const b = await launch({ executablePath: exe, headless: true, protocolTimeout: 15_000, args: ["--disable-gpu", "--hide-scrollbars", "--no-first-run"] });
    process.once("exit", () => void b.close().catch(() => {}));
    console.log("[cards] rendering cards with", exe.split(/[\\/]/).pop());
    return b;
  })().catch((err) => {
    console.error("[cards] couldn't start the browser; sending text cards", err instanceof Error ? err.message : err);
    browser = undefined; // try again next time
    return undefined;
  });
  return browser;
}

// ── The card (the design approved in the mockup) ──────────────────────────────

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LOGO = `<svg viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0EA5E9"/><stop offset="1" stop-color="#4F46E5"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><g stroke="#fff" stroke-linecap="round" fill="none"><path d="M96 300 Q256 120 416 300" stroke-width="30"/><line x1="72" y1="300" x2="440" y2="300" stroke-width="28"/></g><g fill="#fff"><rect x="92" y="336" width="140" height="98" rx="34"/><rect x="280" y="336" width="140" height="98" rx="34"/></g></svg>`;

const CSS = `
  :root { --ink:#0F172A; --muted:#475569; --line:#E2E8F0; --bg:#EEF2F7; --brand1:#0EA5E9; --brand2:#4F46E5; --visa:#1A1F71; --gold:#F7B600; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 900px; height: 1125px; background: var(--bg); }
  body { font-family: Inter, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif; color: var(--ink); padding: 28px; }
  .card > * { flex-shrink: 0; }
  .card { height: 100%; background: #fff; border-radius: 40px; padding: 34px; display: flex; flex-direction: column; gap: 18px; box-shadow: 0 12px 40px rgba(15,23,42,.10); }
  .top { display: flex; align-items: center; justify-content: space-between; }
  .opt { display: flex; align-items: center; gap: 18px; font-size: 30px; font-weight: 700; color: var(--muted); }
  .badge { width: 76px; height: 76px; border-radius: 24px; display: grid; place-items: center; color: #fff; font-size: 44px; font-weight: 800; background: linear-gradient(135deg, var(--brand1), var(--brand2)); }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 26px; font-weight: 700; color: var(--muted); }
  .brand svg { width: 44px; height: 44px; }
  .photo { height: 320px; border-radius: 28px; background: #F8FAFC; border: 2px solid var(--line); display: grid; place-items: center; overflow: hidden; }
  .photo img { max-width: 86%; max-height: 86%; object-fit: contain; }
  .photo.none { background: linear-gradient(135deg, #E0F2FE, #E0E7FF); border: none; }
  .photo.none .icon { font-size: 170px; }
  .name { font-size: 40px; font-weight: 800; line-height: 1.2; max-height: 2.4em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .meta { font-size: 28px; color: var(--muted); display: flex; gap: 14px; align-items: center; }
  .stars { color: #F59E0B; letter-spacing: 1px; }
  .price { display: flex; align-items: baseline; gap: 16px; }
  .price .main { font-size: 60px; font-weight: 800; letter-spacing: -1px; }
  .price .alt { font-size: 30px; color: var(--muted); font-weight: 600; }
  .why { font-size: 30px; line-height: 1.35; color: #1E293B; max-height: 4.05em; overflow: hidden; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; max-height: 110px; overflow: hidden; }
  .chip { font-size: 24px; font-weight: 600; padding: 8px 16px; border-radius: 999px; background: #EEF2FF; color: #3730A3; }
  .spacer { flex: 1 1 auto; }
  .foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-top: 2px solid var(--line); padding-top: 22px; }
  .visa { display: flex; align-items: center; gap: 12px; font-size: 26px; font-weight: 700; color: var(--visa); min-width: 0; }
  .visa .txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .visa .mark { background: var(--visa); color: #fff; font-style: italic; font-weight: 900; letter-spacing: 1px; font-size: 26px; padding: 6px 14px; border-radius: 10px; border-bottom: 5px solid var(--gold); }
  .vote { font-size: 26px; font-weight: 700; color: var(--brand2); background: #EEF2FF; padding: 10px 18px; border-radius: 999px; white-space: nowrap; flex-shrink: 0; }`;

export function cardHtml(d: CardData): string {
  const r = typeof d.rating === "number" ? Math.max(0, Math.min(5, Math.round(d.rating))) : undefined;
  const stars = r === undefined ? "" : "★".repeat(r) + "☆".repeat(5 - r);
  const image = d.image && /^https:\/\//i.test(d.image) ? d.image : undefined;
  const reviews = typeof d.reviews === "number" ? ` (${d.reviews.toLocaleString("en-US")})` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="card">
    <div class="top"><div class="opt"><div class="badge">${esc(d.letter)}</div>${esc(d.labels.option)} ${esc(d.letter)}</div><div class="brand">${LOGO}Bridge</div></div>
    <div class="photo ${image ? "" : "none"}">${image ? `<img src="${esc(image)}" referrerpolicy="no-referrer">` : `<div class="icon">${esc(d.icon || "🛍️")}</div>`}</div>
    <div class="name">${esc(d.name)}</div>
    <div class="meta">${esc(d.store)}${stars ? ` · <span class="stars">${stars}</span> ${esc(d.rating)}${esc(reviews)}` : ""}</div>
    <div class="price"><span class="main">${esc(d.price)}</span>${d.altPrice ? `<span class="alt">${esc(d.altPrice)}</span>` : ""}</div>
    <div class="why">${esc(d.why)}</div>
    <div class="chips">${(d.chips ?? []).slice(0, 4).map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>
    <div class="spacer"></div>
    <div class="foot"><div class="visa"><span class="mark">VISA</span><span class="txt">${esc(d.labels.pay)}</span></div><div class="vote">${esc(d.labels.vote)}</div></div>
  </div></body></html>`;
}

// ── Helpers for building CardData from catalog/search products ───────────────

const FEATURES: Record<string, string> = {
  "large-display": "Large display",
  "big-buttons": "Big buttons",
  "simple-buttons": "Simple buttons",
  "one-touch": "One-touch",
  "chinese-voice": "Chinese voice",
  "voice": "Talking",
  "elder-friendly": "Elder-friendly",
  "senior-friendly": "Elder-friendly",
  "lightweight": "Lightweight",
  "portable": "Portable",
  "wireless": "Wireless",
  "bluetooth": "Bluetooth",
  "rechargeable": "Rechargeable",
  "waterproof": "Waterproof",
  "warm": "Warm",
  "non-slip": "Non-slip",
};

/** Up to 3 short English feature labels from a product's tags (unknown tags are skipped). */
export function featureLabels(tags: string[] = []): string[] {
  return [...new Set(tags.map((t) => FEATURES[t.toLowerCase()]).filter((l): l is string => !!l))].slice(0, 3);
}

const ICONS: [RegExp, string][] = [
  [/blood|pressure|medical|health|thermometer|monitor/i, "🩺"],
  [/phone|tablet|tech|electronic/i, "📱"],
  [/kitchen|cook|rice|pot|food|grocer/i, "🍲"],
  [/cloth|jacket|coat|shoe|wear|scarf/i, "🧥"],
  [/gift|red-envelope|festival/i, "🎁"],
  [/tea|coffee/i, "🍵"],
  [/heater|blanket|warm/i, "🔥"],
];

/** An emoji for the card when the product has no photo. */
export function iconFor(category = "", tags: string[] = []): string {
  const text = `${category} ${tags.join(" ")}`;
  return ICONS.find(([re]) => re.test(text))?.[1] ?? "🛍️";
}
