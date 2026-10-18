// Offline self-test for checkout().
//   npx tsx src/shop/checkout.selftest.ts
// Mock photon, mock Visa, no API keys. Exits non-zero on failure.

process.env.PHOTON_MODE = "mock";
process.env.VISA_MODE = "mock";
process.env.ANTHROPIC_API_KEY = "";
process.env.TRANSLATE_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "";
process.env.GEMINI_API_KEY = "";
delete process.env.SHOP_MODE;
delete process.env.SHOP_DEFAULT_LIMIT_USD;
delete process.env.PAYMENT_CONFIRM_TIMEOUT_MS;

const lines: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
console.warn = () => {};
console.error = () => {};

const { getFamilyByHandle, getAllMembers } = await import("../db/store.js");
const { tryResolvePrompt } = await import("../relay/prompts.js");
const { claimMoneySlot, hasOpenMoneyPrompt, resetMoneySlotsForTests } = await import("../payments/flow.js");
const { checkout, checkoutDeps, shopLimitUsd, buyerMustConfirm, SHOP_DEFAULT_LIMIT_USD } = await import("./checkout.js");
const { scamSignals } = await import("../payments/scamCheck.js");
import type { FamilyMember, IncomingMessage, TapbackKind } from "../types.js";
import type { OrderResult, Product } from "./checkout.js";
import type { GiftResult } from "../payments/visa.js";

const members = getAllMembers();
const m = (id: string) => members.find((x) => x.id === id)!;
const kevin = m("kevin"), mei = m("mei"), nainai = m("nainai");
const family = getFamilyByHandle(kevin.handle)!;

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passes++;
  else { failures++; realLog(`✗ ${name}${detail ? `\n    ${detail}` : ""}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phone = (who: FamilyMember) => (l: string) => l.includes(`📱 ${who.name.padEnd(10)}`);
const dump = (from: number) => lines.slice(from).join("\n    ");
const saw = (who: FamilyMember, text: string, from: number) => lines.slice(from).some((l) => phone(who)(l) && l.includes(text));
const toWho = (who: FamilyMember, from: number) => lines.slice(from).filter(phone(who));

/** Waits for a new line to `who` containing `text`; returns its Bridge message id ("b12"). */
async function waitFor(who: FamilyMember, text: string, from: number, ms = 3000): Promise<string | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const l = lines.slice(from).find((x) => phone(who)(x) && x.includes(text));
    if (l) return l.match(/#(b\d+)/)?.[1] ?? "?";
    await sleep(15);
  }
  return undefined;
}

let seq = 0;
const text = (from: FamilyMember, t: string): IncomingMessage => ({ id: `u${++seq}`, fromHandle: from.handle, kind: "text", text: t, receivedAt: new Date() });
const tap = (from: FamilyMember, id: string, tb: TapbackKind): IncomingMessage => ({ id, fromHandle: from.handle, kind: "tapback", tapback: tb, receivedAt: new Date() });

const product = (over: Partial<Product> = {}): Product => ({
  id: "bp-1", name: { en: "Large-display blood pressure monitor", zh: "大屏血压计" }, price: 30, currency: "USD",
  merchant: "Harbor Health (demo)", shipsTo: ["TW"], tags: ["health", "elder-friendly"],
  url: "https://example.com/bp-1", description: "Big digits, one button, voice readout.", ...over,
});

type Reply = string | { tapback: TapbackKind } | null; // null = don't answer (timeout)
/** Runs a checkout and answers each [member, prompt-substring, reply] in order. */
async function run(buyer: FamilyMember, forMember: FamilyMember, p: Product, steps: [FamilyMember, string, Reply][] = [], opts?: Parameters<typeof checkout>[4]) {
  const from = lines.length;
  const pr = checkout(family, buyer, forMember, p, opts);
  for (const [who, q, reply] of steps) {
    const id = await waitFor(who, q, from);
    check(`${who.name} is asked "${q}"`, !!id, dump(from));
    if (!id || reply === null) continue;
    const ok = typeof reply === "string" ? tryResolvePrompt(text(who, reply)) || tryResolvePrompt({ ...text(who, reply), replyToId: id }) : tryResolvePrompt(tap(who, id, reply.tapback));
    check(`${who.name}'s ${JSON.stringify(reply)} reaches the prompt`, ok);
  }
  const r: OrderResult = await pr;
  return { r, from };
}
const iso3Days = () => new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

// ── Limit ──────────────────────────────────────────────────────────────────
check("default limit 50", SHOP_DEFAULT_LIMIT_USD === 50 && shopLimitUsd(kevin) === 50);
check("buyer's own shopLimitUsd wins", shopLimitUsd({ ...kevin, shopLimitUsd: 120 } as FamilyMember) === 120);

// The buyer already ❤️'d this product's card (opts.buyerAgreed): under the limit, no prompt.
const AGREED = { buyerAgreed: true };
{
  const { r, from } = await run(kevin, nainai, product(), [], AGREED);
  check("under limit: ok", r.ok, JSON.stringify(r));
  check("under limit: mock order id + 3-day ETA", /^ord-/.test(r.orderId ?? "") && r.eta === iso3Days(), JSON.stringify(r));
  check("under limit: charged $30 USD", r.charged?.amount === 30 && r.charged.currency === "USD", JSON.stringify(r));
  check("under limit: no prompt to anyone", lines.length === from, dump(from));
}
{
  const { r } = await run(kevin, nainai, product({ price: 1288, currency: "TWD" }), [], AGREED); // ≈ $40
  check("TWD product, USD buyer: charged in USD", r.ok && r.charged?.currency === "USD" && Math.abs(r.charged.amount - 40) < 0.01, JSON.stringify(r));
}
{
  const { r, from } = await run({ ...kevin, shopLimitUsd: 100 } as FamilyMember, nainai, product({ price: 80 }), [], AGREED);
  check("$80 under a $100 personal limit: no prompt", r.ok && lines.length === from, dump(from));
}

// ── The core rule: under the limit too, no unambiguous pick → the buyer must say ❤️/yes ────────
{
  const QU = "🛒 Buy B · Large-display blood pressure monitor · $30 for Nai Nai?";
  for (const [reply, buys] of [["yes", true], [{ tapback: "love" }, true], ["是", true], ["ok?", false], ["no", false], [{ tapback: "like" }, false], ["yes please", false]] as [Reply, boolean][]) {
    const { r, from } = await run(kevin, nainai, product(), [[kevin, QU, reply]], { letter: "B" });
    check(`under limit, no pick + ${JSON.stringify(reply)} → ${buys ? "bought" : "not bought"}`, r.ok === buys && (buys || /nothing was bought/i.test(r.error ?? "")), JSON.stringify(r) + "\n    " + dump(from));
  }
  // Callers that pass no options get the safe default: asked first.
  const from = lines.length;
  const pr = checkout(family, kevin, nainai, product());
  check("no opts → the buyer is asked before buying", !!(await waitFor(kevin, "🛒 Buy Large-display blood pressure monitor · $30 for Nai Nai?", from)), dump(from));
  check("…with ❤️ or yes in the question", saw(kevin, `❤️ or "yes" to buy`, from), dump(from));
  tryResolvePrompt(text(kevin, "no"));
  check("…and 'no' buys nothing", !(await pr).ok);
  process.env.PAYMENT_CONFIRM_TIMEOUT_MS = "150";
  const { r: rt } = await run(kevin, nainai, product(), [[kevin, "🛒 Buy", null]]);
  delete process.env.PAYMENT_CONFIRM_TIMEOUT_MS;
  check("under limit, no pick + silence → not bought", !rt.ok && /didn't answer/.test(rt.error ?? ""), JSON.stringify(rt));
  check("buyerMustConfirm: no pick → true", (await buyerMustConfirm(kevin, product(), false)) === true);
  check("buyerMustConfirm: picked, under limit → false", (await buyerMustConfirm(kevin, product(), true)) === false);
  check("buyerMustConfirm: picked, over limit → true", (await buyerMustConfirm(kevin, product({ price: 80 }), true)) === true);
}

// Over the limit: only a strict yes buys, even when the buyer ❤️'d the card.
const over = product({ price: 80 });
const Q = "🛒 Buy Large-display blood pressure monitor · $80 for Nai Nai?";
for (const [reply, buys] of [["yes", true], [{ tapback: "love" }, true], ["ok?", false], ["no", false], [{ tapback: "like" }, false]] as [Reply, boolean][]) {
  const { r, from } = await run(kevin, nainai, over, [[kevin, Q, reply]], AGREED);
  check(`over limit + ${JSON.stringify(reply)} → ${buys ? "bought" : "not bought"}`, r.ok === buys && (buys ? /^ord-/.test(r.orderId ?? "") : !r.orderId && /nothing was bought/i.test(r.error ?? "")), JSON.stringify(r) + "\n    " + dump(from));
}
{
  const from = lines.length;
  await run(kevin, nainai, over, [[kevin, Q, "yes"]]);
  check("prompt shows the limit, untranslated details line", saw(kevin, "limit $50", from) && saw(kevin, "Harbor Health (demo)", from), dump(from));
}
{
  // Chinese buyer: details line in her currency and not translated; the sentence is translated.
  const nnBuyer = { ...nainai, isTrustedForMoney: true } as FamilyMember;
  const { r, from } = await run(nnBuyer, kevin, product({ price: 80 }), [[nainai, "🛒 Buy 大屏血压计 · $80 (≈ NT$2,576) for Kevin?", "是"]]);
  check("zh buyer: price in TWD, strict yes 是 buys, charged TWD", r.ok && r.charged?.currency === "TWD" && r.charged.amount === 2576, JSON.stringify(r) + "\n    " + dump(from));
  check("zh buyer: the sentence is translated", saw(nainai, "[en→zh]", from), dump(from));
}
{
  process.env.PAYMENT_CONFIRM_TIMEOUT_MS = "150";
  const { r } = await run(kevin, nainai, over, [[kevin, Q, null]]);
  delete process.env.PAYMENT_CONFIRM_TIMEOUT_MS;
  check("over limit + timeout → not bought", !r.ok && /didn't answer/.test(r.error ?? ""), JSON.stringify(r));
  check("slot released after timeout", !hasOpenMoneyPrompt(kevin));
}

// ── Validation ─────────────────────────────────────────────────────────────
for (const [label, p, re] of [
  ["unsupported currency", product({ currency: "XYZ" }), /can't pay in XYZ/],
  ["over the $1,000 cap", product({ price: 1500 }), /\$1,000 limit/],
  ["zero price", product({ price: 0 }), /valid price/],
  ["NaN price", product({ price: NaN }), /valid price/],
  ["price under 0.01", product({ price: 0.001 }), /valid price/],
  ["negative price", product({ price: -5 }), /valid price/],
] as [string, Product, RegExp][]) {
  const from = lines.length;
  const r = await checkout(family, kevin, nainai, p, AGREED);
  check(`refused: ${label}`, !r.ok && re.test(r.error ?? "") && !r.maybeCharged && lines.length === from, JSON.stringify(r));
}
{
  const r = await checkout(family, { ...kevin, currency: "ZZZ" }, nainai, product());
  check("refused: buyer currency unsupported", !r.ok && /ZZZ/.test(r.error ?? ""), JSON.stringify(r));
  const r2 = await checkout(family, kevin, nainai, null as unknown as Product);
  check("never throws on a bad product", !r2.ok && !!r2.error, JSON.stringify(r2));
}

// ── Scam protection ────────────────────────────────────────────────────────
const giftCard = product({ id: "gc", name: { en: "Apple gift card $25" }, price: 25, tags: ["gift-card"], description: "" });
{
  const { r, from } = await run(kevin, nainai, giftCard, [[mei, "🛡️", "no"]]);
  check("gift card for an elder: guard (Mei) refuses → not bought", !r.ok && /Mei didn't approve/.test(r.error ?? ""), JSON.stringify(r) + "\n    " + dump(from));
  check("guard sees the reason", saw(mei, "gift cards", from), dump(from));
}
{
  const { r } = await run(kevin, nainai, giftCard, [[mei, "🛡️", "yes"]], AGREED);
  check("gift card: guard approves → bought (under the limit, buyer already picked it)", r.ok, JSON.stringify(r));
  const { r: r2 } = await run(kevin, nainai, giftCard, [[mei, "🛡️", "yes"], [kevin, "🛒 Buy", "no"]]);
  check("gift card: guard approves, buyer says no → not bought", !r2.ok, JSON.stringify(r2));
}
{
  process.env.PAYMENT_CONFIRM_TIMEOUT_MS = "150";
  const { r } = await run(kevin, nainai, giftCard, [[mei, "🛡️", null]]);
  delete process.env.PAYMENT_CONFIRM_TIMEOUT_MS;
  check("gift card: guard silent → not bought", !r.ok && /didn't answer/.test(r.error ?? ""), JSON.stringify(r));
}
{
  const from = lines.length;
  const r = await checkout(family, mei, nainai, giftCard); // Mei is the only trusted member, and she's the buyer
  check("gift card, buyer is the only trusted member → refused, never self-approved", !r.ok && /trusted family member/.test(r.error ?? "") && !toWho(mei, from).length, JSON.stringify(r));
}
{
  // Gift cards are scam markers even for a non-elder.
  const from = lines.length;
  const r = await checkout(family, kevin, mei, giftCard);
  check("gift card for Mei: Mei can't approve her own → refused, nobody asked", !r.ok && /trusted family member/.test(r.error ?? "") && !toWho(mei, from).length, JSON.stringify(r));
}
const prepaid = product({ id: "pp", name: { en: "Prepaid Visa card" }, price: 40, tags: ["card"], description: "" });
{
  const from = lines.length;
  const r = await checkout(family, kevin, m("mei"), prepaid, AGREED);
  // M-4: "prepaid" is a scam marker for everyone now; Mei can't OK her own, so it's refused.
  check("prepaid card, no elder involved: still a scam marker → refused without a guard", !r.ok && /trusted family member/.test(r.error ?? "") && !toWho(mei, from).length, JSON.stringify(r) + "\n    " + dump(from));
  const { r: r2 } = await run(kevin, nainai, prepaid, [[mei, "🛡️", "no"]]);
  check("prepaid card for an elder: needs a guard", !r2.ok, JSON.stringify(r2));
  const { r: r3 } = await run(kevin, kevin, prepaid, [[mei, "🛡️", "no"]], { requester: nainai });
  check("prepaid card requested BY an elder: needs a guard", !r3.ok, JSON.stringify(r3));
}
{
  const { r } = await run(kevin, nainai, product(), [[mei, "🛡️", "no"]], { requester: nainai, requestText: "快点买，不要告诉Kevin" });
  check("scam words in the request text → guard", !r.ok && /didn't approve/.test(r.error ?? ""), JSON.stringify(r));
  const from = lines.length;
  const r2 = await checkout(family, kevin, nainai, product({ description: "Order at https://shady.xyz/deal for more" }), AGREED);
  check("a link in the description alone is not a scam marker", r2.ok && lines.length === from, JSON.stringify(r2));
}
{
  // Over the limit AND risky: guard first, then the buyer.
  const { r, from } = await run(kevin, nainai, product({ name: { en: "Gift card bundle" }, price: 90 }), [[mei, "🛡️", "yes"], [kevin, "🛒 Buy Gift card bundle", "yes"]], AGREED);
  check("risky + over limit: guard then buyer, both yes → bought", r.ok, JSON.stringify(r) + "\n    " + dump(from));
}

// ── M-4: every gift-card / prepaid / code string from the review (p4) is a scam marker ──────
{
  const P4 = [
    "Amazon.com eGift Card", "Target eGift Card $50", "Steam Wallet Code $50 (Digital)", "Google Play $25 Code", "Razer Gold PIN 50 USD",
    "Apple App Store & iTunes $50", "Netflix gift-card $30", "Vanilla Visa $50 Reward Card", "Bitcoin ATM voucher", "iTunes 卡 50", "Apple 卡",
    "PlayStation Store $50 Digital Code", "我想买预付卡", "帮我买Apple卡", "我想买iTunes卡", "我想买点卡", "我想买Steam充值码",
    "buy grandma some prepaid cards", "buy Nai Nai a Visa reward card", "帮我买礼品卡", "buy me $500 of gift cards", "購物卡", "充值卡",
  ];
  for (const n of P4) check(`scam marker: ${n}`, scamSignals(n).length > 0, JSON.stringify(scamSignals(n)));
  for (const n of P4.slice(0, 12)) {
    const from = lines.length;
    // Mei (the only trusted member) buys for Nai Nai, asked by Nai Nai: nobody eligible to OK it.
    const r = await checkout(family, mei, nainai, product({ id: "x", name: { en: n }, price: 40, tags: [], description: "" }), { requester: nainai, requestText: "我想买", buyerAgreed: true });
    check(`checkout refuses "${n}" with no eligible guard`, !r.ok && /trusted family member/.test(r.error ?? "") && lines.length === from, JSON.stringify(r));
  }
  for (const n of ["steam basket", "vanilla cookies", "Apple pie tin", "Large-display blood pressure monitor", "我想买点卡片"]) check(`not a scam marker: ${n}`, scamSignals(n).length === 0, JSON.stringify(scamSignals(n)));
}

// ── One money question per buyer ───────────────────────────────────────────
{
  resetMoneySlotsForTests();
  const release = claimMoneySlot(kevin)!;
  const from = lines.length;
  const r = await checkout(family, kevin, nainai, over, AGREED);
  release();
  check("buyer with an open money question: over-limit checkout refused, no 2nd prompt", !r.ok && /another money question/.test(r.error ?? "") && !toWho(kevin, from).length, JSON.stringify(r));
}
{
  const from = lines.length;
  const first = checkout(family, kevin, nainai, over, AGREED);
  await waitFor(kevin, Q, from);
  const second = await checkout(family, kevin, nainai, over, AGREED);
  check("two over-limit checkouts at once: the second is refused", !second.ok && /another money question/.test(second.error ?? ""), JSON.stringify(second));
  check("…and only one prompt was sent", toWho(kevin, from).length === 1, dump(from));
  tryResolvePrompt(text(kevin, "no"));
  check("the first one still works", !(await first).ok && !hasOpenMoneyPrompt(kevin));
}
{
  resetMoneySlotsForTests();
  const release = claimMoneySlot(mei)!;
  const r = await checkout(family, kevin, nainai, giftCard, AGREED);
  release();
  check("busy guard → refused with a clear message", !r.ok && /answering another question/.test(r.error ?? ""), JSON.stringify(r));
}

// ── Sandbox ────────────────────────────────────────────────────────────────
process.env.SHOP_MODE = "sandbox";
{
  const r = await checkout(family, kevin, nainai, product(), AGREED);
  check("sandbox with VISA_MODE=mock → 'shop sandbox not set up'", !r.ok && /shop sandbox not set up/.test(r.error ?? "") && !r.maybeCharged, JSON.stringify(r));
  process.env.VISA_MODE = "sandbox";
  for (const k of ["VISA_USER_ID", "VISA_PASSWORD", "VISA_CERT_PATH", "VISA_KEY_PATH", "VISA_TEST_RECIPIENT_PAN"]) process.env[k] = "";
  const r2 = await checkout(family, kevin, nainai, product(), AGREED);
  check("sandbox without Visa credentials → 'shop sandbox not set up'", !r2.ok && /shop sandbox not set up/.test(r2.error ?? "") && !r2.maybeCharged, JSON.stringify(r2));

  const real = checkoutDeps.sendGift;
  let seen: [string, string, number, string] | undefined;
  checkoutDeps.sendGift = async (f, t, amount, currency): Promise<GiftResult> => {
    seen = [f.id, t.name, amount, currency];
    return { ok: true, amountSent: amount, sentCurrency: currency, amountReceived: amount, receivedCurrency: currency, transactionId: "txn-test-001" };
  };
  const r3 = await checkout(family, kevin, nainai, product(), AGREED);
  check("sandbox success → ord-visa-<txn>, charged in the buyer's currency", r3.ok && r3.orderId === "ord-visa-txn-test-001" && r3.charged?.amount === 30 && r3.eta === iso3Days(), JSON.stringify(r3));
  check("sandbox pays the merchant stand-in", seen?.[0] === "kevin" && seen[1] === "Harbor Health (demo)" && seen[3] === "USD", JSON.stringify(seen));

  checkoutDeps.sendGift = async (_f, _t, amount, currency): Promise<GiftResult> => ({ ok: false, amountSent: amount, sentCurrency: currency, amountReceived: 0, receivedCurrency: currency, error: "Visa didn't answer in time (timeout)", maybeCharged: true });
  const r4 = await checkout(family, kevin, nainai, product(), AGREED);
  check("maybeCharged kept, 'may have gone through; check before trying again'", !r4.ok && r4.maybeCharged === true && /may have gone through; please check before trying again/.test(r4.error ?? ""), JSON.stringify(r4));

  checkoutDeps.sendGift = async (_f, _t, amount, currency): Promise<GiftResult> => ({ ok: false, amountSent: amount, sentCurrency: currency, amountReceived: 0, receivedCurrency: currency, error: "declined by the card's bank" });
  const r5 = await checkout(family, kevin, nainai, product(), AGREED);
  check("declined → plain error, nothing charged", !r5.ok && !r5.maybeCharged && /declined by the card's bank.*Nothing was charged/.test(r5.error ?? ""), JSON.stringify(r5));

  checkoutDeps.sendGift = async () => { throw new Error("boom"); };
  const r6 = await checkout(family, kevin, nainai, product(), AGREED);
  check("a throw during payment → never throws, maybeCharged", !r6.ok && r6.maybeCharged === true, JSON.stringify(r6));
  checkoutDeps.sendGift = real;
  process.env.VISA_MODE = "mock";
}
delete process.env.SHOP_MODE;

realLog(`checkout selftest: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
