// Offline self-test for the Visa payment link (visaAcceptance.ts + checkout SHOP_MODE=paylink).
//   npx tsx src/payments/visaAcceptance.selftest.ts
// A fake Visa Acceptance server checks every request's HTTP signature. Mock photon, no API keys.
// Exits non-zero on failure.
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

process.env.PHOTON_MODE = "mock";
process.env.VISA_MODE = "mock";
process.env.ANTHROPIC_API_KEY = "";
process.env.TRANSLATE_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.GLOSSARY_FILE = "off";
process.env.SHOP_MODE = "paylink";
process.env.PAYLINK_POLL_MS = "40";
process.env.PAYLINK_TIMEOUT_MS = "1500";
process.env.PAYMENT_CONFIRM_TIMEOUT_MS = "300";
process.env.VISA_ACCEPTANCE_ALLOW_LOCAL = "1"; // let the client talk to the local fake server
delete process.env.SHOP_DEFAULT_LIMIT_USD;

const lines: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
console.warn = () => {};
console.error = () => {};

// ── Fake Visa Acceptance (invoicing v2) ──────────────────────────────────────
const MERCHANT = "bridge_test_merchant";
const KEY_ID = "11111111-2222-3333-4444-555555555555";
const SECRET = Buffer.from("not-a-real-secret-just-for-tests").toString("base64");

type Inv = { id: string; status: string; body: any; total: number };
const invoices = new Map<string, Inv>();
const seen: { method: string; path: string; sigOk: boolean; body: any }[] = [];
let nextId = 9000;
let mode: "ok" | "create-500" | "auth-401" | "get-flaky" | "cancel-fails" | "paid-on-cancel" = "ok";
let getCount = 0;

function verify(req: http.IncomingMessage, raw: string): boolean {
  const sig = String(req.headers.signature ?? "");
  const m = /keyid="([^"]+)", algorithm="HmacSHA256", headers="([^"]+)", signature="([^"]+)"/.exec(sig);
  if (!m || m[1] !== KEY_ID || req.headers["v-c-merchant-id"] !== MERCHANT) return false;
  const vals: Record<string, string> = {
    host: String(req.headers.host),
    date: String(req.headers.date),
    "request-target": `${req.method!.toLowerCase()} ${req.url}`,
    digest: String(req.headers.digest ?? ""),
    "v-c-merchant-id": MERCHANT,
  };
  if (raw && vals.digest !== `SHA-256=${createHash("sha256").update(raw).digest("base64")}`) return false;
  const signing = m[2]!.split(" ").map((h) => `${h}: ${vals[h]}`).join("\n");
  return createHmac("sha256", Buffer.from(SECRET, "base64")).update(signing).digest("base64") === m[3];
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const sigOk = verify(req, raw);
    seen.push({ method: req.method!, path: req.url!, sigOk, body });
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (!sigOk || mode === "auth-401") return send(401, { response: { rmsg: "Authentication Failed" } });
    const path = req.url ?? "";
    if (req.method === "POST" && path === "/invoicing/v2/invoices") {
      if (mode === "create-500") return send(502, { message: "Upstream error" });
      const id = String(nextId++);
      const total = Number(body.orderInformation.amountDetails.totalAmount);
      invoices.set(id, { id, status: "CREATED", body, total });
      return send(201, {
        id, status: "CREATED",
        invoiceInformation: { invoiceNumber: id, paymentLink: `https://businesscentertest.cybersource.com/ebc2/invoicing/payInvoice/tok${id}?version=v2.1`, deliveryMode: "none" },
        orderInformation: { amountDetails: { totalAmount: total, currency: body.orderInformation.amountDetails.currency, balanceAmount: total } },
      });
    }
    const get = /^\/invoicing\/v2\/invoices\/(\d+)$/.exec(path);
    if (req.method === "GET" && get) {
      const inv = invoices.get(get[1]!);
      if (!inv) return send(404, { message: "Not found" });
      if (mode === "get-flaky" && ++getCount % 2 === 1) return send(503, { message: "busy" });
      return send(200, { id: inv.id, status: inv.status, orderInformation: { amountDetails: { totalAmount: inv.total, balanceAmount: inv.status === "PAID" ? 0 : inv.total } } });
    }
    const cancel = /^\/invoicing\/v2\/invoices\/(\d+)\/cancelation$/.exec(path);
    if (req.method === "POST" && cancel) {
      const inv = invoices.get(cancel[1]!);
      if (!inv) return send(404, { message: "Not found" });
      if (mode === "cancel-fails") return send(500, { message: "nope" });
      if (mode === "paid-on-cancel") { inv.status = "PAID"; return send(400, { message: "Invoice is already paid" }); }
      if (inv.status !== "PAID") inv.status = "CANCELED";
      return send(200, { id: inv.id, status: inv.status });
    }
    send(404, { message: "unknown path" });
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as AddressInfo).port;

const setCreds = () => {
  process.env.VISA_ACCEPTANCE_MERCHANT_ID = MERCHANT;
  process.env.VISA_ACCEPTANCE_KEY_ID = KEY_ID;
  process.env.VISA_ACCEPTANCE_SECRET_KEY = SECRET;
  process.env.VISA_ACCEPTANCE_BASE_URL = `http://127.0.0.1:${port}`;
  delete process.env.VISA_ACCEPTANCE_HOST;
};
setCreds();

const va = await import("./visaAcceptance.js");
const { getFamilyByHandle, getAllMembers } = await import("../db/store.js");
const { tryResolvePrompt } = await import("../relay/prompts.js");
const { hasOpenMoneyPrompt, resetMoneySlotsForTests } = await import("./flow.js");
const { checkout } = await import("../shop/checkout.js");
import type { FamilyMember, IncomingMessage, TapbackKind } from "../types.js";
import type { Product } from "../shop/catalog.js";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) passes++;
  else { failures++; realLog(`✗ ${name}${detail ? `\n    ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const members = getAllMembers();
const m = (id: string) => members.find((x) => x.id === id)!;
const kevin = m("kevin"), mei = m("mei"), nainai = m("nainai");
const family = getFamilyByHandle(kevin.handle)!;
const phone = (who: FamilyMember) => (l: string) => l.includes(`📱 ${who.name.padEnd(10)}`);
const dump = (from: number) => lines.slice(from).join("\n    ");
async function waitFor(who: FamilyMember, t: string, from: number, ms = 3000): Promise<string | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const l = lines.slice(from).find((x) => phone(who)(x) && x.includes(t));
    if (l) return l;
    await sleep(10);
  }
  return undefined;
}
/** The whole message (all its lines) that starts at the line containing `first`. */
function messageAt(from: number, first: string): string {
  const i = lines.slice(from).findIndex((l) => l.includes(first));
  if (i < 0) return "";
  const out = [lines[from + i]!];
  for (const l of lines.slice(from + i + 1)) {
    if (/📱|✉️|»/.test(l)) break;
    out.push(l);
  }
  return out.join("\n");
}
let seq = 0;
const text = (from: FamilyMember, t: string): IncomingMessage => ({ id: `u${++seq}`, fromHandle: from.handle, kind: "text", text: t, receivedAt: new Date() });
const tap = (from: FamilyMember, id: string, tb: TapbackKind): IncomingMessage => ({ id, fromHandle: from.handle, kind: "tapback", tapback: tb, receivedAt: new Date() });
const product = (over: Partial<Product> = {}): Product => ({
  id: "bp-1", name: { en: "Large-display blood pressure monitor", zh: "大屏血压计" }, price: 39.98, currency: "USD",
  merchant: "Rehabmart.com", shipsTo: ["US"], tags: ["health"], url: "https://example.com/bp", ...over,
});
const lastInvoice = () => [...invoices.values()].at(-1)!;
const markPaid = (inv: Inv) => void (inv.status = "PAID");

// ── 1. Client: signature, request body, statuses ─────────────────────────────
{
  const r = await va.createPayLink({ reference: "bridge-test 1!", description: "Blood pressure monitor for Nai Nai", productName: "Monitor", amount: 39.98, currency: "usd", customerName: "Mei" });
  const s = seen.at(-1)!;
  check("create: signed request accepted (HMAC-SHA256 with digest)", s.sigOk && r.ok, { r, s: s.sigOk });
  check("create: invoice with deliveryMode none, sent now, no partial payments", s.body?.invoiceInformation?.deliveryMode === "none" && s.body.invoiceInformation.sendImmediately === true && s.body.invoiceInformation.allowPartialPayments === false, s.body?.invoiceInformation);
  check("create: amount as a 2-decimal string, currency upper-case", s.body?.orderInformation?.amountDetails?.totalAmount === "39.98" && s.body.orderInformation.amountDetails.currency === "USD");
  check("create: one line item, quantity 1, no email anywhere", s.body?.orderInformation?.lineItems?.length === 1 && s.body.orderInformation.lineItems[0].quantity === 1 && !JSON.stringify(s.body).includes("@"));
  check("create: reference (cleaned) in the description, only documented fields sent", /ref bridge-test1$/.test(s.body?.invoiceInformation?.description ?? "") && !("clientReferenceInformation" in (s.body ?? {})), s.body?.invoiceInformation?.description);
  check("create: returns id + https link", r.ok && /^\d+$/.test(r.id) && r.url.startsWith("https://businesscentertest.cybersource.com/"), r);
  if (r.ok) {
    const g = await va.getPayLink(r.id);
    check("get: signed GET (no digest) accepted, status CREATED", seen.at(-1)!.sigOk && g.ok && g.status === "CREATED", g);
    check("cancel: withdraws the link", (await va.cancelPayLink(r.id)) && invoices.get(r.id)!.status === "CANCELED");
  }
  const sig = va.signedHeaders({ merchantId: "m", keyId: "k", secret: SECRET }, "GET", new URL("https://apitest.cybersource.com/invoicing/v2/invoices/1"), undefined, "Sun, 18 Oct 2026 07:00:00 GMT");
  check("signature headers list for GET has no digest", /headers="host date request-target v-c-merchant-id"/.test(sig.Signature!) && !sig.Digest);

  // Credentials and hosts
  mode = "auth-401";
  const bad = await va.createPayLink({ reference: "x", description: "d", productName: "p", amount: 5, currency: "USD" });
  check("401 → clear 'rejected the sandbox credentials' error", !bad.ok && /rejected the sandbox credentials/.test(bad.error), bad);
  mode = "ok";
  delete process.env.VISA_ACCEPTANCE_SECRET_KEY;
  check("no credentials → not configured, clear error", !va.payLinkConfigured() && /isn't set up/.test(((await va.createPayLink({ reference: "x", description: "d", productName: "p", amount: 5, currency: "USD" })) as any).error));
  setCreds();
  delete process.env.VISA_ACCEPTANCE_BASE_URL;
  process.env.VISA_ACCEPTANCE_HOST = "api.cybersource.com"; // PRODUCTION: real money → refused
  const prod = await va.createPayLink({ reference: "x", description: "d", productName: "p", amount: 5, currency: "USD" });
  check("production host refused (sandbox only, no real money)", !prod.ok && /isn't a Visa sandbox host/.test(prod.error), prod);
  process.env.VISA_ACCEPTANCE_HOST = "apitest.visaacceptance.com";
  check("sandbox hosts are allowed and count as test mode", va.payLinkConfigured() && va.isSandbox());
  process.env.VISA_ACCEPTANCE_BASE_URL = "https://evil.example.com";
  check("a non-Visa base URL is refused", !va.payLinkConfigured());
  process.env.VISA_ACCEPTANCE_BASE_URL = "https://apitest.cybersource.com@evil.example.com";
  check("userinfo trick (apitest…@evil) is refused", !va.payLinkConfigured());
  setCreds();
  delete process.env.VISA_ACCEPTANCE_ALLOW_LOCAL;
  check("a local server is refused outside selftests (no proxy to production)", !va.payLinkConfigured());
  process.env.VISA_ACCEPTANCE_ALLOW_LOCAL = "1";
}

// ── 2. Checkout: the buyer pays on Visa's page → ordered ─────────────────────
{
  resetMoneySlotsForTests();
  const from = lines.length;
  const pr = checkout(family, mei, nainai, product(), { requester: nainai, letter: "B" });
  const l = await waitFor(mei, "💳 B · Large-display blood pressure monitor · $39.98 for Nai Nai", from);
  const msg = messageAt(from, "💳 B ·");
  check("buyer gets the Visa link message (untranslated details line)", Boolean(l), dump(from));
  check("link alone on the last line", /\n\s*│ https:\/\/businesscentertest\.cybersource\.com\/\S+$/.test(msg), msg);
  check("message says test mode, no real money", /Visa test mode: use a test card, no real money/.test(msg), msg);
  check("no ❤️/yes question in paylink mode (paying is the yes)", !lines.slice(from).some((l) => l.includes("🛒 Buy")), dump(from));
  check("buyer's money slot is held while the link is open", hasOpenMoneyPrompt(mei));
  await sleep(150);
  check("nothing ordered before payment", !(await Promise.race([pr.then(() => true), sleep(5).then(() => false)])));
  markPaid(lastInvoice());
  const r = await pr;
  check("PAID → ok order with the Visa invoice id and amount", r.ok && r.orderId === `visa-inv-${lastInvoice().id}` && r.charged?.amount === 39.98 && r.charged.currency === "USD" && /^\d{4}-\d{2}-\d{2}$/.test(r.eta ?? ""), r);
  check("slot released after", !hasOpenMoneyPrompt(mei));
  check("invoice is for the exact item and price", lastInvoice().total === 39.98 && lastInvoice().body.orderInformation.lineItems[0].productName === "Large-display blood pressure monitor");
}

// ── 3. "no" → link canceled, nothing bought ──────────────────────────────────
{
  const from = lines.length;
  const pr = checkout(family, mei, nainai, product(), { requester: nainai, letter: "A" });
  await waitFor(mei, "💳 A ·", from);
  check("'no' answers the link", tryResolvePrompt(text(mei, "no")) === true);
  const r = await pr;
  check("'no' → not ok, not charged, says canceled", !r.ok && !r.maybeCharged && /said no, so I canceled the Visa link and nothing was bought/.test(r.error ?? ""), r);
  check("the invoice was canceled at Visa", lastInvoice().status === "CANCELED");
}

// ── 4. other chat while the link is open is NOT an answer ────────────────────
{
  const from = lines.length;
  const pr = checkout(family, mei, nainai, product(), { requester: nainai });
  const l = await waitFor(mei, "💳 ", from);
  check("'yes' doesn't answer the link (only paying does)", tryResolvePrompt(text(mei, "yes")) === false);
  check("❤️ on the link isn't a payment either", tryResolvePrompt(tap(mei, l?.match(/#(b\d+)/)?.[1] ?? "", "love")) === false);
  await sleep(100);
  check("still waiting after yes/❤️", lastInvoice().status === "CREATED");
  check("👎 on the link cancels", tryResolvePrompt(tap(mei, l?.match(/#(b\d+)/)?.[1] ?? "", "dislike")) === true);
  const r = await pr;
  check("👎 → canceled, nothing bought", !r.ok && !r.maybeCharged && lastInvoice().status === "CANCELED", r);
}

// ── 5. timeout → canceled; paid at the last second → ordered ─────────────────
{
  process.env.PAYLINK_TIMEOUT_MS = "300";
  let r = await checkout(family, mei, nainai, product(), { requester: nainai });
  check("no payment in time → canceled, nothing bought", !r.ok && !r.maybeCharged && /didn't pay within 1 min, so I canceled the Visa link/.test(r.error ?? "") && lastInvoice().status === "CANCELED", r);

  // Paid exactly while Bridge cancels: Visa refuses the cancel (already paid); Bridge looks again and orders.
  mode = "paid-on-cancel";
  r = await checkout(family, mei, nainai, product(), { requester: nainai });
  check("paid at the last second → still ordered (never cancels a paid link)", r.ok && lastInvoice().status === "PAID", r);
  mode = "ok";
  process.env.PAYLINK_TIMEOUT_MS = "1500";
}

// ── 6. Visa errors ───────────────────────────────────────────────────────────
{
  mode = "create-500";
  let r = await checkout(family, mei, nainai, product(), { requester: nainai });
  check("can't create the link → nothing bought, not charged", !r.ok && !r.maybeCharged && /couldn't make the Visa payment link/.test(r.error ?? ""), r);
  check("create failure → no link sent, slot released", !hasOpenMoneyPrompt(mei));

  mode = "get-flaky"; // every other status check fails; Bridge keeps checking
  const pr = checkout(family, mei, nainai, product(), { requester: nainai });
  await sleep(200);
  markPaid(lastInvoice());
  r = await pr;
  check("status-check blips are retried → paid → ordered", r.ok, r);

  mode = "cancel-fails";
  process.env.PAYLINK_TIMEOUT_MS = "250";
  getCount = 0;
  r = await checkout(family, mei, nainai, product(), { requester: nainai });
  check("can't close the link → maybeCharged (never 'nothing charged'), says don't pay it", !r.ok && r.maybeCharged === true && /couldn't close the Visa link. Please don't pay it/.test(r.error ?? ""), r);
  check("cancel was retried", seen.filter((x) => x.path.endsWith(`/${lastInvoice().id}/cancelation`)).length === 3);
  mode = "ok";
  process.env.PAYLINK_TIMEOUT_MS = "1500";
}

// ── 7. Safety rules still apply before any link exists ───────────────────────
{
  const before = invoices.size;
  const r = await checkout(family, kevin, nainai, product({ id: "gc-1", name: { en: "Steam gift card $50" }, price: 50, tags: ["gift-card"] }), { requester: nainai, requestText: "我需要礼品卡" });
  check("scam target for an elder → guard asked; no answer → refused, no Visa link made", !r.ok && invoices.size === before, r);
  const over = await checkout(family, mei, nainai, product({ price: 5000 }), { requester: nainai });
  check("over the per-purchase cap → refused before any link", !over.ok && /limit per purchase/.test(over.error ?? "") && invoices.size === before, over);
  process.env.VISA_ACCEPTANCE_SECRET_KEY = "";
  const nocred = await checkout(family, mei, nainai, product(), { requester: nainai });
  check("no sandbox credentials → clear error, nothing bought", !nocred.ok && !nocred.maybeCharged && /isn't set up/.test(nocred.error ?? ""), nocred);
  setCreds();
}

// ── 8. Chinese-speaking buyer: sentence translated, details + link untouched ──
{
  const from = lines.length;
  const pr = checkout(family, nainai, nainai, product(), { requester: nainai, letter: "C" });
  await waitFor(nainai, "💳 C · 大屏血压计 · ", from);
  const msg = messageAt(from, "💳 C ·");
  check("elder buyer: name in her language, sentence translated, link last", /\[en→zh\] To buy it/.test(msg) && /\n\s*│ https:\/\/\S+$/.test(msg), msg);
  check("non-USD buyer: invoiced in USD, ≈ her currency shown", /\$39\.98 \(≈ NT\$/.test(msg) && lastInvoice().body.orderInformation.amountDetails.currency === "USD" && lastInvoice().total === 39.98, msg);
  tryResolvePrompt(text(nainai, "不"));
  await pr;
}

// ── 9. The whole story: Nai Nai asks → cards → vote → Mei pays on Visa → everyone told ──
{
  process.env.SHOP_SEARCH = "catalog";
  process.env.SERPAPI_API_KEY = "";
  process.env.SHOP_SHIP_DELAY_MS = "999999";
  process.env.SHOP_DELIVER_DELAY_MS = "999999";
  process.env.PAYLINK_TIMEOUT_MS = "3000";
  const { tryHandlePayment } = await import("./flow.js");
  const from = lines.length;
  await tryHandlePayment(family, nainai, text(nainai, "我的血压计坏了，想买个新的，字要大一点"));
  const cardB = await waitFor(kevin, "B · ", from);
  for (const who of [kevin, mei, nainai]) await waitFor(who, "C · ", from);
  check("story: cards reach everyone", Boolean(cardB), dump(from));
  tryResolvePrompt(text(kevin, "B"));
  tryResolvePrompt(text(nainai, "B"));
  const link = await waitFor(mei, "💳 B · ", from, 4000);
  check("story: after the vote, the buyer (Mei) gets the Visa link for B", Boolean(link), dump(from));
  check("story: no ❤️/yes question in between", !lines.slice(from).some((l) => l.includes("🛒 Buy")), dump(from));
  markPaid(lastInvoice());
  const kevinDone = await waitFor(kevin, "✅ Mei ordered a new blood pressure monitor for Nai Nai", from, 4000);
  const naiDone = await waitFor(nainai, "✅ ", from, 4000);
  check("story: once paid, everyone gets the confirmation", Boolean(kevinDone) && Boolean(naiDone), dump(from));
  check("story: buyer's confirmation carries the Visa invoice number", Boolean(await waitFor(mei, `#visa-inv-${lastInvoice().id}`, from, 2000)), dump(from));
}

server.close();
realLog(failures ? `\nvisaAcceptance.selftest: ${failures} FAILED, ${passes} passed` : `visaAcceptance.selftest: all ${passes} checks passed`);
process.exit(failures ? 1 : 0);
