// Product finder for Bridge's shopping flow. Owned by User 2 (spec U2-10a).
//
//   detectShoppingNeed(family, sender, text) → ShoppingNeed | null   "我的血压计坏了" → a need for Nai Nai
//   findOptions(family, need)               → Option[] (top 3)       real search, else the curated catalog
//
// Pipeline: cheap regex pre-check → AI extraction (callTool) of who/what/budget/keywords → candidates
// from SerpApi Google Shopping (search.ts) or data/catalog.json → deterministic filters (cultural rules,
// budget, shipping) → AI ranking with a short English "why" → top 3. With no AI key, regex extraction
// and tag/keyword scoring do the same job. Nothing here ever throws.
//
// Cultural rules (gifts for an elder in a Chinese-speaking family), enforced in code, not just the prompt:
//   no clocks (送钟 sounds like attending a funeral), no sets of four (四 sounds like 死),
//   no pears (分梨 sounds like separation), no white/black flowers or chrysanthemums (funerals).
//   Elder-friendly features (large display, simple buttons, Chinese UI/voice) rank higher.
//   Gift amounts ending in 8 are lucky: see luckyAmount().
//
// Settings: none of its own beyond search.ts (SERPAPI_*, SHOP_SEARCH) and claude.ts (LLM_*, TRANSLATE_PROVIDER).
// Catalog file: data/catalog.json (fictional products and merchants; no links).

import { readFileSync } from "node:fs";
import { GIFT_CARD_MARKERS, isElder } from "../payments/scamCheck.js";
import { isSupportedCurrency, quote } from "../payments/visa.js";
import { callTool, hasClaude } from "../translate/claude.js";
import { searchMode, searchProducts } from "./search.js";
import type { Family, FamilyMember, LanguageCode } from "../types.js";

// ── Contracts (U2-10 / VISA-SHOPPING.md; optional fields are additive) ─────

export interface Product {
  id: string;
  name: Record<LanguageCode, string>; // at least "en"
  price: number;
  currency: string;
  merchant: string;
  shipsTo: string[]; // country codes ([] = unknown, for search results)
  tags: string[];
  image?: string; // local path (catalog) or https URL (search)
  url?: string; // product page link (search results only)
  rating?: number;
  reviews?: number;
  description?: string; // snippet/specs used for ranking
  category?: string; // catalog products only
}

export interface ShoppingNeed {
  forMember: FamilyMember;
  text: string;
  category: string; // medical-device | kitchen | phone | clothing | groceries | gift | home | other
  occasion?: string; // lunar-new-year | birthday | mothers-day | …
  budgetUsd?: number;
  keywordsEn?: string[]; // what to search for, in English: ["blood pressure monitor"]
  mustHave?: string[]; // features she needs: ["large display", "chinese voice"]
}

export interface Option {
  product: Product;
  why: string; // English, ≤25 words; callers translate per reader
}

export const CATEGORIES = ["medical-device", "kitchen", "phone", "clothing", "groceries", "gift", "home", "other"] as const;

const MAX_WHY_WORDS = 25;
const MAX_AI_CANDIDATES = 12;
const TOP_N = 3;

// ── Catalog ────────────────────────────────────────────────────────────────

let catalogCache: Product[] | undefined;

/** The curated demo catalog (data/catalog.json). [] if the file is missing or broken. */
export function loadCatalog(): Product[] {
  if (catalogCache) return catalogCache;
  try {
    const raw = JSON.parse(readFileSync(new URL("../../data/catalog.json", import.meta.url), "utf8"));
    const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray(raw?.products) ? raw.products : [];
    catalogCache = list.filter(
      (p): p is Product =>
        !!p && typeof p === "object" && typeof (p as Product).id === "string" && typeof (p as Product).name?.en === "string" &&
        typeof (p as Product).price === "number" && typeof (p as Product).currency === "string",
    ).map((p) => ({ ...p, shipsTo: Array.isArray(p.shipsTo) ? p.shipsTo : [], tags: Array.isArray(p.tags) ? p.tags : [], merchant: p.merchant || "Demo store" }));
  } catch (err) {
    console.warn(`[shop] could not read data/catalog.json: ${err instanceof Error ? err.message : err}`);
    catalogCache = [];
  }
  return catalogCache;
}

// ── Vocabulary (shared by detection and catalog matching) ──────────────────

interface Thing { re: RegExp; en: string; category: (typeof CATEGORIES)[number] }
const THINGS: Thing[] = [
  { re: /血压计|血壓計|血压仪|血壓儀|量血压|量血壓|blood ?pressure (monitor|cuff|machine)|\bbp monitor/i, en: "blood pressure monitor", category: "medical-device" },
  { re: /体温计|體溫計|温度计|溫度計|额温枪|額溫槍|thermometer/i, en: "thermometer", category: "medical-device" },
  { re: /药盒|藥盒|pill (box|organi[sz]er|case)/i, en: "pill organizer", category: "medical-device" },
  { re: /助听器|助聽器|hearing aid/i, en: "hearing aid", category: "medical-device" },
  { re: /电饭锅|電飯鍋|电锅|電鍋|饭锅|飯鍋|rice cooker/i, en: "rice cooker", category: "kitchen" },
  { re: /热水壶|熱水壺|水壶|水壺|电热壶|電熱壺|快煮壶|快煮壺|kettle/i, en: "electric kettle", category: "kitchen" },
  { re: /平板|ipad|\btablet\b/i, en: "tablet for seniors", category: "phone" },
  { re: /手机|手機|\b(cell ?phone|mobile phone|phone)\b/i, en: "senior phone big buttons", category: "phone" },
  { re: /羽绒服|羽絨服|外套|夹克|夾克|大衣|\b(jacket|coat)\b/i, en: "warm jacket", category: "clothing" },
  { re: /毛衣|开衫|開衫|\b(sweater|cardigan)\b/i, en: "warm sweater", category: "clothing" },
  { re: /围巾|圍巾|\bscarf\b/i, en: "scarf", category: "clothing" },
  { re: /拖鞋|\bslippers?\b/i, en: "non-slip slippers", category: "home" },
  { re: /台灯|檯燈|灯|燈|\blamp\b/i, en: "reading lamp", category: "home" },
  { re: /暖气|暖氣|电暖器|電暖器|暖炉|暖爐|取暖器|\b(space )?heater\b/i, en: "space heater", category: "home" },
  { re: /夜灯|夜燈|night ?light/i, en: "night light", category: "home" },
  { re: /零食|点心|點心|\bsnacks?\b/i, en: "snack gift box", category: "groceries" },
  { re: /茶叶|茶葉|\btea\b/i, en: "tea gift", category: "groceries" },
  { re: /水果|\bfruit\b/i, en: "fruit gift box", category: "groceries" },
  { re: /\b(groceries|grocery)\b|菜|食物|吃的/i, en: "groceries", category: "groceries" },
  { re: /冰箱|\b(fridge|refrigerator)\b/i, en: "refrigerator", category: "home" },
  { re: /洗衣机|洗衣機|\b(washer|washing machine)\b/i, en: "washing machine", category: "home" },
  { re: /微波炉|微波爐|\bmicrowave\b/i, en: "microwave oven", category: "kitchen" },
  { re: /电视|電視|\btv\b|\btelevision\b/i, en: "tv", category: "home" },
  { re: /按摩|massager/i, en: "neck massager", category: "gift" },
  { re: /礼物|禮物|红包|紅包|\b(gift|present)\b/i, en: "gift", category: "gift" },
];

const FEATURES: { re: RegExp; en: string; tags: string[] }[] = [
  { re: /字(要|)大|大字|大屏|大螢幕|大萤幕|看(得|的)清|看不清|屏幕大|螢幕大|显示大|顯示大|\b(big|large|huge|easy[- ]to[- ]read) (screen|display|numbers|digits|text|font)\b/i, en: "large display", tags: ["large-display", "large-print"] },
  { re: /中文|语音|語音|会说话|會說話|\b(chinese|mandarin|cantonese)\b(?!\s+new\s+year)|\b(talking|voice)\b/i, en: "chinese voice", tags: ["chinese-voice", "chinese-labels"] },
  { re: /简单|簡單|按钮大|按鈕大|大按键|大按鍵|好用|容易|\b(simple|easy to use|big buttons?|large buttons?)\b/i, en: "simple buttons", tags: ["simple-buttons", "one-touch", "large-switch"] },
  { re: /保暖|暖和|\b(warm|warmer)\b/i, en: "warm", tags: ["warm"] },
  { re: /防滑|\bnon[- ]?slip\b/i, en: "non-slip", tags: ["non-slip"] },
];

const OCCASIONS: { re: RegExp; id: string }[] = [
  { re: /过年|過年|春节|春節|新年|农历年|農曆年|拜年|\b(lunar|chinese) new year\b|\bspring festival\b/i, id: "lunar-new-year" },
  { re: /生日|寿|壽|\bbirthday\b/i, id: "birthday" },
  { re: /母亲节|母親節|\bmother'?s day\b/i, id: "mothers-day" },
  { re: /中秋|\bmoon ?festival\b|\bmid-autumn\b/i, id: "mid-autumn" },
];

// Rent, bills and money are handled by payments/needs.ts, never as shopping. Gift cards, prepaid
// cards and redeemable codes (GIFT_CARD_MARKERS, shared with the scam check) are never shopped for.
const NOT_SHOPPING_WORDS = /\b(rent|bills?|electricity|utilities|utility|mortgage|loan|tuition|gift ?cards?)\b|房租|租金|电费|電費|水费|水費|账单|帳單|瓦斯费|瓦斯費|贷款|貸款|学费|學費|礼品卡|禮品卡/i;
const NOT_SHOPPING = { test: (t: string) => NOT_SHOPPING_WORDS.test(t) || GIFT_CARD_MARKERS.test(t) };
// Strong triggers: an explicit request to buy/find something.
const STRONG = /想买|想買|帮我找|幫我找|帮我买|幫我買|买个|買個|买一[个個台件双雙]|買一[个個台件双雙]|想要[一个個台]*|\bwant(s)? to buy\b|\b(find|buy|get|order)\b.{1,60}\bfor\b|\b(find|buy|order)\s+(?:[\w']+\s+){0,3}(a|an|some|new)\s+\w+|\bneed(s)? a new\b|\blooking for an?\b|\bshop(ping)? for\b/i;
// Weak triggers: only count with a known object ("我的血压计坏了", "my kettle broke", "需要一个热水壶").
// Possible shopping, for the AI to decide when no known product word matched ("我的眼镜坏了",
// "可以帮我买个电热毯吗", "can we get grandma a new phone?"). Only used when an AI key is set, so
// everyday chat ("I'll get home late") stays cheap: each phrase needs a buy/need/broken cue.
const MAYBE =
  /想买|想買|想要|想换|想換|换个|換個|换一|換一|帮我买|幫我買|帮我找|幫我找|帮我看看|幫我看看|买个|買個|买一|買一|买双|買雙|买件|買件|买台|買台|需要|坏了|壞了|不能用|不灵|不靈|有没有.{0,12}(好|推荐|推薦)|有沒有.{0,12}(好|推荐|推薦)|哪个.{0,12}好|哪個.{0,12}好|推荐|推薦|\b(buy|order|purchase|shop for)\b|\bget (her|him|them|grandma|grandpa|nai ?nai|ye ?ye|mom|dad|a|an|some|new)\b|\b(broke|broken|stopped working|doesn'?t work|not working)\b|\bneed(s)? (a|an|new|some|another)\b|\blooking for\b|\brecommend\b|\breplace\b|\b(gift|present)s?\b|\bideas? for\b|礼物|禮物|送.{0,6}什么|送.{0,6}什麼/i;

const WEAK = /坏了|壞了|不能用|不灵|不靈|需要|缺|\bbroke(n)?\b|\bstopped working\b|\bdoesn'?t work\b|\bneed(s)? an?\b|\bran out of\b/i;

const RELATION_WORDS: [RegExp, (m: FamilyMember) => boolean][] = [
  [/奶奶|外婆|婆婆|阿嬤|阿嬷|姥姥|\b(grandma|grandmother|nai ?nai|granny|po ?po)\b/i, (m) => /grandmother/i.test(m.relationship)],
  [/爷爷|爺爺|外公|阿公|姥爷|姥爺|\b(grandpa|grandfather|ye ?ye|gong ?gong)\b/i, (m) => /grandfather/i.test(m.relationship)],
  [/妈妈|媽媽|\b(mom|mother|mum)\b/i, (m) => /^mother$/i.test(m.relationship)],
  [/爸爸|\b(dad|father)\b/i, (m) => /^father$/i.test(m.relationship)],
];

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Who a message names ("find Nai Nai a…", "给奶奶买…"), if anyone. */
function mentionedMember(family: Family, sender: FamilyMember, text: string): FamilyMember | undefined {
  for (const m of family.members) {
    if (m.id === sender.id) continue;
    const names = [m.name, m.id].filter((n) => n && n.length >= 2).map((n) => escapeRe(n).replace(/\s+/g, "\\s*"));
    if (names.length && new RegExp(`(^|[^A-Za-z])(${names.join("|")})($|[^A-Za-z])`, "i").test(text)) return m;
  }
  for (const [re, pick] of RELATION_WORDS) {
    if (re.test(text)) {
      const m = family.members.find((x) => x.id !== sender.id && pick(x));
      if (m) return m;
    }
  }
  return undefined;
}

// "buy me …", "find me …", "get me …", "给我买…", "帮我买…": for the sender, unless someone is named
// after "for" / "给" / "送" ("find me a gift for grandma", "帮我买个礼物给奶奶").
const FOR_SENDER = /\b(?:buy|find|get|order)\s+me\b|给我买|給我買|帮我买|幫我買|帮我找|幫我找|给我找|給我找/i;

function defaultRecipient(family: Family, sender: FamilyMember, text: string): FamilyMember {
  const self = FOR_SENDER.exec(text);
  if (self) {
    const rest = text.slice(self.index + self[0].length);
    const target = /\bfor\b|给|給|送/i.exec(rest);
    const named = target ? mentionedMember(family, sender, rest.slice(target.index)) : undefined;
    return named ?? sender;
  }
  const named = mentionedMember(family, sender, text);
  if (named) return named;
  if (isElder(sender)) return sender;
  // "find a heater for me" / "I need a new kettle" from a non-elder: for themselves.
  if (/\b(for me|myself|i need|my)\b|给我|給我|我的/i.test(text)) return sender;
  return family.members.find(isElder) ?? sender;
}

/** Regex-only reading of a message. Exported for tests. */
export function quickNeed(family: Family, sender: FamilyMember, text: string): ShoppingNeed | null {
  const t = text.trim();
  if (!t || NOT_SHOPPING.test(t)) return null;
  const thing = THINGS.find((x) => x.re.test(t));
  const strong = STRONG.test(t);
  if (!strong && !(WEAK.test(t) && thing && thing.en !== "gift" && thing.en !== "groceries")) return null;
  const occasion = OCCASIONS.find((o) => o.re.test(t))?.id;
  const features = FEATURES.filter((f) => f.re.test(t)).map((f) => f.en);
  const forMember = defaultRecipient(family, sender, t);
  let keyword = (thing && thing.en !== "gift" && thing.en) || englishObject(family, t);
  if (!keyword && thing?.en === "gift") {
    // "for grandmother" only when the gift really is for an elder.
    const elder = isElder(forMember) ? (/grandfather/i.test(forMember.relationship) ? " for grandfather" : /grandmother/i.test(forMember.relationship) ? " for grandmother" : " for grandparent") : "";
    keyword = `${occasion === "lunar-new-year" ? "lunar new year gift" : "gift"}${elder}`;
  }
  if (!keyword && !strong) return null;
  if (!keyword && !thing && !occasion) return null; // "find someone to help": nothing to buy
  const need: ShoppingNeed = {
    forMember,
    text: t,
    category: thing?.category ?? (occasion ? "gift" : "other"),
  };
  if (occasion) need.occasion = occasion;
  if (keyword) need.keywordsEn = [keyword];
  if (features.length) need.mustHave = features;
  const budget = budgetFromText(t);
  if (budget) need.budgetUsd = budget;
  return need;
}

// "find me a time to call", "find someone to help", "get a ride": not things you can buy.
const NOT_AN_OBJECT = /^(something|anything|it|this|that|(a |the )?(time|way|minute|moment|chance|ride|date|place|spot|seat|slot|room|job|reason|answer|word|someone|somebody|anyone|anybody|person|people|help|doctor|nurse|keys?|phone number|number|address|out)\b.*)$/;

/** "buy grandma a warm jacket for winter" → "warm jacket" (best effort). */
function englishObject(family: Family, text: string): string | undefined {
  let t = text;
  for (const m of family.members) for (const n of [m.name, m.id]) if (n && n.length >= 2) t = t.replace(new RegExp(escapeRe(n), "gi"), " ");
  t = t.replace(/\b(grandma|grandmother|grandpa|grandfather|granny|mom|dad)\b/gi, " ").replace(/\s+/g, " ");
  const m = t.match(/\b(?:buy|find|get|order|need a new|looking for)\s+(?:(?:her|him|me|them|us|my|our)\s+)?(?:(?:a|an|some|the|new)\s+)?([a-z][a-z -]{2,40}?)(?=\s+(?:for|that|with|under|before|to|this|next)\b|[.,!?]|$)/i);
  const obj = m?.[1]?.trim().toLowerCase();
  return obj && !NOT_AN_OBJECT.test(obj) ? obj : undefined;
}

/** "$50", "under 60 dollars", "50 USD", "預算 1500 元" (elder's currency is converted later by the AI path). */
function budgetFromText(text: string): number | undefined {
  const m = text.match(/(?:US)?\$\s?(\d{1,5}(?:\.\d+)?)|(\d{1,5}(?:\.\d+)?)\s?(?:dollars|usd|bucks|美元|美金)/i);
  const n = Number(m?.[1] ?? m?.[2]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ── detectShoppingNeed ─────────────────────────────────────────────────────

const DETECT_TOOL = {
  name: "shopping_need",
  description: "Report whether the message asks to buy something, and if so who it is for and what to search for.",
  input_schema: {
    type: "object" as const,
    properties: {
      isShopping: { type: "boolean", description: "True only if someone wants or needs to BUY a physical product (not rent, bills, money, gift cards, or a past purchase)." },
      forMemberId: { type: "string", description: "id of the family member the product is for" },
      category: { type: "string", enum: [...CATEGORIES] },
      occasion: { type: "string", description: "lunar-new-year, birthday, mothers-day, mid-autumn, or empty" },
      budgetUsd: { type: "number", description: "budget in US dollars if stated (convert other currencies), else 0" },
      keywordsEn: { type: "array", items: { type: "string" }, description: "1-3 short English shopping search phrases, most important first, e.g. 'blood pressure monitor'" },
      mustHave: { type: "array", items: { type: "string" }, description: "features the person asked for, in English, e.g. 'large display', 'chinese voice', 'simple buttons'" },
    },
    required: ["isShopping"],
  },
};

interface Detected {
  isShopping: boolean;
  forMemberId?: string;
  category?: string;
  occasion?: string;
  budgetUsd?: number;
  keywordsEn?: string[];
  mustHave?: string[];
}

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim().slice(0, 60)).slice(0, max) : [];

/** A shopping need in `text`, or null. Cheap regex first; the AI only sees likely candidates. Never throws. */
export async function detectShoppingNeed(family: Family, sender: FamilyMember, text: string): Promise<ShoppingNeed | null> {
  try {
    let quick = quickNeed(family, sender, text ?? "");
    // No known product word: let the AI decide, if there's a buying / need / broken cue at all.
    const aiOnly = !quick && hasClaude() && MAYBE.test(text ?? "") && !NOT_SHOPPING.test(text ?? "");
    if (!quick && aiOnly) quick = { forMember: defaultRecipient(family, sender, (text ?? "").trim()), text: (text ?? "").trim(), category: "other" };
    if (!quick) return null;
    if (!hasClaude()) return quick;
    let d: Detected;
    try {
      d = await callTool<Detected>({
        system:
          "You read one message from a family group chat (Chinese and English speakers) and decide if someone wants to buy a product. " +
          "It IS shopping when someone wants, needs or asks for help choosing a product: a broken thing to replace, 'can you buy…', 'which … is good?', or 'what should we get grandma for her birthday?' (gift ideas: use gift keywords such as 'birthday gift for grandmother'). " +
            "Rent, bills, sending money, gift cards and things already bought are NOT shopping. " +
          "If the sender is an elder talking about her own broken or missing item, it is for her. " +
          "Write keywordsEn as concise English Google Shopping queries. Translate Chinese wishes like 字要大 into mustHave 'large display'.",
        content: JSON.stringify({
          sender: sender.id,
          members: family.members.map((m) => ({ id: m.id, name: m.name, relationship: m.relationship, language: m.language })),
          message: text,
        }),
        tool: DETECT_TOOL,
        maxTokens: 400,
      });
    } catch (err) {
      console.warn(`[shop] need extraction failed (${err instanceof Error ? err.message : err}); using keywords`);
      return aiOnly ? null : quick; // nothing to search for without the AI's keywords
    }
    if (!d || d.isShopping !== true) return null;
    const forMember = family.members.find((m) => m.id === d.forMemberId) ?? quick.forMember;
    const category = (CATEGORIES as readonly string[]).includes(d.category ?? "") ? d.category! : quick.category;
    const need: ShoppingNeed = { forMember, text: quick.text, category };
    const occasion = typeof d.occasion === "string" && /^[a-z-]{3,30}$/.test(d.occasion) ? d.occasion : quick.occasion;
    if (occasion) need.occasion = occasion;
    const budget = typeof d.budgetUsd === "number" && Number.isFinite(d.budgetUsd) && d.budgetUsd > 0 ? d.budgetUsd : quick.budgetUsd;
    if (budget) need.budgetUsd = Math.min(budget, 100_000);
    const kw = strings(d.keywordsEn, 3);
    need.keywordsEn = kw.length ? kw : quick.keywordsEn;
    const must = strings(d.mustHave, 5);
    if (must.length || quick.mustHave) need.mustHave = must.length ? must : quick.mustHave;
    if (!need.keywordsEn?.length) delete need.keywordsEn;
    if (aiOnly && !need.keywordsEn) return null; // the AI said shopping but named nothing to search for
    return need;
  } catch (err) {
    console.warn(`[shop] detectShoppingNeed failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── Cultural rules ─────────────────────────────────────────────────────────

const shipCountry = (m: FamilyMember): string | undefined => {
  const c = (m as FamilyMember & { shipTo?: { country?: string } }).shipTo?.country;
  return typeof c === "string" && c.trim() ? c.trim().toUpperCase() : undefined;
};

/** True when the recipient's family follows Chinese gift customs (an elder, or anyone writing Chinese). */
function chineseCustoms(member: FamilyMember): boolean {
  return /^(zh|yue|cmn|wuu|nan)\b/i.test(member.language) || isElder(member);
}

const CULTURE_RULES: { reason: string; tags: string[]; re: RegExp }[] = [
  { reason: "a clock as a gift sounds like 送终 (attending a funeral)", tags: ["clock"], re: /(?<!\bwith\s)(?<!\band\s)\bclocks?\b(?!\s*(function|feature|setting|display))|[钟鐘](?![点點头頭])/i },
  { reason: "sets of four sound like 死 (death)", tags: ["set-of-4"], re: /\b(set|pack|box) of (4|four)\b|\b(4|four)[- ]?(piece|pc|pcs|pack|count|ct)\b|四(件|入|只|個|个)[组組套]?/i },
  { reason: "sharing pears sounds like 分离 (separation)", tags: ["pear"], re: /\bpears?\b|(?<![凤鳳菠])梨/i },
  { reason: "white or black flowers are for funerals", tags: ["white-flowers"], re: /\b(white|black)\s+(flowers?|roses?|lil(y|ies)|chrysanthemums?|carnations?|bouquet)\b|\bchrysanthemums?\b|菊花|白花|白菊/i },
];

/** Why `product` would be a bad gift for `member` (Chinese customs), or undefined if it's fine. */
export function culturalProblem(product: Product, member: FamilyMember): string | undefined {
  if (!chineseCustoms(member)) return undefined;
  const text = `${product.name.en ?? ""} ${product.name.zh ?? ""}`;
  for (const rule of CULTURE_RULES) {
    if (product.tags.some((t) => rule.tags.includes(t)) || rule.re.test(text)) return rule.reason;
  }
  return undefined;
}

/** A gift amount nudged to end in 8 (lucky): 50 → 58, 100 → 108, 20 → 28. */
export function luckyAmount(amount: number): number {
  if (!(amount > 0)) return 8;
  const base = Math.floor(amount / 10) * 10;
  return base + 8 >= amount ? base + 8 : base + 18;
}

// ── findOptions ────────────────────────────────────────────────────────────

interface Candidate { product: Product; usd: number; score: number; matched: string[]; exact: boolean }

const STOP = new Set(["a", "an", "the", "for", "with", "and", "of", "to", "new", "her", "his", "my", "gift", "elderly", "seniors", "senior"]);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

// Words that say nothing about WHAT the thing is: never enough on their own to make a product relevant.
const GENERIC = new Set([
  ...STOP, "good", "best", "nice", "cheap", "elder", "elders", "grandma", "grandmother", "grandpa", "grandfather", "grandparent",
  "grandparents", "mom", "dad", "parent", "parents", "old", "older", "people", "person", "machine", "device", "thing", "item", "product",
  "one", "some", "non", "big", "large", "small", "simple", "easy", "button", "buttons", "display", "screen", "chinese", "voice", "warm",
  "friendly", "use", "home", "electric", "set", "pack", "box", "christmas", "present", "her", "him", "me", "them", "buy", "find", "want",
]);
const stem = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const objectWords = (s: string) => [...new Set(words(s).filter((w) => !GENERIC.has(w)).map(stem))];

/** The words naming what she wants: keywordsEn + mustHave + objects named in the (Chinese) text. */
function needWords(need: ShoppingNeed): string[] {
  const src = [...(need.keywordsEn ?? []), ...(need.mustHave ?? []), ...THINGS.filter((t) => t.en && t.re.test(need.text ?? "")).map((t) => t.en)];
  return [...new Set(src.flatMap(objectWords))];
}

/** True when `p` shares at least one meaningful word with the need (whole words, simple plural stemming). */
function sharesKeyword(p: Product, need: ShoppingNeed, wanted = needWords(need)): boolean {
  if (!wanted.length) return false;
  const have = new Set(`${p.name.en ?? ""} ${p.tags.join(" ")} ${p.category ?? ""} ${p.description ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).map(stem));
  return wanted.some((w) => have.has(w));
}

function productText(p: Product): string {
  return `${p.name.en ?? ""} ${p.tags.join(" ")} ${p.description ?? ""}`.toLowerCase();
}

function featureTags(need: ShoppingNeed): string[] {
  const out = new Set<string>();
  for (const m of need.mustHave ?? []) {
    out.add(m.toLowerCase().trim().replace(/\s+/g, "-"));
    for (const f of FEATURES) if (f.re.test(m) || f.en === m.toLowerCase()) f.tags.forEach((t) => out.add(t));
  }
  return [...out];
}

const TAG_PHRASES: Record<string, string> = {
  "large-display": "big easy-to-read display",
  "large-print": "large print labels",
  "chinese-voice": "Chinese voice prompts",
  "chinese-labels": "Chinese-language labels",
  "simple-buttons": "simple buttons",
  "one-touch": "one-touch start",
  "large-switch": "one big switch",
  "auto-shutoff": "auto shut-off for safety",
  "non-slip": "non-slip sole",
  "sos-button": "SOS button that calls family",
  warm: "keeps her warm",
  "lunar-new-year": "a fitting New Year gift",
  lucky: "a lucky New Year symbol",
  "soft-food": "soft and easy to eat",
  "elder-friendly": "designed for seniors",
  "video-call": "one-tap video calls with family",
};

function clipWords(s: string, n = MAX_WHY_WORDS): string {
  const w = s.trim().replace(/\s+/g, " ").split(" ");
  return w.length <= n ? w.join(" ") : `${w.slice(0, n).join(" ").replace(/[,;:]$/, "")}…`;
}

function fallbackWhy(c: Candidate, need: ShoppingNeed): string {
  const tags = [...new Set([...c.matched, ...c.product.tags])].filter((t) => TAG_PHRASES[t]);
  const phrases = [...new Set(tags.map((t) => TAG_PHRASES[t]))].slice(0, 3);
  const country = shipCountry(need.forMember);
  if (country && c.product.shipsTo.includes(country)) phrases.push(`ships to ${country}`);
  if (c.product.rating && c.product.reviews) phrases.push(`rated ${c.product.rating}/5 by ${c.product.reviews} buyers`);
  const desc = (c.product.description ?? "").split(/[.;·]/)[0].trim();
  if (phrases.length < 2 && desc) phrases.push(desc.split(/\s+/).slice(0, 14).join(" ").replace(/,$/, "").replace(/^./, (ch) => ch.toLowerCase()));
  if (!phrases.length) return clipWords(`A good match for ${need.keywordsEn?.[0] ?? need.category}.`);
  const text = phrases.join(", ");
  return clipWords(text[0].toUpperCase() + text.slice(1) + ".");
}

const rateCache = new Map<string, number>();
async function toUsd(amount: number, currency: string): Promise<number | undefined> {
  const cur = currency.toUpperCase();
  if (cur === "USD") return amount;
  if (!isSupportedCurrency(cur)) return undefined;
  let rate = rateCache.get(cur);
  if (rate === undefined) {
    const q = await quote(1, cur, "USD");
    rate = q.amount > 0 ? q.amount : NaN;
    if (Number.isFinite(rate)) rateCache.set(cur, rate);
  }
  return Number.isFinite(rate) ? amount * rate! : undefined;
}

function score(p: Product, need: ShoppingNeed, feats: string[]): { score: number; matched: string[]; relevant: boolean; exact: boolean } {
  const text = productText(p);
  const kws = need.keywordsEn ?? [];
  const primary = words(kws[0] ?? "");
  const primaryHit = primary.length > 0 && primary.every((w) => text.includes(w));
  const kwHits = new Set(kws.flatMap(words).filter((w) => text.includes(w))).size;
  const categoryHit = !!p.category && p.category === need.category;
  const occasionHit = !!need.occasion && p.tags.includes(need.occasion);
  const matched = feats.filter((f) => p.tags.includes(f) || text.includes(f.replace(/-/g, " ")));
  const giftBonus = need.category === "gift" && p.tags.includes("gift") ? 1 : 0;
  const elderBonus = isElder(need.forMember) ? ["elder-friendly", "large-display", "simple-buttons", "chinese-voice", "warm"].filter((t) => p.tags.includes(t)).length * 0.5 : 0;
  const chineseBonus = /^zh/i.test(need.forMember.language) && p.tags.some((t) => t.startsWith("chinese")) ? 1 : 0;
  const ratingBonus = p.rating ? (p.rating - 3) * 0.5 + Math.min(Math.log10((p.reviews ?? 0) + 1), 4) * 0.25 : 0;
  const s = (primaryHit ? 4 : 0) + kwHits + (categoryHit ? 3 : 0) + (occasionHit ? 2 : 0) + matched.length * 2 + giftBonus + elderBonus + chineseBonus + ratingBonus;
  // A catalog item must be the kind of thing she asked for; a search result is relevant by construction.
  // Relevance (catalog and search alike): when the need names a thing ("refrigerator"), a product must share a
  // meaningful word with it; a matching category alone isn't enough (a lamp is "home" too). Only a need with no
  // object words (e.g. "a New Year gift") may match on category or occasion.
  const wanted = needWords(need);
  const relevant = wanted.length
    ? sharesKeyword(p, need, wanted)
    : p.category === undefined || categoryHit || (occasionHit && need.category === "gift");
  return { score: s, matched, relevant, exact: primaryHit };
}

async function candidates(products: Product[], need: ShoppingNeed, fromCatalog: boolean): Promise<Candidate[]> {
  const feats = featureTags(need);
  const country = shipCountry(need.forMember);
  const out: Candidate[] = [];
  for (const p of products) {
    if (!(p.price > 0)) continue;
    if (culturalProblem(p, need.forMember)) continue;
    const usd = await toUsd(p.price, p.currency);
    if (usd === undefined) continue; // can't price it for the family
    if (need.budgetUsd && usd > need.budgetUsd * 1.0001) continue;
    if (fromCatalog && country && p.shipsTo.length && !p.shipsTo.includes(country)) continue;
    const s = score(p, need, feats);
    if (!s.relevant) continue;
    out.push({ product: p, usd, score: s.score, matched: s.matched, exact: s.exact });
  }
  out.sort((a, b) => b.score - a.score || a.usd - b.usd);
  // "a heater" → only heaters when the catalog has at least two, not a lamp from the same category.
  const exact = out.filter((c) => c.exact);
  return fromCatalog && exact.length >= 2 ? exact : out;
}

const RANK_TOOL = {
  name: "rank_products",
  description: "Pick the best products for this person, best first, each with a short reason.",
  input_schema: {
    type: "object" as const,
    properties: {
      picks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "candidate index from the list" },
            why: { type: "string", description: "English, at most 25 words, specific to her needs, e.g. 'Big display and Chinese voice prompts; one button.'" },
          },
          required: ["index", "why"],
        },
      },
    },
    required: ["picks"],
  },
};

async function aiRank(list: Candidate[], need: ShoppingNeed): Promise<Option[] | undefined> {
  try {
    const m = need.forMember;
    const res = await callTool<{ picks?: { index?: unknown; why?: unknown }[] }>({
      system:
        `You help a family shop for ${m.name} (${m.relationship}, reads ${m.language}). Choose up to ${TOP_N} products that best fit HER: ` +
        "prefer what she asked for, large displays, simple buttons, Chinese-language UI or voice, good ratings with many reviews, fair prices. " +
        "Skip items that are not what she needs. Write each 'why' in English, at most 25 words, naming the concrete features that help her. " +
        "Never invent features that the description doesn't mention.",
      content: JSON.stringify({
        request: need.text,
        lookingFor: need.keywordsEn ?? [need.category],
        mustHave: need.mustHave ?? [],
        occasion: need.occasion ?? "",
        budgetUsd: need.budgetUsd ?? null,
        candidates: list.map((c, i) => ({
          index: i,
          title: c.product.name.en,
          priceUsd: Math.round(c.usd * 100) / 100,
          rating: c.product.rating ?? null,
          reviews: c.product.reviews ?? null,
          merchant: c.product.merchant,
          features: c.product.tags,
          description: (c.product.description ?? "").slice(0, 300),
        })),
      }),
      tool: RANK_TOOL,
      maxTokens: 600,
    });
    const picks = Array.isArray(res?.picks) ? res.picks : [];
    const used = new Set<number>();
    const out: Option[] = [];
    for (const p of picks) {
      const i = typeof p?.index === "number" ? Math.trunc(p.index) : Number(p?.index);
      if (!Number.isInteger(i) || i < 0 || i >= list.length || used.has(i)) continue;
      used.add(i);
      const why = typeof p.why === "string" && p.why.trim() ? clipWords(p.why) : fallbackWhy(list[i], need);
      out.push({ product: list[i].product, why });
      if (out.length >= TOP_N) break;
    }
    if (!out.length) return undefined;
    // The model picked fewer than it could: top up from the scored order.
    for (let i = 0; i < list.length && out.length < Math.min(TOP_N, list.length); i++) {
      if (!used.has(i)) out.push({ product: list[i].product, why: fallbackWhy(list[i], need) });
    }
    return out;
  } catch (err) {
    console.warn(`[shop] AI ranking failed (${err instanceof Error ? err.message : err}); using tag scores`);
    return undefined;
  }
}

function searchQuery(need: ShoppingNeed): string {
  const main = need.keywordsEn?.[0] ?? (need.category !== "other" ? need.category.replace(/-/g, " ") : "");
  const extras = (need.mustHave ?? []).filter((f) => !/chinese/i.test(f)).slice(0, 2); // "chinese voice" over-narrows US results
  const q = [main, ...extras].join(" ").trim();
  return isElder(need.forMember) && q && !/senior|elder/i.test(q) ? `${q} for seniors` : q;
}

/** Up to 3 options that fit the person, best first. Never throws; [] means nothing fits. */
export async function findOptions(family: Family, need: ShoppingNeed): Promise<Option[]> {
  try {
    void family;
    let list: Candidate[] = [];
    if (searchMode() === "serpapi") {
      const q = searchQuery(need);
      const results = q ? await searchProducts(q, { maxPriceUsd: need.budgetUsd }) : [];
      list = await candidates(results, need, false);
      if (!list.length && results.length) console.warn("[shop] no search result fits; using the catalog");
    }
    if (!list.length) list = await candidates(loadCatalog(), need, true);
    if (!list.length) return [];
    const top = list.slice(0, MAX_AI_CANDIDATES);
    if (top.length > 1 && hasClaude()) {
      const ranked = await aiRank(top, need);
      if (ranked) return ranked;
    }
    return top.slice(0, TOP_N).map((c) => ({ product: c.product, why: fallbackWhy(c, need) }));
  } catch (err) {
    console.warn(`[shop] findOptions failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}
