# Spec U2-13: Fix the shopping review (money safety)
Subagent: **shop-fixes**, working in `/home/claude/work/s-fix/`. Read `U2-11-shopping-review.md`, `U2-10-shopping.md`, `U2-00-master.md`, and the reviewer's probes in `/home/claude/work/s-review/scratch/` (`p1`–`p8`; copy what you need). Reproduce each must-fix with a probe or selftest **before** fixing it.

**Owns:** `src/shop/*` (catalog, search, checkout, shopFlow, u1 + their selftests), `src/payments/scamCheck.ts`, `data/demo-shopping-u2.txt`. Don't edit `src/relay/*` (User 1), `types.ts`, `index.ts` or `photon/*`.

## Core rule (fixes M-1, M-2, M-5): the buyer must always actively agree
Bridge buys only when the **buyer** has given an unambiguous yes to *that* product:
- (a) the buyer voted for the winning option **unambiguously**: a tapback on that option's card, or a threaded reply to that card; or
- (b) the buyer answered a strict confirmation ("Buy B · Big-Digit … · $39.98 for Nai Nai? ❤️ or yes") with ❤️ or a strict yes (`isYes`). Built with `moneyPrompt` + `claimMoneySlot`; the amount line is never translated.
A bare-letter vote, a timeout winner, a 👍, or the "which one?" fallback is **never** enough on its own; each leads to (b). This applies **under the limit too**. Over the limit, (b) is always required, even after (a).

## Must-fix
- **M-1** Implement the core rule in `shopFlow.ts`/`checkout.ts`. Test: p2 (Kevin's phone, only Kevin votes) → Mei is asked and nothing is bought without her ❤️/yes; the main demo → Mei is asked to confirm.
- **M-2** Vote stand-in (`u1.ts`):
  - if `relay/prompts.js` exports `hasOtherOpenPrompt` / `openPromptsFor` (feature-detect; User 1 will add it), ignore bare letters from voters with another open question, and accept only tapbacks/threaded replies on cards;
  - also never register bare-letter vote prompts for a voter with an open money prompt (`hasOpenMoneyPrompt`);
  - with the core rule, a stolen letter can no longer buy anything;
  - Test: p3 → no purchase without Mei's explicit confirmation.
- **M-3** `tryHandleShopping`:
  - `isEmergency(text)` → return false immediately (never claim an emergency; "order an ambulance… she fell" must be relayed and handled as an emergency);
  - explicit commands return true **only after** options were found and cards sent;
  - no options → return false (relay as chat), with no money suggestion unless it's a real need (`needs.ts` path);
  - Test: p1/p7 messages are relayed.
- **M-4** Scam markers (`scamSignals` + checkout's scam-target check + `NOT_SHOPPING` in catalog.ts):
  - `e-?gift`, `gift[- ]?cards?`, `(digital|wallet|store|game) code`, `\bpin\b`, `reward card`, `prepaid`;
  - brands iTunes, App Store, Google Play, Steam, Razer, Vanilla, Amazon gift;
  - Chinese 礼品卡/禮品卡/购物卡/充值卡/预付卡/点卡, and "<brand>卡" (iTunes卡, Apple卡, Steam卡);
  - Table test with every string from p4.
- **M-5** "Which one should I buy?" fallback: accept letters only (no tapbacks), then the core rule (b).

## Should-fix
- `detectShoppingNeed` recipient: "buy me / find me / get me / 给我买 / 帮我买" means the **sender**.
- Refuse prices under 0.01 in checkout.
- `shopForNeed`: every path inside try/catch, never throws.
- Timeout with a single vote: covered by the core rule; make sure the message says who still needs to confirm.

## Nits
- Confirmation wording: "Mei bought Nai Nai a … 🎁" only for gift occasions. Otherwise "Mei ordered a new … for Nai Nai".
- "≈" amounts ≥ 10 without cents.
- Don't add "lunar new year gift for grandmother" when the recipient isn't an elder.

## Verify
- Every reviewer probe behaves safely (before → after in the report).
- `npx tsc --noEmit`; every `src/**/*.selftest.ts` passes (update tests that encoded the old auto-buy); all three sim scripts exit 0.
- Update `data/demo-shopping-u2.txt` so the buyer (Mei, or make Kevin the buyer) confirms. Report under 450 words, mapping each ID → fix → test.
