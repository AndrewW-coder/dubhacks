# Spec U2-10a: Product finder (subagent "finder")
Read first: `U2-10-shopping.md` (contracts, cultural rules), `U2-00-master.md` (rules), `VISA-SHOPPING.md`, `src/translate/claude.ts` (callTool, used for all AI calls; provider is Gemini by default), `src/translate/translator.ts`, `src/payments/visa.ts` (quote, isSupportedCurrency).

**Owns:** `src/shop/catalog.ts`, `src/shop/search.ts`, `data/catalog.json`, `src/shop/catalog.selftest.ts`.

## Build
1. **`data/catalog.json`:** about 30 fictional products across the demo categories:
   - medical devices (blood pressure monitors, thermometers, pill organizers);
   - kitchen (rice cooker, kettle);
   - phones and tablets for elders (big buttons);
   - warm clothing, groceries/snacks, Lunar New Year gifts, home items (lamp, heater, slippers).
   Each needs `name.en` + `name.zh`, a price in USD or a demo currency, a fictional merchant, `shipsTo`, useful `tags` (`large-display`, `chinese-voice`, `elder-friendly`, `simple-buttons`, …) and a `description`. Include tempting **culturally bad** items (a wall clock, a set of 4 cups, pears) so the rules can be tested.
2. **`detectShoppingNeed(family, sender, text)`:**
   - a cheap regex pre-check: 想买, 帮我找, 买个, 坏了 + an object, 需要 + an object, "want to buy", "find … for", "buy … for", "broke", "need a new";
   - then `callTool` extracts `{ isShopping, forMemberId, category, occasion, budgetUsd, keywordsEn: string[], mustHave: string[] }`;
   - regex/keyword fallback without a key;
   - rent and bills are not shopping;
   - never throws.
   `ShoppingNeed` gets optional extra fields (`keywordsEn?`, `mustHave?`) on the interface.
3. **`src/shop/search.ts`:** `searchProducts(query, opts): Promise<Product[]>`, via SerpApi Google Shopping.
   - **Verify the current SerpApi docs with WebSearch/WebFetch** (endpoint, params `engine=google_shopping`, `q`, `gl`/`hl`/`location`, `api_key`; result fields like `shopping_results[].title/price/extracted_price/source/link|product_link/thumbnail/rating/reviews/extensions/snippet`).
   - Map results to `Product` (`url`, `rating`, `reviews`, `description` from snippet/extensions, `merchant` = source).
   - `SERPAPI_API_KEY`; `SERPAPI_BASE_URL` override for tests; 12 s timeout; never throws (returns []).
   - `SHOP_SEARCH=serpapi|catalog` (default serpapi when the key is set).
   - Cache by query for 10 minutes.
4. **`findOptions(family, need)`:**
   - candidates = search results (real) or the catalog filtered by category/keywords;
   - drop culturally bad items for the recipient (rules in the spec; deterministic code, not only the prompt), items over budget, and items that don't ship to `shipTo.country` (catalog only);
   - AI ranking with `callTool` over ≤12 candidates (title, price, rating, reviews, description) → top 3 + `why` (English, ≤25 words, specific to *her*: "big display, Chinese voice prompts");
   - fallback without a key: score by tag/keyword overlap + rating;
   - never throws; [] when nothing fits.
5. **`src/shop/catalog.selftest.ts`** (offline, fake SerpApi + fake Gemini servers; set `TRANSLATE_PROVIDER`/`LLM_*` explicitly so a real `.env` can't interfere). Cover:
   - detection (zh + en, positives + negatives: rent and "I bought groceries" aren't shopping);
   - SerpApi mapping;
   - search failure → catalog fallback;
   - cultural filter (no clock for Nai Nai's New Year gift, no sets of 4);
   - budget filter;
   - top-3 ranking with and without AI.

Report per master rule 8, including the SerpApi doc URLs relied on and any field uncertainty.
