# Spec U2-15: Fewer AI calls for shopping cards
Subagent: **batching** · Copy: `/home/claude/work/v-batch/` · Read first: `U2-00-master.md`, `U2-10-shopping.md`, `src/shop/shopFlow.ts` (how cards are built and translated today), `src/translate/translator.ts` (`translate`, BRIDGE-sender use), `src/translate/claude.ts` (`callTool`).

**Owns:** `src/shop/shopFlow.ts`, `src/shop/shopFlow.selftest.ts`, and an **additive** export in `src/translate/translator.ts` (no behaviour change to `translate()`).

## Problem
A 3-option shopping flow translates the heading, each card's name, summary and why, and the vote/confirmation lines, separately per non-English reader. On Gemini's free tier (~15 requests/minute; 20/day on the main model), one flow can exhaust the quota.

## Build
1. **`translateBatch(texts: string[], to: FamilyMember, family): Promise<string[]>`** in translator.ts (additive):
   - one `callTool` call returning `{ items: string[] }` in the same order and length;
   - Bridge-to-reader register: plain, warm, short; keep names, brands, numbers, prices, URLs and emoji exactly;
   - if `to.language` is "en" (or matches the source), return the input with no call;
   - on any error or a length mismatch, fall back to per-item `translate()` (so behaviour degrades, never breaks);
   - cache per item;
   - never throws.
2. **`shopFlow.ts`:** build every string a reader will see in one flow step (heading + all card texts; later the result/confirmation lines) and translate them **in one `translateBatch` call per reader per step**.
   - **URLs and the amount/price lines are never sent for translation** (they stay as they are).
   - Product names: if `product.name[reader.language]` exists, use it and don't translate it.
3. Measure: add a request counter in the selftest's fake AI server. Compare the main demo flow (Nai Nai's blood pressure monitor → vote → buy) before and after, for 1 Chinese reader + 2 English readers. **Target: at most 3 AI calls for translation in the whole flow** (excluding need detection and ranking). Report the before/after numbers.

## Verify
- Every existing shopFlow check passes, plus new checks:
  - the batch is used, with one call per reader per step;
  - URLs and prices come out untouched;
  - a mismatched batch length falls back;
  - English readers trigger no translation call.
- `npx tsc --noEmit`; all `src/**/*.selftest.ts`; the three sim scripts.
- Report per master rule 8, with the call counts.
