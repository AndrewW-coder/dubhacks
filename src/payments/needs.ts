// Help with real needs. Owned by User 2.
//
// When a grandparent mentions a real need ("我的药快吃完了", "the fridge broke"), the message
// is relayed as normal chat AND every non-elder member is gently asked, in their own
// language: "💊 Nai Nai · $30 / She mentioned she needs medicine. Send her this gift? ❤️ or yes".
// The first "yes" pays (sendGift from that member to the elder); everyone else is told
// it's handled. A grandparent ASKING for money ("can you send me $500", "我需要钱买礼品卡"),
// or a need with scam markers, goes only to a trusted member (never to nobody-in-particular:
// with no trusted member there is no offer). Nothing is ever paid without a person saying yes.
//
// Review U2-08 fixes:
//   M-1  a member with an open money prompt (flow.ts claimMoneySlot) is not sent an offer, so a
//        "yes" can never land on the wrong question.
//   S-6  if the first helper's payment fails (and certainly wasn't charged), the offer reopens:
//        anyone who said yes meanwhile is asked again, and the next yes tries.
//   S-7  a money request's number is read in the elder's currency (块/元 → TWD for Nai Nai) and
//        converted to USD for the cap and the suggestion.
//
// maybeOfferHelp(family, sender, text) is fire-and-forget: it never throws and never
// delays the relay. Called by tryHandlePayment (flow.ts) for every non-gift message.
//
// No settings of its own. Offers stay open for OFFER_TIMEOUT_MS (10 min, the same window as
// the duplicate guard); prompts.ts has no cancel, so late answers are handled here.

import { ask, type Answer } from "../relay/prompts.js";
import { callTool, hasClaude } from "../translate/claude.js";
import { isEmergency } from "../translate/confidence.js";
import { translate } from "../translate/translator.js";
import { claimMoneySlot, isYes, MAX_GIFT_USD, moneyPrompt, parseAmount, paymentFailedText, say } from "./flow.js";
import { formatSignals, isElder, scamSignals, trustedConfirmer } from "./scamCheck.js";
import { formatMoney, isSupportedCurrency, quote, sendGift } from "./visa.js";
import type { Family, FamilyMember } from "../types.js";

/** Don't offer twice for the same elder + need within this window; offers also expire after it. */
const DEDUPE_MS = 10 * 60_000;
const OFFER_TIMEOUT_MS = DEDUPE_MS;
/** Let the relayed message land in everyone's thread before the offer appears under it. */
const OFFER_DELAY_MS = 250;

/** Swappable for tests (flow.selftest.ts). */
export const needsDeps = { sendGift };

type Category = "medicine" | "groceries" | "rent" | "bills" | "doctor" | "appliance" | "money";

const CATEGORIES: { id: Exclude<Category, "money">; words: RegExp; label: string; emoji: string; usd: number }[] = [
  { id: "medicine", words: /\b(medicine|medicines|medication|meds|pills?|prescriptions?|pharmacy|insulin)\b|药|藥/i, label: "medicine", emoji: "💊", usd: 30 },
  { id: "groceries", words: /\b(groceries|grocery|food)\b|买菜|買菜|菜钱|菜錢|吃的|食物/i, label: "groceries", emoji: "🛒", usd: 50 },
  { id: "rent", words: /\brent\b|房租|租金/i, label: "rent", emoji: "🏠", usd: 200 },
  { id: "bills", words: /\b(bills?|electric|electricity|utilities|utility|gas bill|water bill|phone bill)\b|电费|電費|水费|水費|账单|帳單|瓦斯费|瓦斯費/i, label: "bills", emoji: "💡", usd: 60 },
  { id: "doctor", words: /\b(doctor|doctors|clinic|dentist|checkup|check-up)\b|看病|看医生|看醫生|挂号|掛號|牙医|牙醫/i, label: "a doctor's visit", emoji: "🩺", usd: 50 },
  {
    id: "appliance",
    words: /\b(fridge|refrigerator|washer|washing machine|dryer|heater|stove|oven|air ?conditioner|furnace|microwave|tv|phone)\b|冰箱|洗衣机|洗衣機|热水器|熱水器|暖气|暖氣|空调|空調|冷气|冷氣|电视|電視|手机|手機|微波炉|微波爐|炉子|爐子/i,
    label: "a repair",
    emoji: "🔧",
    usd: 80,
  },
];

// The category word alone isn't enough ("I bought groceries"): there must be a need.
const NEED_CUE =
  /\b(need|needs|needed|out of|ran out|running out|running low|can'?t afford|cannot afford|too expensive|so expensive|expensive|broke|broken|stopped working|not working|isn'?t working|died|due|overdue|behind on|short on)\b|需要|要买|要買|没了|沒了|没有了|沒有了|吃完|用完|快没|快沒|坏了|壞了|不能用|不动了|不動了|该交|該交|要交|交不起|买不起|買不起|付不起|不够|不夠|太贵|太貴|好贵|好貴|很贵|很貴/i;

// An elder asking for money for themselves.
const MONEY_REQUEST =
  /\b(send|give|lend|wire|transfer)\s+me\s+(some\s+)?(money|cash|[$¥€£₩]?\s?\d)|\bi\s+need\s+(some\s+)?(money|cash)\b|\bneed\s+[$¥]\s?\d|我需要钱|我需要錢|需要钱|需要錢|要钱|要錢|给我.{0,6}(钱|錢)|給我.{0,6}(钱|錢)|借.{0,4}(钱|錢)|(打|转|轉)(钱|錢|账|帳)给我|(打|转|轉)(钱|錢|账|帳)給我|礼品卡|禮品卡|\bgift ?cards?\b/i;

interface Detected {
  category: Category;
  need: string; // short, English: "medicine", "money"
  emoji: string;
  amountUSD: number;
  asked?: { amount: number; currency: string }; // money requests: the amount the elder wrote, in their currency
}

const recentOffers = new Map<string, number>(); // `${elderId}|${category}` → time offered

/** Fire-and-forget: may ask family members whether they'd like to help. Never throws. */
export function maybeOfferHelp(family: Family, sender: FamilyMember, text: string): void {
  try {
    if (!isElder(sender) || !text.trim() || isEmergency(text)) return;
    const pre = detect(text, sender);
    if (!pre) return;
    void run(family, sender, text, pre).catch((err) => console.error("[needs] offer failed", err));
  } catch (err) {
    console.error("[needs] offer failed", err);
  }
}

/** Test helper: forget previous offers (the 10-minute duplicate guard). */
export function resetNeedsForTests(): void {
  recentOffers.clear();
}

function detect(text: string, elder: FamilyMember): Detected | undefined {
  if (MONEY_REQUEST.test(text)) {
    const p = parseAmount(text, elder); // S-7: in the elder's own currency
    const asked = p.amount !== undefined && Number.isFinite(p.amount) && p.amount > 0 && isSupportedCurrency(p.currency) ? { amount: p.amount, currency: p.currency } : undefined;
    return { category: "money", need: "money", emoji: "🛡️", amountUSD: 50, asked };
  }
  if (!NEED_CUE.test(text)) return undefined;
  const c = CATEGORIES.find((c) => c.words.test(text));
  if (!c) return undefined;
  if (c.id === "appliance" && !/\b(broke|broken|stopped working|not working|isn'?t working|died)\b|坏了|壞了|不能用|不动了|不動了/i.test(text)) return undefined;
  return { category: c.id, need: c.label, emoji: c.emoji, amountUSD: c.usd };
}

/** One offer to the family. All state changes happen synchronously, so two yeses can't both pay. */
interface Offer {
  status: "open" | "paying" | "done";
  payer?: FamilyMember;
  waiting: FamilyMember[]; // said yes while someone else's payment was in flight
  slots: Map<string, () => void>; // helper id → release of their money slot (M-1)
}

async function run(family: Family, elder: FamilyMember, text: string, pre: Detected): Promise<void> {
  const key = `${family.id}|${elder.id}|${pre.category}`;
  const last = recentOffers.get(key);
  if (last !== undefined && Date.now() - last < DEDUPE_MS) return;
  recentOffers.set(key, Date.now());

  const found = pre.category === "money" ? pre : await refine(text, elder, pre);
  if (!found) {
    recentOffers.delete(key); // Claude says it isn't a need; a later real one may still be offered
    return;
  }
  // S-7: the elder's own number, converted to USD, else the category default. Capped in USD.
  const askedUSD = found.asked ? (await quote(found.asked.amount, found.asked.currency, "USD")).amount : found.amountUSD;
  const amountUSD = Math.min(Math.max(1, Math.round(askedUSD)), MAX_GIFT_USD);

  await new Promise((r) => setTimeout(r, OFFER_DELAY_MS));

  // Money requests and anything with scam markers go only to the trusted member (scam protection);
  // with no trusted member, nobody is asked (M-2). Real needs go to every non-elder.
  const signals = scamSignals(text);
  const risky = pre.category === "money" || signals.length > 0;
  const candidates = risky
    ? [trustedConfirmer(family, elder)].filter((m): m is FamilyMember => Boolean(m))
    : family.members.filter((m) => m.id !== elder.id && !isElder(m));

  // M-1: skip anyone who already has a money question open (their "yes" would be ambiguous).
  const offer: Offer = { status: "open", waiting: [], slots: new Map() };
  const helpers: FamilyMember[] = [];
  for (const h of candidates) {
    const release = claimMoneySlot(h);
    if (!release) continue;
    offer.slots.set(h.id, release);
    helpers.push(h);
  }
  if (!helpers.length) {
    recentOffers.delete(key); // nobody could be asked now; a later mention may be offered
    return;
  }

  const { she, her } = pronouns(elder);
  const question = async (helper: FamilyMember, again?: FamilyMember) => {
    const cur = isSupportedCurrency(helper.currency) ? helper.currency! : "USD";
    const q = await quote(amountUSD, "USD", cur);
    const amountStr = formatMoney(q.amount, q.currency);
    const lead = again ? `${again.name}'s payment didn't go through, so this is open again.\n` : "";
    let sentence: string;
    if (risky) {
      const quoted = (await translate(text, elder, helper, family)).text;
      const why = signals.length ? `\n${formatSignals(signals)}\nPlease call ${her} before sending anything.` : "";
      const what = pre.category === "money" ? `${she === "they" ? "are" : "is"} asking for money` : "mentioned a need";
      sentence = `${lead}${cap(she)} ${what}: “${quoted}”${why}\nSend ${her} this gift yourself? ❤️ or "yes" to send, "no" to skip. Bridge never sends money on its own.`;
    } else {
      sentence = `${lead}${cap(she)} mentioned ${she} ${she === "they" ? "need" : "needs"} ${found.need}. Send ${her} this gift? ❤️ or "yes" to send, "no" to skip.`;
    }
    return { text: await moneyPrompt(`${found.emoji} ${elder.name} · ${amountStr}`, sentence, helper, family), amount: q.amount, currency: q.currency };
  };

  const askHelper = async (helper: FamilyMember, again?: FamilyMember): Promise<void> => {
    let answer: Answer | null;
    let q: { amount: number; currency: string };
    try {
      const built = await question(helper, again);
      q = built;
      answer = await ask(helper.handle, built.text, OFFER_TIMEOUT_MS);
    } finally {
      offer.slots.get(helper.id)?.();
      offer.slots.delete(helper.id);
    }
    await onAnswer(helper, answer, q);
  };

  const onAnswer = async (helper: FamilyMember, answer: Answer | null, q: { amount: number; currency: string }): Promise<void> => {
    if (!isYes(answer)) {
      if (answer && offer.status !== "done" && risky) await say(helper, "OK, I didn't send anything.", family);
      return;
    }
    if (offer.status === "done") {
      await say(helper, "Already handled, thank you! ❤️", family);
      return;
    }
    if (offer.status === "paying") {
      offer.waiting.push(helper);
      await say(helper, `${offer.payer!.name} is already sending it. I'll tell you if it doesn't go through. ❤️`, family);
      return;
    }
    offer.status = "paying"; // first yes wins (set before any await so a second yes can't slip in)
    offer.payer = helper;

    const result = await needsDeps.sendGift(helper, elder, q.amount, q.currency);
    if (!result.ok && !result.maybeCharged) {
      // S-6: definitely not charged → reopen. Whoever said yes meanwhile is asked again.
      offer.status = "open";
      offer.payer = undefined;
      await say(helper, paymentFailedText(result), family);
      const retry = offer.waiting.splice(0);
      for (const h of retry) {
        const release = claimMoneySlot(h);
        if (!release) continue; // busy with another money question: don't make their yes ambiguous
        offer.slots.set(h.id, release);
        void askHelper(h, helper).catch((err) => console.error("[needs] re-offer failed", err));
      }
      return;
    }
    offer.status = "done";
    // Free the others: their old offer can only answer "already handled" now, so it may be superseded.
    for (const release of offer.slots.values()) release();
    offer.slots.clear();
    if (!result.ok) {
      // S-4: may have gone through. Don't reopen (that could pay twice).
      await say(helper, paymentFailedText(result), family);
      await Promise.all(offer.waiting.map((h) => say(h, `${helper.name}'s payment may have gone through, so I didn't ask anyone else. Thank you! ❤️`, family)));
      return;
    }
    const got = formatMoney(result.amountReceived, result.receivedCurrency);
    await say(helper, `✅ Sent ${formatMoney(result.amountSent, result.sentCurrency)} to ${elder.name} for ${found.need}. ❤️`, family);
    await say(elder, `🧧 ${helper.name} sent you ${got} for ${found.need}. ❤️`, family);
    await Promise.all(
      helpers.filter((h) => h.id !== helper.id).map((h) => say(h, `${helper.name} already took care of it ❤️`, family)),
    );
  };

  await Promise.all(helpers.map((h) => askHelper(h)));
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** With Claude: confirm it's a real need and pick a sensible amount. Without: category defaults. */
async function refine(text: string, elder: FamilyMember, pre: Detected): Promise<Detected | undefined> {
  if (!hasClaude()) return pre;
  try {
    const r = await callTool<{ isNeed: boolean; need?: string; suggestedAmountUSD?: number }>({
      system:
        "A grandparent wrote this message in a family chat. Decide whether they are mentioning a real, current need that a family member could help pay for (medicine, groceries, rent, bills, a doctor's visit, a broken appliance). Past purchases or general chat are NOT needs. Suggest a modest gift in US dollars.",
      content: `<sender>${elder.name} (${elder.relationship})</sender>\n<message>${text}</message>`,
      tool: {
        name: "report_need",
        description: "Report the need, if any.",
        input_schema: {
          type: "object",
          properties: {
            isNeed: { type: "boolean" },
            need: { type: "string", description: "2-4 English words, e.g. 'medicine', 'a new fridge'" },
            suggestedAmountUSD: { type: "number", description: "Modest amount in USD, e.g. 30" },
          },
          required: ["isNeed"],
        },
      },
      maxTokens: 200,
    });
    if (!r.isNeed) return undefined;
    const amt = Number(r.suggestedAmountUSD);
    return {
      ...pre,
      need: r.need?.trim() || pre.need,
      amountUSD: Number.isFinite(amt) && amt > 0 ? amt : pre.amountUSD,
    };
  } catch (err) {
    console.error("[needs] Claude check failed, using defaults", err);
    return pre;
  }
}

function pronouns(m: FamilyMember): { she: string; her: string } {
  const r = m.relationship.toLowerCase();
  if (/mother|grandma|grandmother|aunt|daughter|sister|wife/.test(r)) return { she: "she", her: "her" };
  if (/father|grandpa|grandfather|uncle|son|brother|husband/.test(r)) return { she: "he", her: "him" };
  return { she: "they", her: "them" };
}
