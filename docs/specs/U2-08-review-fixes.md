# Spec U2-08: Fix the review findings (money safety)

Subagent: **fixes** · Copy: `/home/claude/work/fixes/` (the merged tree) · Read first: `docs/specs/U2-00-master.md` (rules and frozen contracts), `docs/specs/U2-07-review.md`, and the review's probe scripts in `/home/claude/work/review/scratch/` (`s1.txt`–`s4.txt`, `probe.ts`, `family-notrust.json`).

## Owns
`src/payments/{flow,needs,scamCheck,visa}.ts`, `src/payments/*.selftest.ts`, `src/translate/translator.ts` (one change only: M-9), `data/demo-u2.txt`. `src/relay/prompts.ts` is **User 1's** and must not change: work around it.

## Must-fix
- **M-1 A "yes" must never pay for a different prompt.** Today a bare answer resolves the member's *most recent* open prompt (prompts.ts), so a help offer that arrives after a gift confirm steals Kevin's "yes" (probe `s1.txt`). Fix it in User 2 code:
  - keep a registry of members with an open money prompt (gift confirm, guard approval, help offer);
  - `needs.ts` must not send an offer to a member who already has one open;
  - the gift flow must not open a confirm for a member who has an open help offer: tell them "Answer my earlier question first 🙂", or wait. Pick one and document it.
  - Add a selftest reproducing `s1.txt` that fails before the fix.
- **M-2 No trusted member = no risky gift.** If `requiresConfirmation` (or any scam signal) applies and there is no eligible guard, refuse with a friendly message. Never fall through to the sender's own yes (probe `s4.txt`).
- **M-3 The guard is never the recipient (or the sender).** `trustedConfirmer(family, requester, recipient?)` excludes both; this is an additive optional parameter. With no one left, M-2 applies (probe `s2.txt`).
- **M-4 Strict yes.** `isYes` accepts only a whole-message yes: `^(yes|y|ok|okay|confirm|sure|yep|是|是的|好|好的|可以|行|对|對)[\s!.。！]*$` (case-insensitive). Anything containing a question mark, "no", "not", "cancel", "don't", "不", "别" or "取消" is not a yes. Tapbacks: only ❤️ (love) counts. Update the prompt wording to say "❤️ or yes". Add table tests.

## Should-fix (do all of these)
- **S-1** Amounts: "$1,000" → 1000, "$50,000" → 50000, "1,234.50" → 1234.5. Reject scientific notation.
- **S-2** A currency that isn't in the rate table → refuse ("I can't send that currency yet") instead of treating it as 1:1 with USD. Export the supported list from visa.ts if needed (additive).
- **S-3** `requiresConfirmation` uses the USD-converted amount.
- **S-4** Visa transport failures (timeout, connection reset, status 0) must say "it may have gone through; please check before trying again", not "Nothing was charged". Add an optional `GiftResult.maybeCharged?: boolean` and use it in flow and needs.
- **S-5** `sendGift` validates its input (amount finite, > 0, ≤ the cap; known currency) and returns `ok:false` otherwise, in mock mode too.
- **S-6** needs.ts: if the first helper's payment fails, reopen. Tell anyone who already said yes, and let the next yes try.
- **S-7** needs.ts money requests: parse the number in the requester's currency (块/元 → their currency), convert to USD for the cap and the suggestion.
- **S-8** Money prompts: build the amount/name parts outside the translated text, so translation can never change a number (translate only the surrounding sentence, with placeholders, or send the amount on its own line).
- **S-9** translator.ts: don't add Bridge's own messages (sender id `bridge`) to the family conversation history. That's the only translator change allowed.

## Verification
- Every probe in `/home/claude/work/review/scratch/` now behaves safely (describe each before/after in the report).
- New and updated selftests cover M-1…M-4, S-1, S-2, S-5, S-6. `npx tsx` on every `src/**/*.selftest.ts` passes.
- `npx tsc --noEmit`, `npm run sim:demo` and `GLOSSARY_FILE=off npm run sim:u2` pass with no keys, and the sim:u2 output still reads well. Add a comment in demo-u2.txt explaining the doubled "meaning A" lines after the review step.
- Report per master rule 8, mapping each finding ID → fix → test.
