// Real product search for Bridge's shopping flow: SerpApi's Google Shopping engine. Owned by User 2.
//
// searchProducts(query, opts) → Product[] (never throws; [] on any error, timeout or no results).
// catalog.ts calls it first and falls back to the curated catalog (data/catalog.json) on [].
//
// Docs relied on (checked 2026-10):
//   https://serpapi.com/google-shopping-api           GET https://serpapi.com/search?engine=google_shopping
//       params: q, api_key, gl, hl, location, google_domain, min_price/max_price, no_cache …
//       shopping_results[]: position, title, product_id, product_link, source, price, extracted_price,
//       rating, reviews, snippet, extensions[], thumbnail, delivery, multiple_sources …
//       (shopping_results has product_link but NO link; inline_shopping_results has link.)
//   https://serpapi.com/api-status-and-error-codes    errors are {"error": "..."}; "no results" is HTTP 200
//       with an `error` message and search_metadata.status "Success".
//
// Settings (read from process.env at call time):
//   SERPAPI_API_KEY      SerpApi key. Without it, searchProducts returns [] without a network call.
//   SERPAPI_BASE_URL     default https://serpapi.com (tests point it at a fake server)
//   SERPAPI_GL           Google country, default "us"
//   SERPAPI_HL           Google UI language, default "en"
//   SERPAPI_LOCATION     optional location string, e.g. "Seattle, Washington, United States"
//   SERPAPI_TIMEOUT_MS   per-request timeout, default 12000
//   SHOP_SEARCH          serpapi | catalog (read by searchMode(); default serpapi when the key is set)

import type { Product } from "./catalog.js";

const env = (k: string) => process.env[k]?.trim() ?? "";
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; products: Product[] }>();

export interface SearchOptions {
  gl?: string;
  hl?: string;
  location?: string;
  maxPriceUsd?: number; // passed as max_price (only meaningful when results are in USD)
  limit?: number; // default 20
}

/** "serpapi" when real search should be tried, else "catalog". */
export function searchMode(): "serpapi" | "catalog" {
  const mode = env("SHOP_SEARCH").toLowerCase();
  if (mode === "catalog") return "catalog";
  return env("SERPAPI_API_KEY") ? "serpapi" : "catalog";
}

/** For tests: forget cached searches. */
export function clearSearchCache(): void {
  cache.clear();
}

/** Google Shopping results as Products. Never throws; [] on any failure. Cached per query for 10 minutes. */
export async function searchProducts(query: string, opts: SearchOptions = {}): Promise<Product[]> {
  try {
    const key = env("SERPAPI_API_KEY");
    const q = query.trim();
    if (!key || !q) return [];
    const gl = (opts.gl || env("SERPAPI_GL") || "us").toLowerCase();
    const hl = (opts.hl || env("SERPAPI_HL") || "en").toLowerCase();
    const location = opts.location || env("SERPAPI_LOCATION");
    const limit = opts.limit ?? 20;

    const cacheKey = JSON.stringify([q.toLowerCase(), gl, hl, location, opts.maxPriceUsd ?? null, limit]);
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.products;

    const params = new URLSearchParams({ engine: "google_shopping", q, gl, hl, api_key: key });
    if (location) params.set("location", location);
    if (opts.maxPriceUsd && opts.maxPriceUsd > 0 && gl === "us") params.set("max_price", String(Math.ceil(opts.maxPriceUsd)));
    const base = (env("SERPAPI_BASE_URL") || "https://serpapi.com").replace(/\/+$/, "");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(env("SERPAPI_TIMEOUT_MS")) || 12_000);
    let json: any;
    try {
      const res = await fetch(`${base}/search?${params}`, { signal: ctrl.signal, headers: { accept: "application/json" } });
      const text = await res.text();
      if (!res.ok) {
        // Never log the URL: it contains the API key.
        console.warn(`[shop] SerpApi error ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
        return [];
      }
      json = JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }

    const raw: any[] = [
      ...(Array.isArray(json?.shopping_results) ? json.shopping_results : []),
      ...(Array.isArray(json?.categorized_shopping_results)
        ? json.categorized_shopping_results.flatMap((c: any) => (Array.isArray(c?.shopping_results) ? c.shopping_results : []))
        : []),
      ...(Array.isArray(json?.inline_shopping_results) ? json.inline_shopping_results : []),
    ];
    if (!raw.length) {
      if (json?.error) console.warn(`[shop] SerpApi: ${String(json.error).slice(0, 200)}`);
      return [];
    }

    const seen = new Set<string>();
    const products: Product[] = [];
    for (const r of raw) {
      const p = mapResult(r, gl);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      products.push(p);
      if (products.length >= limit) break;
    }
    if (products.length) cache.set(cacheKey, { at: Date.now(), products });
    return products;
  } catch (err) {
    const why = err instanceof Error && err.name === "AbortError" ? "timed out" : err instanceof Error ? err.message : String(err);
    console.warn(`[shop] SerpApi search failed (${why}); using the catalog`);
    return [];
  }
}

// ── Mapping ────────────────────────────────────────────────────────────────

// Longest symbols first so "NT$" isn't read as "$".
const SYMBOLS: [string, string][] = [
  ["NT$", "TWD"], ["HK$", "HKD"], ["CA$", "CAD"], ["C$", "CAD"], ["US$", "USD"], ["MX$", "MXN"],
  ["CN¥", "CNY"], ["RMB", "CNY"], ["€", "EUR"], ["£", "GBP"], ["₩", "KRW"], ["₫", "VND"], ["₱", "PHP"], ["₹", "INR"],
];
const GL_CURRENCY: Record<string, string> = {
  us: "USD", tw: "TWD", hk: "HKD", ca: "CAD", mx: "MXN", cn: "CNY", jp: "JPY", kr: "KRW", vn: "VND", ph: "PHP", in: "INR", gb: "GBP", uk: "GBP",
};

/** The currency a SerpApi price string is written in ("$45.99", "NT$1,290", "45,00 €"). */
export function currencyOf(price: unknown, gl: string): string {
  const s = typeof price === "string" ? price : "";
  const code = s.match(/\b(USD|TWD|HKD|CAD|CNY|JPY|KRW|EUR|GBP|MXN|VND|PHP|INR)\b/i)?.[1];
  if (code) return code.toUpperCase();
  for (const [sym, cur] of SYMBOLS) if (s.includes(sym)) return cur;
  if (s.includes("¥")) return gl === "cn" ? "CNY" : "JPY";
  if (s.includes("$")) return GL_CURRENCY[gl] && ["TWD", "HKD", "CAD", "MXN"].includes(GL_CURRENCY[gl]) ? GL_CURRENCY[gl] : "USD";
  return GL_CURRENCY[gl] ?? "USD";
}

function numberFrom(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function httpsUrl(v: unknown): string | undefined {
  return typeof v === "string" && /^https?:\/\//i.test(v) ? v : undefined;
}

/** One SerpApi shopping result → Product (undefined if it has no title or price). */
export function mapResult(r: any, gl = "us"): Product | undefined {
  if (!r || typeof r !== "object") return undefined;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  const price = numberFrom(r.extracted_price) ?? numberFrom(r.price);
  if (!title || !price) return undefined;
  const extensions = Array.isArray(r.extensions) ? r.extensions.filter((e: unknown) => typeof e === "string") : [];
  const description = [typeof r.snippet === "string" ? r.snippet : "", ...extensions, typeof r.delivery === "string" ? r.delivery : ""]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" · ");
  const id = `serp-${String(r.product_id ?? r.immersive_product_page_token ?? title).slice(0, 80).replace(/[^A-Za-z0-9_-]/g, "") || "item"}`;
  const product: Product = {
    id,
    name: { en: title },
    price: Math.round(price * 100) / 100,
    currency: currencyOf(r.price, gl),
    merchant: typeof r.source === "string" && r.source.trim() ? r.source.trim() : "Online store",
    shipsTo: [],
    tags: tagsFor(`${title} ${description}`),
  };
  const url = httpsUrl(r.product_link) ?? httpsUrl(r.link);
  if (url) product.url = url;
  const image = httpsUrl(r.thumbnail) ?? httpsUrl(r.serpapi_thumbnail);
  if (image) product.image = image;
  const rating = numberFrom(r.rating);
  if (rating !== undefined && rating <= 5) product.rating = rating;
  const reviews = numberFrom(r.reviews);
  if (reviews !== undefined) product.reviews = Math.round(reviews);
  if (description) product.description = description.slice(0, 400);
  return product;
}

const TAG_WORDS: [string, RegExp][] = [
  ["large-display", /\b(large|big|extra[- ]large|jumbo|oversized?)\s+(display|screen|digits?|numbers?|lcd|backlit)|\b(display|screen)\s+\d(\.\d)?\s*(in|inch|")|\bbig[- ]digit/i],
  ["chinese-voice", /\b(chinese|mandarin|cantonese)\b.*\b(voice|talking|speak|broadcast)|\b(voice|talking)\b.*\b(chinese|mandarin|cantonese)\b|中文語音|中文语音/i],
  ["chinese-labels", /\b(chinese|mandarin)\b/i],
  ["talking", /\btalking\b|\bvoice\b/i],
  ["simple-buttons", /\b(one[- ]touch|one[- ]button|big buttons?|large buttons?|simple|easy[- ]to[- ]use|big keys?|large keys?)\b/i],
  ["elder-friendly", /\b(senior|seniors|elderly|elder|grandparents?|seniors?')\b/i],
  ["auto-shutoff", /\bauto(matic)?[- ]?shut[- ]?off\b/i],
  ["non-slip", /\bnon[- ]?slip\b|\banti[- ]?slip\b/i],
  ["warm", /\b(warm|fleece|down|thermal|heated|wool)\b/i],
];
function tagsFor(text: string): string[] {
  return TAG_WORDS.filter(([, re]) => re.test(text)).map(([t]) => t);
}
