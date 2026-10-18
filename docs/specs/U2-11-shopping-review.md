# Spec U2-11: Independent review of the shopping work
Read-only reviewer that didn't write any of this. Pre-shopping snapshot: `/home/claude/work/s-base/`. Under review: `src/shop/*`, `src/payments/{flow,needs}.ts` changes, `data/catalog.json`, `data/demo-shopping-u2.txt`, against `U2-10-shopping.md` and `VISA-SHOPPING.md`.

Check:
1. **Contracts:** `findOptions`, `detectShoppingNeed`, `checkout` and `tryHandleShopping` never throw; the signatures match U2-10.
2. **Money safety:**
   - nothing bought without a vote winner, and over the limit, without a strict yes from the buyer;
   - the scam check can't be bypassed through shopping (e.g. "帮我买礼品卡" / "buy me $500 of gift cards");
   - no double purchase (two votes, a re-vote, a late vote after the decision closes);
   - a vote can't be hijacked by a non-family handle;
   - over-cap and unsupported currencies are refused.
3. **Conversation robustness:**
   - normal chat during a vote is relayed, not swallowed;
   - answers to other Bridge questions (review, payments) aren't stolen by vote prompts;
   - one decision per family;
   - timeouts behave;
   - 0, 1 and 2 options behave.
4. **Content:**
   - links are untranslated and on their own line;
   - catalog products are fictional, with no real brands implied as partners;
   - cultural filters work for Nai Nai and not for Kevin;
   - search results with no keyword match are dropped.
5. **Run:** `npx tsc --noEmit`, every `src/**/*.selftest.ts`, and the three sim scripts. Read `data/demo-shopping-u2.txt`'s output as a judge would.

Report a ranked list: **must-fix** (file:line, the failure scenario, a suggested fix), should-fix, nits. Don't edit repo files; probes go in your scratch dir. Under 500 words.
