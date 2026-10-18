# Spec U2-10b: Checkout (subagent "checkout")
Read first: `U2-10-shopping.md`, `U2-00-master.md`, `VISA-SHOPPING.md` ("Visa: what to use", "Safety"), `src/payments/visa.ts` (quote, sendGift, MAX_GIFT_USD, isSupportedCurrency, maybeCharged semantics), `src/payments/flow.ts` (isYes, moneyPrompt, localize, say, claimMoneySlot), `src/payments/scamCheck.ts`, `src/relay/prompts.ts` (ask).

**Owns:** `src/shop/checkout.ts`, `src/shop/checkout.selftest.ts`. Import `Product` *types* from `./catalog.js` (another agent is writing it; define a local copy of the `Product` interface from the spec if the file doesn't exist yet, and note it in your report).

## Build `checkout(family, buyer, forMember, product): Promise<OrderResult>`. Never throws.
1. Validate: price > 0, a supported currency (`isSupportedCurrency`), converted USD ≤ `MAX_GIFT_USD`.
2. The limit: `shopLimitUsd` from the buyer (optional cast; the field arrives later from U1), default `SHOP_DEFAULT_LIMIT_USD` = 50. Over the limit, use **strict confirmation** with `ask()` + `isYes` (❤️ or yes) via `moneyPrompt`. The amount line is never translated; the price is shown in the buyer's currency via `quote()`. Use `claimMoneySlot` so the buyer can't have two money questions open.
3. Scam protection: if `forMember`/the requester is an elder *and* the product looks like a scam target (gift cards, prepaid cards, crypto, wire), or the product text triggers `scamSignals`, refuse unless a `trustedConfirmer` (not the buyer, not the recipient) approves.
4. Payment, by `SHOP_MODE`:
   - **mock (default):** fake order id `ord-…` and ETA in 3 days (ISO date); charged in the buyer's currency.
   - **sandbox:** pay via the existing Visa path. For now reuse `sendGift(buyer, merchantStandIn, …)` semantics, or a TODO with a clear `error: "shop sandbox not set up"`. Keep `maybeCharged` semantics. Mark `// VISA-BOOTH:` where the booth's recommended API (e.g. Visa Intelligent Commerce) plugs in.
5. Plain-English errors; `maybeCharged` → "may have gone through; check before trying again".
6. `src/shop/checkout.selftest.ts` (offline). Cover:
   - under the limit → no prompt;
   - over the limit → a prompt, and only a strict yes buys (test "ok?", "yes", ❤️, 👍, timeout);
   - unsupported currency / over the cap refused;
   - the scam case needs a guard;
   - one money question per buyer;
   - sandbox not set up → a clear error.

Report per master rule 8.
