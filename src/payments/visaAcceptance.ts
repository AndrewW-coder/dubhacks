// Visa Acceptance (Cybersource) sandbox client: a hosted Visa payment link for one purchase.
// Owned by User 2 (spec U2-16). Used by shop/checkout.ts when SHOP_MODE=paylink.
//
// How a purchase is paid:
//   1. createPayLink() creates an invoice for the exact item and price with deliveryMode "none"
//      (Visa sends no email), and returns Visa's hosted payment page (invoiceInformation.paymentLink).
//   2. Bridge texts that link to the buyer. The buyer pays on Visa's own page, so Bridge never
//      sees or stores card details.
//   3. getPayLink() reads the invoice status; PAID means the buyer paid. (Pay by Link proper only
//      reports payments through a webhook, which needs a public server; invoices can be polled.)
//   4. cancelPayLink() withdraws an unpaid link (the buyer said no, or it timed out).
//
// SANDBOX ONLY: requests go to Visa's test hosts, where only Visa's published test cards work and
// no real money moves. Any other host is refused.
//
// Auth: Cybersource HTTP Signature (HMAC-SHA256 over host, date, request-target, digest and
// v-c-merchant-id, with the shared secret, which is base64).
//
// Settings (process.env, read at call time):
//   VISA_ACCEPTANCE_MERCHANT_ID   sandbox merchant ID (Business Center → your org)
//   VISA_ACCEPTANCE_KEY_ID        REST shared-secret key ID (Business Center → Key Management)
//   VISA_ACCEPTANCE_SECRET_KEY    REST shared secret (base64), never committed
//   VISA_ACCEPTANCE_HOST          apitest.cybersource.com (default) or apitest.visaacceptance.com
//   VISA_ACCEPTANCE_BASE_URL      tests only: a local fake server (http://127.0.0.1:port), honoured
//                                 only with VISA_ACCEPTANCE_ALLOW_LOCAL=1
//   VISA_ACCEPTANCE_TIMEOUT_MS    per request (default 15000)

import { createHash, createHmac } from "node:crypto";

export interface PayLinkRequest {
  /** Our own reference, e.g. "bridge-mvd7b6qf". Letters, digits and dashes. */
  reference: string;
  description: string; // "Blood pressure monitor for Nai Nai"
  productName: string;
  productSku?: string;
  amount: number; // in `currency`, already rounded
  currency: string; // ISO code, e.g. "USD"
  customerName?: string; // the buyer's first name (no email: Visa sends nothing)
}

export type PayLinkStatus = "CREATED" | "SENT" | "DRAFT" | "PENDING" | "PARTIAL" | "PAID" | "CANCELED" | "UNKNOWN";

export type PayLinkResult =
  | { ok: true; id: string; url: string; status: PayLinkStatus }
  | { ok: false; error: string; status?: PayLinkStatus; httpStatus?: number };

const SANDBOX_HOSTS = new Set(["apitest.cybersource.com", "apitest.visaacceptance.com"]);

interface Settings {
  merchantId: string;
  keyId: string;
  secret: string;
  base: URL;
  timeoutMs: number;
}

/** Are the sandbox credentials present? (Says nothing about whether they work.) */
export function payLinkConfigured(): boolean {
  return typeof settings() !== "string";
}

/** True: Bridge only ever talks to Visa's test hosts (or a local fake in tests), so no real money moves. */
export function isSandbox(): boolean {
  const s = settings();
  return typeof s === "string" || SANDBOX_HOSTS.has(s.base.host) || s.base.hostname === "127.0.0.1" || s.base.hostname === "localhost";
}

function settings(): Settings | string {
  const env = (k: string) => process.env[k]?.trim() ?? "";
  const merchantId = env("VISA_ACCEPTANCE_MERCHANT_ID");
  const keyId = env("VISA_ACCEPTANCE_KEY_ID");
  const secret = env("VISA_ACCEPTANCE_SECRET_KEY");
  if (!merchantId || !keyId || !secret) return "the Visa sandbox isn't set up (VISA_ACCEPTANCE_MERCHANT_ID, _KEY_ID and _SECRET_KEY in .env)";
  const override = env("VISA_ACCEPTANCE_BASE_URL");
  let base: URL;
  try {
    base = new URL(override || `https://${env("VISA_ACCEPTANCE_HOST") || "apitest.cybersource.com"}`);
  } catch {
    return "VISA_ACCEPTANCE_BASE_URL / VISA_ACCEPTANCE_HOST isn't a valid address";
  }
  // A local fake server only for selftests (they set VISA_ACCEPTANCE_ALLOW_LOCAL=1), so a local proxy
  // can't be used to reach a production host.
  const local = override && process.env.VISA_ACCEPTANCE_ALLOW_LOCAL === "1" && (base.hostname === "127.0.0.1" || base.hostname === "localhost");
  // Real money never: only Visa's test hosts, or a local fake server in tests.
  if (!local && !(base.protocol === "https:" && SANDBOX_HOSTS.has(base.host))) {
    return `${base.host} isn't a Visa sandbox host; Bridge only uses the sandbox (apitest.cybersource.com or apitest.visaacceptance.com)`;
  }
  const t = Number(env("VISA_ACCEPTANCE_TIMEOUT_MS"));
  return { merchantId, keyId, secret, base, timeoutMs: Number.isFinite(t) && t > 0 ? t : 15_000 };
}

/** Creates the invoice and returns Visa's hosted payment link. Never throws. */
export async function createPayLink(req: PayLinkRequest): Promise<PayLinkResult> {
  const s = settings();
  if (typeof s === "string") return { ok: false, error: s };
  if (!(req.amount > 0) || !Number.isFinite(req.amount)) return { ok: false, error: "the amount isn't valid" };
  const amount = money(req.amount, req.currency);
  const body = {
    ...(req.customerName ? { customerInformation: { name: clip(req.customerName, 60) } } : {}),
    invoiceInformation: {
      description: clip(`${req.description} · ref ${req.reference.replace(/[^A-Za-z0-9-]/g, "")}`, 200),
      dueDate: tomorrow(),
      sendImmediately: true,
      deliveryMode: "none", // Visa sends no email; Bridge texts the link itself
      allowPartialPayments: false,
    },
    orderInformation: {
      amountDetails: { totalAmount: amount, currency: req.currency.toUpperCase() },
      lineItems: [
        {
          productSku: clip((req.productSku || req.reference).replace(/[^A-Za-z0-9-]/g, "") || "item", 30),
          productName: clip(req.productName, 60),
          quantity: 1,
          unitPrice: amount,
          totalAmount: amount,
        },
      ],
    },
  };
  const r = await call(s, "POST", "/invoicing/v2/invoices", body);
  if (!r.ok) return r;
  const id = str(r.json?.id) ?? str(r.json?.invoiceInformation?.invoiceNumber);
  const url = httpsLink(r.json?.invoiceInformation?.paymentLink);
  const status = statusOf(r.json?.status);
  if (!id || !url) return { ok: false, error: "Visa didn't return a payment link", status };
  if (status === "CANCELED") return { ok: false, error: "Visa canceled the payment link right away", status };
  return { ok: true, id, url, status };
}

/** Reads an invoice's status. Never throws. */
export async function getPayLink(id: string): Promise<{ ok: true; status: PayLinkStatus; balance?: number } | { ok: false; error: string; httpStatus?: number }> {
  const s = settings();
  if (typeof s === "string") return { ok: false, error: s };
  const r = await call(s, "GET", `/invoicing/v2/invoices/${encodeURIComponent(id)}`);
  if (!r.ok) return r;
  const balance = Number(r.json?.orderInformation?.amountDetails?.balanceAmount);
  return { ok: true, status: statusOf(r.json?.status), ...(Number.isFinite(balance) ? { balance } : {}) };
}

/** Withdraws an unpaid link. True when Visa confirmed the cancelation. Never throws. */
export async function cancelPayLink(id: string): Promise<boolean> {
  const s = settings();
  if (typeof s === "string") return false;
  const r = await call(s, "POST", `/invoicing/v2/invoices/${encodeURIComponent(id)}/cancelation`, {});
  return r.ok;
}

// ── HTTP + signature ─────────────────────────────────────────────────────────

type CallResult = { ok: true; json: any } | { ok: false; error: string; httpStatus?: number };

async function call(s: Settings, method: "GET" | "POST", path: string, body?: unknown): Promise<CallResult> {
  const url = new URL(path, s.base);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = signedHeaders(s, method, url, payload);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), s.timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body: payload, signal: ctl.signal });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (res.status === 401 || res.status === 403) return { ok: false, httpStatus: res.status, error: "Visa rejected the sandbox credentials (check the merchant ID, key ID and secret)" };
    if (!res.ok) {
      const why = str(json?.message) ?? str(json?.reason) ?? str(json?.details?.[0]?.reason) ?? `HTTP ${res.status}`;
      return { ok: false, httpStatus: res.status, error: `Visa said: ${clip(why, 160)}` };
    }
    return { ok: true, json: json ?? {} };
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    return { ok: false, error: aborted ? "Visa didn't answer in time" : `couldn't reach Visa (${(err as Error)?.message ?? err})` };
  } finally {
    clearTimeout(timer);
  }
}

/** Cybersource HTTP Signature headers. Exported for the selftest. */
export function signedHeaders(s: Pick<Settings, "merchantId" | "keyId" | "secret">, method: string, url: URL, payload?: string, date = new Date().toUTCString()): Record<string, string> {
  const host = url.host;
  const target = `${method.toLowerCase()} ${url.pathname}${url.search}`;
  const digest = payload !== undefined ? `SHA-256=${createHash("sha256").update(payload, "utf8").digest("base64")}` : undefined;
  const names = digest ? ["host", "date", "request-target", "digest", "v-c-merchant-id"] : ["host", "date", "request-target", "v-c-merchant-id"];
  const values: Record<string, string> = { host, date, "request-target": target, ...(digest ? { digest } : {}), "v-c-merchant-id": s.merchantId };
  const signingString = names.map((n) => `${n}: ${values[n]}`).join("\n");
  const signature = createHmac("sha256", Buffer.from(s.secret, "base64")).update(signingString, "utf8").digest("base64");
  return {
    "v-c-merchant-id": s.merchantId,
    Date: date,
    Host: host,
    ...(digest ? { Digest: digest, "Content-Type": "application/json" } : {}),
    Accept: "application/hal+json;charset=utf-8",
    Signature: `keyid="${s.keyId}", algorithm="HmacSHA256", headers="${names.join(" ")}", signature="${signature}"`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND"]);

function money(amount: number, currency: string): string {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? String(Math.round(amount)) : amount.toFixed(2);
}

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

function statusOf(v: unknown): PayLinkStatus {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return (["CREATED", "SENT", "DRAFT", "PENDING", "PARTIAL", "PAID", "CANCELED"] as const).find((x) => x === s) ?? (s === "CANCELLED" ? "CANCELED" : "UNKNOWN");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined;
}

function httpsLink(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.hostname === "127.0.0.1" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
