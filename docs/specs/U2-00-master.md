# Spec U2-00: Running the User 2 plan (master)

Owner: reallyrealistic (User 2). Source plan: `docs/USER2_GUIDE.md`.
Runner: Claude, orchestrating at most **5 subagents at a time**. Each subagent gets one step spec (`U2-0x-*.md`) as its brief.

## Constraints of this run

- **No API keys exist yet** (no `.env` on the machine): no `ANTHROPIC_API_KEY`, `SPEECH_API_KEY` or Visa credentials. So every step is built and verified **against local fake HTTP servers**. Runs with real keys are listed as "needs credentials" follow-ups for reallyrealistic.
- Code is built in isolated copies (`/home/claude/work/<agent>/`, sharing one `node_modules`). Then it's merged into the main copy, verified on reallyrealistic's computer, and written into their repo folder. **Nothing is committed or pushed by this run.**
- `heic-convert` (+ `@types/heic-convert`) is already installed for the photos step. **No other new npm dependencies**: if a step truly needs one, it reports that instead of installing.

## Step map

| Step (guide) | Spec | Runs as | Owns (only these files may change) |
|---|---|---|---|
| 0 First run | U2-00 (this) | orchestrator | none; verification only |
| 1–3 Translator, confidence, glossary | U2-01 | subagent **translate** | `src/translate/{translator,confidence,glossary,try}.ts`, new `src/translate/*.selftest.ts`, `data/translation-tests.json`, `data/glossary.example.json` |
| 4 Voice notes | U2-02 | subagent **voice** | `src/media/voice.ts`, new `src/media/voice.selftest.ts` |
| 5 Photos | U2-03 | subagent **photos** | `src/media/image.ts`, new `src/media/image.selftest.ts` |
| 6 Visa Direct sandbox | U2-04 | subagent **visa** | `src/payments/visa.ts`, new `src/payments/visa.selftest.ts` |
| 7–8 Payment flow + help with needs | U2-05 | subagent **payments** | `src/payments/{flow,scamCheck}.ts`, new `src/payments/needs.ts`, new `src/payments/flow.selftest.ts`, `data/demo-u2.txt` |
| 9 README + Devpost draft | U2-06 | subagent **writeup** (wave 2) | `README.md`, new `docs/DEVPOST.md` |
| Check | U2-07 | subagent **review** (wave 2) | none; read-only review |

Wave 1 = U2-01…05 in parallel (5 agents). Wave 2 = U2-06 + U2-07 after the merge.

## Frozen contracts (no subagent may change these signatures)

```ts
// translate/
translate(text, from: FamilyMember, to: FamilyMember, family: Family): Promise<Translation>
needsReview(original: string, t: Translation): boolean
isEmergency(text: string): boolean
getGlossary(familyId): GlossaryEntry[];  addEntry(familyId, entry): void;  isConfirmedPhrase(text): boolean
hasClaude(): boolean;  callTool<T>({ system, content, tool, maxTokens?, model? }): Promise<T>   // claude.ts: nobody edits it
// media/
transcribe(audioPath: string, language: LanguageCode): Promise<string>     // never throws
synthesize(text: string, language: LanguageCode): Promise<string>          // returns a local audio file path
explainImage(imagePath: string, targetLanguage: LanguageCode): Promise<string>  // "" = nothing to say; never throws
// payments/
quote(amount, fromCurrency, toCurrency): Promise<Quote>
sendGift(from: FamilyMember, to: FamilyMember, amount, currency): Promise<GiftResult>   // never throws
formatMoney(amount, currency): string
tryHandlePayment(family, sender, msg): Promise<boolean>
```
Interfaces may gain **optional** fields only (`GlossaryEntry`, `Quote`, `GiftResult`).

## Rules for every subagent

1. Work only inside your own copy `/home/claude/work/<agent>/`. Edit only the files your spec owns.
2. Never edit: `src/types.ts`, `src/config.ts`, `.env.example`, `package.json`, `package-lock.json`, `.gitignore`, or anything in `src/photon`, `src/relay`, `src/review`, `src/db`, `src/index.ts`, `src/sim.ts`.
3. New settings: read them from `process.env` **inside your own module**, documented in the module's header comment, and list them in your report. The orchestrator adds them to `.env.example`. Allowed test overrides: `ANTHROPIC_BASE_URL` (built into the SDK), `SPEECH_BASE_URL`, `VISA_BASE_URL`.
4. No real API keys exist, so test against a **local fake server** you write in `/home/claude/work/<agent>/scratch/` (not in the repo). A `*.selftest.ts` in your folder is welcome if it runs offline with `npx tsx <file>` and exits non-zero on failure.
5. Never write secrets, real card numbers or real phone numbers. Visa sandbox *test* card numbers belong in env vars, never in code.
6. Everything must keep working with **no keys at all** (placeholders/mock), because the other teammate runs the simulator without keys.
7. Acceptance for every step: `npx tsc --noEmit` passes in your copy; `npm run sim:demo` and `npm run sim:u2` exit 0 with no stack traces; your step's own checks pass.
8. Final report (your last message): files changed; how you tested (commands + key output); new env vars; what still needs real credentials; open issues. Under 400 words.

## Orchestrator steps

1. Write all specs (done when this folder exists).
2. Launch wave 1 (U2-01…05) in parallel.
3. Merge: copy each agent's owned files into `/home/claude/dubhacks`; add new env vars to `.env.example` (User 2 section) and `data/glossary.json` to `.gitignore`; run tsc + both sim scripts + every `*.selftest.ts`.
4. Launch wave 2 (U2-06 writeup, U2-07 review). Apply the review's must-fix items.
5. **Step 0 on reallyrealistic's computer:** copy the merged tree into a scratch dir on the machine (not their repo, so their Windows `node_modules` is untouched), `npm ci`, `npx tsc --noEmit`, `npm run sim:demo`, `npm run sim:u2`, and every selftest.
6. Write the changed files into their repo folder (uncommitted), and report.
