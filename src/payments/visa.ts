// Cross-border gifts with Visa Direct (sandbox only, never real accounts). Owned by User 2.
//
// VISA_MODE=mock (default) returns a fake successful transfer with demo exchange rates, so the
// demo never depends on sandbox access and makes no network call.
// VISA_MODE=sandbox calls the Visa Developer sandbox:
//   - quote()    → Foreign Exchange Rates API   POST /forexrates/v1/foreignexchangerates
//   - sendGift() → FX quote, then Funds Transfer API push funds (OCT)
//                  POST /visadirect/fundstransfer/v1/pushfundstransactions
// Auth is two-way TLS (project cert + private key, Visa CA bundle) PLUS HTTP Basic auth
// (Two-Way SSL user ID / password from the project's Credentials page).
// Docs: https://developer.visa.com/pages/working-with-visa-apis/two-way-ssl
//       https://developer.visa.com/api-reference/visa_direct/reference.md
//       https://developer.visa.com/api-reference/foreign_exchange/reference.md
//
// Settings (read from process.env at call time; the shared ones are also in config.ts):
//   VISA_MODE              mock | sandbox (default mock)
//   VISA_USER_ID           Two-Way SSL user ID           (Basic auth username)
//   VISA_PASSWORD          Two-Way SSL password          (Basic auth password)
//   VISA_CERT_PATH         project client certificate (PEM, e.g. cert.pem)
//   VISA_KEY_PATH          private key (PEM, e.g. privateKey.pem)
//   VISA_CA_PATH           Visa CA file(s), PEM; comma-separate several (e.g. the sandbox root
//                          and issuing CA). Added on top of Node's default trust store.
//   VISA_BASE_URL          default https://sandbox.api.visa.com (tests point it at a fake server)
//   VISA_ACQUIRING_BIN     default 408999 (the sandbox test acquiring BIN used in Visa's samples)
//   VISA_ACQUIRER_COUNTRY  default 840 (ISO 3166 numeric, USA)
//   VISA_TEST_SENDER_PAN   sandbox TEST card number for the sender      (lives in .env only!)
//   VISA_TEST_RECIPIENT_PAN sandbox TEST card number for the recipient  (lives in .env only!)
//   VISA_TIMEOUT_MS        per-call timeout, default 15000
//
// Card data: FamilyMember has no card fields (types are frozen), so for the demo EVERY family
// member maps to the two sandbox test PANs above. Card numbers never appear in code or logs
// (logs show the last 4 digits only).

import { readFileSync } from "node:fs";
import https from "node:https";
import tls from "node:tls";
import { config } from "../config.js";
import type { FamilyMember } from "../types.js";

export interface GiftResult {
  ok: boolean;
  amountSent: number;
  sentCurrency: string;
  amountReceived: number;
  receivedCurrency: string;
  transactionId?: string;
  error?: string;
  approvalCode?: string;
  actionCode?: string;
  raw?: unknown; // debug only: Visa's response body
  /** True when Visa may have processed the transfer anyway (timeout, connection reset): never say "nothing was charged". */
  maybeCharged?: boolean;
}

/** Demo cap: no single gift above this many US dollars. Enforced by sendGift itself (and by flow/needs first). */
export const MAX_GIFT_USD = 1000;

// Demo rates (units per 1 USD), used in mock mode and whenever the FX API fails.
const USD_RATES: Record<string, number> = {
  USD: 1, TWD: 32.2, CNY: 7.12, HKD: 7.8, KRW: 1385, JPY: 151, VND: 25400, PHP: 57.5, INR: 84, MXN: 19.8, EUR: 0.92, GBP: 0.77, CAD: 1.38,
};

/** Currencies Bridge can send or receive (the demo rate table). Anything else is refused, never treated as USD. */
export const SUPPORTED_CURRENCIES: readonly string[] = Object.keys(USD_RATES);
export function isSupportedCurrency(c: string | undefined): boolean {
  return typeof c === "string" && Object.hasOwn(USD_RATES, c.trim().toUpperCase());
}

// ISO 4217 numeric codes (the FX API wants numeric currency codes).
const NUMERIC_CURRENCY: Record<string, string> = {
  USD: "840", TWD: "901", CNY: "156", HKD: "344", KRW: "410", JPY: "392", VND: "704", PHP: "608", INR: "356", MXN: "484", EUR: "978", GBP: "826", CAD: "124",
};

// Minor units, so amounts are rounded the way the currency is written.
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND"]);

export interface Quote { amount: number; currency: string; rate: number; source?: "visa" | "demo" }

// ── Settings ───────────────────────────────────────────────────────────────

const env = (key: string, fallback = "") => process.env[key]?.trim() || fallback;
const settings = () => ({
  mode: (env("VISA_MODE", config.visaMode) as "mock" | "sandbox"),
  baseUrl: env("VISA_BASE_URL", "https://sandbox.api.visa.com").replace(/\/+$/, ""),
  userId: env("VISA_USER_ID", config.visaUserId),
  password: env("VISA_PASSWORD", config.visaPassword),
  certPath: env("VISA_CERT_PATH", config.visaCertPath),
  keyPath: env("VISA_KEY_PATH", config.visaKeyPath),
  caPath: env("VISA_CA_PATH", config.visaCaPath),
  acquiringBin: env("VISA_ACQUIRING_BIN", "408999"),
  acquirerCountry: env("VISA_ACQUIRER_COUNTRY", "840"),
  senderPan: env("VISA_TEST_SENDER_PAN"),
  recipientPan: env("VISA_TEST_RECIPIENT_PAN"),
  timeoutMs: Number(env("VISA_TIMEOUT_MS", "15000")) || 15000,
});

// ── Public API ─────────────────────────────────────────────────────────────

/** How much `amount` in `fromCurrency` is in `toCurrency`. Never throws. */
export async function quote(amount: number, fromCurrency: string, toCurrency: string): Promise<Quote> {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  if (settings().mode === "sandbox" && from !== to) {
    const live = await visaQuote(amount, from, to);
    if (live) return live;
  }
  return demoQuote(amount, fromCurrency, toCurrency);
}

export async function sendGift(
  from: FamilyMember,
  to: FamilyMember,
  amount: number,
  currency: string,
): Promise<GiftResult> {
  const receivedCurrency = to?.currency ?? currency;
  const invalid = validateGift(amount, currency, receivedCurrency);
  if (invalid) {
    return { ok: false, amountSent: amount, sentCurrency: currency, amountReceived: 0, receivedCurrency, error: invalid };
  }
  try {
    const q = await quote(amount, currency, receivedCurrency);
    if (settings().mode !== "sandbox") {
      await new Promise((r) => setTimeout(r, 300)); // feels like a real call in the demo
      return {
        ok: true,
        amountSent: amount,
        sentCurrency: currency,
        amountReceived: q.amount,
        receivedCurrency: q.currency,
        transactionId: `mock-${Date.now()}`,
      };
    }
    return await pushFunds(from, to, amount, currency, q);
  } catch (err) {
    // Belt and braces: sendGift never throws.
    console.error(`[visa] push failed unexpectedly: ${(err as Error)?.message ?? err}`);
    return {
      ok: false, amountSent: amount, sentCurrency: currency, amountReceived: 0, receivedCurrency,
      error: "the payment service had an unexpected problem",
      maybeCharged: settings().mode === "sandbox", // we can't tell how far the push got
    };
  }
}

/** Why this gift can't be sent at all (bad amount, over the cap, unknown currency), or undefined if it's fine. */
function validateGift(amount: number, currency: string, receivedCurrency: string): string | undefined {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0.01) return "the amount isn't valid";
  if (!isSupportedCurrency(currency)) return `I can't send ${String(currency)} yet`;
  if (!isSupportedCurrency(receivedCurrency)) return `I can't send to an account in ${String(receivedCurrency)} yet`;
  const minorDigits = ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
  if (Math.abs(amount * 10 ** minorDigits - Math.round(amount * 10 ** minorDigits)) > 1e-6) return "the amount has too many decimal places";
  if (demoQuote(amount, currency, "USD").amount > MAX_GIFT_USD) return `that's over the ${formatMoney(MAX_GIFT_USD, "USD")} limit per gift`;
  return undefined;
}

/** "$50.00", "NT$1,610", "¥356" — for messages people read. */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

// ── Demo rates ─────────────────────────────────────────────────────────────

function demoQuote(amount: number, fromCurrency: string, toCurrency: string): Quote {
  const from = USD_RATES[fromCurrency.toUpperCase()];
  const to = USD_RATES[toCurrency.toUpperCase()];
  if (!from || !to) return { amount, currency: fromCurrency, rate: 1, source: "demo" };
  const rate = to / from;
  return { amount: Math.round(amount * rate * 100) / 100, currency: toCurrency.toUpperCase(), rate, source: "demo" };
}

// ── Foreign Exchange Rates API ─────────────────────────────────────────────

async function visaQuote(amount: number, from: string, to: string): Promise<Quote | null> {
  const src = NUMERIC_CURRENCY[from];
  const dst = NUMERIC_CURRENCY[to];
  if (!src || !dst) return null;
  const s = settings();
  const res = await visaPost("/forexrates/v1/foreignexchangerates", {
    // Required: sourceCurrencyCode, destinationCurrencyCode (ISO 4217 numeric), sourceAmount.
    sourceCurrencyCode: src,
    destinationCurrencyCode: dst,
    sourceAmount: amount.toFixed(2),
    markupRate: "0",
    acquiringBin: s.acquiringBin,
    acquirerCountryCode: s.acquirerCountry,
    transactionType: "PUSH",
  }, `fx ${from}->${to}`);
  if (!res.ok) return null;
  const body = res.body as Record<string, unknown>;
  // VERIFY: destinationAmount is the converted amount (in `to`), conversionRate excludes markup.
  // The direction of conversionRate is not spelled out in the docs, so prefer destinationAmount.
  const destAmount = Number(body.destinationAmount);
  let rate = destAmount > 0 && amount > 0 ? destAmount / amount : Number(body.conversionRate);
  if (!(rate > 0) || !Number.isFinite(rate)) return null;
  const converted = destAmount > 0 ? destAmount : amount * rate;
  return { amount: roundFor(converted, to), currency: to, rate, source: "visa" };
}

// ── Funds Transfer API: push funds (OCT) ───────────────────────────────────

async function pushFunds(from: FamilyMember, to: FamilyMember, amount: number, currency: string, q: Quote): Promise<GiftResult> {
  const s = settings();
  const fail = (error: string, extra: Partial<GiftResult> = {}): GiftResult => ({
    ok: false, amountSent: amount, sentCurrency: currency, amountReceived: 0, receivedCurrency: q.currency, error, ...extra,
  });

  if (!s.recipientPan) return fail("Visa sandbox isn't set up (VISA_TEST_RECIPIENT_PAN is missing)");

  const stan = nextStan();
  const now = new Date();
  const body: Record<string, unknown> = {
    systemsTraceAuditNumber: stan, // VERIFY: schema says number; Visa's samples send a 6-digit string
    retrievalReferenceNumber: rrn(now, stan),
    localTransactionDateTime: localDateTime(now),
    acquiringBin: s.acquiringBin,
    acquirerCountryCode: s.acquirerCountry,
    businessApplicationId: "PP", // person-to-person
    transactionCurrencyCode: currency.toUpperCase(), // alpha or numeric ISO 4217 both accepted
    amount: Number(amount.toFixed(ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2)),
    recipientPrimaryAccountNumber: s.recipientPan,
    recipientName: asciiName(to.name),
    senderName: asciiName(from.name),
    senderReference: `bridge${stan}`,
    // VERIFY: sender address/country are demo values; Visa needs them for P2P, not real data here.
    senderAddress: "901 Metro Center Blvd",
    senderCity: "Foster City",
    senderStateCode: "CA",
    senderCountryCode: s.acquirerCountry,
    sourceOfFundsCode: "05", // VERIFY: 05 = debit/prepaid card-funded per Visa samples
    merchantCategoryCode: "6012",
    cardAcceptor: {
      name: "Bridge Family Gifts",
      idCode: "BRIDGE-GIFTS-01",
      terminalId: "BRIDGE01",
      address: { country: "USA", state: "CA", county: "San Mateo", zipCode: "94404" },
    },
  };
  if (s.senderPan) body.senderAccountNumber = s.senderPan;

  const res = await visaPost("/visadirect/fundstransfer/v1/pushfundstransactions", body,
    `push stan=${stan} ${amount} ${currency} to ${mask(s.recipientPan)}`);
  const raw = res.body;
  const actionCode = pickString(raw, "actionCode");
  const approvalCode = pickString(raw, "approvalCode"); // VERIFY: present on approvals per Visa samples
  const transactionId = pickString(raw, "transactionIdentifier");

  if (!res.ok) {
    // A timeout or reset after the request went out: Visa may still have pushed the funds.
    const extra: Partial<GiftResult> = { actionCode, raw, ...(res.uncertain ? { maybeCharged: true } : {}) };
    return fail(res.error ?? (actionCode ? actionCodeMessage(actionCode) : "the payment didn't go through"), extra);
  }
  if (actionCode !== "00") return fail(actionCodeMessage(actionCode), { actionCode, approvalCode, transactionId, raw });
  return {
    ok: true,
    amountSent: amount,
    sentCurrency: currency,
    amountReceived: q.amount,
    receivedCurrency: q.currency,
    transactionId,
    approvalCode,
    actionCode,
    raw,
  };
}

// VERIFY: standard ISO 8583 / Visa action codes; check Visa Direct's own code table.
function actionCodeMessage(code: string | undefined): string {
  switch (code) {
    case undefined: case "": return "Visa didn't say whether it was approved";
    case "05": return "declined by the card's bank";
    case "14": return "invalid card number";
    case "51": return "insufficient funds";
    case "54": return "the card has expired";
    case "57": case "62": case "93": return "this card can't receive this kind of transfer";
    case "61": case "65": return "the amount is over the card's limit";
    case "91": case "96": return "the card's bank is unavailable, try again later";
    default: return `declined (Visa code ${code})`;
  }
}

// ── HTTP with mutual TLS + Basic auth ──────────────────────────────────────

/** `uncertain`: the request may have reached Visa but we never got a clear answer (timeout, reset, cut-off response). */
interface VisaResponse { ok: boolean; status: number; body: unknown; error?: string; uncertain?: boolean }

let agentCache: { key: string; agent?: https.Agent; error?: string } | undefined;

/** Reads cert/key/CA once (per set of paths). A missing file → an error string, no crash. */
function getAgent(): { agent?: https.Agent; error?: string } {
  const s = settings();
  const key = [s.certPath, s.keyPath, s.caPath].join("|");
  if (agentCache?.key === key) return agentCache;
  let result: { agent?: https.Agent; error?: string };
  if (!s.certPath || !s.keyPath) {
    result = { error: "Visa sandbox isn't set up (VISA_CERT_PATH / VISA_KEY_PATH missing)" };
  } else {
    try {
      const read = (label: string, p: string) => {
        try { return readFileSync(p, "utf8"); } catch { throw new Error(`Visa sandbox isn't set up (can't read ${label} file)`); }
      };
      const cert = read("VISA_CERT_PATH", s.certPath);
      const keyPem = read("VISA_KEY_PATH", s.keyPath);
      const extraCa = s.caPath ? s.caPath.split(",").map((p) => p.trim()).filter(Boolean).map((p) => read("VISA_CA_PATH", p)) : [];
      result = { agent: new https.Agent({ cert, key: keyPem, ca: [...tls.rootCertificates, ...extraCa], keepAlive: false }) };
    } catch (err) {
      result = { error: (err as Error).message };
    }
  }
  agentCache = { key, ...result };
  return result;
}

async function visaPost(path: string, payload: unknown, logLabel: string): Promise<VisaResponse> {
  const s = settings();
  const started = Date.now();
  const log = (outcome: string) => console.log(`[visa] ${logLabel} → ${outcome} (${Date.now() - started}ms)`);

  if (!s.userId || !s.password) {
    log("not configured");
    return { ok: false, status: 0, body: undefined, error: "Visa sandbox isn't set up (VISA_USER_ID / VISA_PASSWORD missing)" };
  }
  const { agent, error } = getAgent();
  if (!agent) {
    log("not configured");
    return { ok: false, status: 0, body: undefined, error };
  }

  const data = JSON.stringify(payload);
  return new Promise<VisaResponse>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (r: VisaResponse, outcome: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log(outcome);
      resolve(r);
    };
    let req: ReturnType<typeof https.request>;
    try {
      req = https.request(`${s.baseUrl}${path}`, {
        method: "POST",
        agent,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(data),
          Authorization: `Basic ${Buffer.from(`${s.userId}:${s.password}`).toString("base64")}`,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", () => done({ ok: false, status: 0, body: undefined, error: "the connection to Visa broke before it answered", uncertain: true }, "response error"));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try { body = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
          const status = res.statusCode ?? 0;
          const code = pickString(body, "actionCode");
          const outcome = `HTTP ${status}${code ? ` actionCode ${code}` : ""}`;
          if (status >= 200 && status < 300) return done({ ok: true, status, body }, outcome);
          done({ ok: false, status, body, error: httpErrorMessage(status, body), uncertain: status === 408 || status === 504 }, outcome);
        });
      });
    } catch (err) {
      return done({ ok: false, status: 0, body: undefined, error: "couldn't reach Visa (bad VISA_BASE_URL)" }, `request error ${(err as Error).message}`);
    }
    timer = setTimeout(() => {
      req.destroy(new Error("timeout"));
      done({ ok: false, status: 0, body: undefined, error: "Visa didn't answer in time (timeout)", uncertain: true }, "timeout");
    }, s.timeoutMs);
    req.on("error", (err: NodeJS.ErrnoException) => {
      const tlsRejected = /certificate|handshake|alert|SSL|TLS/i.test(`${err.code ?? ""} ${err.message}`);
      // Refused / DNS / TLS-rejected requests never reached Visa's processing; anything else might have.
      const neverSent = tlsRejected || ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"].includes(err.code ?? "");
      done({
        ok: false, status: 0, body: undefined, uncertain: !neverSent,
        error: tlsRejected ? "sandbox auth failed (TLS certificate problem)"
          // A TLS 1.3 server that rejects our client cert often just resets the connection.
          : err.code === "ECONNRESET" ? "couldn't reach Visa (connection reset; check the client certificate)"
          : "couldn't reach Visa (connection error)",
      }, `error ${err.code ?? err.message}`);
    });
    req.end(data);
  });
}

function httpErrorMessage(status: number, body: unknown): string {
  if (status === 401 || status === 403) return "sandbox auth failed";
  const code = pickString(body, "actionCode");
  if (code) return actionCodeMessage(code);
  if (status === 400) return "Visa rejected the request details";
  if (status === 404) return "Visa API not found (check VISA_BASE_URL and the project's APIs)";
  if (status === 408 || status === 504) return "Visa didn't answer in time (timeout)";
  if (status >= 500) return "Visa is having trouble right now, try again later";
  return `Visa error (HTTP ${status})`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

let stanCounter = Math.floor(Math.random() * 1_000_000);
/** 6-digit systems trace audit number, unique per call within this process. */
function nextStan(): string {
  stanCounter = (stanCounter + 1) % 1_000_000;
  return String(stanCounter).padStart(6, "0");
}

/** Retrieval reference number, format ydddhhnnnnnn (last digit of year, Julian day, hour, STAN). */
function rrn(d: Date, stan: string): string {
  const start = new Date(d.getFullYear(), 0, 0);
  const day = Math.floor((d.getTime() - start.getTime()) / 86_400_000);
  return `${d.getFullYear() % 10}${String(day).padStart(3, "0")}${String(d.getHours()).padStart(2, "0")}${stan}`;
}

/** YYYY-MM-DDThh:mm:ss in local time. */
function localDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function roundFor(amount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency) ? Math.round(amount) : Math.round(amount * 100) / 100;
}

function mask(pan: string): string {
  return pan.length > 4 ? `****${pan.slice(-4)}` : "****";
}

/** Visa name fields want plain ASCII; "Nai Nai" stays, "奶奶" becomes "Family Member". */
function asciiName(name: string): string {
  const ascii = name.normalize("NFKD").replace(/[^\x20-\x7E]/g, "").trim().slice(0, 30);
  return ascii || "Family Member";
}

function pickString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const v = (body as Record<string, unknown>)[key];
  return v === undefined || v === null ? undefined : String(v);
}
