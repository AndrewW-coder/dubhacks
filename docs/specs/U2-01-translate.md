# Spec U2-01: Translator, confidence, glossary (guide steps 1–3)

Subagent: **translate** · Copy: `/home/claude/work/translate/` · Read first: `docs/specs/U2-00-master.md` (rules), `docs/USER2_GUIDE.md` steps 1–3, `src/translate/*`, `src/relay/router.ts` (how you're called), `src/review/bridgeReview.ts` (how `addEntry` is called).

## Owns
`src/translate/translator.ts`, `src/translate/confidence.ts`, `src/translate/glossary.ts`, `src/translate/try.ts`, new `src/translate/*.selftest.ts`, `data/translation-tests.json`, `data/glossary.example.json`. **Not** `claude.ts`.

## Goal
Translations that sound like a warm bilingual relative, good confidence signals for the review flow, reliable emergency detection, and a glossary that remembers what reviewers taught it, including across restarts.

## Requirements

### R1 Prompt quality (translator.ts)
- Review and improve `SYSTEM_PROMPT` and `buildPrompt`. Must cover:
  - elder ↔ grandchild register (respectful *and* affectionate, never stiff);
  - slang/abbreviations from young people turned into plain language the elder understands ("ngl your dumplings slap" → sincere praise);
  - names, nicknames and `keepAsIs` glossary terms left untouched;
  - code-switching (translate only what the reader can't read);
  - romanized input (pinyin);
  - brands (Costco) kept.
- Add 2–4 compact few-shot examples inside the system prompt (Chinese ↔ English, matching the demo family) that show tone, confidence and alternatives.
- Keep the output contract: tool `submit_translation` → `{ text, confidence, notes?, alternatives? }`.

### R2 Learned phrases are applied, not just remembered
- Add optional `language?: LanguageCode` to `GlossaryEntry`.
- When the incoming text exactly matches a learned entry (`keepAsIs: false`; same normalization as `isConfirmedPhrase`), and either the entry has `language === to.language` or no language but its meaning is clearly in the target script, return `{ text: meaning, confidence: 1, notes: "Confirmed by family" }` **without calling Claude**. Otherwise keep passing it to Claude as `<confirmed_meanings>`.
- `bridgeReview.ts` (User 1) calls `addEntry(familyId, { term, meaning, keepAsIs: false })` with no language. Handle that: if `meaning` is mostly Latin script, treat it as `en`; if mostly CJK, as `zh`. Write a tiny `guessLanguage()` helper.

### R3 Glossary persistence (glossary.ts)
- Entries added through `addEntry` are saved to `data/glossary.json` (shape: `{ [familyId]: GlossaryEntry[] }`). The write is debounced (~500 ms) and atomic (write a temp file, then rename). Wrap it in try/catch and never crash.
- On load: start from `data/glossary.example.json`, then overlay `data/glossary.json` (`.json` wins on the same normalized term).
- The orchestrator will add `data/glossary.json` to `.gitignore`; just mention it in your report.

### R4 Emergencies (confidence.ts)
- Keep patterns specific. Must be TRUE for: "help", "help I fell", "I fell", "call 911", "救命", "救命，我摔倒了", "我摔倒了", "叫救护车", "我心脏不舒服", "喘不过气", "ayuda", "me caí", "살려주세요", "cứu tôi".
- Must be FALSE for: "can you help me with the recipe?", "help me pick a gift", "我在医院，别担心", "我去医院看朋友", "I fell asleep early lol", "this song is a heart attack 😂", "救命这个好好笑" (Chinese internet slang "救命" meaning "OMG this is so funny": add a guard for laughter markers like 好好笑/哈哈/笑死/lol/😂 in the same message).
- Put these in `src/translate/confidence.selftest.ts` as a table test; exit 1 on any failure.

### R5 Confidence sanity (translator.ts)
- After Claude responds: if `confidence < 0.8` and there are no alternatives, lower confidence by 0.1 (a reviewer can't choose without options) **only if** it's still ≥ threshold. Simpler acceptable rule: ensure `needsReview` results always have ≥1 alternative by adding the literal translation as an alternative. Pick one and document it.
- Clamp, trim, and dedupe alternatives (already partly done).

### R6 Test data + runner
- `data/translation-tests.json`: keep the existing cases, and add at least 6 more covering R1 (slang, code-switching, pinyin, brands, kinship terms, an affectionate scolding).
- `try.ts`: add a `--json` flag that prints a machine-readable summary (`{ pass, total, failures: [...] }`) to make tuning faster. Keep the default human output.

## Verification (no API key exists)
- Write a fake Anthropic Messages server in `scratch/` that answers `POST /v1/messages` with a `tool_use` block. Run `ANTHROPIC_API_KEY=fake ANTHROPIC_BASE_URL=http://127.0.0.1:<port> npx tsx src/translate/try.ts` and check:
  - the request contains the few-shot examples, the glossary and the recent context;
  - the learned-phrase short-circuit makes **no** request;
  - API errors fall back to the original text with `uncertain: true`.
- `npx tsx src/translate/confidence.selftest.ts` passes. Also add `src/translate/glossary.selftest.ts` covering persistence + overlay + the learned-phrase short-circuit (it may write to a temp cwd).
- `npx tsc --noEmit`, `npm run sim:demo`, `npm run sim:u2` all pass with **no** key set.

## Out of scope
Changing `claude.ts`, the router, review flow, or any signature in the master spec.
