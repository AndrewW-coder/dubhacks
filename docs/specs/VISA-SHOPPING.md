# Spec: Bridge shops for the people you love (Visa track pivot)

Owners: **both**. Supersedes the "Visa gifts" framing in `docs/PLAN.md` and `README.md`.
Status: proposed. Agree on it together, then build in parallel with the same rules as `docs/PARALLEL_PLAN.md`.

## Why change

The Visa track is **"Reimagine Shopping"**: use generative AI to make commerce more intuitive and personalized across discovery, decision-making, personalization, checkout, payments, loyalty and rewards, or post-purchase.

Today Bridge's Visa feature is **sending money between family members** (Visa Direct). That's a transfer, not shopping, so it only touches "payments". This spec keeps everything we've built (relay, review, translation, payments) and aims it at **shopping for a family member across a language gap**.

## The pitch

> Buying things for an aging parent or grandparent abroad is miserable from both sides. Grandma can't use English-language stores. The grandkids can't read her language, don't know what she actually needs, and can't check what arrived. **Bridge sits in the family's chats and shops for the people you love.** It notices a need, finds options that fit *her*, lets the family decide together with a tapback, checks out with Visa, and follows the order through in everyone's own language.

Photon pitch too: an AI and a family **deciding a purchase together** inside iMessage is the "hybrid intelligence" the Photon track asks for.

## The demo (one continuous story, ~2 minutes)

| # | Stage (Visa's list) | What happens on the phones |
|---|---|---|
| 1 | **Discovery** | Nai Nai (Chinese) texts: "我的血压计坏了" ("my blood pressure monitor broke"). It's relayed as normal chat. Bridge also recognizes a shopping need. |
| 2 | **Personalization** | Bridge picks **3 options for her**: large display, Chinese-language voice or screen, simple buttons, ships to her city, within the family's budget. Each comes with a one-line "why this one". |
| 3 | **Decision-making** | Each family member gets the same 3 options **in their own language** as cards A/B/C. They vote with tapbacks (👍 A · ❤️ B · 😂 C) or a letter. Kevin ❤️ B, Mei ❤️ B, so B wins. |
| 4 | **Checkout** | Kevin is the buyer (`isTrustedForMoney`). Under his auto-approve limit, Bridge buys it; over it, Kevin gets "Buy B for NT$1,290 (≈ $40)? ❤️ to confirm". The scam check still applies. |
| 5 | **Payments** | Paid with Kevin's Visa (sandbox or mock). Everyone sees the price in their own currency. |
| 6 | **Post-purchase** | Nai Nai gets "Kevin bought you a new blood pressure monitor 🎁, arriving Thursday" in Chinese. Then "shipped" and "delivered" updates. She photographs the manual, and Bridge explains it in Chinese (existing `explainImage`). |
| 7 | *(stretch)* **Loyalty** | "Family wallet": purchases earn points the family can put toward the next gift. Only if time allows. |

**Personalization detail judges will remember:** cultural awareness. "Gift for Nai Nai for New Year" never suggests a clock (送钟 sounds like "attending a funeral") or a set of four, and suggests a red-envelope amount ending in 8. Keep a short rules list per culture in the catalog module.

The existing features stay in the story: review (an ambiguous need gets the bilingual check), relay, emergency detection, and money gifts (as a secondary "or just send money" option).

## How it fits the current code

```
Nai Nai's message ─► router (U1) ─► tryHandlePayment (U2) ─► needs.ts (U2) detects a need
                                                              │
                                     shop/catalog.ts (U2) ◄───┘ findOptions(): 2–3 options + why
                                                              │
                                     relay/vote.ts (U1)  ◄────┘ familyVote(): cards in each language, tapback votes
                                                              │
                                     shop/checkout.ts (U2) ◄──┘ checkout(): limit, confirm, Visa (mock/sandbox)
                                                              │
                                     shop/orders.ts (U1) ◄────┘ trackOrder(): confirmation + shipped/delivered updates
```

`tryHandlePayment` stays the single entry point, so **the router doesn't change**. `needs.ts` today offers *money* for a need; it now offers a **shopping flow** when the need is a thing you can buy (appliance, medicine, groceries, gift), and still offers money for rent/bills.

## Ownership

| File | Owner | Notes |
|---|---|---|
| `src/shop/catalog.ts` (new), `data/catalog.json` (new) | **U2** | Curated catalog + AI ranking + "why this one" + cultural rules |
| `src/shop/checkout.ts` (new) | **U2** | Limits, confirmation, Visa (mock first), receipts |
| `src/payments/needs.ts`, `src/payments/flow.ts` | **U2** | Route buyable needs and "find/buy X for Y" requests to the shopping flow |
| `src/relay/vote.ts` (new), `src/relay/prompts.ts` | **U1** | Family vote primitive (`askAll`) |
| `src/shop/orders.ts` (new) | **U1** | Order confirmation + simulated shipping timeline, in each reader's language |
| `src/types.ts` | shared, **additive only** | `FamilyMember.shipTo?` (below), its own `contract:` commit |
| `data/demo-shopping.txt` (new) | **U1** | Simulator script for the demo story |
| `README.md`, `docs/DEVPOST.md` | **U2** | Rewrite the pitch around shopping |

## Contracts

Types used by only one side live in that side's module, not `types.ts`.

```ts
// ── types.ts (additive) ─────────────────────────────────────────────
interface FamilyMember {
  // …existing fields
  shipTo?: { city: string; country: string }; // demo only: city + country, never a real street address
  shopLimitUsd?: number;                       // buyer's auto-approve limit; above it, Bridge asks ❤️ to confirm
}

// ── shop/catalog.ts (U2) ────────────────────────────────────────────
export interface Product {
  id: string;
  name: Record<LanguageCode, string>;   // at least "en"; add the demo languages
  price: number; currency: string;      // merchant's price
  merchant: string;                     // fictional demo merchant names
  shipsTo: string[];                    // country codes
  tags: string[];                       // "large-display", "chinese-voice", "elder-friendly", …
  image?: string;                       // optional local path in data/
}
export interface ShoppingNeed {
  forMember: FamilyMember;              // who it's for (usually the elder)
  text: string;                         // the original message
  category: string;                     // "medical-device", "gift", "groceries", …
  occasion?: string;                    // "lunar-new-year", "birthday", …
  budgetUsd?: number;
}
export interface Option { product: Product; why: string } // `why` in English; callers translate per reader
/** 2–3 options that fit the person. Never throws; [] means nothing fits (fall back to the money offer). */
export function findOptions(family: Family, need: ShoppingNeed): Promise<Option[]>;

// ── relay/vote.ts (U1) ──────────────────────────────────────────────
export interface VoteResult {
  winner: number | null;                // option index, or null if nobody voted in time
  votes: Map<string, number>;           // member id → option index
}
/**
 * Shows each voter `card(reader)` (already in the reader's language) and collects votes:
 * 👍/❤️/😂/‼️ = A/B/C/D, or a letter. Resolves when a majority agrees, everyone has
 * voted, or `timeoutMs` passes (then the most votes wins, ties go to the earliest).
 * Votes are never relayed as chat.
 */
export function familyVote(
  family: Family, voters: FamilyMember[], card: (reader: FamilyMember) => Promise<string>,
  optionCount: number, timeoutMs: number,
): Promise<VoteResult>;

// ── shop/checkout.ts (U2) ───────────────────────────────────────────
export interface OrderResult {
  ok: boolean; orderId?: string;
  charged?: { amount: number; currency: string };   // in the buyer's currency
  eta?: string;                                     // ISO date
  error?: string; maybeCharged?: boolean;           // same meaning as GiftResult
}
/** Asks the buyer to confirm when over their limit, then pays. Never throws. */
export function checkout(family: Family, buyer: FamilyMember, forMember: FamilyMember, product: Product): Promise<OrderResult>;

// ── shop/orders.ts (U1) ─────────────────────────────────────────────
/** Confirmation to everyone, then simulated "shipped" / "delivered" updates. Each reader gets it in their language. */
export function trackOrder(family: Family, buyer: FamilyMember, forMember: FamilyMember, product: Product, order: OrderResult): void;
```

Settings (each read inside its own module, added to `.env.example` in the owner's section):
`SHOP_MODE=mock|sandbox` (U2, default mock) · `SHOP_VOTE_TIMEOUT_MS` (U1, default 120000) · `SHOP_SHIP_DELAY_MS` / `SHOP_DELIVER_DELAY_MS` (U1, demo speed, default 20000 / 40000).

## Visa: what to use

1. **Ask at the Visa booth first** which APIs they want to see. Visa has been pushing **agent-initiated purchases** (Visa Intelligent Commerce: tokenized credentials an AI agent can pay with, under limits the cardholder sets). That matches "Bridge buys it for you, within Kevin's limit" exactly. Use it if a sandbox is available.
2. Otherwise use whatever card-payment sandbox the booth recommends, and keep **Visa Direct** for the "or just send money" option, which is already built.
3. **`SHOP_MODE=mock` is the demo default** and must always work. Say honestly in the demo which parts are mock.
4. Never real cards. Sandbox test card numbers live in `.env` only.

## Safety (judges will ask)

- Nothing is bought without a person: under the limit, the vote *is* the approval. Over it, the buyer confirms with ❤️.
- A purchase requested **by** an elder ("buy me gift cards") goes through the existing scam check and a trusted member, same as money requests today.
- One open shopping decision per family at a time. A second need waits, or joins the first if it's for the same person.
- Every step degrades gracefully: no catalog match → money offer. Vote times out → buyer picks. Payment fails → clear message, nothing shipped.

## Build order

| Step | U1 (AndrewW-coder) | U2 (reallyrealistic) |
|---|---|---|
| 1 | `contract:` commit for `shipTo` / `shopLimitUsd`; `askAll` + `familyVote` with simulator tests | `data/catalog.json` (~30 items across the demo categories) + `findOptions` with placeholder ranking |
| 2 | `trackOrder` with simulated timeline | `checkout` in mock mode; route buyable needs from `needs.ts` |
| 3 | `data/demo-shopping.txt`; run the whole story in the simulator | AI ranking + "why this one" + cultural rules; real Visa per the booth's answer |
| 4 | Live test on phones; record backup video of the shopping story | README + Devpost rewrite around shopping |

**Sync points:** after step 1, agree the card text format (who writes it: catalog gives `why`, vote shows it). After step 2, run the full story in the simulator together. **Freeze** before the final rehearsal, as in the parallel plan.

**Cut order if short on time:** loyalty → real Visa sandbox (keep mock) → shipping updates (keep the confirmation) → AI ranking (keep curated order). **Never cut:** need → options in each language → tapback vote → checkout confirmation.

## Open questions

- Visa booth: which APIs and sandbox? Do they score using Visa technology heavily?
- The Visa judging rubric: paste it into this doc and check the demo against each criterion.
- Demo merchant data: all fictional (names, prices) to avoid implying real partnerships.
