// Grandparents are common scam targets. Any money request coming from an
// elder is confirmed with a trusted family member before it goes through, and
// classic scam markers ("buy gift cards", "don't tell anyone", "bail") are named
// in that question so the confirmer knows WHY Bridge is worried. Owned by User 2.

import type { Family, FamilyMember } from "../types.js";

const ELDER_RELATIONSHIPS = ["grandmother", "grandfather", "grandparent"];

/** Gifts above this many US dollars are confirmed even when the sender isn't an elder (pass the USD amount). */
const LARGE_AMOUNT = 200;

export function isElder(member: FamilyMember): boolean {
  return ELDER_RELATIONSHIPS.includes(member.relationship.toLowerCase());
}

/**
 * True when a trusted member must approve first: the requester is an elder, the amount
 * is large, or the message has scam markers (pass `scamSignals(text)` as `signals`).
 * `amountUsd` is the gift converted to US dollars (an unknown/NaN amount always needs approval).
 * If this is true and there is no eligible confirmer, the gift must be refused (never self-approved).
 */
export function requiresConfirmation(requester: FamilyMember, amountUsd: number, signals: string[] = []): boolean {
  if (isElder(requester)) return true;
  if (signals.length > 0) return true;
  return !(amountUsd <= LARGE_AMOUNT);
}

/**
 * Every member who may approve this gift: trusted for money, and neither the requester nor the
 * person who would receive the money (nobody approves a gift to themselves).
 */
export function trustedConfirmers(family: Family, requester: FamilyMember, recipient?: FamilyMember): FamilyMember[] {
  return family.members.filter((m) => m.isTrustedForMoney === true && m.id !== requester.id && m.id !== recipient?.id);
}

/** The first eligible confirmer (see trustedConfirmers), or undefined when there is nobody. */
export function trustedConfirmer(family: Family, requester: FamilyMember, recipient?: FamilyMember): FamilyMember | undefined {
  return trustedConfirmers(family, requester, recipient)[0];
}

// Gift cards, e-gift / prepaid / reward cards and redeemable codes: what scammers ask elders to
// buy, because the "money" is gone as soon as the code is read out. Brands are matched only next
// to a card/code word where the brand is also an everyday word (a steam iron, vanilla cookies).
// Also used by shop/checkout.ts (scam target) and shop/catalog.ts (never shopping).
const GIFT_BRANDS = "itunes|apple|app ?store|google ?play|steam|razer|vanilla|amazon|target|walmart|netflix|xbox|playstation|psn|nintendo|ebay|best ?buy|sephora";
export const GIFT_CARD_MARKERS = new RegExp(
  [
    "\\be-?gift",
    "\\bgift[- ]?cards?\\b",
    "\\b(digital|wallet|store|game|gift|redeem|redemption|voucher|top[- ]?up|recharge) codes?\\b",
    "\\bpin\\b",
    "\\breward cards?\\b",
    "\\bpre-?paid\\b",
    "\\bitunes\\b",
    "\\bapp ?store (card|code|credit|gift)",
    "\\bapple (gift|store) (card|code)",
    "\\bgoogle ?play\\b",
    "\\bsteam (wallet|gift|card|code|credit|key)s?\\b",
    "\\brazer\\b",
    "\\bvanilla (visa|mastercard|gift|reward|prepaid|card)",
    "\\bamazon(\\.com)? (e-?)?gift",
    "礼品卡|禮品卡|购物卡|購物卡|充值卡|储值卡|儲值卡|预付卡|預付卡|点卡(?!片)|點卡(?!片)|点数卡|點數卡|游戏卡|遊戲卡|礼券|禮券|充值码|充值碼|兑换码|兌換碼",
    `(${GIFT_BRANDS})\\s*(卡|充值|码|碼)`,
  ].join("|"),
  "i",
);

// Each rule: what to look for, and the reason shown to the confirmer.
const MONEY_WORDS = /[$¥€£₩]|\d|\b(money|cash|pay|send|transfer|dollars?|bucks)\b|钱|錢|元|块|塊|转账|轉帳|汇款|匯款/i;
const URGENT_WORDS = /\b(urgent|urgently|right now|right away|immediately|asap|hurry|today only|emergency fee)\b|紧急|緊急|很急|马上|馬上|立刻|立即|赶快|趕快|快点|快點/i;

const RULES: { test: (text: string) => boolean; reason: string }[] = [
  {
    test: (t) => GIFT_CARD_MARKERS.test(t),
    reason: "mentions gift cards: a common scam",
  },
  {
    test: (t) => /\bwire\b|\bwiring\b|western union|moneygram|电汇|電匯|汇款到|匯款到/i.test(t),
    reason: "asks for a wire transfer: very hard to get back",
  },
  {
    test: (t) => /\b(crypto|cryptocurrency|bitcoin|btc|usdt|tether|ethereum|eth wallet)\b|比特币|比特幣|虚拟货币|虛擬貨幣|加密货币|加密貨幣|数字货币|數字貨幣/i.test(t),
    reason: "mentions crypto: a common scam",
  },
  {
    test: (t) =>
      /\b(don'?t|do not|dont) tell\b|\bkeep (it|this) (a )?secret\b|\bbetween (you and me|us)\b|别告诉|別告訴|不要告诉|不要告訴|不要跟.{0,6}说|不要跟.{0,6}說|保密/i.test(t),
    reason: "asks to keep it secret: a classic scam sign",
  },
  {
    test: (t) => URGENT_WORDS.test(t) && MONEY_WORDS.test(t),
    reason: "is urgent about money: scammers rush people",
  },
  {
    test: (t) => /\birs\b|\binternal revenue\b|\bsocial security (number|office)\b|税务局|稅務局|国税局|國稅局|公安局/i.test(t),
    reason: "mentions the IRS or a government office: they never ask for money by text",
  },
  {
    test: (t) => /\bbail\b|\bjail\b|\barrested\b|保释|保釋|被抓|坐牢|拘留/i.test(t),
    reason: "mentions bail or jail: a classic 'grandchild in trouble' scam",
  },
  {
    test: (t) => /https?:\/\/\S+|\bwww\.\S+|\b[\w-]+\.(ly|xyz|top|link|click|info|biz|io)\/\S*/i.test(t),
    reason: "includes a link: never pay through a link in a message",
  },
];

/** Classic scam markers in `text`, as short reasons ("mentions gift cards: a common scam"). Empty = none. */
export function scamSignals(text: string): string[] {
  return RULES.filter((r) => r.test(text)).map((r) => r.reason);
}

/** "⚠️ mentions gift cards: a common scam" lines for a confirmer's question ("" when there are none). */
export function formatSignals(signals: string[]): string {
  return signals.map((s) => `⚠️ ${s}`).join("\n");
}
