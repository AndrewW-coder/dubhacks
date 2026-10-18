// Checkout: Bridge buys the product the family picked. Owned by User 2 (spec U2-10b).
//
// FROZEN SIGNATURE: checkout(family, buyer, forMember, product) → OrderResult. Never throws.
// (An optional 5th argument, `opts`, names who asked for the purchase and their words, so the
// scam check can look at them. Callers that don't pass it get the safe default: the requester is
// taken to be `forMember`.)
//
// Steps:
//   1. Validate: price ≥ 0.01, a supported currency (visa.ts rate table), at most MAX_GIFT_USD.
//   2. Scam check (before anything else is asked): if the product text has scam markers
//      (scamSignals), OR an elder is involved (requester / recipient / buyer) and the product is a
//      scam target (gift cards, prepaid cards, crypto, wire/money transfers), a trusted member who
//      is NOT the buyer, NOT the recipient and NOT the requester must approve. Nobody eligible →
//      refused, never self-approved.
//   3. The buyer agrees (spec U2-13, the core rule). Bridge buys only when the BUYER has given an
//      unambiguous yes to THIS product:
//        (a) opts.buyerAgreed: the buyer ❤️/‼️-tapped this option's own card in the vote (the
//            caller decides; a bare letter, a 👍, a timeout winner or "which one?" never counts), or
//        (b) the buyer answers a strict confirmation, "🛒 Buy B · <name> · $39.98 for Nai Nai?",
//            with ❤️ or a strict yes (isYes in flow.ts). "ok?", 👍, silence → nothing is bought.
//      (b) is asked whenever (a) is missing, under the limit too, and ALWAYS over the buyer's
//      limit (`shopLimitUsd` on the buyer, optional, read with a cast until U1's contract commit
//      adds it to types.ts; default SHOP_DEFAULT_LIMIT_USD = 50), even after (a).
//      The who/what/how-much line is never translated (moneyPrompt); the price is shown in the
//      buyer's currency via quote(). claimMoneySlot keeps one money question per member.
//   4. Pay, by SHOP_MODE:
//        mock (default)  fake order id "ord-…", ETA in 3 days (ISO date), charged in the buyer's currency.
//        sandbox         the Visa sandbox via sendGift(buyer → merchant stand-in) for now, keeping
//                        maybeCharged semantics. Needs VISA_MODE=sandbox and the Visa credentials,
//                        otherwise error "shop sandbox not set up …".
//        paylink         a real Visa checkout page (spec U2-16, payments/visaAcceptance.ts, SANDBOX
//                        ONLY: Visa test cards, no real money). Bridge creates a Visa Acceptance
//                        invoice for the exact item and price and texts its hosted payment link to
//                        the buyer. Paying on Visa's page IS the buyer's yes, so step 3's ❤️/yes
//                        question is replaced by the link (the scam check still runs first, and its
//                        warning is shown with the link). Bridge polls the invoice: PAID → ordered;
//                        "no" (or 👎) to the link, or no payment within PAYLINK_TIMEOUT_MS → the
//                        link is canceled and nothing is bought. Bridge never sees card details.
//   5. Errors are plain English. maybeCharged → "may have gone through; check before trying again".
//
// Checkout only messages people it asks (the buyer, a guard). Telling the family about the order
// (or the failure) is the caller's job (shopFlow / trackOrder), using OrderResult.
//
// Settings (read from process.env at call time):
//   SHOP_MODE                mock | paylink | sandbox (default mock)
//   SHOP_DEFAULT_LIMIT_USD   buyer's limit when FamilyMember.shopLimitUsd is unset (default 50)
//   PAYMENT_CONFIRM_TIMEOUT_MS  how long to wait for a yes (shared with flow.ts, default 3 min)
//   PAYLINK_TIMEOUT_MS       paylink: how long the Visa link stays open (default 600000 = 10 min)
//   PAYLINK_POLL_MS          paylink: how often Bridge checks whether it was paid (default 4000)

import { config } from "../config.js";
import { ask, cancel as cancelPrompt, openPrompt, type Answer } from "../relay/prompts.js";
import { claimMoneySlot, confirmTimeoutMs, isYes, moneyPrompt, say } from "../payments/flow.js";
import { formatSignals, GIFT_CARD_MARKERS, isElder, scamSignals, trustedConfirmers } from "../payments/scamCheck.js";
import { formatMoney, isSupportedCurrency, MAX_GIFT_USD, quote, sendGift } from "../payments/visa.js";
import { cancelPayLink, createPayLink, getPayLink, isSandbox } from "../payments/visaAcceptance.js";
import type { Family, FamilyMember, LanguageCode } from "../types.js";

import type { Product } from "./catalog.js";
export type { Product };

export interface OrderResult {
  ok: boolean;
  orderId?: string;
  charged?: { amount: number; currency: string };
  eta?: string; // ISO date, YYYY-MM-DD
  error?: string;
  maybeCharged?: boolean;
}

export interface CheckoutOptions {
  /** Who asked for this purchase (e.g. Nai Nai said "我想买…"). Default: forMember. */
  requester?: FamilyMember;
  /** The requester's own words, also scanned for scam markers. */
  requestText?: string;
  /**
   * True only when the buyer has unambiguously picked THIS product already (a ❤️/‼️ tapback on its
   * own card). Default false: the buyer is asked a strict ❤️/yes confirmation first. Ignored over
   * the buyer's limit, where the confirmation is always asked.
   */
  buyerAgreed?: boolean;
  /** The option's letter on the cards ("B"), shown in the confirmation. */
  letter?: string;
}

export const SHOP_DEFAULT_LIMIT_USD = 50;

/** Swappable for tests (checkout.selftest.ts); production uses visa.ts. */
export const checkoutDeps = { sendGift, createPayLink, getPayLink, cancelPayLink };

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND"]);
const MIN_PRICE = 0.01;
const ETA_DAYS = 3;

// Products scammers ask elders to buy: gift / prepaid / reload cards and codes, crypto, money
// transfers (GIFT_CARD_MARKERS is shared with scamSignals and the catalog).
const SCAM_TARGET_WORDS =
  /\bgift ?cards?\b|\bprepaid\b|\b(reload|top[- ]?up|stored[- ]value|cash) cards?\b|\bvouchers?\b|\b(crypto|bitcoin|btc|usdt|ethereum)\b|\bwire\b|western union|moneygram|money ?order|礼品卡|禮品卡|购物卡|購物卡|充值卡|储值卡|儲值卡|预付卡|預付卡|点数卡|點數卡|比特币|比特幣|加密货币|加密貨幣|虚拟货币|虛擬貨幣|电汇|電匯/i;
const SCAM_TARGET = { test: (t: string) => SCAM_TARGET_WORDS.test(t) || GIFT_CARD_MARKERS.test(t) };
const SCAM_TARGET_TAGS = new Set(["gift-card", "giftcard", "gift card", "egift", "e-gift", "prepaid", "prepaid-card", "reward-card", "digital-code", "pin", "crypto", "voucher", "wire", "money-transfer"]);

function settings() {
  const env = (k: string) => process.env[k]?.trim() ?? "";
  const limit = Number(env("SHOP_DEFAULT_LIMIT_USD"));
  return {
    mode: (["sandbox", "paylink"] as const).find((m) => m === env("SHOP_MODE").toLowerCase()) ?? ("mock" as const),
    defaultLimitUsd: env("SHOP_DEFAULT_LIMIT_USD") && Number.isFinite(limit) && limit >= 0 ? limit : SHOP_DEFAULT_LIMIT_USD,
    visaMode: env("VISA_MODE") || config.visaMode,
  };
}

/**
 * Will checkout ask the buyer a ❤️/yes confirmation before paying? True unless the buyer already
 * agreed unambiguously AND the price is within their limit. Unknown/bad prices → true. Never throws.
 */
export async function buyerMustConfirm(buyer: FamilyMember, product: Product, buyerAgreed = false): Promise<boolean> {
  try {
    if (!buyerAgreed) return true;
    const currency = String(product?.currency ?? "").trim().toUpperCase();
    if (typeof product?.price !== "number" || !isSupportedCurrency(currency)) return true;
    return !((await quote(product.price, currency, "USD")).amount <= shopLimitUsd(buyer));
  } catch {
    return true;
  }
}

/** The buyer's own limit (FamilyMember.shopLimitUsd, arriving from U1), or the default. */
export function shopLimitUsd(buyer: FamilyMember): number {
  const own = (buyer as FamilyMember & { shopLimitUsd?: unknown }).shopLimitUsd;
  return typeof own === "number" && Number.isFinite(own) && own >= 0 ? own : settings().defaultLimitUsd;
}

export async function checkout(
  family: Family,
  buyer: FamilyMember,
  forMember: FamilyMember,
  product: Product,
  opts: CheckoutOptions = {},
): Promise<OrderResult> {
  let paymentStarted = false;
  try {
    return await run(family, buyer, forMember, product, opts, () => { paymentStarted = true; });
  } catch (err) {
    console.error(`[shop] checkout failed unexpectedly: ${(err as Error)?.message ?? err}`);
    return paymentStarted
      ? { ok: false, maybeCharged: true, error: "I couldn't confirm the order. It may have gone through; please check before trying again." }
      : { ok: false, error: "Something went wrong before paying, so nothing was bought." };
  }
}

async function run(
  family: Family, buyer: FamilyMember, forMember: FamilyMember, product: Product, opts: CheckoutOptions, markPaying: () => void,
): Promise<OrderResult> {
  // ── 1. Validate ──────────────────────────────────────────────────────────
  if (!product || typeof product !== "object") return fail("I don't know which product to buy, so nothing was bought.");
  const price = product.price;
  const currency = typeof product.currency === "string" ? product.currency.trim().toUpperCase() : "";
  const buyerCurrency = (buyer.currency ?? "USD").trim().toUpperCase();
  if (typeof price !== "number" || !Number.isFinite(price) || !(price >= MIN_PRICE)) return fail("This product doesn't have a valid price, so nothing was bought.");
  if (!isSupportedCurrency(currency)) return fail(`I can't pay in ${currency || "that currency"} yet, so nothing was bought.`);
  if (!isSupportedCurrency(buyerCurrency)) return fail(`I can't charge a card in ${buyerCurrency} yet, so nothing was bought.`);
  const usd = (await quote(price, currency, "USD")).amount;
  if (!(usd <= MAX_GIFT_USD)) return fail(`That's over the ${formatMoney(MAX_GIFT_USD, "USD")} limit per purchase, so nothing was bought.`);

  const inBuyer = await quote(price, currency, buyerCurrency);
  const chargeAmount = roundFor(inBuyer.amount, buyerCurrency);
  if (!(chargeAmount > 0)) return fail("This product doesn't have a valid price, so nothing was bought.");
  const name = productName(product, buyer.language);
  const priceStr = formatMoney(price, currency);
  const buyerStr = buyerCurrency === currency ? "" : ` (≈ ${formatMoney(approx(chargeAmount), buyerCurrency)})`;
  const merchant = typeof product.merchant === "string" && product.merchant.trim() ? ` · ${product.merchant.trim()}` : "";
  const details = `🛒 ${name} → ${forMember.name} · ${priceStr}${buyerStr}${merchant}`;

  const limit = shopLimitUsd(buyer);
  const overLimit = usd > limit;
  // The core rule: without the buyer's unambiguous pick, always ask; over the limit, always ask.
  const mustConfirm = overLimit || opts.buyerAgreed !== true;
  const requester = opts.requester ?? forMember;
  const letter = typeof opts.letter === "string" && /^[A-Z]$/.test(opts.letter.trim()) ? `${opts.letter.trim()} · ` : "";
  const buyLine = `🛒 Buy ${letter}${name} · ${priceStr}${buyerStr} for ${forMember.name}?${merchant ? ` (${merchant.slice(3)}${overLimit ? ` · limit ${formatMoney(limit, "USD")}` : ""})` : overLimit ? ` (limit ${formatMoney(limit, "USD")})` : ""}`;

  // One money question per member: hold the buyer's slot from here until we're done, so no
  // other money prompt opens for them while a guard is being asked (same rule as flow.ts).
  // paylink: the Visa link is the buyer's question, so their slot is held while it's open.
  const paylink = settings().mode === "paylink";
  let releaseBuyer: (() => void) | undefined;
  if (mustConfirm || paylink) {
    releaseBuyer = claimMoneySlot(buyer);
    if (!releaseBuyer) return fail(`${buyer.name} has another money question from me open. Answer that first, then try again. Nothing was bought.`);
  }
  try {
    // ── 2. Scam check ──────────────────────────────────────────────────────
    const productText = scanText(product);
    const signals = [...new Set([...scamSignals(productText), ...(opts.requestText ? scamSignals(opts.requestText) : [])])];
    const elderInvolved = isElder(requester) || isElder(forMember) || isElder(buyer);
    const target = isScamTarget(product, productText);
    let warning = ""; // set when the buyer approves a flagged purchase themselves
    if (signals.length || (elderInvolved && target)) {
      const reasons = target && !signals.length ? ["is a gift card / prepaid / crypto / money-transfer product: a common scam target"] : signals;
      const approved = await guardApproval(family, buyer, forMember, requester, details, reasons);
      if (approved === "buyer") {
        // Buyer priority: no third trusted member (e.g. a two-person family), and the buyer is a
        // trusted adult paying with their own card. They decide, but always with an explicit
        // confirmation that shows the warning signs (a ❤️ on the card alone isn't enough).
        warning = `⚠️ Please double-check this one:
${formatSignals(reasons)}
`;
        if (!releaseBuyer) {
          releaseBuyer = claimMoneySlot(buyer);
          if (!releaseBuyer) return fail(`${buyer.name} has another money question from me open. Answer that first, then try again. Nothing was bought.`);
        }
      } else if (approved) return approved;
    }

    // ── 3. The buyer agrees (the core rule) ────────────────────────────────
    if (paylink) {
      // Paying on Visa's own page is the buyer's yes: the link replaces the ❤️/yes question.
      return await payByLink(family, buyer, forMember, product, { name, letter, merchant, chargeAmount, buyerCurrency, usdAmount: currency === "USD" ? price : roundFor(usd, "USD"), overLimit, limit, warning }, markPaying);
    }
    if (mustConfirm || warning) {
      const answer = await ask(
        buyer.handle,
        await moneyPrompt(
          buyLine,
          warning +
            (overLimit
              ? `This is over your shopping limit. Buy it? ❤️ or "yes" to confirm, "no" to cancel.`
              : `Should I buy it? ❤️ or "yes" to buy, "no" to cancel.`),
          buyer,
          family,
        ),
        confirmTimeoutMs(),
      );
      if (!answer) return fail(`${buyer.name} didn't answer, so nothing was bought.`);
      if (!isYes(answer)) return fail(`${buyer.name} didn't confirm, so nothing was bought.`);
    }

    // ── 4. Pay ─────────────────────────────────────────────────────────────
    markPaying();
    return await pay(buyer, product, currency, chargeAmount, buyerCurrency);
  } finally {
    releaseBuyer?.();
  }
}

/**
 * Asks a trusted member to OK a risky purchase. Returns a refusal, undefined when approved, or
 * "buyer" when nobody else can approve and the buyer may decide (with a warning) themselves.
 */
async function guardApproval(
  family: Family, buyer: FamilyMember, forMember: FamilyMember, requester: FamilyMember, details: string, reasons: string[],
): Promise<OrderResult | "buyer" | undefined> {
  // Never the buyer, the recipient or the requester (nobody approves their own purchase).
  const eligible = trustedConfirmers(family, requester, forMember).filter((m) => m.id !== buyer.id);
  if (!eligible.length) {
    // Buyer priority: a trusted, non-elder buyer pays with their own card, so they can decide.
    // An elder or untrusted buyer is still refused (the scam this guards against coaches elders).
    if (buyer.isTrustedForMoney && !isElder(buyer)) return "buyer";
    return fail(`Purchases like this need a trusted family member (not the buyer or ${forMember.name}) to OK them first, and there isn't one set up. Nothing was bought.`);
  }
  let guard: FamilyMember | undefined;
  let release: (() => void) | undefined;
  for (const m of eligible) {
    release = claimMoneySlot(m);
    if (release) { guard = m; break; }
  }
  if (!guard || !release) return fail(`${eligible[0]!.name} is answering another question from me right now. Please try again in a few minutes. Nothing was bought.`);

  let answer: Answer | null;
  try {
    await say(buyer, `I'm checking with ${guard.name} first, to keep the family safe.`, family);
    answer = await ask(
      guard.handle,
      await moneyPrompt(
        `🛡️ ${details} · ${buyer.name} pays`,
        `This purchase needs your OK first.\n${formatSignals(reasons)}\nDoes this look right? ❤️ or "yes" to allow, "no" to stop.`,
        guard,
        family,
      ),
      confirmTimeoutMs(),
    );
  } finally {
    release();
  }
  if (isYes(answer)) return undefined;
  await say(guard, answer ? "OK, I stopped it. Nothing was bought." : `No answer, so I didn't buy it.`, family);
  return fail(answer ? `${guard.name} didn't approve, so nothing was bought.` : `${guard.name} didn't answer, so nothing was bought.`);
}

async function pay(buyer: FamilyMember, product: Product, productCurrency: string, amount: number, currency: string): Promise<OrderResult> {
  const s = settings();
  if (s.mode === "mock") {
    const eta = new Date(Date.now() + ETA_DAYS * 86_400_000).toISOString().slice(0, 10);
    return { ok: true, orderId: `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, charged: { amount, currency }, eta };
  }

  // VISA-BOOTH: this is where the booth's recommended purchase API plugs in (e.g. Visa Intelligent
  // Commerce: a tokenized credential the agent pays with, under the cardholder's limit). Until
  // then, the sandbox path is a Visa Direct push to a merchant stand-in, which proves the money
  // moves through Visa but is NOT a real card purchase.
  if (s.visaMode !== "sandbox") {
    return fail("shop sandbox not set up (SHOP_MODE=sandbox needs VISA_MODE=sandbox and the Visa credentials). Nothing was bought.");
  }
  const merchant: FamilyMember = {
    id: "merchant", name: product.merchant || "Merchant", handle: "", language: "en", relationship: "merchant",
    isBilingualReviewer: false, currency: productCurrency,
  };
  const r = await checkoutDeps.sendGift(buyer, merchant, amount, currency);
  if (r.ok) {
    const eta = new Date(Date.now() + ETA_DAYS * 86_400_000).toISOString().slice(0, 10);
    return { ok: true, orderId: `ord-visa-${r.transactionId ?? Date.now().toString(36)}`, charged: { amount: r.amountSent, currency: r.sentCurrency }, eta };
  }
  if (r.maybeCharged) {
    return { ok: false, maybeCharged: true, error: `I couldn't confirm the payment (${r.error ?? "no answer from Visa"}). It may have gone through; please check before trying again.` };
  }
  if (/isn't set up/i.test(r.error ?? "")) return fail(`shop sandbox not set up (${r.error}). Nothing was bought.`);
  return fail(`The payment didn't go through: ${r.error ?? "unknown error"}. Nothing was charged.`);
}

// ── paylink: a real Visa checkout page (spec U2-16) ─────────────────────────

interface LinkInfo {
  name: string;
  letter: string; // "B · " or ""
  merchant: string; // " · Store" or ""
  chargeAmount: number; // in the buyer's currency (shown as ≈)
  buyerCurrency: string;
  usdAmount: number; // what the Visa invoice charges
  overLimit: boolean;
  limit: number;
  warning: string;
}

// Threaded replies to the link can say any of these; a bare (unthreaded) answer only reaches the
// link when prompts.ts sees it as a short answer ("no", "n", "cancel", "不"), hence "reply to this message".
const NO_ANSWER = /^\s*(n|no|nope|nah|cancel|stop|不|不要|不用|不买|不買|取消|算了)\s*[.!。！]?\s*$/i;
const isNoAnswer = (a: Answer) => (a.via === "tapback" ? a.tapback === "dislike" : NO_ANSWER.test(a.text ?? ""));

function linkTimeoutMs(): number {
  const n = Number(process.env.PAYLINK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60_000;
}
function linkPollMs(): number {
  const n = Number(process.env.PAYLINK_POLL_MS);
  return Number.isFinite(n) && n > 0 ? n : 4_000;
}

async function payByLink(
  family: Family, buyer: FamilyMember, forMember: FamilyMember, product: Product, info: LinkInfo, markPaying: () => void,
): Promise<OrderResult> {
  // Invoiced in USD: Visa sandbox merchants are normally set up for USD only. A buyer with another
  // currency sees the approximate amount in theirs too.
  const amountStr = formatMoney(info.usdAmount, "USD") + (info.buyerCurrency === "USD" ? "" : ` (≈ ${formatMoney(approx(info.chargeAmount), info.buyerCurrency)})`);
  const reference = `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const created = await checkoutDeps.createPayLink({
    reference,
    description: `${productName(product, "en")} for ${forMember.name} (Bridge family shopping)`,
    productName: productName(product, "en"),
    productSku: typeof product.id === "string" ? product.id : undefined,
    amount: info.usdAmount,
    currency: "USD",
    customerName: buyer.name,
  });
  if (!created.ok) return fail(`I couldn't make the Visa payment link (${created.error}). Nothing was bought.`);

  const timeoutMs = linkTimeoutMs();
  let saidNo = false;
  let messageId: string | undefined;
  try {
    const limitNote = info.overLimit ? ` (over your ${formatMoney(info.limit, "USD")} limit)` : "";
    const testNote = isSandbox() ? " Visa test mode: use a test card, no real money." : "";
    const prompt = await moneyPrompt(
      `💳 ${info.letter}${info.name} · ${amountStr} for ${forMember.name}${info.merchant}`,
      `${info.warning}To buy it${limitNote}, pay on Visa's secure checkout page below and I'll order it as soon as it's paid. To cancel, reply "no" to this message or 👎 it.${testNote}`,
      buyer,
      family,
    );
    // The link alone on the last line, so iMessage previews it. Only "no"/👎 answers this message;
    // anything else the buyer writes is relayed as normal chat.
    const opened = await openPrompt(buyer.handle, `${prompt}\n${created.url}`, { timeoutMs: timeoutMs + 5_000, accept: isNoAnswer });
    messageId = opened.messageId;
    void opened.answer.then((a) => { if (a && isNoAnswer(a)) saidNo = true; });
  } catch (err) {
    // The link never reached the buyer: withdraw it so it can't be paid by accident.
    console.error(`[shop] couldn't send the Visa link: ${(err as Error)?.message ?? err}`);
    return (await closeLink(created.id))
      ? fail("I couldn't send the Visa payment link, so I canceled it. Nothing was bought.")
      : { ok: false, maybeCharged: true, error: "I couldn't send the Visa payment link or confirm it was closed. Please check before trying again." };
  }
  markPaying(); // the buyer has the link: from here an unexpected error must say "may have gone through"

  try {
    const end = Date.now() + timeoutMs;
    while (!saidNo && Date.now() < end) {
      await sleep(Math.min(linkPollMs(), Math.max(0, end - Date.now())));
      if (saidNo) break;
      const st = await checkoutDeps.getPayLink(created.id);
      if (!st.ok) continue; // a blip: keep checking until the link times out
      if (st.status === "PAID") return paidOrder(created.id, info);
      if (st.status === "CANCELED") return fail(`The Visa payment link was canceled, so nothing was bought.`);
    }
    // "no" or timed out: withdraw the link (retrying), then look once more in case it was paid.
    const why = saidNo ? `${buyer.name} said no` : `${buyer.name} didn't pay within ${Math.max(1, Math.round(timeoutMs / 60_000))} min`;
    const closed = await closeLink(created.id);
    const final = await checkoutDeps.getPayLink(created.id);
    if (final.ok && final.status === "PAID") return paidOrder(created.id, info);
    if (closed || (final.ok && final.status === "CANCELED")) return fail(`${why}, so I canceled the Visa link and nothing was bought.`);
    // Not confirmed closed: the link may still be payable, so never say "nothing was charged".
    return { ok: false, maybeCharged: true, error: `${why}, but I couldn't close the Visa link. Please don't pay it, and check before trying again.` };
  } finally {
    if (messageId) cancelPrompt(messageId);
  }
}

/** Cancels an invoice, retrying a few times. True once Visa confirms it's canceled. */
async function closeLink(id: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if (await checkoutDeps.cancelPayLink(id)) return true;
    const st = await checkoutDeps.getPayLink(id);
    if (st.ok && (st.status === "CANCELED" || st.status === "PAID")) return st.status === "CANCELED";
    await sleep(200 * (i + 1));
  }
  return false;
}

function paidOrder(invoiceId: string, info: LinkInfo): OrderResult {
  const eta = new Date(Date.now() + ETA_DAYS * 86_400_000).toISOString().slice(0, 10);
  return { ok: true, orderId: `visa-inv-${invoiceId}`, charged: { amount: info.usdAmount, currency: "USD" }, eta };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fail(error: string): OrderResult {
  return { ok: false, error };
}

function productName(p: Product, language: LanguageCode): string {
  const names = p.name && typeof p.name === "object" ? p.name : {};
  return (names[language] ?? names.en ?? Object.values(names)[0] ?? p.id ?? "the item").toString().trim();
}

/** Everything a scammer could hide in, minus links: search results always have a product URL. */
function scanText(p: Product): string {
  const names = p.name && typeof p.name === "object" ? Object.values(p.name) : [];
  return [...names, ...(Array.isArray(p.tags) ? p.tags : []), p.description ?? "", p.merchant ?? ""]
    .filter((x) => typeof x === "string")
    .join(" \n ")
    .replace(/https?:\/\/\S+|\bwww\.\S+/gi, " ");
}

function isScamTarget(p: Product, text: string): boolean {
  return SCAM_TARGET.test(text) || (Array.isArray(p.tags) && p.tags.some((t) => SCAM_TARGET_TAGS.has(String(t).toLowerCase())));
}

/** An estimate ("≈") shows no fake precision: whole units from 10 up. */
function approx(amount: number): number {
  return amount >= 10 ? Math.round(amount) : amount;
}

function roundFor(amount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency) ? Math.round(amount) : Math.round(amount * 100) / 100;
}
