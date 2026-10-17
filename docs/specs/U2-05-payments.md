# Spec U2-05: Payment conversation + help with real needs (guide steps 7–8)

Subagent: **payments** · Copy: `/home/claude/work/payments/` · Read first: `docs/specs/U2-00-master.md`, `docs/USER2_GUIDE.md` steps 7–8, `src/payments/*`, `src/relay/prompts.ts` (`ask()`; you can't change it), `src/relay/router.ts` (where `tryHandlePayment` is called), `src/photon/mock.ts` (sim commands), `data/demo-u2.txt`.

## Owns
`src/payments/flow.ts`, `src/payments/scamCheck.ts`, new `src/payments/needs.ts`, new `src/payments/flow.selftest.ts`, `data/demo-u2.txt`. Use `visa.ts` (`quote`, `sendGift`, `formatMoney`, `GiftResult`) **as-is**: another agent owns it, and only optional fields may appear.

## Goal
Money conversations feel natural and safe in both languages, and when a grandparent mentions a real need, the family is gently offered a way to help.

## Requirements

### R1 Gift flow polish (flow.ts)
- The regex fallback (no Claude) must handle:
  - "send Nai Nai $50 for New Year";
  - "can you send grandma 30 bucks";
  - "给Kevin发个红包，100块" (amount 100, currency = sender's default or CNY for 块/元; recipient by name);
  - "give mei $20";
  - "send 50 to Kevin";
  - relationship words ("grandma"/"奶奶" → the member whose relationship is grandmother).
- Non-gifts stay chat (return false): "I spent $20 on groceries", "the tickets were $300", "Nai Nai gave me $20 yesterday".
- Outcomes, each with a clear message in the reader's language (via the existing `localize` / `say`):
  - "no"/cancel → "OK, I didn't send anything.";
  - timeout → "No answer, so I didn't send it.";
  - `sendGift` `ok: false` → its `error`, and that nothing was charged;
  - a recipient not found → a hint with real member names.
- Warmer 🧧 message to the recipient, including the note in *their* language (translate the note itself, not only the wrapper).
- Amount sanity: reject ≤0 or > 1000 (demo cap; constant at the top) with a friendly message.

### R2 Scam protection (scamCheck.ts + flow.ts)
- Money requests **from** an elder ("can you send me $500", "我需要钱买礼品卡") and gifts **from** an elder both require `trustedConfirmer` approval (keep the current behavior).
- Add `scamSignals(text): string[]` that detects classic scam markers (gift cards / 礼品卡, wire, crypto/bitcoin, "don't tell", urgency + money, "IRS", "bail", unknown links). When it fires, the confirmer's question says **why** ("⚠️ mentions gift cards: a common scam").
- A request from an elder to *receive* money (not a gift to someone): relay the message as normal chat (return false) **and** start the needs flow (R3) with a trusted member, never auto-paying.

### R3 Help with real needs (new needs.ts)
- `maybeOfferHelp(family, sender, text): void`. Fire-and-forget, called from `tryHandlePayment` before returning false. It does nothing unless the sender is an elder (`grandmother`/`grandfather`/`grandparent`) and the text mentions a need: medicine/药/prescription, groceries/买菜/food, rent/房租, bills/电费, doctor/看病, a broken appliance. Use a regex pre-check, then (if Claude is available) `callTool` to extract `{ need, suggestedAmountUSD }`; otherwise use defaults per category (medicine 30, groceries 50, bills 60…).
- Ask **every non-elder member in parallel** with `ask()`, in their language: "💊 Nai Nai mentioned she needs medicine. Send her $30? ❤️ to send". The **first yes wins** and does `sendGift` from that member to the elder. Tell the others "Kevin already took care of it ❤️". A later yes from someone else gets "Already handled, thank you!" (their prompt may still be pending; `prompts.ts` has no cancel, so handle late answers in your code). The elder gets "🧧 Kevin sent you $30 for medicine".
- Never offer twice for the same elder + need within 10 minutes. Skip emergencies (`isEmergency`): those go to the family immediately, and money talk would be tone-deaf.

### R4 Demo script (data/demo-u2.txt)
Extend the script so `npm run sim:u2` exercises:
- a Chinese red-envelope gift;
- a cancel;
- a timeout (use a short wait plus a note that it takes the confirm timeout; if that's too slow for a script, make the timeout overridable with `process.env.PAYMENT_CONFIRM_TIMEOUT_MS`, documented in the header, and set nothing in the script);
- a scam-flagged request from Nai Nai;
- a needs offer where Kevin says yes and Mei later says yes.

## Verification (no keys: regex paths; optionally a fake Anthropic server for the Claude paths)
- `src/payments/flow.selftest.ts`: it calls `tryHandlePayment` / `maybeOfferHelp` directly against the **mock** photon client (`PHOTON_MODE=mock`; capture output by wrapping `console.log`, or import `photon/client.js` and answer prompts with `tryResolvePrompt` from `relay/prompts.js`). Assert:
  - every R1 phrasing parses (amount, currency, recipient) and every non-gift returns false;
  - cancel, timeout, decline and success messages;
  - scam signals appear in the confirmer's question;
  - a needs offer → first yes pays exactly once, and the second yes gets "already handled";
  - no duplicate offer within 10 minutes;
  - no offer on emergencies.
- `npm run sim:u2` shows each flow, readable top to bottom; `npm run sim:demo` and `npx tsc --noEmit` pass.
