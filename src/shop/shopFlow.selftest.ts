// Offline self-test for the shopping conversation (spec U2-10c).
//   npx tsx src/shop/shopFlow.selftest.ts
// Mock photon, no API keys (placeholder translations "[en→zh] …"), answers via tryResolvePrompt.
// Exits non-zero on failure.

process.env.PHOTON_MODE = "mock";
process.env.VISA_MODE = "mock";
process.env.SHOP_MODE = "mock";
process.env.SHOP_SEARCH = "catalog";
process.env.ANTHROPIC_API_KEY = "";
process.env.LLM_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.SERPAPI_API_KEY = "";
process.env.TRANSLATE_PROVIDER = "anthropic";
delete process.env.SHOP_VOTE_TIMEOUT_MS;
delete process.env.PAYMENT_CONFIRM_TIMEOUT_MS;

const lines: string[] = [];
const realLog = console.log;
const realWarn = console.warn;
console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
console.warn = () => {};

const { getFamilyByHandle, getAllMembers } = await import("../db/store.js");
const { tryResolvePrompt } = await import("../relay/prompts.js");
const { tryHandlePayment, resetMoneySlotsForTests, claimMoneySlot } = await import("../payments/flow.js");
const catalog = await import("./catalog.js");
const { resetNeedsForTests } = await import("../payments/needs.js");
const { tryHandleShopping, shopDeps, hasOpenDecision, resetShoppingForTests, pickBuyer } = await import("./shopFlow.js");
const { u1Options, parseVote, tally } = await import("./u1.js");
import type { Family, FamilyMember, IncomingMessage, TapbackKind } from "../types.js";
import type { Option, ShoppingNeed } from "./catalog.js";

u1Options.useStandIns = true; // test the stand-ins even if User 1's modules are merged

const members = getAllMembers();
const m = (id: string) => members.find((x) => x.id === id)!;
const kevin = m("kevin"), mei = m("mei"), nainai = m("nainai");
const family = getFamilyByHandle(kevin.handle)!;
// Create the mock port once before anything sends: concurrent first sends would otherwise each
// create their own mock (photon/client.ts getPort), and every message would be "#b1".
await (await import("../photon/client.js")).setTyping(kevin.handle, false);

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passes++;
  else {
    failures++;
    realLog(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
  }
}

let seq = 0;
const msg = (from: FamilyMember, text: string): IncomingMessage => ({ id: `s${++seq}`, fromHandle: from.handle, kind: "text", text, receivedAt: new Date() });
const tap = (from: FamilyMember, id: string, tapback: TapbackKind): IncomingMessage => ({ id, fromHandle: from.handle, kind: "tapback", tapback, receivedAt: new Date() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isPhone = (who: FamilyMember) => (l: string) => l.includes(`📱 ${who.name.padEnd(10)}`);
const dump = (from: number) => lines.slice(from).join("\n    ");

/** The first NEW line (after `from`) for `who` containing `text`, waiting up to `ms`. */
async function lineFor(who: FamilyMember, text: string, from: number, ms = 3000): Promise<string | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = lines.slice(from).find((l) => isPhone(who)(l) && l.includes(text));
    if (hit) return hit;
    await sleep(15);
  }
  return undefined;
}
const saw = (who: FamilyMember, text: string, from: number) => lines.slice(from).some((l) => isPhone(who)(l) && l.includes(text));
const idOf = (line: string | undefined) => line?.match(/#(b\d+)/)?.[1] ?? "";
/** The full printed message starting at a phone line (continuation lines are joined into it by the mock). */
const body = (line: string | undefined) => (line ?? "").split("\n").map((l) => l.replace(/^.*│\s?/, "").replace(/^#b\d+\s+/, ""));
async function settle() {
  const end = Date.now() + 5000;
  while (hasOpenDecision(family) && Date.now() < end) await sleep(20);
  await sleep(50);
}
function reset() {
  resetShoppingForTests();
  resetNeedsForTests();
  resetMoneySlotsForTests();
}


// ── Fake finder: the tests don't depend on data/catalog.json ────────────────
// Realistic options, some with links (search results) and some without (curated demo items).
const BP: Option[] = [
  { product: { id: "bp-a", name: { en: "VitaCheck Arm Blood Pressure Monitor", zh: "VitaCheck 上臂式血压计" }, price: 29.99, currency: "USD", merchant: "HealthHub Demo", shipsTo: [], tags: ["large-display"], url: "https://example.com/bp-a", description: "Upper-arm monitor with a 4-inch display. Stores 60 readings." }, why: "Big numbers she can read without glasses." },
  { product: { id: "bp-b", name: { en: "EasyPulse Talking Monitor", zh: "EasyPulse 语音血压计" }, price: 39.99, currency: "USD", merchant: "SilverCare Demo", shipsTo: [], tags: ["chinese-voice"], url: "https://example.com/bp-b?ref=demo&x=1", rating: 4.6, reviews: 812, description: "Reads results aloud in Mandarin. One-button start." }, why: "Speaks the result in Mandarin, one big button." },
  { product: { id: "bp-c", name: { en: "CalmCuff Wrist Monitor" }, price: 45, currency: "USD", merchant: "Lotus Demo Store", shipsTo: ["TW"], tags: ["simple-buttons"], description: "Small wrist monitor, easy to carry." }, why: "Small wrist monitor, easy to carry." },
];
const TABLET: Option[] = [
  { product: { id: "tab-a", name: { en: "GrandTab 8 Big-Button Tablet" }, price: 89, currency: "USD", merchant: "Elder Tech Demo", shipsTo: [], tags: ["simple-buttons"], description: "8-inch tablet with a simplified home screen." }, why: "Simple home screen with large icons." },
  { product: { id: "tab-b", name: { en: "Mandarin Voice Tablet 10" }, price: 149, currency: "USD", merchant: "Lotus Demo Store", shipsTo: [], tags: ["chinese-voice"], url: "https://example.com/tab-b", description: "10-inch tablet with Mandarin voice control." }, why: "She can talk to it in Mandarin." },
];
const PHONE: Option[] = [
  { product: { id: "ph-a", name: { en: "EasyCall Flip Phone" }, price: 45, currency: "USD", merchant: "Phone Demo", shipsTo: [], tags: ["simple-buttons"], description: "Big keys." }, why: "Big keys." },
  { product: { id: "ph-b", name: { en: "TalkEasy Senior Phone" }, price: 49, currency: "USD", merchant: "Phone Demo", shipsTo: [], tags: ["simple-buttons"], description: "Loud speaker." }, why: "Loud speaker." },
];
const HEATER: Option[] = [
  { product: { id: "heat-a", name: { en: "Quiet Ceramic Heater" }, price: 35, currency: "USD", merchant: "Warm Home Demo", shipsTo: [], tags: ["simple-buttons"], description: "Tip-over shutoff and one dial." }, why: "One dial, switches itself off if knocked over." },
];
shopDeps.findOptions = async (_f: Family, need: ShoppingNeed) => {
  const t = `${need.text} ${(need.keywordsEn ?? []).join(" ")}`;
  if (/血压|血壓|blood pressure/i.test(t)) return BP;
  if (/tablet|平板/i.test(t)) return TABLET;
  if (/heater/i.test(t)) return HEATER;
  if (/phone/i.test(t)) return PHONE;
  return []; // fridge etc.: nothing fits
};
shopDeps.detectShoppingNeed = async (fam: Family, sender: FamilyMember, text: string) => {
  if (/\brent\b|房租|bills?\b/i.test(text)) return null;
  const thing = /血压|血壓|blood pressure|tablet|heater|fridge|phone/i.exec(text)?.[0];
  if (!thing) return null;
  const kw = /血压|血壓|blood pressure/i.test(thing) ? "blood pressure monitor" : thing.toLowerCase();
  const nn = fam.members.find((x) => x.id === "nainai")!;
  const forMember = /nai nai|grandma|奶奶/i.test(text) ? nn : sender;
  return { forMember, text, category: /fridge/i.test(thing) ? "home" : "medical-device", keywordsEn: [kw] };
};

// ── Unit: vote parsing and tally ───────────────────────────────────────────
check("parseVote B", parseVote("B", 3) === 1);
check("parseVote b.", parseVote(" b. ", 3) === 1);
check("parseVote 3", parseVote("3", 3) === 2);
check("parseVote D out of range", parseVote("D", 3) === undefined);
check("parseVote chat", parseVote("B looks good", 3) === undefined);
check("tally most votes", tally(new Map([["a", 2], ["b", 2], ["c", 0]]), 3) === 2);
check("tally tie → earliest", tally(new Map([["a", 2], ["b", 0]]), 3) === 0);
check("tally none → null", tally(new Map(), 3) === null);
check("buyer: elder asks → trusted Mei", pickBuyer(family, nainai, nainai)?.id === "mei");
check("buyer: Kevin asks for Nai Nai → Kevin", pickBuyer(family, kevin, nainai)?.id === "kevin");

// ── 1. Natural message → false (relayed), cards in both languages, URL untranslated ──
let bCardKevin = "";
{
  reset();
  const from = lines.length;
  const handled = await tryHandlePayment(family, nainai, msg(nainai, "我的血压计坏了，想买个新的，字要大一点"));
  check("natural message returns false (relayed as chat)", handled === false);

  const head = await lineFor(kevin, "🛍️", from);
  check("heading to Kevin in English", Boolean(head?.includes("Nai Nai wants a blood pressure monitor. Here are 3 options; reply A, B or C")), dump(from));
  const headZh = await lineFor(nainai, "🛍️", from);
  check("heading to Nai Nai in her language", Boolean(headZh?.includes("[en→zh]")), dump(from));

  const kB = await lineFor(kevin, "B · EasyPulse Talking Monitor", from);
  bCardKevin = idOf(kB);
  const kBody = body(kB);
  check("Kevin's card B: price in USD", kBody[1]?.startsWith("$39.99 · ") === true, kBody.join(" | "));
  check("Kevin's card B: URL alone on its own last line", kBody[kBody.length - 1] === "https://example.com/bp-b?ref=demo&x=1", kBody.join(" | "));

  const zB = await lineFor(nainai, "B · EasyPulse 语音血压计", from);
  const zBody = body(zB);
  check("Nai Nai's card B: name in Chinese", Boolean(zB), dump(from));
  check("Nai Nai's card B: price in TWD", /^≈ NT\$1,28\d · /.test(zBody[1] ?? ""), zBody.join(" | "));
  check("Kevin's card B: rating shown", kBody[1]?.includes("⭐ 4.6 (812)") === true, kBody.join(" | "));
  check("summary doesn't repeat itself when why = description", body(await lineFor(kevin, "C · CalmCuff", from))[2] === "Small wrist monitor, easy to carry.", dump(from));
  check("Nai Nai's card B: summary translated", zBody[2]?.startsWith("[en→zh]") === true, zBody.join(" | "));
  check("Nai Nai's card B: URL untranslated, own line", zBody[zBody.length - 1] === "https://example.com/bp-b?ref=demo&x=1", zBody.join(" | "));
  const zC = body(await lineFor(nainai, "C · ", from));
  check("no URL → demo product (translated label)", zC[zC.length - 1] === "([en→zh] demo product)", zC.join(" | "));
  check("cards go to Mei too", saw(mei, "A · VitaCheck", from) && saw(mei, "C · CalmCuff", from));
  check("heading comes before the cards", lines.findIndex((l, i) => i >= from && isPhone(kevin)(l) && l.includes("🛍️")) < lines.findIndex((l, i) => i >= from && isPhone(kevin)(l) && l.includes("A · VitaCheck")));

  // ── 2. Chat during the vote is not swallowed ───────────────────────────────
  const chat = msg(kevin, "B looks good, big screen");
  check("chat during the vote isn't a prompt answer", tryResolvePrompt(chat) === false);
  check("chat during the vote isn't handled by Bridge", (await tryHandlePayment(family, kevin, chat)) === false);

  // A bare "ok" from Mei lands on a vote prompt: it's passed on and relayed as chat, and Mei gets a reminder.
  const okFrom = lines.length;
  check("'ok' is taken by a vote prompt", tryResolvePrompt(msg(mei, "ok")) === true);
  check("'ok' is relayed to the family", Boolean(await lineFor(kevin, "Mei: ok", okFrom)), dump(okFrom));
  const reminder = await lineFor(mei, "🗳️ Still deciding", okFrom);
  check("Mei gets a re-opened vote reminder", Boolean(reminder), dump(okFrom));

  // ── 3. Votes: Kevin ❤️ his card B + Nai Nai's letter "B" → a majority (2 of 3) for B ──
  const voteFrom = lines.length;
  check("Kevin ❤️ on card B is a vote", tryResolvePrompt(tap(kevin, bCardKevin, "love")) === true);
  check("Nai Nai's 'B' is a vote (not relayed)", tryResolvePrompt(msg(nainai, "B")) === true);
  check("B wins, announced to everyone", Boolean(await lineFor(kevin, "🗳️ B · EasyPulse", voteFrom)) && Boolean(await lineFor(nainai, "🗳️ B · EasyPulse 语音血压计", voteFrom)), dump(voteFrom));
  // The core rule: Mei (the buyer) didn't pick B herself, so she's asked, even under the limit.
  check("family told who still has to confirm", Boolean(await lineFor(kevin, "Waiting for Mei to confirm before buying it for Nai Nai", voteFrom)), dump(voteFrom));
  const ask3 = await lineFor(mei, "🛒 Buy B · EasyPulse Talking Monitor · $39.99 for Nai Nai?", voteFrom);
  check("under the limit, buyer didn't pick → Mei asked ❤️/yes (untranslated details line)", Boolean(ask3) && saw(mei, `❤️ or "yes" to buy`, voteFrom), dump(voteFrom));
  await sleep(100);
  check("nothing bought before Mei's yes", !lines.slice(voteFrom).some((l) => l.includes("✅")), dump(voteFrom));
  check("Mei's 👍 is not a yes", tryResolvePrompt(tap(mei, idOf(ask3), "like")) === true);
  check("👍 → nothing bought", Boolean(await lineFor(mei, "Mei didn't confirm, so nothing was bought", voteFrom)) && !lines.slice(voteFrom).some((l) => l.includes("✅")), dump(voteFrom));
  await settle();
}
{
  // Same again, and this time Mei says yes.
  reset();
  const from = lines.length;
  await tryHandlePayment(family, nainai, msg(nainai, "我的血压计坏了，想买个新的，字要大一点"));
  const kB = idOf(await lineFor(kevin, "B · EasyPulse Talking Monitor", from));
  await lineFor(mei, "C · CalmCuff", from);
  tryResolvePrompt(tap(kevin, kB, "love"));
  tryResolvePrompt(msg(nainai, "B"));
  const voteFrom = from;
  await lineFor(mei, "🛒 Buy B · EasyPulse", voteFrom);
  check("Mei's yes answers the confirmation", tryResolvePrompt(msg(mei, "yes")) === true);
  check("not a gift occasion → 'ordered a new …' to Nai Nai in her language", Boolean(await lineFor(nainai, "✅ [en→zh] Mei ordered a new blood pressure monitor for you", voteFrom)), dump(voteFrom));
  check("confirmation to Kevin", Boolean(await lineFor(kevin, "✅ Mei ordered a new blood pressure monitor for Nai Nai, arriving", voteFrom)), dump(voteFrom));
  check("confirmation to the buyer has the product + price", Boolean(await lineFor(mei, "✅ You ordered a new blood pressure monitor for Nai Nai", voteFrom)) && saw(mei, "EasyPulse Talking Monitor · $39.99", voteFrom), dump(voteFrom));
  check("votes never relayed", !lines.slice(voteFrom).some((l) => l.includes("Nai Nai: B") || l.includes("Nai Nai: [zh→en] B")));
  await settle();
  check("decision closed", !hasOpenDecision(family));
}

// ── 4. Tapback on a card counts for that card, whatever the kind ───────────
{
  reset();
  const from = lines.length;
  check("explicit command returns true", (await tryHandlePayment(family, kevin, msg(kevin, "find Nai Nai a blood pressure monitor"))) === true);
  check("explicit command isn't relayed", !(await lineFor(mei, "Kevin: ", from, 400)));
  const kC = idOf(await lineFor(kevin, "C · CalmCuff", from));
  const zHead = idOf(await lineFor(nainai, "🛍️", from));
  check("👍 on card C → C", tryResolvePrompt(tap(kevin, kC, "like")) === true);
  // A 👎 on a card isn't a vote.
  const zA = idOf(await lineFor(nainai, "A · VitaCheck", from));
  tryResolvePrompt(tap(nainai, zA, "dislike"));
  check("😂 on the heading → C", tryResolvePrompt(tap(nainai, zHead, "laugh")) === true);
  check("C wins with 2 votes", Boolean(await lineFor(kevin, "🗳️ C · CalmCuff", from)) && saw(kevin, "(2 votes)", from), dump(from));
  check("Kevin's 👍 on the card is a vote, not a yes → Kevin asked", Boolean(await lineFor(kevin, "🛒 Buy C · CalmCuff Wrist Monitor · $45 for Nai Nai?", from)), dump(from));
  tryResolvePrompt(msg(kevin, "yes"));
  check("requester Kevin is the buyer", Boolean(await lineFor(mei, "✅ Kevin ordered a new blood pressure monitor for Nai Nai", from)), dump(from));
  await settle();
}

// ── 5. One decision per family ─────────────────────────────────────────────
{
  reset();
  process.env.SHOP_VOTE_TIMEOUT_MS = "600";
  const from = lines.length;
  await tryHandleShopping(family, kevin, msg(kevin, "find Nai Nai a blood pressure monitor"));
  await lineFor(kevin, "C · CalmCuff", from);
  check("a decision is open", hasOpenDecision(family));
  check("second explicit request while open → relayed (false)", (await tryHandleShopping(family, mei, msg(mei, "buy Nai Nai a tablet"))) === false);
  check("second request told to wait", Boolean(await lineFor(mei, "I'm still helping the family choose a blood pressure monitor for Nai Nai", from)), dump(from));
  check("no tablet cards", !saw(mei, "GrandTab", from));

  // ── 6. Timeout: one vote → that option wins after SHOP_VOTE_TIMEOUT_MS ──
  const voteFrom = lines.length;
  check("Mei votes A", tryResolvePrompt(msg(mei, "A")) === true);
  check("timeout → most votes (A)", Boolean(await lineFor(kevin, "🗳️ A · VitaCheck", voteFrom, 2000)) && saw(kevin, "(1 vote)", voteFrom), dump(voteFrom));
  check("timeout with one vote → says who must confirm", Boolean(await lineFor(mei, "Waiting for Kevin to confirm", voteFrom)), dump(voteFrom));
  check("timeout winner → the buyer is asked", Boolean(await lineFor(kevin, "🛒 Buy A · VitaCheck", voteFrom)), dump(voteFrom));
  tryResolvePrompt(msg(kevin, "no"));
  check("buyer's no → nothing bought", Boolean(await lineFor(kevin, "didn't confirm, so nothing was bought", voteFrom)) && !lines.slice(voteFrom).some((l) => l.includes("✅")), dump(voteFrom));
  await settle();
}
{
  // M-1 (probe p2): Kevin's own phone, only Kevin votes → Mei (the buyer) must say yes; silence buys nothing.
  reset();
  process.env.SHOP_VOTE_TIMEOUT_MS = "400";
  process.env.PAYMENT_CONFIRM_TIMEOUT_MS = "300";
  const from = lines.length;
  await tryHandlePayment(family, kevin, msg(kevin, "my phone broke lol"));
  await lineFor(kevin, "B · TalkEasy", from);
  tryResolvePrompt(msg(kevin, "B"));
  check("p2: Mei is asked to confirm Kevin's phone", Boolean(await lineFor(mei, "🛒 Buy B · TalkEasy Senior Phone · $49 for Kevin?", from, 2000)), dump(from));
  check("p2: Mei silent → nothing bought", Boolean(await lineFor(mei, "Mei didn't answer, so nothing was bought", from, 2000)) && !lines.slice(from).some((l) => l.includes("✅")), dump(from));
  await settle();
  delete process.env.PAYMENT_CONFIRM_TIMEOUT_MS;
}
{
  // M-1 (probe p3): Mei's bare "A" (maybe meant for another question) is a vote, never a purchase.
  reset();
  process.env.SHOP_VOTE_TIMEOUT_MS = "400";
  process.env.PAYMENT_CONFIRM_TIMEOUT_MS = "300";
  const from = lines.length;
  await tryHandlePayment(family, nainai, msg(nainai, "我的血压计坏了"));
  await lineFor(mei, "C · CalmCuff", from);
  tryResolvePrompt(msg(mei, "A"));
  check("p3: Mei's bare letter → Mei still asked to confirm", Boolean(await lineFor(mei, "🛒 Buy A · VitaCheck", from, 2000)), dump(from));
  check("p3: no confirmation → nothing bought", Boolean(await lineFor(mei, "Mei didn't answer", from, 2000)) && !lines.slice(from).some((l) => l.includes("✅")), dump(from));
  await settle();
  delete process.env.PAYMENT_CONFIRM_TIMEOUT_MS;
  delete process.env.SHOP_VOTE_TIMEOUT_MS;
}
{
  // The core rule (a): the buyer's own ❤️ on the winning card is enough under the limit.
  reset();
  const from = lines.length;
  await tryHandleShopping(family, kevin, msg(kevin, "find Nai Nai a blood pressure monitor"));
  const kA = idOf(await lineFor(kevin, "A · VitaCheck", from));
  await lineFor(mei, "C · CalmCuff", from);
  tryResolvePrompt(tap(kevin, kA, "love"));
  tryResolvePrompt(msg(mei, "A"));
  check("buyer ❤️ on the winning card → 'Checking out'", Boolean(await lineFor(kevin, "Checking out for Nai Nai with your card", from)), dump(from));
  check("…and bought without a 2nd question", Boolean(await lineFor(mei, "✅ Kevin ordered a new blood pressure monitor", from)) && !saw(kevin, "🛒 Buy", from), dump(from));
  await settle();
}
{
  // M-2: a voter with an open money question gets no vote prompts until it closes.
  reset();
  const release = claimMoneySlot(mei)!;
  const from = lines.length;
  await tryHandleShopping(family, kevin, msg(kevin, "find Nai Nai a blood pressure monitor"));
  await lineFor(kevin, "C · CalmCuff", from);
  await sleep(300);
  check("M-2: no cards to Mei while her money question is open", !saw(mei, "🛍️", from), dump(from));
  // (Leftover prompts from earlier blocks may take it and pass it on: then it's relayed as chat.)
  const a2 = lines.length;
  const taken = tryResolvePrompt(msg(mei, "A"));
  check("M-2: Mei's bare 'A' isn't a vote while her money question is open", !taken || Boolean(await lineFor(kevin, "Mei: A", a2, 1000)), dump(a2));
  release();
  check("M-2: Mei gets the cards once it closes", Boolean(await lineFor(mei, "C · CalmCuff", from, 2000)), dump(from));
  const kA = idOf(await lineFor(kevin, "A · VitaCheck", from));
  tryResolvePrompt(tap(kevin, kA, "love"));
  tryResolvePrompt(msg(mei, "A"));
  await lineFor(nainai, "✅", from);
  await settle();
}
{
  reset();
  process.env.SHOP_VOTE_TIMEOUT_MS = "300";
  const from = lines.length;
  await tryHandleShopping(family, kevin, msg(kevin, "find Nai Nai a blood pressure monitor"));
  const pick = await lineFor(kevin, "Nobody voted", from, 2000);
  check("timeout with no votes → the buyer picks", Boolean(pick), dump(from));
  check("M-5: a tapback on 'which one?' isn't a pick", tryResolvePrompt(tap(kevin, idOf(pick), "love")) === true);
  check("M-5: asked again for a letter", Boolean(await lineFor(kevin, "Please reply with just a letter", from)), dump(from));
  check("buyer answers B", tryResolvePrompt(msg(kevin, "B")) === true);
  check("M-5: the pick is confirmed first", Boolean(await lineFor(kevin, "🛒 Buy B · EasyPulse", from)) && !saw(nainai, "✅", from), dump(from));
  tryResolvePrompt(msg(kevin, "yes"));
  check("buyer's confirmed pick is bought", Boolean(await lineFor(nainai, "✅ [en→zh] Kevin ordered a new blood pressure monitor for you", from)), dump(from));
  await settle();
  delete process.env.SHOP_VOTE_TIMEOUT_MS;
}

// ── 7. Over the limit → the buyer confirms ─────────────────────────────────
{
  reset();
  const from = lines.length;
  check("tablet command handled", (await tryHandleShopping(family, kevin, msg(kevin, "find Nai Nai a tablet with big buttons"))) === true);
  const head2 = await lineFor(kevin, "🛍️", from);
  check("2 options → 'reply A or B'", Boolean(head2?.includes("Here are 2 options; reply A or B, or tapback 👍/❤️.")) && !head2!.includes("😂"), head2 ?? dump(from));
  const tabB = await lineFor(mei, "B · Mandarin Voice Tablet", from);
  check("search result's link alone on the last line", body(tabB).at(-1) === "https://example.com/tab-b", body(tabB).join(" | "));
  check("'C' isn't a vote with 2 options (passed on as chat)", tryResolvePrompt(msg(kevin, "C")) === true && Boolean(await lineFor(mei, "Kevin: C", from)), dump(from));
  check("Kevin's 'B' still counts after that", tryResolvePrompt(msg(kevin, "B")) === true);
  tryResolvePrompt(msg(mei, "B"));
  const confirm = await lineFor(kevin, `"yes"`, from);
  check("over the limit → Kevin asked to confirm", Boolean(confirm) && confirm!.includes("$149"), dump(from));
  check("no confirmation before the yes", !saw(nainai, "✅", from));
  check("Kevin's yes answers it", tryResolvePrompt(msg(kevin, "yes")) === true);
  check("bought after the yes", Boolean(await lineFor(nainai, "✅ [en→zh] Kevin ordered a new tablet for you", from)), dump(from));
  await settle();
}

// ── 8. Checkout fails → a clear message, nothing confirmed ────────────────
{
  reset();
  const realCheckout = shopDeps.checkout;
  shopDeps.checkout = async () => ({ ok: false, error: "The card was declined, so nothing was bought." });
  const from = lines.length;
  await tryHandleShopping(family, kevin, msg(kevin, "find Nai Nai a blood pressure monitor"));
  await lineFor(mei, "C · CalmCuff", from);
  tryResolvePrompt(msg(kevin, "A"));
  tryResolvePrompt(msg(mei, "A"));
  check("buyer told it failed", Boolean(await lineFor(kevin, "The card was declined, so nothing was bought.", from)), dump(from));
  check("others told nothing was ordered", Boolean(await lineFor(mei, "nothing was ordered for Nai Nai", from)), dump(from));
  check("no confirmation", !lines.slice(from).some((l) => l.includes("✅")));
  await settle();

  reset();
  shopDeps.checkout = async () => ({ ok: false, error: "timeout", maybeCharged: true });
  const f2 = lines.length;
  await tryHandleShopping(family, kevin, msg(kevin, "find Nai Nai a blood pressure monitor"));
  await lineFor(mei, "C · CalmCuff", f2);
  tryResolvePrompt(msg(kevin, "A"));
  tryResolvePrompt(msg(mei, "A"));
  check("maybe charged → 'may have gone through'", Boolean(await lineFor(kevin, "may have gone through", f2)), dump(f2));
  check("maybe charged → never 'nothing was charged'", !lines.slice(f2).some((l) => l.includes("Nothing was charged")));
  await settle();
  shopDeps.checkout = realCheckout;
}

// ── 8b. One option ─────────────────────────────────────────────────────────
{
  reset();
  const from = lines.length;
  await tryHandleShopping(family, kevin, msg(kevin, "find Nai Nai a heater"));
  const head = await lineFor(kevin, "🛍️", from);
  check("1 option → 'reply A, or tapback 👍'", Boolean(head?.includes("Here is 1 option; reply A, or tapback 👍.")), head ?? dump(from));
  check("1 option → legend has only A", Boolean(head?.includes("👍 A")) && !head!.includes("❤️ B"), head ?? "");
  const card = await lineFor(mei, "A · Quiet Ceramic Heater", from);
  check("single card is sent", Boolean(card), dump(from));
  check("❤️ on the only card votes A", tryResolvePrompt(tap(mei, idOf(card), "love")) === true);
  check("Kevin's 'A'", tryResolvePrompt(msg(kevin, "A")) === true);
  check("A wins", Boolean(await lineFor(nainai, "🗳️ A · ", from)), dump(from));
  check("Kevin's bare 'A' → Kevin confirms (under the limit too)", Boolean(await lineFor(kevin, "🛒 Buy A · Quiet Ceramic Heater · $35 for Nai Nai?", from)), dump(from));
  tryResolvePrompt(tap(kevin, idOf(await lineFor(kevin, "🛒 Buy A", from)), "love"));
  check("bought after ❤️", Boolean(await lineFor(nainai, "✅ [en→zh] Kevin ordered a new heater for you", from)), dump(from));
  await settle();
}

// ── 9. No options / not shopping / money needs ─────────────────────────────
{
  reset();
  const from = lines.length;
  check("M-3: explicit with no options → relayed (false)", (await tryHandleShopping(family, kevin, msg(kevin, "find Nai Nai a fridge"))) === false);
  check("M-3: no options → a short note, no money suggestion", Boolean(await lineFor(kevin, `couldn't find a good option for Nai Nai`, from)) && !saw(kevin, "send Nai Nai $", from), dump(from));
  for (const t of ["order an ambulance for grandma now, she fell", "find someone to help Nai Nai, she fell and is bleeding", "buy grandma a heater, she fell and is bleeding"]) {
    check(`M-3: emergency is never claimed: "${t}"`, (await tryHandleShopping(family, kevin, msg(kevin, t))) === false);
  }
  check("'find my keys' is just chat", (await tryHandleShopping(family, kevin, msg(kevin, "find my keys please"))) === false);
  check("rent stays a money need (no shopping)", (await tryHandleShopping(family, nainai, msg(nainai, "房租该交了，我需要钱"))) === false);
  await sleep(500);
  check("rent → no cards", !lines.slice(from).some((l) => l.includes("🛍️")));
  // M-3 with the real detector: chat that only looks like a command is relayed, with no note.
  const fakeDetect = shopDeps.detectShoppingNeed;
  shopDeps.detectShoppingNeed = catalog.detectShoppingNeed;
  const f1 = lines.length;
  for (const t of ["find me a time to call grandma tonight", "can you find my keys? lol", "order a pizza for us lol"]) {
    check(`M-3: "${t}" → relayed`, (await tryHandleShopping(family, kevin, msg(kevin, t))) === false);
  }
  await sleep(300);
  check("M-3: no Bridge note or money suggestion for chat", !lines.slice(f1).some((l) => isPhone(kevin)(l)), dump(f1));
  shopDeps.detectShoppingNeed = fakeDetect;
  // A buyable need with nothing in the catalog falls back to needs.ts's money offer.
  reset();
  const f2 = lines.length;
  await tryHandlePayment(family, nainai, msg(nainai, "the fridge is broken"));
  check("fridge (no options) → money offer as before", Boolean(await lineFor(kevin, "🔧 Nai Nai ·", f2)), dump(f2));
  await sleep(50);
  reset();
}

// ── 10. AI call budget (spec U2-15): a fake OpenAI-compatible server counts every request ──
// Main demo: Nai Nai's blood pressure monitor → Kevin ❤️ B + Nai Nai "B" → Mei yes → bought.
// 1 Chinese reader (Nai Nai) + 2 English readers (Kevin, Mei).
{
  const http = await import("node:http");
  type AiReq = { tool: string; content: string; items?: string[] };
  const aiCalls: AiReq[] = [];
  let batchMode: "ok" | "short" | "error" = "ok";
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const reqBody = JSON.parse(raw || "{}");
      const tool: string = reqBody.tools?.[0]?.function?.name ?? "";
      const content = String(reqBody.messages?.find((x: { role: string }) => x.role === "user")?.content ?? "");
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const reply = (args: unknown) =>
        send(200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } }] });
      const entry: AiReq = { tool, content };
      aiCalls.push(entry);
      if (tool === "submit_translation") return reply({ text: `[zh·1] ${content.match(/<message>([\s\S]*?)<\/message>/)?.[1] ?? ""}`, confidence: 0.95 });
      if (tool === "submit_literal") return reply({ text: "[zh·lit]" });
      if (tool === "submit_translations") {
        let items: string[] = [];
        try {
          items = JSON.parse(content.match(/<items>([\s\S]*?)<\/items>/)?.[1] ?? "[]");
        } catch {}
        entry.items = items;
        if (batchMode === "error") return send(500, { error: { message: "boom" } });
        const out = items.map((t) => `[zh·b] ${t}`);
        return reply({ items: batchMode === "short" ? out.slice(0, -1) : out });
      }
      if (tool === "money_intent") return reply({ isGift: false });
      if (tool === "report_need") return reply({ isNeed: true, need: "a blood pressure monitor", suggestedAmountUSD: 38 });
      return reply({});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const saved = { p: process.env.TRANSLATE_PROVIDER, k: process.env.LLM_API_KEY, u: process.env.LLM_BASE_URL, m: process.env.LLM_MODEL };
  process.env.TRANSLATE_PROVIDER = "openai-compatible";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.LLM_MODEL = "fake-model";

  const TRANSLATION_TOOLS = new Set(["submit_translation", "submit_literal", "submit_translations"]);
  const translationCalls = () => aiCalls.filter((c) => TRANSLATION_TOOLS.has(c.tool));
  const forReader = (who: FamilyMember) => translationCalls().filter((c) => c.content.includes(`<recipient>${who.name},`));

  // Fresh wording (not cached by earlier placeholder runs): "a blood pressure monitor with big numbers".
  const realDetect = shopDeps.detectShoppingNeed;
  shopDeps.detectShoppingNeed = async (fam: Family, sender: FamilyMember, text: string) => {
    const need = await realDetect(fam, sender, text);
    return need ? { ...need, keywordsEn: ["blood pressure monitor with big numbers"] } : need;
  };
  reset();
  aiCalls.length = 0;
  const from = lines.length;
  await tryHandlePayment(family, nainai, msg(nainai, "我想买一个血压计，字要大一点"));
  const kB = idOf(await lineFor(kevin, "B · EasyPulse Talking Monitor", from));
  await lineFor(mei, "C · CalmCuff", from);
  const zB = await lineFor(nainai, "B · EasyPulse 语音血压计", from);
  const zC = await lineFor(nainai, "C · ", from);
  const cardsCalls = translationCalls().length;
  tryResolvePrompt(tap(kevin, kB, "love"));
  tryResolvePrompt(msg(nainai, "B"));
  await lineFor(nainai, "🗳️ B · EasyPulse 语音血压计", from);
  await lineFor(mei, "🛒 Buy B · EasyPulse", from);
  const voteCalls = translationCalls().length - cardsCalls;
  tryResolvePrompt(msg(mei, "yes"));
  const done = await lineFor(nainai, "✅", from);
  await settle();
  const total = translationCalls().length;
  const byTool = (t: string) => translationCalls().filter((c) => c.tool === t).length;
  realLog(
    `  [ai] main demo flow: ${total} translation calls (cards ${cardsCalls}, vote result ${voteCalls}, order ${total - cardsCalls - voteCalls}; ` +
      `batch ${byTool("submit_translations")}, single ${byTool("submit_translation")}, literal ${byTool("submit_literal")}); ` +
      `other AI calls: ${aiCalls.filter((c) => !TRANSLATION_TOOLS.has(c.tool)).map((c) => c.tool).join(", ") || "none"}`,
  );
  check("AI: whole demo flow ≤ 3 translation calls", total <= 3, String(total));
  check("AI: English readers trigger no translation call", forReader(kevin).length === 0 && forReader(mei).length === 0);
  check("AI: cards = one batch call for Nai Nai", cardsCalls === 1 && aiCalls.some((c) => c.tool === "submit_translations" && c.content.includes("<recipient>Nai Nai,")), String(cardsCalls));
  check("AI: vote result = one call for Nai Nai", voteCalls === 1, String(voteCalls));
  const zBb = body(zB);
  check("AI: Nai Nai's card B summary from the batch", zBb[2]?.startsWith("[zh·b] ") === true, zBb.join(" | "));
  check("AI: Nai Nai's card B: URL untouched on its own line", zBb.at(-1) === "https://example.com/bp-b?ref=demo&x=1", zBb.join(" | "));
  check("AI: Nai Nai's card B: price line untouched", /^≈ NT\$1,28\d · SilverCare Demo · ⭐ 4\.6 \(812\)$/.test(zBb[1] ?? ""), zBb.join(" | "));
  check("AI: own-language name kept, untranslated", zBb[0]?.endsWith("B · EasyPulse 语音血压计") === true, zBb[0] ?? "");
  check("AI: missing zh name translated in the batch", body(zC)[0]?.endsWith("C · [zh·b] CalmCuff Wrist Monitor") === true, body(zC).join(" | "));
  const sent = aiCalls.flatMap((c) => c.items ?? []);
  check("AI: no URL or price is ever sent for translation", sent.length > 0 && !sent.some((t) => /https?:\/\/|NT\$|\$\d|SilverCare Demo · /.test(t)), JSON.stringify(sent));
  check("AI: names with a zh translation are not sent", !sent.some((t) => /EasyPulse Talking Monitor|VitaCheck Arm/.test(t)), JSON.stringify(sent));
  check("AI: the order is confirmed to Nai Nai", Boolean(done), dump(from));
  shopDeps.detectShoppingNeed = realDetect;

  // translateBatch unit checks.
  const { translateBatch } = await import("../translate/translator.js");
  aiCalls.length = 0;
  const en = await translateBatch(["Hello there", "https://example.com/x"], kevin, family);
  check("batch: English reader → input as is, no call", JSON.stringify(en) === JSON.stringify(["Hello there", "https://example.com/x"]) && aiCalls.length === 0);
  const ok = await translateBatch(["Pick one, please.", "https://example.com/x", "", "Pick one, please.", "Thanks!"], nainai, family);
  check("batch: one call, order kept, links/blanks untouched, duplicates sent once",
    aiCalls.length === 1 && JSON.stringify(aiCalls[0]!.items) === JSON.stringify(["Pick one, please.", "Thanks!"]) &&
      JSON.stringify(ok) === JSON.stringify(["[zh·b] Pick one, please.", "https://example.com/x", "", "[zh·b] Pick one, please.", "[zh·b] Thanks!"]), JSON.stringify(ok));
  aiCalls.length = 0;
  const again = await translateBatch(["Thanks!", "Pick one, please."], nainai, family);
  check("batch: cached per item → no call", aiCalls.length === 0 && again[0] === "[zh·b] Thanks!", JSON.stringify(again));
  batchMode = "short";
  aiCalls.length = 0;
  const short = await translateBatch(["One more thing.", "And another."], nainai, family);
  check("batch: length mismatch → per-item translate() fallback",
    JSON.stringify(short) === JSON.stringify(["[zh·1] One more thing.", "[zh·1] And another."]) && aiCalls.filter((c) => c.tool === "submit_translation").length === 2, JSON.stringify(short));
  batchMode = "error";
  aiCalls.length = 0;
  const err = await translateBatch(["Something new."], nainai, family);
  check("batch: provider error → per-item fallback, never throws", err[0] === "[zh·1] Something new.", JSON.stringify(err));
  batchMode = "ok";

  server.close();
  process.env.TRANSLATE_PROVIDER = saved.p;
  process.env.LLM_API_KEY = saved.k ?? "";
  process.env.LLM_BASE_URL = saved.u ?? "";
  process.env.LLM_MODEL = saved.m ?? "";
  if (saved.u === undefined) delete process.env.LLM_BASE_URL;
  if (saved.m === undefined) delete process.env.LLM_MODEL;
}

console.log = realLog;
console.warn = realWarn;
console.log(failures ? `\n${failures} failed, ${passes} passed` : `shopFlow.selftest: all ${passes} checks passed`);
process.exit(failures ? 1 : 0);
