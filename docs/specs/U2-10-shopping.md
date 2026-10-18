# Spec U2-10: Shopping for family, User 2's half of `VISA-SHOPPING.md`

Owner: reallyrealistic (User 2). Implements the U2 rows of `docs/specs/VISA-SHOPPING.md` (steps 1–3), plus reallyrealistic's pipeline:

> Grandma describes what she wants → translate to English → pull keywords → **search shopping websites** → check the descriptions → pick the top 3 → send them to grandma in Chinese (each with **the link** and a summary) → grandma and Kevin talk it over → buy. All in iMessage.

Runner: orchestrator + 3 parallel subagents (wave 1), then writeup + independent review (wave 2). Rules from `U2-00-master.md` apply (own files only, no secrets, works with no keys, fake servers for tests, under-400-word reports).

## Product source: real search first, curated catalog as the safety net
- **Real search (`SHOP_SEARCH=serpapi`, default when `SERPAPI_API_KEY` is set):** SerpApi's Google Shopping engine, which aggregates many stores, so the links are real. Gemini's built-in Google Search grounding is not available on free-tier keys, so it isn't used.
- **Curated catalog (`SHOP_SEARCH=catalog`, the default without a key, and the fallback on any search error):** `data/catalog.json`, about 30 fictional demo products with fictional merchants, per the design doc. Fictional products get no external link (`url` absent); the card says "demo product".
- Demo safety: the catalog path must always work offline, so the stage demo never depends on a search API.

## Frozen contracts (from VISA-SHOPPING.md, with additive optional fields)
```ts
// shop/catalog.ts (U2)
export interface Product {
  id: string;
  name: Record<LanguageCode, string>;   // at least "en"
  price: number; currency: string;
  merchant: string;
  shipsTo: string[];                    // country codes ([] = unknown, for search results)
  tags: string[];
  image?: string;                       // local path (catalog) or https URL (search)
  url?: string;                         // NEW optional: product page link (search results only)
  rating?: number; reviews?: number;    // NEW optional (search results)
  description?: string;                 // NEW optional: snippet/specs used for ranking
}
export interface ShoppingNeed { forMember: FamilyMember; text: string; category: string; occasion?: string; budgetUsd?: number }
export interface Option { product: Product; why: string }   // why in English; callers translate per reader
export function findOptions(family: Family, need: ShoppingNeed): Promise<Option[]>;   // never throws; [] = nothing fits
export function detectShoppingNeed(family: Family, sender: FamilyMember, text: string): Promise<ShoppingNeed | null>; // NEW: never throws

// shop/checkout.ts (U2)
export interface OrderResult { ok: boolean; orderId?: string; charged?: { amount: number; currency: string }; eta?: string; error?: string; maybeCharged?: boolean }
export function checkout(family: Family, buyer: FamilyMember, forMember: FamilyMember, product: Product): Promise<OrderResult>; // never throws

// U1 functions we CALL (they may not exist yet; see shop/u1.ts below)
familyVote(family, voters, card: (reader) => Promise<string>, optionCount, timeoutMs): Promise<{ winner: number | null; votes: Map<string, number> }>  // relay/vote.ts
trackOrder(family, buyer, forMember, product, order): void                                                                                           // shop/orders.ts
FamilyMember.shipTo?: { city; country }, FamilyMember.shopLimitUsd?: number                                                                            // types.ts, U1's contract commit
```

## Files (all User 2)
| File | Built by |
|---|---|
| `src/shop/catalog.ts`, `data/catalog.json`, `src/shop/search.ts`, `src/shop/catalog.selftest.ts` | subagent **finder** |
| `src/shop/checkout.ts`, `src/shop/checkout.selftest.ts` | subagent **checkout** |
| `src/shop/shopFlow.ts`, `src/shop/u1.ts`, `src/shop/shopFlow.selftest.ts`, edits to `src/payments/needs.ts` + `src/payments/flow.ts`, `data/demo-shopping-u2.txt` | subagent **conversation** |
| `README.md`, `docs/DEVPOST.md` | subagent **writeup** (wave 2) |

`src/shop/u1.ts` is the **bridge to User 1's not-yet-written pieces**. It tries `import("../relay/vote.js")` / `import("./orders.js")` (via a variable specifier so TypeScript doesn't need the files) and uses them if present. Otherwise it uses simple built-in stand-ins: a vote using `askFirst` (first letter/tapback per person, majority wins, timeout → most votes), and an order confirmation using `say()`. It reads `shipTo` / `shopLimitUsd` with an optional cast, so `types.ts` stays untouched until Andrew's contract commit. When Andrew merges his files, ours start using them with no code change.

## The conversation (shopFlow.ts)
1. **Trigger:** `flow.ts` → after the money check fails, `shopFlow.tryHandleShopping(family, sender, msg)` runs:
   - **explicit requests** from anyone: "我想买个…", "帮我找…", "find Nai Nai a…", "buy grandma a…";
   - **needs.ts:** a *buyable* need ("我的血压计坏了") starts a shopping flow instead of the money offer; rent and bills still get the money offer.
   The original message is still relayed as chat (return false), except for explicit "find/buy X for Y" commands to Bridge.
2. `detectShoppingNeed` → `findOptions` (top 3) → cards. Each option is one message: letter, name, price in the reader's currency (`quote()`), merchant, a 1–2 sentence summary + why, in **the reader's language**, and **the link on its own line** (so iMessage shows a preview).
3. `familyVote` (U1 or stand-in) over the elder + non-elder members. While the vote is open, people can chat freely (normal relay); only letters and tapbacks on cards count as votes.
4. The winner → buyer = a member with `isTrustedForMoney` (or the first non-elder) → `checkout()`. Over the buyer's `shopLimitUsd` (default 50), the buyer confirms with ❤️ or "yes" (strict yes from flow.ts). Requests *from* an elder go through the existing scam check.
5. `trackOrder` (U1 or stand-in): "Kevin bought you … 🎁" in each reader's language.
6. One open shopping decision per family. Everything degrades: no options → existing money offer; vote timeout → most votes, else the buyer picks; checkout fails → a clear message, nothing ordered.

## Cultural rules (finder)
- Gifts for elders (Chinese family): no clocks (送钟), no sets of four, no pears to split (分梨), no white/black flowers.
- Suggested amounts ending in 8 are good.
- Prefer elder-friendly features: large display, simple buttons, Chinese-language UI or voice, and shipping to `shipTo.country`.

## Acceptance (wave 1 merged)
- `npx tsc --noEmit`; all `src/**/*.selftest.ts` pass offline; `npm run sim:demo`, `npm run sim:u2` and the new `data/demo-shopping-u2.txt` run with no keys.
- With the fake SerpApi + fake Gemini servers: Nai Nai's "我想买一个血压计，字要大一点" → 3 cards in Chinese to her and in English to Kevin, each with a link. Kevin ❤️ B, Nai Nai replies "B" → checkout (mock) → confirmation to both.
- No real card numbers, addresses or API keys in code. Fictional merchants only in the catalog.
