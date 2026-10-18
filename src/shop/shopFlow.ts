// The family shopping conversation. Owned by User 2 (spec U2-10c, steps 1–6 of "The conversation"
// in U2-10-shopping.md).
//
//   tryHandleShopping(family, sender, msg) is called by payments/flow.ts for every text that
//   isn't a money gift. It returns true ONLY for an explicit command to Bridge ("find Nai Nai a
//   blood pressure monitor", "buy grandma a heater", "Bridge，帮奶奶找个血压计") once options were
//   found and the cards are going out; that message is then not relayed. An emergency ("order an
//   ambulance for grandma, she fell") returns false at once and never shops. No options, a busy
//   family, or anything else ("我想买个血压计", "我的血压计坏了") returns false (relayed as chat);
//   natural messages run the shopping flow in the background.
//   shopForNeed(family, sender, text) is the background flow; needs.ts awaits it too, so a buyable
//   need gets cards instead of the money offer (and the money offer when nothing fits).
//
// One decision:
//   1. detectShoppingNeed → findOptions (top 3)                                     [catalog.ts]
//   2. a heading, then one card per option, in each reader's language: letter, name, price in the
//      reader's currency, merchant, summary + why, and the link ALONE on the last line (never
//      translated, so iMessage previews it), or "demo product" when there's no link
//   3. familyVote over every member (U1's, or the stand-in in u1.ts); chat flows freely meanwhile
//   2b. 1–3 options (findOptions may return fewer than 3): letters, legend and votes follow the count
//   4. winner → buyer (the requester if they're not an elder and not the recipient, else a member
//      trusted for money, else the first non-elder) → checkout() (the scam check and the buyer's
//      ❤️/yes confirmation live in checkout.ts) → nobody voted: the buyer picks a letter
//   THE CORE RULE (spec U2-13): Bridge buys only after the BUYER's unambiguous yes to that
//      product: their ❤️/‼️ on the winning option's own card (VoteResult.how = "card"), or a strict
//      ❤️/yes to "🛒 Buy B · … · $39.98 for Nai Nai?". A bare letter, a 👍, a timeout winner or the
//      "which one?" fallback is never enough; over the limit the confirmation is always asked.
//   5. trackOrder (U1's, or the stand-in): "Kevin bought you a gift 🎁" for a gift occasion,
//      else "Mei ordered a new blood pressure monitor for Nai Nai", in each language
//   6. one open decision per family; every failure ends with a clear message and nothing ordered
//
// No settings of its own (SHOP_VOTE_TIMEOUT_MS is read in u1.ts).

import { sendText } from "../photon/client.js";
import { ask } from "../relay/prompts.js";
import { BRIDGE } from "../relay/say.js";
import { translate } from "../translate/translator.js";
import { isEmergency } from "../translate/confidence.js";
import { localize, paymentFailedText, say } from "../payments/flow.js";
import { isMoneyOnlyNeed } from "../payments/needs.js";
import { isElder, scamSignals, trustedConfirmers } from "../payments/scamCheck.js";
import { formatMoney, isSupportedCurrency, quote } from "../payments/visa.js";
import { detectShoppingNeed, findOptions, type Option, type Product, type ShoppingNeed } from "./catalog.js";
import { buyerMustConfirm, checkout } from "./checkout.js";
import { familyVote, parseVote, passOn, trackOrder, voteTimeoutMs, type VoteCard } from "./u1.js";
import type { Family, FamilyMember, IncomingMessage } from "../types.js";

/** Swappable for tests (shopFlow.selftest.ts). */
export const shopDeps = { detectShoppingNeed, findOptions, checkout, familyVote, trackOrder };

const LETTERS = ["A", "B", "C", "D"];
const ICONS = ["👍", "❤️", "😂", "‼️"];
const MAX_OPTIONS = 3;
/** Same message seen twice (flow.ts + needs.ts) → one detection. */
const DETECTION_TTL_MS = 60_000;
/** Let the relayed message land in everyone's thread before the cards appear under it. */
const CARDS_DELAY_MS = 250;
/** An explicit command waits at most this long for its cards to start going out. */
const CARDS_OUT_MAX_MS = 15_000;

// Calls for help that isConfirmed-emergency (translate/confidence.ts) may miss: never shopping.
// "order an ambulance for grandma now, she fell" is relayed as chat, never claimed by Bridge.
const URGENT_HELP =
  /\b(ambulance|paramedics?|911|999|112|police|fire (truck|department|brigade)|er|emergency room)\b|\b(fell|fallen|collapsed|passed out|fainted|bleeding|unconscious|not breathing|can'?t breathe|heart attack|stroke|seizure)\b|救护车|救護車|摔倒|跌倒|昏倒|晕倒|暈倒|流血|急救|报警|報警|不能呼吸|心脏病|心臟病/i;

function isUrgent(text: string): boolean {
  return isEmergency(text) || URGENT_HELP.test(text);
}

interface Decision {
  forMember: FamilyMember;
  what: string;
}
const decisions = new Map<string, Decision>(); // family id → the open decision
const detections = new Map<string, { at: number; result: Promise<boolean> }>();

/** Test helper. */
export function resetShoppingForTests(): void {
  decisions.clear();
  detections.clear();
}
export function hasOpenDecision(family: Family): boolean {
  return decisions.has(family.id);
}

// "find Nai Nai a …", "buy grandma a …", "Bridge, can you find …", "Bridge，帮奶奶找/买 …"
const EXPLICIT = /^\s*(?:@?bridge[\s,:，、]*)?(?:(?:please|pls|can you|could you|would you)\s+)?(?:find|buy|order|shop for)\b|^\s*@?bridge[\s,:，、]*(?:请|請)?(?:帮|幫).{0,8}(?:找|买|買)/i;

export async function tryHandleShopping(family: Family, sender: FamilyMember, msg: IncomingMessage): Promise<boolean> {
  try {
    const text = (msg?.text ?? "").trim();
    if (!text || !family || !sender) return false;
    if (isUrgent(text)) return false; // an emergency is relayed (and handled) as one, never shopped
    if (!EXPLICIT.test(text)) {
      void shopForNeed(family, sender, text); // background; the message is relayed as chat
      return false;
    }
    if (isElder(sender) && scamSignals(text).length) return false; // the money/scam flow handles it
    const need = await shopDeps.detectShoppingNeed(family, sender, text);
    if (!need) return false; // "find my keys": just chat
    const r = await startDecision(family, sender, need, { explicit: true });
    if (r.status === "started") return await r.cardsOut; // true only once the cards are going out
    if (r.status === "busy") {
      void say(sender, `I'm still helping the family choose ${r.what} for ${r.forMember.name}, so I shared your message with everyone. Ask me again once that's done 🙂`, family).catch(() => {});
    } else if (need.category !== "other") {
      // A real product with nothing that fits. No money suggestion here: real needs get the
      // money offer from payments/needs.ts.
      void say(sender, `I couldn't find a good option for ${need.forMember.id === sender.id ? "you" : need.forMember.name}, so I shared your message with the family.`, family).catch(() => {});
    }
    return false; // relayed as chat
  } catch (err) {
    console.error("[shop] tryHandleShopping failed", err);
    return false;
  }
}

/**
 * Background shopping for a natural message. Resolves true once a decision has started (cards
 * are going out), false if this isn't shopping, nothing fits, or the family is already deciding.
 * The same message asked twice (flow.ts, then needs.ts) shares one detection. Never rejects.
 */
export function shopForNeed(family: Family, sender: FamilyMember, text: string): Promise<boolean> {
  try {
    return shopForNeedUnsafe(family, sender, text);
  } catch (err) {
    console.error("[shop] background shopping failed", err);
    return Promise.resolve(false);
  }
}

function shopForNeedUnsafe(family: Family, sender: FamilyMember, text: string): Promise<boolean> {
  if (!family || !sender || typeof text !== "string" || !text.trim()) return Promise.resolve(false);
  const now = Date.now();
  for (const [k, d] of detections) if (now - d.at > DETECTION_TTL_MS) detections.delete(k);
  const key = `${family.id}|${sender.id}|${text.trim()}`;
  const seen = detections.get(key);
  if (seen) return seen.result;
  const result = (async () => {
    if (!text.trim() || isUrgent(text)) return false;
    if (isElder(sender) && scamSignals(text).length) return false; // scam markers: money/scam flow only
    if (isMoneyOnlyNeed(sender, text)) return false; // rent, bills, medicine, doctor, money requests
    const need = await shopDeps.detectShoppingNeed(family, sender, text);
    if (!need) return false;
    return (await startDecision(family, sender, need)).status === "started";
  })().catch((err) => {
    console.error("[shop] background shopping failed", err);
    return false;
  });
  detections.set(key, { at: now, result });
  return result;
}

type Start = { status: "started"; cardsOut: Promise<boolean> } | { status: "none" } | ({ status: "busy" } & Decision);

/** Claims the family's one decision, finds options, and runs the rest in the background. */
async function startDecision(family: Family, requester: FamilyMember, need: ShoppingNeed, how: { explicit?: boolean } = {}): Promise<Start> {
  const busy = decisions.get(family.id);
  if (busy) return { status: "busy", ...busy };
  const decision: Decision = { forMember: need.forMember, what: describe(need) };
  decisions.set(family.id, decision); // synchronous claim: two needs can't both start
  let options: Option[];
  try {
    options = (await shopDeps.findOptions(family, need)).slice(0, MAX_OPTIONS);
  } catch (err) {
    console.error("[shop] findOptions failed", err);
    options = [];
  }
  if (!options.length) {
    decisions.delete(family.id);
    return { status: "none" };
  }
  // Resolves true as soon as the first reader's cards are built (they're being sent), false if the
  // decision ends before that; an explicit command is only claimed (not relayed) on true.
  let cardsReady!: (ok: boolean) => void;
  const ready = new Promise<boolean>((r) => (cardsReady = r));
  const cardsOut = Promise.race([ready, new Promise<boolean>((r) => setTimeout(() => r(true), CARDS_OUT_MAX_MS).unref?.())]);
  void runDecision(family, requester, need, decision, options, cardsReady, how.explicit ? 0 : CARDS_DELAY_MS)
    .catch((err) => console.error("[shop] decision failed", err))
    .finally(() => {
      cardsReady(false);
      if (decisions.get(family.id) === decision) decisions.delete(family.id);
    });
  return { status: "started", cardsOut };
}

async function runDecision(
  family: Family, requester: FamilyMember, need: ShoppingNeed, decision: Decision, options: Option[], cardsReady: (ok: boolean) => void, delayMs: number,
): Promise<void> {
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const forMember = need.forMember;
  const voters = family.members;
  const card: VoteCard = async (reader: FamilyMember) => {
    const parts = [await heading(family, reader, requester, forMember, decision.what, options.length), ...(await Promise.all(options.map((o, i) => optionCard(family, reader, o, i))))];
    setImmediate(() => cardsReady(true)); // after the vote starts sending them
    return parts;
  };

  const result = await shopDeps.familyVote(family, voters, card, options.length, voteTimeoutMs());
  const buyer = pickBuyer(family, requester, forMember);
  if (!buyer) {
    await Promise.all(voters.map((m) => say(m, "There's nobody in the family who can pay for this, so I didn't buy anything.", family)));
    return;
  }

  let winner = result.winner;
  // The core rule (a): only the buyer's ❤️/‼️ on the winning card itself is an unambiguous yes.
  let buyerAgreed = false;
  if (winner === null || winner < 0 || winner >= options.length) {
    winner = await buyerPicks(family, buyer, forMember, options); // a letter: still confirmed (b)
    if (winner === null) {
      await Promise.all(voters.map((m) => say(m, `Nobody picked an option, so I didn't buy anything for ${forMember.name}.`, family)));
      return;
    }
  } else {
    buyerAgreed = result.votes.get(buyer.id) === winner && result.how?.get(buyer.id) === "card";
    const confirm = await buyerMustConfirm(buyer, options[winner]!.product, buyerAgreed);
    const n = [...result.votes.values()].filter((v) => v === winner).length;
    await Promise.all(
      voters.map(async (m) => sendText(m.handle, `🗳️ ${LETTERS[winner!]} · ${await localName(family, m, options[winner!]!.product)}\n${await localize(winnerSentence(n, m, buyer, forMember, confirm), m, family)}`)),
    );
  }

  const product = options[winner]!.product;
  // The requester and their own words go to checkout's scam check (an elder asking matters);
  // buyerAgreed=false makes checkout ask the buyer "🛒 Buy B · … ? ❤️ or yes" first.
  const order = await shopDeps.checkout(family, buyer, forMember, product, { requester, requestText: need.text, buyerAgreed, letter: LETTERS[winner] });
  if (!order.ok) {
    // checkout's errors are already plain sentences ("Kevin didn't confirm, so nothing was bought.").
    const error = order.error?.trim();
    const own = order.maybeCharged
      ? error && /may have gone through/i.test(error) ? error : paymentFailedText(order)
      : error || "The purchase didn't go through, so nothing was bought.";
    await say(buyer, own, family);
    const others = voters.filter((m) => m.id !== buyer.id);
    const line = order.maybeCharged
      ? `${buyer.name}'s purchase may have gone through; ${buyer.name} is checking. I'll let you know.`
      : `The purchase didn't go through, so nothing was ordered for ${forMember.name}.`;
    await Promise.all(others.map((m) => say(m, line, family)));
    return;
  }
  const isGift = need.category === "gift" || Boolean(need.occasion);
  shopDeps.trackOrder(family, buyer, forMember, product, order, { isGift, what: decision.what });
}

function winnerSentence(votes: number, reader: FamilyMember, buyer: FamilyMember, forMember: FamilyMember, confirm: boolean): string {
  const chose = `The family chose this (${votes === 1 ? "1 vote" : `${votes} votes`}).`;
  const to = reader.id === forMember.id ? "you" : forMember.name;
  if (reader.id === buyer.id) return confirm ? `${chose} I'll ask you to confirm before I buy it for ${forMember.name}.` : `${chose} Checking out for ${forMember.name} with your card.`;
  return confirm ? `${chose} Waiting for ${buyer.name} to confirm before buying it for ${to}.` : `${chose} ${buyer.name} is buying it for ${to}.`;
}

const SKIP = /^\s*(no|n|skip|cancel|none|不|不要|不用|算了|取消)\s*[.!。！]*\s*$/i;
const PICK_TRIES = 3;

/**
 * Nobody voted: the buyer picks with a letter (A–C), or "no". Tapbacks don't count here (M-5):
 * "which one?" has no card to tap. A non-letter answer (e.g. a "yes" meant for another question)
 * is passed on, and the buyer is asked again. The pick is then confirmed by checkout (b).
 */
async function buyerPicks(family: Family, buyer: FamilyMember, forMember: FamilyMember, options: Option[]): Promise<number | null> {
  const letters = LETTERS.slice(0, options.length).join(", ");
  const deadline = Date.now() + voteTimeoutMs();
  let question = `Nobody voted for ${forMember.name}'s options. Which one should I buy? Reply with a letter (${letters}), or "no" to skip.`;
  for (let i = 0; i < PICK_TRIES && Date.now() < deadline; i++) {
    const a = await ask(buyer.handle, await localize(question, buyer, family), Math.max(1, deadline - Date.now()));
    if (!a) return null;
    if (a.via === "text") {
      const pick = parseVote(a.text, options.length);
      if (pick !== undefined) return pick;
      if (SKIP.test(a.text)) return null;
      await passOn(buyer, a.text).catch((err) => console.error("[shop] pass-on failed", err));
    }
    question = `Please reply with just a letter (${letters}) so I know which one to buy, or "no" to skip.`;
  }
  return null;
}

/** The requester if they can pay (not an elder, not the recipient), else a trusted member, else the first non-elder. */
export function pickBuyer(family: Family, requester: FamilyMember, forMember: FamilyMember): FamilyMember | undefined {
  if (!isElder(requester) && requester.id !== forMember.id) return requester;
  const trusted = trustedConfirmers(family, forMember, forMember)[0];
  return trusted ?? family.members.find((m) => !isElder(m) && m.id !== forMember.id);
}

// ── Cards ───────────────────────────────────────────────────────────────────

function describe(need: ShoppingNeed): string {
  const kw = (need as ShoppingNeed & { keywordsEn?: string[] }).keywordsEn?.filter(Boolean) ?? [];
  if (kw.length) {
    const thing = kw.slice(0, 3).join(" ");
    return /^(a|an|the|some)\s/i.test(thing) ? thing : `${/^[aeiou]/i.test(thing) ? "an" : "a"} ${thing}`;
  }
  return `something (${need.category.replace(/[-_]/g, " ")})`;
}

async function heading(family: Family, reader: FamilyMember, requester: FamilyMember, forMember: FamilyMember, what: string, n: number): Promise<string> {
  const letters = LETTERS.slice(0, n);
  const lettersText = letters.length > 1 ? `${letters.slice(0, -1).join(", ")} or ${letters[letters.length - 1]}` : letters[0]!;
  const forYou = reader.id === forMember.id;
  const lead =
    requester.id === forMember.id
      ? forYou ? `You'd like ${what}.` : `${forMember.name} wants ${what}.`
      : requester.id === reader.id ? `You asked me to find ${what} for ${forMember.name}.` : `${requester.name} asked me to find ${what} for ${forYou ? "you" : forMember.name}.`;
  const sentence = `${lead} ${n === 1 ? "Here is 1 option" : `Here are ${n} options`}; reply ${lettersText}, or tapback ${ICONS.slice(0, n).join("/")}. Feel free to talk it over first.`;
  const legend = letters.map((l, i) => `${ICONS[i]} ${l}`).join(" · ");
  return `🛍️ ${await localize(sentence, reader, family)}\n${legend}`;
}

/** One option card. Names/prices/links are never run through the translator; the URL is alone on the last line. */
export async function optionCard(family: Family, reader: FamilyMember, option: Option, index: number): Promise<string> {
  const p = option.product;
  const [name, price, blurb] = await Promise.all([localName(family, reader, p), priceFor(reader, p), localize(summary(option), reader, family)]);
  const link = p.url && /^https?:\/\/\S+$/i.test(p.url.trim()) ? p.url.trim() : `(${await localize("demo product", reader, family)})`;
  const rating = typeof p.rating === "number" ? ` · ⭐ ${p.rating}${typeof p.reviews === "number" ? ` (${p.reviews})` : ""}` : "";
  return `${LETTERS[index]} · ${name}\n${price} · ${p.merchant}${rating}\n${blurb}\n${link}`;
}

function summary(o: Option): string {
  const d = (o.product.description ?? "").replace(/\s+/g, " ").trim();
  const first = d.match(/^.{0,160}?[.!?。！？](\s|$)/)?.[0]?.trim() ?? (d.length > 160 ? `${d.slice(0, 157)}…` : d);
  const why = o.why?.trim() ?? "";
  const same = (a: string, b: string) => a.replace(/[.!?。！？\s]+$/u, "").toLowerCase() === b.replace(/[.!?。！？\s]+$/u, "").toLowerCase();
  return first && why && same(first, why) ? why : [first, why].filter(Boolean).join(" ");
}

async function localName(family: Family, reader: FamilyMember, p: Product): Promise<string> {
  const own = p.name[reader.language] ?? p.name[reader.language.split("-")[0]!];
  if (own) return own;
  const en = p.name.en ?? Object.values(p.name)[0] ?? p.id;
  if (reader.language === "en") return en;
  return (await translate(en, BRIDGE, reader, family)).text;
}

async function priceFor(reader: FamilyMember, p: Product): Promise<string> {
  const to = isSupportedCurrency(reader.currency) ? reader.currency! : p.currency;
  if (to.toUpperCase() === p.currency.toUpperCase() || !isSupportedCurrency(p.currency)) return formatMoney(p.price, p.currency);
  const q = await quote(p.price, p.currency, to);
  if (q.currency === p.currency) return formatMoney(p.price, p.currency);
  return `≈ ${formatMoney(q.amount >= 10 ? Math.round(q.amount) : q.amount, q.currency)}`; // an estimate: no fake precision
}
