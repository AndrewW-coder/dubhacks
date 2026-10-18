# Spec U2-10c: Shopping conversation (subagent "conversation")
Read first: `U2-10-shopping.md` (especially "The conversation" and the `u1.ts` bridge), `U2-00-master.md`, `VISA-SHOPPING.md`, `src/payments/flow.ts`, `src/payments/needs.ts`, `src/relay/prompts.ts` (askFirst, tryResolvePrompt), `src/relay/router.ts` + `src/index.ts` (how messages flow; don't edit them), `src/photon/mock.ts` (sim commands), `src/translate/translator.ts` (translate), `src/payments/visa.ts` (quote, formatMoney).

**Owns:** `src/shop/shopFlow.ts`, `src/shop/u1.ts`, `src/shop/shopFlow.selftest.ts`, `data/demo-shopping-u2.txt`, and minimal edits to `src/payments/flow.ts` + `src/payments/needs.ts` (a hook call only; keep their existing behaviour and selftests green).

Two other agents are writing `src/shop/catalog.ts` (findOptions, detectShoppingNeed, Product, Option, ShoppingNeed) and `src/shop/checkout.ts` (checkout, OrderResult) in parallel. Code against the contracts in U2-10-shopping.md. If those files don't exist in your copy, create **temporary minimal stubs with exactly the contract signatures** (catalog: return 3 hard-coded demo options; checkout: mock ok) so you can test, and say so in your report. The orchestrator replaces them with the real ones at merge.

## Build
1. **`src/shop/u1.ts`:** `familyVote(...)` and `trackOrder(...)` with the exact signatures from VISA-SHOPPING.md.
   - Each first tries a dynamic import of User 1's module (`"../relay/vote.js"` / `"./orders.js"` built from a variable, so tsc doesn't resolve it); on failure it uses a stand-in.
   - Vote stand-in: send each voter their card (one message per option), then accept a letter A–D or a tapback on an option card (👍 A · ❤️ B · 😂 C · ‼️ D) per voter. Majority, or everyone voted, or timeout (`SHOP_VOTE_TIMEOUT_MS`, default 120000) → most votes; ties → earliest option. Votes are never relayed as chat (use the prompts registry: a prompt per voter that stays open until they vote; re-open after an unrelated answer).
   - `trackOrder` stand-in: a confirmation to everyone in their language ("Kevin bought Nai Nai … 🎁, arriving …").
   - Also `shopLimitUsd(member)` / `shipTo(member)` readers with an optional cast.
2. **`src/shop/shopFlow.ts`:** `tryHandleShopping(family, sender, msg): Promise<boolean>`. Steps 1–6 of "The conversation" in the parent spec:
   - one open decision per family;
   - cards per option in the reader's language (translate name/summary/why with the existing `translate`, using a Bridge sender like flow.ts's `BRIDGE`);
   - the price in the reader's currency;
   - **the URL on its own line, never translated**;
   - "demo product" when there's no URL;
   - a heading message first, in each language ("Nai Nai wants a blood pressure monitor. Here are 3 options; reply A, B or C, or tapback 👍/❤️/😂. Feel free to talk it over first.").
   Return true only for explicit commands addressed to Bridge ("find/buy X for Y"); a natural message ("我想买个血压计") returns false (it's relayed as chat) and the flow runs in the background.
3. **Hooks:**
   - `flow.ts`: after the money logic decides the message isn't a payment, call `tryHandleShopping`. If it returns true, return true.
   - `needs.ts`: buyable needs start shopping (`detectShoppingNeed` non-null) instead of the money offer; rent/bills keep the money offer.
   - Keep every existing flow/needs selftest passing; update a needs test only if it asserts the old money offer for a now-buyable need, and say which.
4. **`data/demo-shopping-u2.txt`:** the full story in the simulator, no keys:
   - Nai Nai's need;
   - cards to all;
   - Kevin chats "B looks good, big screen";
   - Kevin ❤️ the B card, Nai Nai "B";
   - checkout (under the limit, so no prompt; then a second run over the limit with a confirm);
   - the confirmation;
   - and a "no options" fallback example.
5. **`src/shop/shopFlow.selftest.ts`** (offline, mock photon, answers via `tryResolvePrompt`). Cover:
   - cards in both languages with the URL untranslated;
   - the vote majority;
   - a letter vote and a tapback vote;
   - chat during the vote is not swallowed;
   - the timeout;
   - one decision per family;
   - the explicit command returns true and the natural message returns false;
   - the over-limit confirm;
   - checkout failure → a message and no confirmation.

Report per master rule 8.
