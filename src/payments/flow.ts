// Money conversations: "Send Nai Nai $50 for New Year". Owned by User 2.
// Called by relay/router.ts for every text message BEFORE it is relayed.
//
// FROZEN SIGNATURE: tryHandlePayment(family, sender, msg) → true if this message was a
// money command and has been fully handled (so it is NOT relayed), false otherwise.
//
// Flow for a gift:
//   1. cheap regex pre-check (normal chat never waits on Claude)
//   2. parse who / how much / note (Claude, or a regex fallback without an API key)
//   3. sanity check the amount (> 0, at most MAX_GIFT_USD) and the currencies (known rates only)
//   4. scam check: risky gifts are confirmed by a trusted family member first (never the
//      sender or the recipient). No eligible member → the gift is refused, never self-approved.
//   5. the sender confirms ("❤️ or yes"), with the amount in the recipient's currency
//   6. sendGift() (Visa), then both sides are told in their own language
//
// One money question per member at a time (review U2-08 M-1). prompts.ts gives a bare "yes" to
// the member's MOST RECENT open prompt, so two open money prompts for one person would let a
// "yes" pay for the wrong one. claimMoneySlot() keeps a registry of members with an open money
// prompt (gift confirm, guard approval, help offer, see needs.ts). If the sender already has
// one open (e.g. a help offer), the gift is refused with "Answer my earlier question first 🙂"
// (we refuse rather than wait: waiting would hold the sender's message queue for up to 10 min).
// A busy guard is skipped for another eligible one, or the gift is refused.
// Amounts and names in money prompts are never translated: Bridge's sentence is translated,
// and the who/how-much line is built separately (review S-8).
// Anything that is NOT a gift returns false (it's relayed as chat), and maybeOfferHelp()
// (needs.ts) gets a look at it: a grandparent mentioning medicine, or asking for money.
// Then the shopping flow (shop/shopFlow.ts tryHandleShopping): an explicit "find/buy X for Y"
// command to Bridge returns true (not relayed); other messages are relayed and may start a
// shopping decision in the background.
//
// Settings (optional, read from process.env here):
//   PAYMENT_CONFIRM_TIMEOUT_MS   how long Bridge waits for a "yes" (default 180000 = 3 min)

import { sendText } from "../photon/client.js";
import { ask, type Answer } from "../relay/prompts.js";
import { callTool, hasClaude } from "../translate/claude.js";
import { translate } from "../translate/translator.js";
import { formatSignals, requiresConfirmation, scamSignals, trustedConfirmers } from "./scamCheck.js";
import { maybeOfferHelp } from "./needs.js";
import { tryHandleShopping } from "../shop/shopFlow.js";
import { formatMoney, isSupportedCurrency, MAX_GIFT_USD as VISA_MAX_GIFT_USD, quote, sendGift, SUPPORTED_CURRENCIES } from "./visa.js";
import type { Family, FamilyMember, IncomingMessage } from "../types.js";

/** Demo cap: no single gift above this many US dollars (converted from the sender's currency). */
export const MAX_GIFT_USD = VISA_MAX_GIFT_USD;

export function confirmTimeoutMs(): number {
  const n = Number(process.env.PAYMENT_CONFIRM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 3 * 60_000;
}

/** Swappable for tests (flow.selftest.ts); production always uses visa.ts. */
export const flowDeps = { sendGift };

// ── One open money prompt per member (M-1) ──────────────────────────────────

const moneySlots = new Map<string, symbol>(); // member handle → token of the open money prompt

/**
 * Reserves `member` for one money prompt. Returns a release function, or undefined if the member
 * already has a money prompt open. Check-and-set is synchronous, so two flows can't both win.
 * The release only frees the slot if it still belongs to this claim.
 */
export function claimMoneySlot(member: FamilyMember): (() => void) | undefined {
  if (moneySlots.has(member.handle)) return undefined;
  const token = Symbol(member.id);
  moneySlots.set(member.handle, token);
  return () => {
    if (moneySlots.get(member.handle) === token) moneySlots.delete(member.handle);
  };
}

export function hasOpenMoneyPrompt(member: FamilyMember): boolean {
  return moneySlots.has(member.handle);
}

/** Test helper. */
export function resetMoneySlotsForTests(): void {
  moneySlots.clear();
}

// Amounts, currency words, or gift verbs next to a number, in English and Chinese.
const LOOKS_LIKE_MONEY =
  /[$¥€£₩]\s?\d|\d+(\.\d+)?\s?(dollars?|bucks|usd|twd|ntd|rmb|cny|元|块|塊|美元|美金)|\b(send|gift|give|pay|transfer|venmo)\b.*\d|红包|紅包|给.{0,6}钱|給.{0,6}錢|打钱|轉帳|转账/i;

interface MoneyIntent {
  isGift: boolean; // sender wants to send money to someone in the family
  recipientId?: string;
  amount?: number; // NaN = an amount was written but can't be read safely ("1e3", "12,50")
  currency?: string;
  note?: string;
}

export async function tryHandlePayment(family: Family, sender: FamilyMember, msg: IncomingMessage): Promise<boolean> {
  const text = msg.text ?? "";
  const handled = LOOKS_LIKE_MONEY.test(text) && (await handleGift(family, sender, text));
  if (handled) return true;
  // Not a gift. "find Nai Nai a …" (a command to Bridge) is handled by the shopping flow;
  // anything else is relayed as normal chat, with needs / shopping as side flows.
  if (await tryHandleShopping(family, sender, msg)) return true;
  maybeOfferHelp(family, sender, text);
  return false;
}

async function handleGift(family: Family, sender: FamilyMember, text: string): Promise<boolean> {
  const intent = await parseIntent(text, sender, family);
  // "I spent $20 on groceries", "Nai Nai gave me $20" → not a command, relay as chat.
  if (!intent.isGift) return false;

  const currency = normalizeCurrency(intent.currency) ?? sender.currency ?? "USD";
  const others = family.members.filter((m) => m.id !== sender.id);
  const recipient = others.find((m) => m.id === intent.recipientId);

  if (!isSupportedCurrency(currency)) {
    await say(sender, `Sorry, I can't send that currency yet. I can send: ${SUPPORTED_CURRENCIES.join(", ")}.`, family);
    return true;
  }
  if (!recipient) {
    const example = others[0]?.name ?? "Nai Nai";
    const amountOk = intent.amount !== undefined && Number.isFinite(intent.amount) && intent.amount > 0;
    await say(sender, `Who should I send it to? I can send to ${listNames(others)}. Try: "send ${example} ${amountOk ? formatMoney(intent.amount!, currency) : "$20"}".`, family);
    return true;
  }
  if (intent.amount === undefined || !Number.isFinite(intent.amount)) {
    await say(sender, `How much should I send ${recipient.name}? Please write a plain amount, like: "send ${recipient.name} $20".`, family);
    return true;
  }

  const amount = intent.amount;
  if (amount < 0.01) {
    await say(sender, `I can only send an amount above zero. Try: "send ${recipient.name} $20".`, family);
    return true;
  }
  const receiveCurrency = recipient.currency ?? currency;
  if (!isSupportedCurrency(receiveCurrency)) {
    await say(sender, `Sorry, I can't send money to ${recipient.name}'s currency yet.`, family);
    return true;
  }
  const inUsd = await quote(amount, currency, "USD");
  if (!(inUsd.amount <= MAX_GIFT_USD)) {
    await say(sender, `That's more than I can send at once (the limit is ${formatMoney(MAX_GIFT_USD, "USD")} per gift). Try a smaller amount?`, family);
    return true;
  }

  // M-1: one money prompt per member. Hold the sender's slot from here until the gift is done,
  // so no help offer can open for them while the guard is being asked.
  const releaseSender = claimMoneySlot(sender);
  if (!releaseSender) {
    await say(sender, `Answer my earlier question first 🙂 (❤️ or "yes", or "no" to skip it), then send this again.`, family);
    return true;
  }
  try {
    await confirmAndSend(family, sender, recipient, text, intent, amount, currency, inUsd.amount);
  } finally {
    releaseSender();
  }
  return true;
}

async function confirmAndSend(
  family: Family, sender: FamilyMember, recipient: FamilyMember, text: string, intent: MoneyIntent,
  amount: number, currency: string, amountUsd: number,
): Promise<void> {
  const received = await quote(amount, currency, recipient.currency ?? currency);
  const sentStr = formatMoney(amount, currency);
  const receivedStr = received.currency === currency ? "" : ` (≈ ${formatMoney(received.amount, received.currency)})`;

  // Scam protection: elders sending money, large amounts, or scam markers need a trusted member's OK first.
  const signals = scamSignals(text);
  if (requiresConfirmation(sender, amountUsd, signals)) {
    const eligible = trustedConfirmers(family, sender, recipient); // M-3: never the sender or the recipient
    if (!eligible.length) {
      // M-2: a risky gift with nobody to check it is refused, never approved by the sender alone.
      await say(sender, `I can't send this one: gifts like this need a trusted family member to OK them first (someone other than you and ${recipient.name}), and there isn't one set up yet. Nothing was sent.`, family);
      return;
    }
    let guard: FamilyMember | undefined;
    let releaseGuard: (() => void) | undefined;
    for (const m of eligible) {
      releaseGuard = claimMoneySlot(m);
      if (releaseGuard) { guard = m; break; }
    }
    if (!guard || !releaseGuard) {
      await say(sender, `${eligible[0]!.name} is answering another question from me right now. Please try again in a few minutes. Nothing was sent.`, family);
      return;
    }
    let ok: Answer | null;
    try {
      await say(sender, `I'm checking with ${guard.name} first, to keep your money safe.`, family);
      const why = signals.length ? `\n${formatSignals(signals)}` : "";
      ok = await ask(
        guard.handle,
        await moneyPrompt(
          `🛡️ ${sender.name} ➡️ ${recipient.name} · ${sentStr}${receivedStr}`,
          `This gift needs your OK first.${why}\nDoes this look right? ❤️ or "yes" to allow, "no" to stop.`,
          guard,
          family,
        ),
        confirmTimeoutMs(),
      );
    } finally {
      releaseGuard();
    }
    if (!isYes(ok)) {
      await say(sender, ok ? `${guard.name} didn't approve, so I didn't send the money.` : `${guard.name} didn't answer, so I didn't send the money.`, family);
      await say(guard, ok ? "OK, I stopped it. Nothing was sent." : `No answer, so I didn't send ${sender.name}'s gift.`, family);
      return;
    }
  }

  const note = intent.note ? ` · 💌 ${intent.note}` : ""; // the sender's own words, shown to the sender as written
  const answer = await ask(
    sender.handle,
    await moneyPrompt(`💸 ${recipient.name} · ${sentStr}${receivedStr}${note}`, `Send this gift? ❤️ or "yes" to confirm, "no" to cancel.`, sender, family),
    confirmTimeoutMs(),
  );
  if (!answer) {
    await say(sender, "No answer, so I didn't send it.", family);
    return;
  }
  if (!isYes(answer)) {
    await say(sender, "OK, I didn't send anything.", family);
    return;
  }

  const result = await flowDeps.sendGift(sender, recipient, amount, currency);
  if (!result.ok) {
    await say(sender, paymentFailedText(result), family);
    return;
  }

  const got = formatMoney(result.amountReceived, result.receivedCurrency);
  await say(sender, `✅ Sent ${sentStr} to ${recipient.name}. ${recipient.name} received ${got}. ❤️`, family);
  await sendText(recipient.handle, await giftMessage(sender, recipient, got, intent.note, family));
}

/** The warm 🧧 message: the wrapper is Bridge's (English → reader), the note is the sender's own words. */
async function giftMessage(sender: FamilyMember, recipient: FamilyMember, got: string, note: string | undefined, family: Family) {
  const wrapper = await localize(`🧧 A gift from ${sender.name}! ${sender.name} sent you ${got}, with love. ❤️`, recipient, family);
  if (!note) return wrapper;
  const noteText = (await translate(note, sender, recipient, family)).text;
  return `${wrapper}\n💌 “${noteText}”`;
}

// ── Helpers (also used by needs.ts) ───────────────────────────────────────────

// M-4: only a whole-message yes counts. "ok?", "yes please", "ok wait, no", "sure... not" do not.
const YES = /^(yes|y|ok|okay|confirm|sure|yep|是|是的|好|好的|可以|行|对|對)[\s!.。！]*$/i;
const NOT_YES = /[?？]|\b(no|not|cancel|don'?t)\b|不|别|別|取消/i;

export function isYes(a: Answer | null): boolean {
  if (!a) return false;
  if (a.via === "tapback") return a.tapback === "love"; // only ❤️; 👍 is too easy to give by accident
  const t = typeof a.text === "string" ? a.text.trim() : "";
  return YES.test(t) && !NOT_YES.test(t);
}

/** What to tell someone whose payment failed. Never "nothing was charged" when Visa may have taken it (S-4). */
export function paymentFailedText(result: { error?: string; maybeCharged?: boolean }): string {
  return result.maybeCharged
    ? `I couldn't confirm the payment (${result.error ?? "no answer from the payment service"}). It may have gone through; please check before trying again.`
    : `Sorry, the payment didn't go through: ${result.error ?? "unknown error"}. Nothing was charged.`;
}

/**
 * A money question: `details` (who and how much) is built here and NEVER translated, so a
 * translation can't change a number or a name (S-8). Only Bridge's `sentence` is translated.
 */
export async function moneyPrompt(details: string, sentence: string, reader: FamilyMember, family: Family): Promise<string> {
  return `${details}\n${await localize(sentence, reader, family)}`;
}

/** Bridge's own messages are written in English and translated for the reader. */
const BRIDGE: FamilyMember = { id: "bridge", name: "Bridge", handle: "", language: "en", relationship: "family assistant", isBilingualReviewer: false };

export async function localize(text: string, reader: FamilyMember, family: Family): Promise<string> {
  if (reader.language === "en") return text;
  return (await translate(text, BRIDGE, reader, family)).text;
}

export async function say(to: FamilyMember, text: string, family: Family): Promise<void> {
  await sendText(to.handle, await localize(text, to, family));
}

function listNames(members: FamilyMember[]): string {
  const names = members.map((m) => m.name);
  return names.length <= 1 ? (names[0] ?? "nobody yet") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

const CURRENCY_ALIASES: Record<string, string> = { RMB: "CNY", NTD: "TWD", NT: "TWD", "NT$": "TWD", US$: "USD", "HK$": "HKD" };
function normalizeCurrency(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const up = c.trim().toUpperCase();
  return CURRENCY_ALIASES[up] ?? (/^[A-Z]{3}$/.test(up) ? up : undefined);
}

async function parseIntent(text: string, sender: FamilyMember, family: Family): Promise<MoneyIntent> {
  const others = family.members.filter((m) => m.id !== sender.id);
  if (hasClaude()) {
    try {
      const raw = await callTool<MoneyIntent>({
        system:
          "You read one message from a family chat and decide whether the sender is asking Bridge (the family's assistant) to send money to a family member right now. Statements about money ('I spent $20', 'groceries cost ¥50', 'Nai Nai gave me $20') are NOT gifts. Requests for money for the sender ('send me $500') are NOT gifts. In Chinese, 块/元 means the sender's default currency when it is TWD, CNY or HKD, otherwise CNY.",
        content: [
          `<sender>${sender.name} (${sender.relationship}), default currency ${sender.currency ?? "USD"}</sender>`,
          `<family>${others.map((m) => `${m.id}: ${m.name} (${m.relationship})`).join("; ")}</family>`,
          `<message>${text}</message>`,
        ].join("\n"),
        tool: {
          name: "money_intent",
          description: "Report whether this is a request to send a money gift, and its details.",
          input_schema: {
            type: "object",
            properties: {
              isGift: { type: "boolean" },
              recipientId: { type: "string", description: "id from <family>, if a recipient is named (by name or relationship, e.g. grandma)" },
              amount: { type: "number" },
              currency: { type: "string", description: "ISO code, e.g. USD, TWD. Use the sender's default if no symbol." },
              note: { type: "string", description: "Occasion or message for the recipient, e.g. 'New Year', in the sender's words" },
            },
            required: ["isGift"],
          },
        },
        maxTokens: 300,
      });
      const byId = others.find((m) => m.id === raw.recipientId) ?? others.find((m) => m.name.toLowerCase() === String(raw.recipientId ?? "").toLowerCase());
      return {
        isGift: Boolean(raw.isGift),
        recipientId: byId?.id,
        amount: raw.amount === undefined || raw.amount === null ? undefined : Number(raw.amount),
        currency: raw.currency,
        note: raw.note?.trim() || undefined,
      };
    } catch (err) {
      console.error("[payments] intent parse failed, falling back to regex", err);
    }
  }
  return parseWithRegex(text, sender, others);
}

// ── Regex fallback (no Claude) ────────────────────────────────────────────────

// Words people use for a relationship → the `relationship` value in family.json.
const RELATIONSHIP_WORDS: [RegExp, string[]][] = [
  [/\b(grandma|granny|nana|grandmother)\b|奶奶|外婆|姥姥|阿嬤|阿嬷|婆婆/i, ["grandmother", "grandparent"]],
  [/\b(grandpa|granddad|grandad|grandfather)\b|爷爷|爺爺|外公|姥爷|姥爺|阿公/i, ["grandfather", "grandparent"]],
  [/\b(grandson)\b|孙子|孫子|外孙|外孫/i, ["grandson", "grandchild"]],
  [/\b(granddaughter)\b|孙女|孫女|外孙女|外孫女/i, ["granddaughter", "grandchild"]],
  [/\b(mom|mum|mother|mama)\b|妈妈|媽媽|妈|媽/i, ["mother"]],
  [/\b(dad|father|papa)\b|爸爸|爸/i, ["father"]],
];

const SYMBOLS: Record<string, string> = { $: "USD", "US$": "USD", "NT$": "TWD", "HK$": "HKD", "¥": "CNY", "€": "EUR", "£": "GBP", "₩": "KRW" };
const WORDS: Record<string, string> = {
  usd: "USD", dollar: "USD", dollars: "USD", bucks: "USD", 美元: "USD", 美金: "USD",
  twd: "TWD", ntd: "TWD", cny: "CNY", rmb: "CNY", 人民币: "CNY", 人民幣: "CNY",
};
const CHINESE_UNIT = /^(元|块|塊)$/;

// A number as people write money: "50", "50.5", "1,000", "1,234.50". Validated in readNumber().
const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?`;
const WITH_SYMBOL = new RegExp(String.raw`(US\$|NT\$|HK\$|[$¥€£₩])\s?${NUM}`, "i");
const WITH_UNIT = new RegExp(String.raw`${NUM}\s?(usd|twd|ntd|cny|rmb|dollars?|bucks|美元|美金|人民币|人民幣|元|块|塊)`, "i");
const BARE = new RegExp(NUM);

/**
 * The amount and currency in `text`, read in the sender's currency when none is written
 * (元/块 → the sender's TWD/CNY/HKD, else CNY). An amount written with a symbol wins over a
 * bare number ("2 hongbao of $50" → $50). amount is NaN when a number is there but unsafe to
 * read: scientific notation ("1e3"), a decimal comma ("12,50"), or more than 2 decimals.
 * Also used by needs.ts for elders' money requests (S-7).
 */
export function parseAmount(text: string, sender: FamilyMember): { amount?: number; currency: string } {
  let currency = sender.currency ?? "USD";
  const sym = text.match(WITH_SYMBOL);
  const unit = sym ? null : text.match(WITH_UNIT);
  const bare = sym || unit ? null : text.match(BARE);
  const m = sym ?? unit ?? bare;
  if (!m) return { currency };
  const [whole, ...groups] = m;
  const intPart = sym ? groups[1] : groups[0];
  const fracPart = sym ? groups[2] : groups[1];
  if (sym) currency = SYMBOLS[groups[0]!.toUpperCase()] ?? SYMBOLS[groups[0]!] ?? currency;
  else if (unit) {
    const u = groups[2]!;
    currency = CHINESE_UNIT.test(u) ? (["CNY", "TWD", "HKD"].includes(sender.currency ?? "") ? sender.currency! : "CNY") : (WORDS[u.toLowerCase()] ?? currency);
  }
  const after = text.slice((m.index ?? 0) + whole.length);
  const before = text.slice(0, m.index ?? 0);
  const numberEnd = sym ? after : text.slice((m.index ?? 0) + intPart!.length + (fracPart?.length ?? 0));
  const unsafe =
    /^[eE][+-]?\d/.test(numberEnd) || // 1e3
    /^[,.]?\d/.test(numberEnd) || // "12,50", "1,0000", "1.2.3"
    /(\d[eE][+-]?|[\d.,])$/.test(before) || // "1e3 dollars" (the regex only saw "3 dollars"), "1.$5"
    (fracPart !== undefined && fracPart.length > 3); // "$0.001": more than 2 decimals
  if (unsafe) return { amount: NaN, currency };
  return { amount: Number(intPart!.replace(/,/g, "") + (fracPart ?? "")), currency };
}

/** Handles "send Nai Nai $50 for New Year", "can you send grandma 30 bucks", "给Kevin发个红包，100块". */
export function parseWithRegex(text: string, sender: FamilyMember, others: FamilyMember[]): MoneyIntent {
  // Asking for money for yourself, or reporting a past gift, is not a command.
  const isRequest = /\b(send|give|lend|wire|transfer|pay)\s+me\b|给我|給我|借我/i.test(text);
  const isPast = /\b(gave|sent|paid|spent)\b|给了|給了|发了|發了|花了/i.test(text);
  const verb =
    /\b(send|gift|give|pay|transfer|wire)\b/i.test(text) ||
    /红包|紅包|(给|給).{1,12}(发|發|转|轉|打|汇|匯)|(发|發|转|轉|打|汇|匯).{0,4}(钱|錢|红包|紅包)给|(发|發|转|轉|打).{0,4}(钱|錢|红包|紅包)給/.test(text);
  const isGift = verb && !isRequest && !isPast;

  const { amount, currency } = parseAmount(text, sender);

  const note = text.match(/\bfor (?:the |a |an |your |her |his )?(.+?)[.!?]*$/i)?.[1]?.trim() || (/红包|紅包/.test(text) ? "红包" : undefined);

  return { isGift, recipientId: findRecipient(text, others)?.id, amount, currency, note };
}

function findRecipient(text: string, others: FamilyMember[]): FamilyMember | undefined {
  const lower = text.toLowerCase();
  const word = (w: string) => {
    const s = w.toLowerCase();
    if (/[^\x00-\x7f]/.test(s)) return lower.includes(s); // Chinese names: no word boundaries
    return new RegExp(`(^|[^a-z])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z])`, "i").test(lower);
  };
  const byName = others.find((o) => word(o.name) || word(o.id));
  if (byName) return byName;
  for (const [re, rels] of RELATIONSHIP_WORDS) {
    if (!re.test(text)) continue;
    const hit = others.find((o) => rels.includes(o.relationship.toLowerCase()));
    if (hit) return hit;
  }
  return undefined;
}
