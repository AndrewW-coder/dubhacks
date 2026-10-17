// Offline self-test for the money flow and the "help with real needs" flow.
//   npx tsx src/payments/flow.selftest.ts
// Runs against the mock photon client with no API keys (regex paths) and exits non-zero on failure.

process.env.PHOTON_MODE = "mock";
process.env.VISA_MODE = "mock";
process.env.ANTHROPIC_API_KEY = ""; // force the regex paths even if a .env has a key
delete process.env.PAYMENT_CONFIRM_TIMEOUT_MS;

// Capture everything the mock phones print.
const lines: string[] = [];
const realLog = console.log;
const realWarn = console.warn;
console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
console.warn = () => {};

const { getFamilyByHandle, getAllMembers } = await import("../db/store.js");
const { tryResolvePrompt } = await import("../relay/prompts.js");
const { tryHandlePayment, parseWithRegex, flowDeps, isYes, resetMoneySlotsForTests, hasOpenMoneyPrompt } = await import("./flow.js");
const { maybeOfferHelp, needsDeps, resetNeedsForTests } = await import("./needs.js");
const { scamSignals, trustedConfirmer, requiresConfirmation } = await import("./scamCheck.js");
import type { Family, FamilyMember, IncomingMessage } from "../types.js";
import type { GiftResult } from "./visa.js";

// Ignore AI settings from a developer's .env: this test uses a fake Anthropic server.
// (dotenv never overrides variables that are already set, and claude.ts reads these lazily.)
process.env.TRANSLATE_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "";
process.env.GEMINI_API_KEY = "";

const members = getAllMembers();
const m = (id: string) => members.find((x) => x.id === id)!;
const kevin = m("kevin"), mei = m("mei"), nainai = m("nainai");
const family = getFamilyByHandle(kevin.handle)!;

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
const msg = (from: FamilyMember, text: string): IncomingMessage => ({ id: `t${++seq}`, fromHandle: from.handle, kind: "text", text, receivedAt: new Date() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phone = (who: FamilyMember) => (l: string) => l.includes(`📱 ${who.name.padEnd(10)}`);

/** Waits until a NEW line (after `from`) for `who` contains `text`. */
async function waitFor(who: FamilyMember, text: string, from: number, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (lines.slice(from).some((l) => phone(who)(l) && l.includes(text))) return true;
    await sleep(20);
  }
  return false;
}
const saw = (who: FamilyMember, text: string, from: number) => lines.slice(from).some((l) => phone(who)(l) && l.includes(text));
const dump = (from: number) => lines.slice(from).join("\n    ");

function answer(who: FamilyMember, text: string): boolean {
  return tryResolvePrompt(msg(who, text));
}

/** Sends `text` from `who`, answers each [member, question-substring, reply] in order, returns the handler result. */
async function convo(who: FamilyMember, text: string, steps: [FamilyMember, string, string][], fam: Family = family): Promise<{ handled: boolean; from: number }> {
  const from = lines.length;
  const p = tryHandlePayment(fam, who, msg(who, text));
  for (const [member, q, reply] of steps) {
    const asked = await waitFor(member, q, from);
    check(`"${text}": ${member.name} is asked "${q}"`, asked, dump(from));
    if (asked) check(`"${text}": ${member.name}'s "${reply}" answers the prompt`, answer(member, reply));
  }
  return { handled: await p, from };
}

// ── R1: parsing ────────────────────────────────────────────────────────────
const others = (s: FamilyMember) => family.members.filter((x) => x.id !== s.id);
const parses: [FamilyMember, string, number, string, string][] = [
  [kevin, "send Nai Nai $50 for New Year", 50, "USD", "nainai"],
  [kevin, "can you send grandma 30 bucks", 30, "USD", "nainai"],
  [nainai, "给Kevin发个红包，100块", 100, "TWD", "kevin"], // 块 → sender's default (TWD)
  [mei, "给Kevin发个红包，100块", 100, "CNY", "kevin"], // 块 from a USD sender → CNY
  [kevin, "give mei $20", 20, "USD", "mei"],
  [kevin, "send 50 to Kevin", 50, "USD", ""], // can't send to yourself: no recipient
  [mei, "send 50 to Kevin", 50, "USD", "kevin"],
  [kevin, "send 奶奶 ¥200", 200, "CNY", "nainai"],
];
for (const [s, text, amount, currency, rid] of parses) {
  const i = parseWithRegex(text, s, others(s));
  check(`parse "${text}" from ${s.id}`, i.isGift && i.amount === amount && i.currency === currency && (i.recipientId ?? "") === rid, JSON.stringify(i));
}
check("note parsed", parseWithRegex("send Nai Nai $50 for New Year", kevin, others(kevin)).note === "New Year");

for (const text of ["I spent $20 on groceries", "the tickets were $300", "Nai Nai gave me $20 yesterday", "can you send me $20"]) {
  check(`non-gift parse "${text}"`, !parseWithRegex(text, kevin, others(kevin)).isGift);
  check(`non-gift "${text}" returns false`, (await tryHandlePayment(family, kevin, msg(kevin, text))) === false);
}

// ── R1: outcomes ───────────────────────────────────────────────────────────
{
  const { handled, from } = await convo(kevin, "send Nai Nai $50 for New Year", [[kevin, "💸 Nai Nai · $50 (≈ NT$1,610) · 💌 New Year", "yes"]]);
  check("success handled", handled);
  check("success: sender told", saw(kevin, "✅ Sent $50 to Nai Nai", from), dump(from));
  check("success: recipient gets 🧧 with the note translated", saw(nainai, "🧧", from) && saw(nainai, "[en→zh] New Year", from), dump(from));
}
{
  const { handled, from } = await convo(kevin, "give mei $20", [[kevin, "💸 Mei · $20", "no"]]);
  check("cancel handled", handled);
  check("cancel message", saw(kevin, "OK, I didn't send anything.", from), dump(from));
}
{
  process.env.PAYMENT_CONFIRM_TIMEOUT_MS = "200";
  const { handled, from } = await convo(kevin, "send Mei $10", []);
  delete process.env.PAYMENT_CONFIRM_TIMEOUT_MS;
  check("timeout handled", handled);
  check("timeout message", saw(kevin, "No answer, so I didn't send it.", from), dump(from));
}
{
  const real = flowDeps.sendGift;
  flowDeps.sendGift = async (_f, _t, amount, currency): Promise<GiftResult> => ({ ok: false, amountSent: amount, sentCurrency: currency, amountReceived: 0, receivedCurrency: currency, error: "card declined (test)" });
  const { from } = await convo(kevin, "send Mei $15", [[kevin, "💸 Mei · $15", "yes"]]);
  flowDeps.sendGift = real;
  check("failure: error + nothing charged", saw(kevin, "card declined (test)", from) && saw(kevin, "Nothing was charged", from), dump(from));
}
{
  const from = lines.length;
  check("unknown recipient handled", await tryHandlePayment(family, kevin, msg(kevin, "send Bob $20")));
  check("unknown recipient hint names real members", saw(kevin, "Nai Nai", from) && saw(kevin, "Mei", from), dump(from));
}
{
  let from = lines.length;
  check("over cap handled", await tryHandlePayment(family, kevin, msg(kevin, "send Mei $5000")));
  check("over cap message", saw(kevin, "limit is $1,000", from), dump(from));
  from = lines.length;
  check("zero handled", await tryHandlePayment(family, kevin, msg(kevin, "send Mei $0")));
  check("zero message", saw(kevin, "above zero", from), dump(from));
  from = lines.length;
  check("1000 TWD is under the USD cap", (await Promise.race([tryHandlePayment(family, nainai, msg(nainai, "send Kevin 1000 TWD")).then(() => "done"), sleep(300).then(() => "asked")])) === "asked" && saw(mei, "🛡️ Nai Nai ➡️ Kevin · NT$1,000", from), dump(from));
  answer(mei, "no");
  await sleep(50);
}

// ── R2: scam protection ────────────────────────────────────────────────────
check("scamSignals: gift cards", scamSignals("我需要钱买礼品卡").some((s) => s.includes("gift cards")));
check("scamSignals: crypto, IRS, bail, link", ["send bitcoin", "the IRS called", "I need bail money", "pay at http://x.co/a"].every((t) => scamSignals(t).length > 0));
check("scamSignals: normal chat is clean", scamSignals("send Nai Nai $50 for New Year").length === 0 && scamSignals("你吃饭了吗？").length === 0);
{
  const { handled, from } = await convo(nainai, "给Kevin发个红包，100块", [
    [mei, "🛡️ Nai Nai ➡️ Kevin · NT$100 (≈ $3.11)", "yes"],
    [nainai, "💸 Kevin · NT$100 (≈ $3.11) · 💌 红包", "好"],
  ]);
  check("elder red envelope handled", handled);
  check("elder red envelope: Kevin gets 🧧", saw(kevin, "🧧 A gift from Nai Nai", from), dump(from));
  // S-8: the who/how-much line is built outside translation (no "[en→zh]" in front of it).
  check("S-8: amount line is not translated", lines.slice(from).some((l) => phone(nainai)(l) && /#b\d+  💸 Kevin · NT\$100/.test(l)) && !saw(nainai, "[en→zh] 💸", from), dump(from));
}
{
  const { from } = await convo(nainai, "send Kevin $20 right now, don't tell your mom", [[mei, "⚠️ asks to keep it secret", "no"]]);
  check("elder gift with scam markers: urgency named", saw(mei, "⚠️ is urgent about money", from), dump(from));
  check("guard decline message", saw(nainai, "Mei didn't approve", from), dump(from));
}
{
  resetNeedsForTests();
  let calls = 0;
  const real = needsDeps.sendGift;
  needsDeps.sendGift = async (...a) => (calls++, real(...a));
  const from = lines.length;
  check("elder money request relays as chat", (await tryHandlePayment(family, nainai, msg(nainai, "我需要钱买礼品卡"))) === false);
  check("money request: Mei (trusted) is warned", await waitFor(mei, "⚠️ mentions gift cards: a common scam", from), dump(from));
  check("money request: Kevin is not asked", !saw(kevin, "asking for money", from), dump(from));
  answer(mei, "no");
  await sleep(100);
  check("money request: nothing paid", calls === 0);
  check("money request: Mei told nothing was sent", saw(mei, "OK, I didn't send anything.", from), dump(from));
  needsDeps.sendGift = real;
}

// ── R3: help with real needs ───────────────────────────────────────────────
{
  resetNeedsForTests();
  let calls = 0;
  const real = needsDeps.sendGift;
  needsDeps.sendGift = async (...a) => (calls++, real(...a));
  const from = lines.length;
  check("need relays as chat", (await tryHandlePayment(family, nainai, msg(nainai, "我的药快吃完了，好贵"))) === false);
  check("need: Kevin offered", await waitFor(kevin, "💊 Nai Nai · $30", from) && saw(kevin, "She mentioned she needs medicine.", from), dump(from));
  check("need: Mei offered", await waitFor(mei, "💊 Nai Nai · $30", from), dump(from));
  check("need: Kevin's yes answers", answer(kevin, "yes"));
  await sleep(30);
  check("need: Mei's later yes answers", answer(mei, "yes"));
  check("need: Nai Nai told who paid", await waitFor(nainai, "🧧 Kevin sent you", from), dump(from));
  check("need: Mei told Kevin handled it", await waitFor(mei, "Kevin already took care of it", from), dump(from));
  check("need: Mei's yes during Kevin's payment → told it's in progress", await waitFor(mei, "Kevin is already sending it", from), dump(from));
  check("need: paid exactly once", calls === 1, `calls=${calls}`);

  const again = lines.length;
  maybeOfferHelp(family, nainai, "我的药快吃完了，好贵");
  await sleep(600);
  check("need: no duplicate offer within 10 minutes", !saw(kevin, "💊", again) && !saw(mei, "💊", again), dump(again));
  needsDeps.sendGift = real;
}
{
  resetNeedsForTests();
  const from = lines.length;
  maybeOfferHelp(family, nainai, "救命，我摔倒了，我需要药");
  maybeOfferHelp(family, kevin, "I need medicine"); // not an elder
  maybeOfferHelp(family, nainai, "我今天去买菜了"); // groceries, but no need
  maybeOfferHelp(family, nainai, "我在医院，别担心");
  await sleep(600);
  check("no offer on emergencies / non-elders / plain chat", !lines.slice(from).some((l) => l.includes("📱")), dump(from));
  maybeOfferHelp(family, nainai, "the fridge is broken");
  check("broken appliance → offer", await waitFor(kevin, "🔧 Nai Nai ·", from) && saw(kevin, "She mentioned she needs a repair", from), dump(from));
  await sleep(50);
  resetMoneySlotsForTests(); // these offers are left unanswered on purpose
}

// ── U2-08 review fixes ─────────────────────────────────────────────────────
const without = (patch: (m: FamilyMember) => FamilyMember): Family => ({ ...family, members: family.members.map((x) => patch({ ...x })) });
const noTrust = without((x) => ({ ...x, isTrustedForMoney: false }));
const counting = () => {
  const calls: { from: string; to: string; amount: number; currency: string }[] = [];
  const realFlow = flowDeps.sendGift, realNeeds = needsDeps.sendGift;
  flowDeps.sendGift = async (f, t, a, c) => (calls.push({ from: f.id, to: t.id, amount: a, currency: c }), realFlow(f, t, a, c));
  needsDeps.sendGift = async (f, t, a, c) => (calls.push({ from: f.id, to: t.id, amount: a, currency: c }), realNeeds(f, t, a, c));
  return { calls, restore: () => { flowDeps.sendGift = realFlow; needsDeps.sendGift = realNeeds; } };
};

// M-4: strict yes
{
  const yes = ["yes", "Yes!", "y", "OK", "okay.", "confirm", "sure", "yep", "是", "是的", "好", "好的", "可以", "行", "对", "對", "好！", "ok!!"];
  const notYes = ["ok?", "yes?", "ok wait, no", "send it to mei instead", "sure... not", "y no", "No", "nope", "是不是", "好吗?", "可以吗", "Okay no",
    "yes please", "yeah", "send", "ok cancel", "don't", "不好", "别", "取消", "好？", "", "  ", "okay not now", "yes but don't"];
  for (const t of yes) check(`M-4 isYes("${t}")`, isYes({ via: "text", text: t }));
  for (const t of notYes) check(`M-4 !isYes("${t}")`, !isYes({ via: "text", text: t }));
  check("M-4 ❤️ counts", isYes({ via: "tapback", tapback: "love" }));
  for (const tb of ["like", "dislike", "laugh", "emphasize", "question"] as const) check(`M-4 ${tb} tapback is not a yes`, !isYes({ via: "tapback", tapback: tb }));
  check("M-4 null is not a yes", !isYes(null));
}

// S-1: amounts
{
  const amounts: [string, number][] = [["send Nai Nai $1,000", 1000], ["send grandma $50,000", 50000], ["send Mei 1,234.50 dollars", 1234.5], ["send nai nai 2 hongbao of $50", 50], ["send Nai Nai $50 for her 80th birthday", 50], ["send mei NT$500", 500]];
  for (const [t, n] of amounts) check(`S-1 parse "${t}" → ${n}`, parseWithRegex(t, kevin, others(kevin)).amount === n, JSON.stringify(parseWithRegex(t, kevin, others(kevin))));
  for (const t of ["send nainai 1e3 dollars", "send Nai Nai $1e3", "send nai nai $0.001", "send mei €12,50"]) check(`S-1 "${t}" is rejected`, Number.isNaN(parseWithRegex(t, kevin, others(kevin)).amount), JSON.stringify(parseWithRegex(t, kevin, others(kevin))));
  let from = lines.length;
  await tryHandlePayment(family, kevin, msg(kevin, "send Nai Nai $50,000"));
  check("S-1 $50,000 is over the cap (not $50)", saw(kevin, "limit is $1,000", from), dump(from));
  from = lines.length;
  await tryHandlePayment(family, kevin, msg(kevin, "send Mei 1e3 dollars"));
  check("S-1 scientific notation → asked for a plain amount", saw(kevin, "How much should I send Mei", from), dump(from));
}

// M-1: reproduce review probe s1. A help offer must not steal the "yes" for Kevin's own gift.
{
  resetNeedsForTests();
  const { calls, restore } = counting();
  const from = lines.length;
  await tryHandlePayment(family, nainai, msg(nainai, "我的药快吃完了")); // offer is sent ~250ms later
  const gift = tryHandlePayment(family, kevin, msg(kevin, "send Mei $10"));
  check("M-1 Kevin's gift confirm is shown", await waitFor(kevin, "💸 Mei · $10", from), dump(from));
  await waitFor(mei, "💊 Nai Nai · $30", from);
  await sleep(100);
  check("M-1 Kevin (busy with a money question) is not sent the offer", !saw(kevin, "💊", from), dump(from));
  check("M-1 Kevin's yes answers a prompt", answer(kevin, "yes"));
  await gift;
  check("M-1 the yes paid Kevin's $10 to Mei, and nothing else", calls.length === 1 && calls[0]!.to === "mei" && calls[0]!.amount === 10, JSON.stringify(calls));
  check("M-1 Kevin told his gift was sent", saw(kevin, "✅ Sent $10 to Mei", from), dump(from));
  answer(mei, "no");
  await sleep(50);
  restore();
}
{
  // The other order: an open help offer → a new gift from that member is refused, not queued behind it.
  resetNeedsForTests();
  const { calls, restore } = counting();
  const from = lines.length;
  maybeOfferHelp(family, nainai, "我的药快吃完了");
  await waitFor(kevin, "💊 Nai Nai · $30", from);
  check("M-1 offer holds Kevin's money slot", hasOpenMoneyPrompt(kevin));
  check("M-1 gift during an open offer is handled", await tryHandlePayment(family, kevin, msg(kevin, "send Mei $10")));
  check("M-1 … with 'Answer my earlier question first'", saw(kevin, "Answer my earlier question first 🙂", from) && !saw(kevin, "💸", from), dump(from));
  // A guard with an open offer is busy too: Nai Nai's red envelope can't borrow Mei's open question.
  await waitFor(mei, "💊 Nai Nai · $30", from);
  await tryHandlePayment(family, nainai, msg(nainai, "给Kevin发个红包，100块"));
  check("M-1 busy guard → gift refused, guard not asked", saw(nainai, "Mei is answering another question", from) && !saw(mei, "🛡️", from), dump(from));
  answer(kevin, "no");
  answer(mei, "no");
  await sleep(50);
  check("M-1 nothing paid", calls.length === 0, JSON.stringify(calls));
  check("M-1 slots released after answers", !hasOpenMoneyPrompt(kevin) && !hasOpenMoneyPrompt(mei));
  restore();
}

// M-2: no trusted member → no risky gift (review probe s4)
{
  const { calls, restore } = counting();
  for (const [who, text] of [[nainai, "给Kevin发个红包，100块"], [kevin, "send Nai Nai $500"], [kevin, "send Mei $20 for gift cards, don't tell anyone"]] as const) {
    const from = lines.length;
    check(`M-2 "${text}" handled`, await tryHandlePayment(noTrust, who, msg(who, text)));
    await sleep(20);
    check(`M-2 "${text}" refused without asking anyone`, saw(who, "need a trusted family member", from) && !lines.slice(from).some((l) => l.includes("💸") || l.includes("🛡️ ")), dump(from));
  }
  check("M-2 nothing paid", calls.length === 0, JSON.stringify(calls));
  check("S-3 requiresConfirmation(NaN) is true", requiresConfirmation(kevin, NaN));
  const from = lines.length;
  maybeOfferHelp(noTrust, nainai, "我需要钱买礼品卡");
  await sleep(500);
  check("M-2 money request with no trusted member → nobody is asked", !lines.slice(from).some((l) => l.includes("📱")), dump(from));
  restore();
}

// M-3: the guard is never the recipient or the sender (review probe s2)
{
  check("M-3 trustedConfirmer excludes the recipient", trustedConfirmer(family, nainai, mei) === undefined && trustedConfirmer(family, nainai, kevin)?.id === "mei");
  check("M-3 trustedConfirmer excludes the requester", trustedConfirmer(family, mei)?.id !== "mei");
  const { calls, restore } = counting();
  for (const [who, text] of [[nainai, "给Mei发个红包，500块"], [kevin, "send Mei $50 for gift cards urgently, don't tell anyone"]] as const) {
    const from = lines.length;
    await tryHandlePayment(family, who, msg(who, text));
    await sleep(20);
    check(`M-3 "${text}": Mei is not asked to approve a gift to herself`, !saw(mei, "🛡️", from) && saw(who, "need a trusted family member", from), dump(from));
  }
  check("M-3 nothing paid", calls.length === 0, JSON.stringify(calls));
  // With Kevin trusted too, he (not Mei) checks the gift to Mei.
  const bothTrusted = without((x) => ({ ...x, isTrustedForMoney: x.id !== "nainai" }));
  const { from } = await convo(nainai, "给Mei发个红包，500块", [[kevin, "🛡️ Nai Nai ➡️ Mei · NT$500", "no"]], bothTrusted);
  check("M-3 another trusted member is asked instead", !saw(mei, "🛡️", from), dump(from));
  restore();
}

// S-2: unknown currencies are refused, never treated as USD
{
  const { calls, restore } = counting();
  const sgd = without((x) => (x.id === "kevin" ? { ...x, currency: "SGD" } : x));
  let from = lines.length;
  await tryHandlePayment(sgd, { ...kevin, currency: "SGD" }, msg(kevin, "send Mei 50"));
  check("S-2 unknown sender currency refused", saw(kevin, "can't send that currency yet", from), dump(from));
  from = lines.length;
  await tryHandlePayment(sgd, mei, msg(mei, "send Kevin $50"));
  check("S-2 unknown recipient currency refused", saw(mei, "can't send money to Kevin's currency", from), dump(from));
  check("S-2 nothing paid", calls.length === 0, JSON.stringify(calls));
  restore();
}

// S-3: the large-amount check uses USD (NT$250 ≈ $7.76 is small, $250 is large)
{
  const from = lines.length;
  const p = tryHandlePayment(family, kevin, msg(kevin, "send Nai Nai 250 TWD"));
  check("S-3 NT$250 from Kevin goes straight to his confirm", await waitFor(kevin, "💸 Nai Nai · NT$250", from) && !saw(mei, "🛡️", from), dump(from));
  answer(kevin, "no");
  await p;
  check("S-3 $250 needs a guard", requiresConfirmation(kevin, 250) && !requiresConfirmation(kevin, 7.76));
}

// S-4: a payment that may have gone through never says "Nothing was charged"
{
  const real = flowDeps.sendGift;
  flowDeps.sendGift = async (_f, _t, amount, currency): Promise<GiftResult> => ({ ok: false, amountSent: amount, sentCurrency: currency, amountReceived: 0, receivedCurrency: currency, error: "Visa didn't answer in time (timeout)", maybeCharged: true });
  const { from } = await convo(kevin, "send Mei $15", [[kevin, "💸 Mei · $15", "yes"]]);
  flowDeps.sendGift = real;
  check("S-4 maybe-charged → 'may have gone through; please check'", saw(kevin, "may have gone through; please check before trying again", from) && !saw(kevin, "Nothing was charged", from), dump(from));
}

// S-6: the first helper's payment fails → the offer reopens and the next yes pays
{
  resetNeedsForTests();
  const calls: string[] = [];
  const real = needsDeps.sendGift;
  needsDeps.sendGift = async (f, t, a, c): Promise<GiftResult> => {
    calls.push(f.id);
    if (f.id === "kevin") { await sleep(100); return { ok: false, amountSent: a, sentCurrency: c, amountReceived: 0, receivedCurrency: c, error: "card declined (test)" }; }
    return real(f, t, a, c);
  };
  const from = lines.length;
  maybeOfferHelp(family, nainai, "我的药快吃完了");
  await waitFor(kevin, "💊 Nai Nai · $30", from);
  await waitFor(mei, "💊 Nai Nai · $30", from);
  answer(kevin, "yes");
  await sleep(20);
  answer(mei, "yes"); // while Kevin's payment is in flight
  check("S-6 Mei told Kevin is already sending", await waitFor(mei, "Kevin is already sending it", from), dump(from));
  check("S-6 Kevin told his payment failed", await waitFor(kevin, "card declined (test)", from) && saw(kevin, "Nothing was charged", from), dump(from));
  check("S-6 Mei is asked again", await waitFor(mei, "Kevin's payment didn't go through, so this is open again", from), dump(from));
  answer(mei, "yes");
  check("S-6 Mei's yes pays", await waitFor(nainai, "🧧 Mei sent you", from), dump(from));
  check("S-6 exactly one failed + one paid", calls.join(",") === "kevin,mei", calls.join(","));
  needsDeps.sendGift = real;
}
{
  // ...but a maybe-charged failure does NOT reopen (that could pay twice).
  resetNeedsForTests();
  const calls: string[] = [];
  const real = needsDeps.sendGift;
  needsDeps.sendGift = async (f, _t, a, c): Promise<GiftResult> => (calls.push(f.id), { ok: false, amountSent: a, sentCurrency: c, amountReceived: 0, receivedCurrency: c, error: "timeout", maybeCharged: true });
  const from = lines.length;
  maybeOfferHelp(family, nainai, "我的药快吃完了");
  await waitFor(kevin, "💊 Nai Nai · $30", from);
  await waitFor(mei, "💊 Nai Nai · $30", from);
  answer(kevin, "yes");
  check("S-6/S-4 Kevin told it may have gone through", await waitFor(kevin, "may have gone through", from), dump(from));
  answer(mei, "yes");
  check("S-6/S-4 Mei's later yes → already handled, not paid", await waitFor(mei, "Already handled", from) && calls.length === 1, calls.join(","));
  needsDeps.sendGift = real;
}

// S-7: a money request's number is read in the elder's currency and converted to USD
{
  resetNeedsForTests();
  const from = lines.length;
  await tryHandlePayment(family, nainai, msg(nainai, "我需要钱，给我3000块"));
  check("S-7 3000块 from Nai Nai = NT$3,000 ≈ $93 offered to Mei", await waitFor(mei, "🛡️ Nai Nai · $93", from), dump(from));
  answer(mei, "no");
  await sleep(50);
  resetNeedsForTests();
  const f2 = lines.length;
  maybeOfferHelp(family, nainai, "send me $50,000 now");
  check("S-7 huge request is capped at $1,000", await waitFor(mei, "🛡️ Nai Nai · $1,000", f2), dump(f2));
  answer(mei, "no");
  await sleep(50);
}

console.log = realLog;
console.warn = realWarn;
console.log(failures ? `\n${failures} failed, ${passes} passed` : `flow.selftest: all ${passes} checks passed`);
process.exit(failures ? 1 : 0);
