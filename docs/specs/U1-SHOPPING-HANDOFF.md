# Shopping pivot: Andrew's part (User 1)

From reallyrealistic (User 2). Your rows of `docs/specs/VISA-SHOPPING.md` are unchanged, plus **one change to `familyVote`**. My half (product search, checkout, the shopping conversation) is in `src/shop/` and already runs end to end in the simulator. Until your pieces land it uses simple built-in stand-ins (`src/shop/u1.ts`); the moment your files exist, it uses yours. No order dependency and no shared files, except the one `types.ts` contract commit below.

## What reallyrealistic added beyond the doc
Grandma's request now goes to **real shopping sites** (SerpApi Google Shopping, when `SERPAPI_API_KEY` is set) and the cards carry **real product links**. The fictional catalog is the offline fallback, so the demo always works without keys.

## Your tasks, in order
1. **`contract:` commit, `src/types.ts` (additive):**
   ```ts
   shipTo?: { city: string; country: string };   // on FamilyMember, demo only
   shopLimitUsd?: number;                        // buyer's auto-approve limit (default 50 if absent)
   ```
   Push it on its own as soon as you can. My code reads these with an optional cast today, so nothing breaks either way.
2. **`src/relay/vote.ts`: `familyVote`**, exact signature from VISA-SHOPPING.md, **except that `card` may return `string | string[]`**:
   - `string[]`: send each element as **its own message**, in order. Element 0 is the heading; element *i* (1..n) is option card *i*, with its link alone on the last line so iMessage shows a preview.
   - A **tapback on option card *i*** is a vote for option *i* (any tapback kind). Elsewhere: 👍 A · ❤️ B · 😂 C · ‼️ D. Letters A–D always work.
   - Votes are never relayed as chat; normal chat during a vote **is** relayed (the family talks it over).
   - Resolve on majority, everyone voted, or timeout (`SHOP_VOTE_TIMEOUT_MS`, default 120000) → most votes; ties → earliest option.
   - **Please record each card's message ID in `messageMap`** so a threaded reply to a card ("is B too heavy?") threads onto the same card in everyone else's thread.
3. **`src/shop/orders.ts`: `trackOrder`** per the doc: confirmation to everyone in their language, then simulated "shipped" / "delivered" (`SHOP_SHIP_DELAY_MS` / `SHOP_DELIVER_DELAY_MS`).
4. **`data/demo-shopping.txt`** (your file): the stage story. Mine, `data/demo-shopping-u2.txt`, already exercises the same flow against the stand-ins; copy from it freely.
5. **Live test on phones:**
   - link previews on the cards;
   - tapbacks on cards counted as votes;
   - a threaded reply to a card relayed correctly;
   - the backup video of the shopping story.

## Two small asks from my side's testing
- **`prompts.ts`: add `hasOtherOpenPrompt(handle, exceptIds?: string[]): boolean`.** The independent review found that a bare "A" meant for your translation-review question could land on a vote card (newest prompt wins) and count as a vote. My code already feature-detects this function and, when it exists, ignores bare letters from voters with another question open (tapbacks and threaded replies on cards still count). My side also can't buy anything without the buyer's explicit ❤️/yes, so this is about not losing the review answer, not about money.
- **`prompts.ts`: add `cancel(messageId)` (or `cancelFor(handle)`).** Today a bare "ok"/"好" said during a vote takes one of that voter's open card prompts, so their tapbacks on the remaining cards stop counting until they get a reminder. With a cancel, the vote can withdraw its prompts cleanly. Additive, so nothing breaks.
- **Card count is 1–3**, not always 3. Your `familyVote` should take `optionCount` from the caller, and the tapback legend should match it (👍 A only for a single option).

## What you can rely on from me (src/shop, User 2)
`detectShoppingNeed`, `findOptions` (top 3 + `why`, culturally filtered), `checkout` (mock by default; strict ❤️/yes over the buyer's limit; scam check), and `tryHandleShopping`, which is called from `payments/flow.ts`. **The router needs no change.**

## Settings you'll see in `.env.example`
`SERPAPI_API_KEY`, `SHOP_SEARCH` (`serpapi` | `catalog`), `SHOP_MODE` (`mock` | `sandbox`), `SHOP_DEFAULT_LIMIT_USD`, `SHOP_VOTE_TIMEOUT_MS`.
