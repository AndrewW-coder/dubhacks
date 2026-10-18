// Offline selftest for shop/catalog.ts + shop/search.ts: npx tsx src/shop/catalog.selftest.ts
// Runs a fake SerpApi server (SERPAPI_BASE_URL) and a fake Gemini/OpenAI-compatible server (LLM_BASE_URL)
// on 127.0.0.1. Exits non-zero on failure. All products and keys here are fake.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Pin every setting so a developer's .env can't interfere (dotenv never overrides variables already set).
Object.assign(process.env, {
  TRANSLATE_PROVIDER: "gemini",
  LLM_API_KEY: "fake",
  GEMINI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  LLM_MODEL: "fake-model",
  LLM_TIMEOUT_MS: "3000",
  SERPAPI_API_KEY: "fake-serp-key",
  SERPAPI_GL: "us",
  SERPAPI_HL: "en",
  SERPAPI_LOCATION: "",
  SERPAPI_TIMEOUT_MS: "12000",
  SHOP_SEARCH: "",
  VISA_MODE: "mock",
});

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

// ── Fake SerpApi ───────────────────────────────────────────────────────────

let serpMode: "ok" | "error" | "slow" | "empty" = "ok";
const serpRequests: URLSearchParams[] = [];
const SERP_FIXTURE = {
  search_metadata: { id: "fake", status: "Success" },
  shopping_results: [
    {
      position: 1, title: "Talking Blood Pressure Monitor for Seniors, Large Backlit Display", product_id: "111",
      product_link: "https://www.google.com/shopping/product/111", source: "FakeMart", price: "$45.99", extracted_price: 45.99,
      rating: 4.6, reviews: 2311, snippet: "Mandarin and English voice broadcast, one-touch button", extensions: ["Large display", "Free shipping"],
      thumbnail: "https://example.test/111.jpg", delivery: "Free delivery",
    },
    {
      position: 2, title: "Basic Wrist Blood Pressure Cuff", product_id: "222",
      product_link: "https://www.google.com/shopping/product/222", source: "DemoShop", price: "$19.99", extracted_price: 19.99,
      rating: 3.9, reviews: 120, thumbnail: "https://example.test/222.jpg",
    },
    {
      position: 3, title: "Upper Arm Blood Pressure Monitor, Big Digits, 2 Users", product_id: "333",
      product_link: "https://www.google.com/shopping/product/333", source: "ExampleStore", price: "NT$1,190", extracted_price: 1190,
      rating: 4.4, reviews: 870, extensions: ["Big buttons"],
    },
    {
      position: 4, title: "Talking Alarm Clock with Big Numbers", product_id: "444",
      product_link: "https://www.google.com/shopping/product/444", source: "FakeMart", price: "$15.00", extracted_price: 15, rating: 4.8, reviews: 5000,
    },
    {
      position: 5, title: "Blood Pressure Monitor Cuffs, Set of 4", product_id: "555",
      product_link: "https://www.google.com/shopping/product/555", source: "FakeMart", price: "$22.00", extracted_price: 22,
    },
    {
      position: 6, title: "Hospital-Grade Blood Pressure Monitor with Bluetooth", product_id: "666",
      product_link: "https://www.google.com/shopping/product/666", source: "DemoShop", price: "$149.00", extracted_price: 149, rating: 4.7, reviews: 400,
    },
    { position: 7, title: "No price item", product_id: "777", source: "DemoShop" },
  ],
};

function serpHandler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  serpRequests.push(url.searchParams);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname !== "/search") return send(404, { error: "wrong path" });
  if (serpMode === "error") return send(500, { error: "boom" });
  if (serpMode === "empty") return send(200, { search_metadata: { status: "Success" }, error: "Google hasn't returned any results for this query." });
  if (serpMode === "slow") return void setTimeout(() => send(200, SERP_FIXTURE), 1500);
  send(200, SERP_FIXTURE);
}

// ── Fake Gemini (OpenAI-compatible) ────────────────────────────────────────

let llmMode: "ok" | "error" | "badIndexes" | "notShopping" = "ok";
const llmRequests: { tool: string; user: any }[] = [];

function llmHandler(req: IncomingMessage, res: ServerResponse) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = JSON.parse(body || "{}");
    const tool: string = json.tools?.[0]?.function?.name ?? "";
    let user: any = json.messages?.[1]?.content;
    try { user = JSON.parse(user); } catch { /* plain text */ }
    llmRequests.push({ tool, user });
    if (llmMode === "error") {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "boom" } }));
    }
    let args: unknown;
    if (tool === "shopping_need") {
      args = llmMode === "notShopping"
        ? { isShopping: false }
        : {
            isShopping: true, forMemberId: "nainai", category: "medical-device", occasion: "", budgetUsd: 0,
            keywordsEn: ["blood pressure monitor large display"], mustHave: ["large display", "chinese voice"],
          };
    } else if (tool === "rank_products") {
      const n = user?.candidates?.length ?? 0;
      args = llmMode === "badIndexes"
        ? { picks: [{ index: 99, why: "nope" }, { index: -1, why: "nope" }] }
        : { picks: [
            { index: Math.min(1, n - 1), why: "Big digits and two big buttons she can press easily; " + "very ".repeat(40) + "long" },
            { index: 0, why: "Speaks results in Mandarin with a large backlit display." },
            { index: 0, why: "duplicate should be ignored" },
          ] };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "fake", object: "chat.completion",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } }],
    }));
  });
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  const serp = await listen(serpHandler);
  const llm = await listen(llmHandler);
  process.env.SERPAPI_BASE_URL = serp.url;
  process.env.LLM_BASE_URL = llm.url;

  const { detectShoppingNeed, findOptions, culturalProblem, loadCatalog, luckyAmount, quickNeed } = await import("./catalog.js");
  const { searchProducts, clearSearchCache, currencyOf, mapResult } = await import("./search.js");
  type ShoppingNeed = import("./catalog.js").ShoppingNeed;
  type Family = import("../types.js").Family;

  const family: Family = {
    id: "test-family", name: "Test family",
    members: [
      { id: "nainai", name: "Nai Nai", handle: "+15550000001", language: "zh", relationship: "grandmother", isBilingualReviewer: false, currency: "TWD" },
      { id: "kevin", name: "Kevin", handle: "+15550000002", language: "en", relationship: "grandson", isBilingualReviewer: false, currency: "USD", isTrustedForMoney: true },
      { id: "mei", name: "Mei", handle: "+15550000003", language: "en", relationship: "granddaughter", isBilingualReviewer: true, currency: "USD" },
    ],
  };
  const [nainai, kevin] = family.members;
  const noAI = () => (process.env.LLM_API_KEY = "");
  const withAI = () => (process.env.LLM_API_KEY = "fake");
  const catalogIds = new Set(loadCatalog().map((p) => p.id));

  // 1. Catalog file
  const catalog = loadCatalog();
  check("catalog has ~30 products with en+zh names", catalog.length >= 28 && catalog.every((p) => p.name.en && p.name.zh), catalog.length);
  check("catalog products have no external links", catalog.every((p) => !p.url));

  // 2. Detection without AI (regex fallback)
  noAI();
  const d1 = await detectShoppingNeed(family, nainai, "我的血压计坏了");
  check("zh: 我的血压计坏了 → need for Nai Nai", d1?.forMember.id === "nainai" && d1.category === "medical-device" && d1.keywordsEn?.[0] === "blood pressure monitor", d1);
  const d2 = await detectShoppingNeed(family, nainai, "我想买一个血压计，字要大一点");
  check("zh: 字要大 → mustHave large display", !!d2?.mustHave?.includes("large display"), d2?.mustHave);
  const d3 = await detectShoppingNeed(family, kevin, "Can you find Nai Nai a warm jacket for winter?");
  check("en: find Nai Nai a warm jacket → for Nai Nai, clothing", d3?.forMember.id === "nainai" && d3.category === "clothing", d3 && { f: d3.forMember.id, c: d3.category });
  const d4 = await detectShoppingNeed(family, kevin, "let's buy grandma a gift for Lunar New Year, under $60");
  check("en: New Year gift for grandma, budget $60", d4?.forMember.id === "nainai" && d4.occasion === "lunar-new-year" && d4.budgetUsd === 60, d4 && { f: d4.forMember.id, o: d4.occasion, b: d4.budgetUsd });
  const d5 = await detectShoppingNeed(family, nainai, "我的热水壶坏了，需要一个新的");
  check("zh: 热水壶坏了 → kitchen", d5?.category === "kitchen", d5?.category);
  const d6 = await detectShoppingNeed(family, kevin, "my kettle broke");
  check("en: my kettle broke (from Kevin) → for Kevin", d6?.forMember.id === "kevin", d6?.forMember.id);
  for (const [who, text] of [
    [kevin, "I need to pay rent this month"],
    [kevin, "I bought groceries today"],
    [nainai, "这个月的房租还没交，需要帮忙"],
    [nainai, "我需要钱交电费"],
    [kevin, "I'm broke lol"],
    [nainai, "今天天气很好"],
    [kevin, "can you buy me gift cards for grandma"],
    [nainai, "我需要你打电话给我"],
  ] as const) {
    check(`negative: "${text}" → null`, (await detectShoppingNeed(family, who, text)) === null);
  }

  // 3. Detection with AI
  withAI();
  llmMode = "ok";
  llmRequests.length = 0;
  const a1 = await detectShoppingNeed(family, nainai, "我想买一个血压计，字要大一点");
  check("AI: extraction used (keywords + mustHave)", a1?.keywordsEn?.[0] === "blood pressure monitor large display" && !!a1.mustHave?.includes("chinese voice"), a1);
  check("AI: called once with the shopping_need tool", llmRequests.length === 1 && llmRequests[0].tool === "shopping_need");
  llmRequests.length = 0;
  check("AI: regex pre-check skips the AI for chit-chat", (await detectShoppingNeed(family, kevin, "good morning everyone")) === null && llmRequests.length === 0);
  check("AI: rent never reaches the AI", (await detectShoppingNeed(family, kevin, "I want to buy time to pay rent")) === null && llmRequests.length === 0);
  llmMode = "notShopping";
  check("AI: isShopping=false → null", (await detectShoppingNeed(family, kevin, "find the remote for me")) === null);
  llmMode = "error";
  const a2 = await detectShoppingNeed(family, nainai, "我的血压计坏了");
  check("AI error → regex fallback", a2?.keywordsEn?.[0] === "blood pressure monitor", a2);
  llmMode = "ok";

  // 4. SerpApi mapping + cache
  clearSearchCache();
  serpMode = "ok";
  serpRequests.length = 0;
  const results = await searchProducts("blood pressure monitor large display");
  const r0 = results.find((p) => p.id === "serp-111");
  check("serp: request params", serpRequests[0]?.get("engine") === "google_shopping" && serpRequests[0]?.get("q") === "blood pressure monitor large display" && serpRequests[0]?.get("api_key") === "fake-serp-key" && serpRequests[0]?.get("gl") === "us" && serpRequests[0]?.get("hl") === "en", serpRequests[0] && Object.fromEntries(serpRequests[0]));
  check("serp: priceless item skipped", results.length === 6 && !results.some((p) => p.id === "serp-777"), results.length);
  check("serp: mapping (url, merchant, price, rating, reviews, image)", r0?.url === "https://www.google.com/shopping/product/111" && r0.merchant === "FakeMart" && r0.price === 45.99 && r0.currency === "USD" && r0.rating === 4.6 && r0.reviews === 2311 && r0.image === "https://example.test/111.jpg" && r0.shipsTo.length === 0, r0);
  check("serp: description from snippet + extensions", !!r0?.description?.includes("Mandarin") && !!r0.description.includes("Large display"), r0?.description);
  check("serp: tags inferred from text", !!r0?.tags.includes("large-display") && r0.tags.includes("chinese-voice"), r0?.tags);
  check("serp: NT$ price → TWD", results.find((p) => p.id === "serp-333")?.currency === "TWD");
  check("currencyOf: $ / NT$ / HK$ / €", currencyOf("$5", "us") === "USD" && currencyOf("NT$5", "us") === "TWD" && currencyOf("HK$5", "us") === "HKD" && currencyOf("5,00 €", "de") === "EUR");
  await searchProducts("blood pressure monitor large display");
  check("serp: second identical search served from cache", serpRequests.length === 1, serpRequests.length);
  serpMode = "error";
  clearSearchCache();
  check("serp: HTTP 500 → []", (await searchProducts("kettle")).length === 0);
  serpMode = "empty";
  check("serp: no results → []", (await searchProducts("kettle")).length === 0);
  process.env.SERPAPI_TIMEOUT_MS = "300";
  serpMode = "slow";
  const t0 = Date.now();
  check("serp: timeout → [] quickly", (await searchProducts("slow kettle")).length === 0 && Date.now() - t0 < 1400, Date.now() - t0);
  process.env.SERPAPI_TIMEOUT_MS = "12000";
  const saveKey = process.env.SERPAPI_API_KEY;
  process.env.SERPAPI_API_KEY = "";
  serpRequests.length = 0;
  check("serp: no key → [] with no request", (await searchProducts("kettle")).length === 0 && serpRequests.length === 0);
  process.env.SERPAPI_API_KEY = saveKey;

  // 5. findOptions with real search + AI ranking
  const bpNeed: ShoppingNeed = { forMember: nainai, text: "我想买一个血压计，字要大一点", category: "medical-device", keywordsEn: ["blood pressure monitor"], mustHave: ["large display"], budgetUsd: 100 };
  clearSearchCache();
  serpMode = "ok";
  withAI();
  llmMode = "ok";
  llmRequests.length = 0;
  const o1 = await findOptions(family, bpNeed);
  const sent = llmRequests.find((r) => r.tool === "rank_products")?.user?.candidates ?? [];
  const sentTitles: string[] = sent.map((c: any) => c.title);
  check("search+AI: 3 options with links", o1.length === 3 && o1.every((o) => o.product.url?.startsWith("https://")), o1.map((o) => o.product.id));
  check("search+AI: clock and set of 4 never shown to the AI", !sentTitles.some((t) => /clock|set of 4/i.test(t)) && sentTitles.length > 0, sentTitles);
  check("search+AI: over-budget $149 item dropped", !sentTitles.some((t) => /Hospital-Grade/.test(t)));
  check("search+AI: ≤12 candidates, with price/rating/reviews/description", sent.length <= 12 && sent.every((c: any) => "priceUsd" in c && "rating" in c && "reviews" in c && "description" in c));
  check("search+AI: AI order kept, duplicate ignored, list topped up", o1[0]?.product.id === sentId(sent, o1[0]) && o1[1]?.why.startsWith("Speaks results in Mandarin") && new Set(o1.map((o) => o.product.id)).size === 3, o1.map((o) => [o.product.id, o.why]));
  check("search+AI: why ≤25 words", o1.every((o) => o.why.split(/\s+/).length <= 25 && o.why.length > 0), o1.map((o) => o.why));
  check("search+AI: SerpApi max_price from budget", serpRequests.at(-1)?.get("max_price") === "100");

  // 6. Search failure → catalog fallback
  clearSearchCache();
  serpMode = "error";
  noAI();
  const o2 = await findOptions(family, bpNeed);
  check("search failure → catalog options (no links)", o2.length === 3 && o2.every((o) => catalogIds.has(o.product.id) && !o.product.url), o2.map((o) => o.product.id));
  process.env.SHOP_SEARCH = "catalog";
  serpRequests.length = 0;
  const o2b = await findOptions(family, bpNeed);
  check("SHOP_SEARCH=catalog → no SerpApi call", o2b.length === 3 && serpRequests.length === 0);

  // 7. Cultural rules (catalog path, no AI)
  for (const id of ["clock-red", "clock-talking", "cups-set4", "pears-gift", "flowers-white"]) {
    const p = catalog.find((x) => x.id === id)!;
    check(`culture: ${id} flagged for Nai Nai`, !!p && !!culturalProblem(p, nainai));
  }
  for (const id of ["cups-set6", "orchid-pot", "scarf-red", "oranges-gift", "bp-talking-xl"]) {
    const p = catalog.find((x) => x.id === id)!;
    check(`culture: ${id} allowed`, !!p && !culturalProblem(p, nainai));
  }
  check("culture: rules don't apply to Kevin (en)", !culturalProblem(catalog.find((x) => x.id === "clock-red")!, kevin));
  const giftNeed: ShoppingNeed = { forMember: nainai, text: "给奶奶买过年礼物", category: "gift", occasion: "lunar-new-year", keywordsEn: ["lunar new year gift for grandmother"] };
  const o3 = await findOptions(family, giftNeed);
  check("culture: New Year gift for Nai Nai → 3 options, no clock/4-set/pears/white flowers", o3.length === 3 && o3.every((o) => !/clock|set of 4|pear|white/i.test(o.product.name.en)), o3.map((o) => o.product.id));
  const clockNeed: ShoppingNeed = { forMember: nainai, text: "买个钟", category: "home", keywordsEn: ["clock"] };
  check("culture: asking for a clock for her finds no clock", (await findOptions(family, clockNeed)).every((o) => !/clock/i.test(o.product.name.en)));

  // 8. Budget + shipping filters
  const cheap = await findOptions(family, { ...bpNeed, budgetUsd: 45 });
  check("budget: every option ≤ $45 (NT$1,290 ≈ $40 included)", cheap.length > 0 && cheap.every((o) => o.product.currency !== "USD" || o.product.price <= 45) && cheap.some((o) => o.product.id === "bp-talking-xl") && !cheap.some((o) => o.product.id === "bp-smart-pro"), cheap.map((o) => o.product.id));
  check("budget: nothing fits → []", (await findOptions(family, { ...bpNeed, budgetUsd: 5 })).length === 0);
  const nainaiTW = { ...nainai, shipTo: { city: "Taipei", country: "TW" } } as typeof nainai;
  const shipped = await findOptions(family, { ...bpNeed, forMember: nainaiTW, budgetUsd: undefined, mustHave: undefined });
  check("shipping: items that don't ship to TW are dropped", shipped.length > 0 && shipped.every((o) => o.product.shipsTo.includes("TW")), shipped.map((o) => o.product.id));

  // 8b. Relevance: things the catalog doesn't carry → [] (so needs.ts can fall back to the money offer)
  for (const [who, text] of [[nainai, "冰箱坏了"], [kevin, "Nai Nai's refrigerator broke, can we buy her a new fridge?"], [nainai, "我的洗衣机坏了"], [kevin, "find grandma a washing machine"]] as const) {
    const need = await detectShoppingNeed(family, who, text);
    const opts = need ? await findOptions(family, need) : [];
    check(`relevance: "${text}" → need detected, but [] options`, !!need && opts.length === 0, opts.map((o) => o.product.id));
  }
  const bpOnly = await findOptions(family, { forMember: nainai, text: "blood pressure monitor", category: "medical-device", keywordsEn: ["blood pressure monitor"] });
  check("relevance: blood pressure monitor → only BP monitors", bpOnly.length > 0 && bpOnly.every((o) => /blood pressure/i.test(o.product.name.en)), bpOnly.map((o) => o.product.id));
  const tabNeed = await detectShoppingNeed(family, kevin, "find a tablet for grandma");
  const tabs = tabNeed ? await findOptions(family, tabNeed) : [];
  check("relevance: tablet for grandma → tablets/phones only", tabs.length > 0 && tabs.every((o) => o.product.category === "phone"), tabs.map((o) => o.product.id));
  const heaters = await findOptions(family, { forMember: nainai, text: "Nai Nai needs a new heater", category: "home", keywordsEn: ["space heater"] });
  check("relevance: heater → no lamp or slippers", heaters.length > 0 && heaters.every((o) => /heater/i.test(o.product.name.en)), heaters.map((o) => o.product.id));
  process.env.SHOP_SEARCH = "";
  clearSearchCache();
  serpMode = "ok";
  const fridgeSerp = await findOptions(family, { forMember: nainai, text: "冰箱坏了", category: "home", keywordsEn: ["refrigerator"] });
  check("relevance: search results sharing no keyword are dropped (BP fixture for a fridge → [])", fridgeSerp.length === 0, fridgeSerp.map((o) => o.product.id));
  process.env.SHOP_SEARCH = "catalog";

  // 9. Top 3 without AI
  const o4 = await findOptions(family, { ...bpNeed, mustHave: ["large display", "chinese voice"] });
  check("no AI: top pick is the talking big-display monitor", o4[0]?.product.id === "bp-talking-xl", o4.map((o) => o.product.id));
  check("no AI: 3 blood pressure monitors", o4.length === 3 && o4.every((o) => /blood pressure/i.test(o.product.name.en)), o4.map((o) => o.product.name.en));
  check("no AI: why is specific and ≤25 words", /display/i.test(o4[0]?.why ?? "") && o4.every((o) => o.why.split(/\s+/).length <= 25), o4.map((o) => o.why));

  // 10. AI ranking failures fall back to scores
  withAI();
  llmMode = "error";
  const o5 = await findOptions(family, bpNeed);
  check("AI rank error → scored top 3", o5.length === 3 && o5[0].why.length > 0, o5.map((o) => o.product.id));
  llmMode = "badIndexes";
  const o6 = await findOptions(family, bpNeed);
  check("AI rank with invalid indexes → scored top 3", o6.length === 3, o6.map((o) => o.product.id));
  llmMode = "ok";
  const o7 = await findOptions(family, bpNeed);
  check("catalog + AI ranking → 3 options", o7.length === 3 && o7[1].why.startsWith("Speaks results"), o7.map((o) => [o.product.id, o.why]));

  // 10b. Review fixes (U2-13): "buy me" is for the sender; gift cards are never shopping;
  // "for grandmother" only when the recipient is an elder.
  noAI();
  for (const [who, t, want] of [
    [kevin, "buy me a clock", "kevin"], [kevin, "find me a gift for lunar new year", "kevin"], [kevin, "get me a new kettle for winter", "kevin"],
    [kevin, "find me a gift for grandma", "nainai"], [kevin, "find me a time to call grandma tonight", "kevin"],
    [nainai, "给我买个血压计", "nainai"], [nainai, "帮我买个礼物给Kevin", "kevin"], [kevin, "find Nai Nai a heater", "nainai"],
  ] as const) {
    const q = quickNeed(family, who, t);
    check(`recipient: "${t}" → ${want}`, (q?.forMember.id ?? (t.includes("time") ? "kevin" : "none")) === want, q?.forMember.id);
  }
  const ny = quickNeed(family, nainai, "给Kevin买个过年礼物");
  check("lunar gift for Kevin → no 'for grandmother'", ny?.forMember.id === "kevin" && !ny.keywordsEn?.some((k) => /grand/.test(k)), ny?.keywordsEn);
  const ny2 = quickNeed(family, kevin, "给奶奶买个过年礼物");
  check("lunar gift for Nai Nai → 'for grandmother'", ny2?.forMember.id === "nainai" && ny2.keywordsEn?.[0] === "lunar new year gift for grandmother", ny2?.keywordsEn);
  for (const t of ["我想买预付卡", "帮我买Apple卡", "我想买iTunes卡", "我想买点卡", "我想买Steam充值码", "buy grandma some prepaid cards", "buy Nai Nai a Visa reward card", "find Nai Nai an Amazon eGift card", "buy grandma a Google Play code"]) {
    check(`never shopping: "${t}"`, quickNeed(family, nainai, t) === null && quickNeed(family, kevin, t) === null);
  }

  // 11. Never throws
  let threw = false;
  try {
    await findOptions(family, { forMember: nainai, text: "", category: "other" });
    await findOptions(family, null as unknown as ShoppingNeed);
    await detectShoppingNeed(family, nainai, undefined as unknown as string);
    quickNeed(family, kevin, "");
  } catch {
    threw = true;
  }
  check("never throws on odd input", !threw);
  const spaced = mapResult({ title: "Omron 3 Series", extracted_price: 39.99, source: "Target", product_link: "https://www.google.com/search?ibp=oshop&q=large display blood pressure monitor&prds=catalogid:1" });
  check("SerpApi product_link with spaces → one encoded link", spaced?.url === "https://www.google.com/search?ibp=oshop&q=large%20display%20blood%20pressure%20monitor&prds=catalogid:1", spaced?.url);
  check("luckyAmount ends in 8", luckyAmount(50) === 58 && luckyAmount(100) === 108 && luckyAmount(58) === 58 && luckyAmount(59) === 68);

  serp.server.close();
  llm.server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);

  function sentId(cands: any[], first: { product: { name: Record<string, string> } } | undefined) {
    // The fake ranks candidate #1 first: the first option must be that candidate.
    return cands[1] && first && cands[1].title === first.product.name.en ? (first as any).product.id : "mismatch";
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
