# User 2 guide: reallyrealistic

Your half of Bridge: **what messages say, and the money.** You own `src/translate/`, `src/media/`, `src/payments/`, `data/glossary*.json`, `data/translation-tests.json`, `data/demo-u2.txt`. Full team plan: [`PARALLEL_PLAN.md`](PARALLEL_PLAN.md).

**Status (Sat 17 Oct, after the spec run in `docs/specs/`):** steps 1–8 are **built and tested against fake servers**, and an independent review's money-safety fixes are applied. That covers the translator, emergencies, glossary learning and persistence, voice notes (OpenAI), photos (incl. HEIC), Visa Direct sandbox code, the gift flow, scam checks and help-with-needs. All checks pass on your machine (`npx tsx src/**/*.selftest.ts`, `npm run sim:u2`). What's left needs **real credentials**:
1. **AI key: Gemini is now the default (free).** Your key is already in `.env` as `LLM_API_KEY`, with `TRANSLATE_PROVIDER=gemini`. Run `npm run try:translate` on Windows and tune the prompt (step 1–2 boxes). To switch providers later, set `TRANSLATE_PROVIDER=anthropic` (+ `ANTHROPIC_API_KEY`), or `openai-compatible` + `LLM_BASE_URL` + `LLM_MODEL` for OpenAI/Groq/OpenRouter/DeepSeek/Ollama. If `gemini-3.8-flash` isn't available on your key, Bridge falls back to older flash models by itself, or set `LLM_MODEL`.
2. `SPEECH_API_KEY` (OpenAI): send a real iPhone voice note through Andrew's live bot (step 4).
3. Visa sandbox cert, key, CA, user ID/password and the sandbox **test** card numbers in `.env`, then `VISA_MODE=sandbox`. Check the `// VERIFY:` fields in `src/payments/visa.ts` (step 6).
4. Fill the `[TODO]`s in `docs/DEVPOST.md`.

Run `npm install` once first: `heic-convert` was added. The boxes below are the original checklist; tick them as you confirm each with real keys.

---

## Step 0: First run (15 min)

- [ ] Push Phase 0 (see "Pushing" at the bottom), then tell Andrew to pull and read `docs/USER1_ROLES.md`.
- [ ] `npm install` (only once per machine).
- [x] `.env` exists with your Gemini key (`TRANSLATE_PROVIDER=gemini`, `LLM_API_KEY=…`). Never commit it; it's gitignored.
- [ ] `npm run sim:u2`: you should now see real translations instead of `[zh→en] …`.
- [ ] Message Andrew the API key privately. He needs it for live testing.
- [ ] **Decide the demo languages together.** If they aren't Chinese ↔ English, update `data/family.example.json` languages (ask Andrew; it's his file) plus your `data/translation-tests.json` and `data/glossary.example.json`.

**Your two everyday commands:**
```bash
npm run try:translate          # all test phrases: translation, confidence, would-it-be-reviewed
npm run sim                    # chat as anyone: "nainai: 你吃饭了吗", "kevin: send Nai Nai $50"
```
Never set `PHOTON_MODE=live`; that's Andrew's line.

---

## Step 1: Translator (U2.1–U2.2) ✅ drafted, now tune it

Built: `src/translate/translator.ts` + `claude.ts`. It gives Claude both relationships, the glossary, and the last 10 messages, and gets back `{ text, confidence, notes, alternatives }`. It skips Claude for same-language and emoji-only messages, caches repeats, and if the API fails, sends the original text flagged as unsure (it never drops a message). The `🧪` test hook still works.

- [ ] `npm run try:translate` and read every result. Aim for **≥ 16/20 ✅**.
- [ ] Tune `SYSTEM_PROMPT` in `translator.ts` until:
  - grandparent ↔ grandchild sounds warm and respectful (not stiff);
  - "Nai Nai" / names stay as-is;
  - slang from Kevin turns into something Nai Nai would understand.
- [ ] Check speed: each message should take < 3 s. If it's slower, set `ANTHROPIC_MODEL=claude-haiku-5-5` in `.env` and compare quality.
- [ ] Add 5 phrases from your real family to `data/translation-tests.json`.
- [ ] Push (`u2/translator` branch → `main`). **Sync S1:** tell Andrew so he can pull it onto real phones.

## Step 2: Confidence + emergencies (U2.3) ✅ drafted, now calibrate

Built: `src/translate/confidence.ts` has emergency patterns for English, Chinese, Spanish, Korean and Vietnamese. They're deliberately specific: "can you help me with the recipe" is *not* an emergency.

- [ ] In `try:translate`, the `low` phrases (idioms, sarcasm) should really come back below 0.75 confidence, and each should include alternatives. If not, adjust the confidence section of the prompt, or `REVIEW_CONFIDENCE_THRESHOLD` in `.env`.
- [ ] Add emergency phrases for your demo language and test both directions (a real emergency, and a calm "I'm at the hospital, don't worry").

## Step 3: Glossary + learning (U2.4) ✅ drafted, now agree the format with Andrew

Built: `src/translate/glossary.ts` loads `data/glossary.example.json`; `needsReview()` skips phrases a reviewer already answered. The sim shows "asked once, never again" (`npm run sim:u2`).

- [ ] Add your family's real nicknames, dish names and dialect words to `data/glossary.example.json`.
- [ ] **Sync S2 (~H10):** with Andrew, confirm what `bridgeReview.ts` passes to `addEntry()` (today: `term` = original text, `meaning` = the chosen translation). If you want a `language` field, add it as an **optional** field in your own `GlossaryEntry`.
- [ ] Stretch: save learned entries to `data/glossary.json` so they survive restarts.

## Step 4: Voice notes (U2.5) ⏳ your next build

`src/media/voice.ts`: `transcribe(audioPath, language)` must return the transcript; the router already relays it as `🎤 Nai Nai: …`.

- [ ] Pick a speech-to-text API that handles your demo language well (OpenAI's transcription models, Deepgram and ElevenLabs Scribe are common choices; check current docs and pricing). Put its key in `SPEECH_API_KEY` and its name in `SPEECH_PROVIDER`.
- [ ] Add its npm package in **a commit of its own**, and push right away (lockfile rule).
- [ ] iPhone voice notes arrive as `.caf`. If the API rejects them, convert to `.m4a`/`.mp3` with ffmpeg first.
- [ ] Ask Andrew for a real `.caf` from his smoke test, then test in the sim: `nainai: voice ./sample.caf`.
- [ ] Stretch: `synthesize()` for a spoken reply to grandparents.

## Step 5: Photos (U2.6) ✅ drafted

Built: `src/media/image.ts` sends the photo to Claude vision; it returns `""` for selfies and food, and a translation plus plain explanation for letters, labels and forms.

- [ ] Test it: `nainai: image ./some-label.jpg` in the sim (use a photo of a medicine label or letter).
- [ ] iPhone photos may be `.heic`. Add conversion (e.g. the `sharp` package) if Andrew's live test shows that.

## Step 6: Visa Direct sandbox (U2.7) ⏳ start the paperwork early

Mock mode already works (`VISA_MODE=mock`, demo exchange rates in `src/payments/visa.ts`). The demo never depends on the sandbox.

- [ ] **Early:** at the Visa booth, ask which APIs the track expects. Create a Visa Developer project and download the sandbox credentials: user ID/password and the mutual-TLS cert, key and CA.
- [ ] Put the file paths in `.env` (`VISA_CERT_PATH`, …). **Never commit the cert files.**
- [ ] Replace `quote()` with the Foreign Exchange Rates API, and the mock branch of `sendGift()` with a Funds Transfer API push payment.
- [ ] Map Visa error codes to a short plain-language `error`.
- [ ] If the sandbox fights you past H15: keep mock mode for the demo and say so honestly to judges.

## Step 7: Payment flow (U2.8) ✅ drafted, now polish

Built: `src/payments/flow.ts` runs the whole conversation:
1. A cheap regex check, so normal chat never waits on Claude.
2. Claude parses the request (with a regex fallback).
3. Scam check: elders and large amounts are confirmed by a trusted member first.
4. The sender confirms with ❤️ or "yes", seeing the amount in the recipient's currency.
5. `sendGift()` runs.
6. Both sides are told the result in their own language.

"I spent $20 on groceries" stays normal chat.

- [ ] Try it with a real key: `npm run sim:u2`, then your own phrasings in `npm run sim` ("给Kevin发个红包，100块", "can you send grandma 30 bucks").
- [ ] The 🧧 message to the recipient should feel warm. Tune the wording in `flow.ts`.
- [ ] Failure path: set `VISA_MODE=sandbox` without credentials and check the "didn't go through" message is clear.

## Step 8: Help with real needs (U2.9) + edge cases (H16–18)

- [ ] When an elder mentions needing medicine or groceries, `tryHandlePayment()` should **return false** (so the message still relays) and also `ask()` a family member: "Grandpa needs medicine. Send him $30? ❤️ to send".
- [ ] Tick your sections of `docs/EDGE_CASES.md`.

## Step 9: Phase 3 (H18–24)

- [ ] **H18 feature freeze.** After that, only bug fixes.
- [ ] README update + Devpost writeup (you own both) with screenshots from Andrew's phones.
- [ ] Rehearse the 3-minute demo twice (`docs/PLAN.md`), and prepare one-line answers about the Visa flow and the scam check.

---

## Pushing

**Phase 0 (do once, now)** puts the scaffold *and* your first drafts on `main` in one commit. That's safe because Andrew hasn't started yet. Run this from the repo folder:

```bash
npm install
git add --renormalize .
git add -A
git commit -m "Phase 0: scaffold, Photon client, simulator, role split, User 2 first drafts"
git push origin main
```

If `git push` says permission denied, Andrew must add **reallyrealistic** as a collaborator (repo Settings → Collaborators), or he can pull the folder from you and push it himself.

**Every step after that:** `git switch main && git pull --rebase`, then `git switch -c u2/<step>`, build, `git add -A && git commit && git push -u origin u2/<step>`, and merge.

## Saving your sanity (and Andrew's Pro limits)

You're on Claude Max: when Andrew needs a big chunk of code, offer to generate it, but **he commits it in his own files** so ownership stays clean.
