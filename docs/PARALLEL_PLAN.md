# Parallel build plan: User 1 and User 2

Two people, 24 hours, almost no merge conflicts. **Find your role, read your section, and start.**

| | Who | Owns | In one line |
|---|---|---|---|
| **User 1** | **AndrewW-coder** (better laptop, Claude Pro) | Photon, relay, human review, live demo machine | "Messages get to the right phones, in sync." |
| **User 2** | **reallyrealistic** (Claude Max) | Translation, confidence, glossary, voice notes, photos, Visa payments | "What the messages say, and the money." |

Why this split: User 1's work is hands-on (Photon booth, real phones, running the live bot all weekend) and uses less Claude, so it suits the stronger laptop and the Pro plan's limits. User 2's work is the code-heavy, prompt-iterating part, which suits Claude Max; it runs only the light terminal simulator, so the laptop doesn't matter. Short brief for User 1: [`USER1_ROLES.md`](USER1_ROLES.md).

How this avoids conflicts: **every file has exactly one owner**, and the files both people touch (types, config, the router's call sites) were written and frozen in Phase 0. User 2 never edits the router; every User 2 feature is already called from it through a fixed function signature. Until the real code lands, each of those functions returns a placeholder, so the whole app runs end to end from minute one (`npm run sim:demo`).

---

## Phase 0: shared setup (≈20 min, before splitting)

Whoever has the scaffold on their machine does steps 1–4 and pushes. The other person waits, then pulls.

1. [ ] `npm install`. This creates `package-lock.json`; commit it now so nobody fights over it later.
2. [ ] `git add --renormalize .`. This applies the new `.gitattributes` (LF line endings). Without it, Windows shows every file as modified.
3. [ ] `npm run typecheck && npm run sim:demo`. You should see every relay path in the terminal.
4. [ ] Commit `Phase 0: scaffold, contracts, Photon client, simulator`, push to `main`.
5. [ ] **Both:** `git pull`, `npm install`, `cp .env.example .env`.
6. [ ] **Together (5 min):** decide the demo languages and send keys privately (Anthropic key, Photon token once you have it).
7. [ ] **User 1:** go to the Photon booth now (see `docs/PHOTON_SETUP.md` §1). **User 2:** go to the Visa booth now and ask which sandbox APIs the track expects.

---

## Rules that keep merges clean

1. **Only edit files you own** (table below). Need a change in the other person's file? Message them and they make it, or leave a `// TODO [U1]` / `// TODO [U2]` comment in *your own* file.
2. **Frozen contracts:** `src/types.ts`, `src/config.ts`, `.env.example`, `src/photon/port.ts`, `src/photon/client.ts`, and the signatures marked `FROZEN SIGNATURE`. To change one: **additive only** (new optional field, new function), in a tiny commit titled `contract: …`, pushed immediately, with a message to the other person.
3. **Work on your own branch:** `u1/<step>` or `u2/<step>`. Run `git pull --rebase origin main` before each step; merge to `main` when each step works (small PRs, several per hour is fine).
4. **New dependencies:** run `npm install <pkg>` in a commit of its own and push right away. On a `package-lock.json` conflict, run `git checkout --theirs package-lock.json && npm install`, then commit.
5. **New files are free** inside your own folders. Prefer a new file over growing a shared one.
6. **Only User 1 runs `PHOTON_MODE=live`.** Two listeners on the same line relay every message twice. User 2 develops with `npm run sim`; to try something on real phones, ask User 1 to pull and restart.
7. **Shared docs:** `docs/EDGE_CASES.md` has a section per user, so tick only your own. `README.md` is edited only by User 2, in Phase 3. `docs/PLAN.md` is reference only.

## File ownership

| Path | Owner | Notes |
|---|---|---|
| `src/photon/*` | **U1** | `port.ts` and `client.ts` frozen; `live.ts`, `mock.ts`, `smoke.ts` free |
| `src/relay/*` (router, messageMap, prompts, explain) | **U1** | `prompts.ts` `ask()` is shared, called by U2 |
| `src/review/*` | **U1** | |
| `src/db/*`, `data/family*.json`, `data/demo-script.txt` | **U1** | |
| `src/index.ts`, `src/sim.ts` | **U1** | |
| `docs/PHOTON_SETUP.md` | **U1** | |
| `src/translate/*` (translator, confidence, glossary) | **U2** | signatures frozen; `glossary.addEntry()` is called by U1 |
| `src/payments/*` (flow, visa, scamCheck) | **U2** | |
| `src/media/*` (voice, image) | **U2** | called by U1's router through frozen signatures |
| `data/glossary*.json`, `data/translation-tests.*` (new) | **U2** | |
| `README.md`, Devpost text | **U2** (Phase 3) | |
| `src/types.ts`, `src/config.ts`, `.env.example`, `package.json` | **shared, frozen** | rule 2 / rule 4 |

## The contracts (what each side can rely on)

```ts
// User 2 provides, User 1's router calls:
translate(text, from: FamilyMember, to: FamilyMember, family): Promise<Translation>   // translate/translator.ts
needsReview(originalText, translation): boolean                                     // translate/confidence.ts
isEmergency(text): boolean                                                          // translate/confidence.ts
tryHandlePayment(family, sender, msg): Promise<boolean>  // true = handled, don't relay  (payments/flow.ts)
addEntry(familyId, { term, meaning, keepAsIs })                                     // translate/glossary.ts
transcribe(audioPath, language): Promise<string>                                    // media/voice.ts
explainImage(imagePath, targetLanguage): Promise<string>  // "" = ordinary photo      (media/image.ts)

// User 1 provides, User 2 can call:
sendText(handle, text, { replyToId? }): Promise<messageId>                          // photon/client.ts
ask(handle, question, timeoutMs): Promise<{via:"tapback",tapback} | {via:"text",text} | null>  // relay/prompts.ts
```

`Translation = { text, confidence 0-1, notes?, alternatives?, uncertain? }`. The `🧪` test hook in the placeholder translator forces a low-confidence result; **U2: keep it** in the real translator so U1 can keep testing review.

---

## Timeline and sync points

| Hour | User 1 | User 2 | Sync |
|---|---|---|---|
| 0–0.5 | Phase 0 | Phase 0 | **S0:** scaffold on `main` |
| 0.5–1.5 | U1.1 Photon credentials + smoke test | U2.1 Claude translator v1 | |
| 1.5–4 | U1.2 Live relay on real phones | U2.1 (cont.) + U2.2 test phrase set | **S1 (~H4):** real translations on real phones 🎉 |
| 4–7 | U1.3 Human review flow | U2.3 Confidence + emergencies, U2.4 Glossary | |
| 7–10 | U1.4 Relay sync edge cases | U2.5 Voice notes, U2.6 Photos | **S2 (~H10):** review ↔ glossary learning works end to end |
| 10–13 | U1.5 Polish + U1.6 hardening | U2.7 Visa Direct sandbox | **S2b:** voice + photos tested on real phones |
| 13–16 | U1.7 Live-test User 2's features on phones | U2.8 Payment conversation flow | |
| 16–18 | U1.8 Demo setup on phones | U2.9 Help-with-needs + language edge cases | **S3 (H18): feature freeze** |
| 18–24 | Phase 3 together | Phase 3 together | |

If one side finishes early, take the next item from **"Stretch"** in your own section, not from the other person's.

---

## USER 1 plan (AndrewW-coder): Photon, relay, review, live demo

Read `docs/PHOTON_SETUP.md` first. Your home: `src/photon`, `src/relay`, `src/review`, `src/db`, `src/index.ts`.
You're on Claude Pro: use Sonnet in Claude Code, clear the conversation between tasks, ask for small specific fixes, and hand "write a whole module" jobs to User 2.

### U1.1 Photon credentials + smoke test (H0.5–1.5)
- [ ] Get `IMESSAGE_ADDRESS` + `IMESSAGE_TOKEN` (booth / app.photon.codes). Ask the five booth questions in PHOTON_SETUP §1.
- [ ] `npm run photon:smoke -- <your phone>`, then reply, tapback, untapback, edit, unsend, and send a photo and a voice note from the phone.
- [ ] Compare the raw events with `toIncoming()` in `src/photon/live.ts` and fix any field names (especially reply: `threadOriginatorGuid` vs `replyTargetGuid`; tapbacks: separate event vs `received` + `reactionTargetGuid`).
- [ ] If each phone gets its own line/token, implement one client per line in `live.ts`.
- **Done when:** every row of the PHOTON_SETUP §3 table produces the right `IncomingMessage` (log it with `PHOTON_DEBUG=1`).

### U1.2 Live relay between real phones (H1.5–4)
- [x] Create `data/family.json` with 2–3 real phones (yours, User 2's, a third device or friend).
- [x] `npm run dev` with `PHOTON_MODE=live`, then test: text, threaded reply, tapback, edit, unsend between two phones.
- [x] Check there's no echo loop and no duplicate relays, and that reply threading lands on the right bubble in every thread.
- [ ] **S1:** pull User 2's translator, and show real translated messages on real phones.
- **Done when:** a message from phone A appears on phones B and C as `Name: text`, and tapbacks/edits/unsends mirror.

### U1.3 Human review flow (H4–7), `src/review/bridgeReview.ts`
- [x] Pick the reviewer whose `reviewLanguages` cover both languages, and never the sender.
- [x] Tapback answers: say "👍 = A, ❤️ = B" in the question and map them in `askReviewer()`.
- [x] Timeout: send the best guess with `uncertain: true` (already done), then confirm the "(translation unsure…)" note reads well.
- [x] Two reviewers: ask both and take the first answer; tell the other "Mei already answered, thanks!"
- [x] Write the question in the **reviewer's** language (call `translate()`).
- [ ] With User 2, agree the glossary entry format that `addEntry()` gets from a review answer (S2).
- **Done when:** `🧪` messages are held, the reviewer answers by letter or by tapback, and the right meaning sends.

### U1.4 Relay sync edge cases (H7–10), `src/relay/router.ts`
- [ ] Edit after 15 min: send "✏️ correction: …" as a threaded reply instead.
- [ ] Unsend after 2 min: edit the copy to "(message removed)" instead.
- [ ] Tapbacks appear to come from "Bridge": add a short "Kevin ❤️ your message" text for elders (make it optional per member).
- [ ] A new member joins mid-conversation: add a `join` command or edit `family.json` and restart, so the demo still works.
- [ ] Simultaneous messages: confirm the per-sender queue in `index.ts` keeps order, and emergencies jump the queue (already done).
- [ ] While one message waits for a reviewer (up to `REVIEW_TIMEOUT_MS`), that sender's later messages are held behind it. Decide whether to relay later messages that don't need review in the meantime.
- [ ] Reconnect: kill your network for 30 s and check that `catchUp` replays the missed messages without duplicates.
- **Done when:** your section of `docs/EDGE_CASES.md` is ticked.

### U1.5 Polish (H10–12)
- [ ] `?` reply (`src/relay/explain.ts`): answer in the asker's language and show the cultural `notes`.
- [ ] Typing indicator (`setTyping`) while translating/reviewing.
- [ ] Urgent messages: add a message effect or a second alert text.

### U1.6 Hardening (H12–13)
- [ ] Persist `messageMap` and the family (a JSON file or SQLite) so a restart mid-demo doesn't break replies, tapbacks and edits.
- [ ] Run the live bot for an hour straight; confirm the reconnect and catch-up path survives sleep and Wi-Fi changes.

### U1.7 Live-test User 2's features on real phones (H13–16)
- [ ] As each User 2 step merges, pull, restart live, and test it on phones: voice notes (`.caf` from a real iPhone), photos, payment confirmations by tapback.
- [ ] Report bugs to User 2 with the raw event (`PHOTON_DEBUG=1`) rather than fixing their files.

### U1.8 Demo setup (H16–18)
- [ ] Final `data/family.json` with the demo phones, and a judge's phone ready to add.
- [ ] Rewrite `data/demo-script.txt` to match the live demo, so it doubles as a rehearsal in the sim.
- [ ] Record an early backup video of the core flow as soon as it works, then re-record in Phase 3.

---

## USER 2 plan (reallyrealistic): translation, glossary, voice, photos, payments

You develop entirely in mock mode: `npm run sim` (interactive) and `npm run sim:demo`. Your home: `src/translate`, `src/media`, `src/payments`. **Don't run `PHOTON_MODE=live`** (rule 6).

### U2.1 Claude translator v1 (H0.5–4), `src/translate/translator.ts`
- [ ] Put `ANTHROPIC_API_KEY` in `.env`. Use `@anthropic-ai/sdk` (already installed).
- [ ] Prompt inputs: sender and recipient `relationship` (for honorifics and tone: elders formal and warm, cousins casual), `getGlossary(family.id)` (keep `keepAsIs` terms untouched), and the last ~10 messages of the family (keep this history inside your module).
- [ ] Get structured JSON back (tool use or JSON output): `{ text, confidence, notes, alternatives }`.
- [ ] Short-circuits that skip Claude: same language, emoji-only, a lone "ok/👍".
- [ ] On an API error or timeout (~8 s), return the original text with a note, never throw (or the message is lost).
- [ ] Keep the `🧪` test hook.
- **Done when:** `npm run sim:demo` shows natural translations in both directions. **S1:** User 1 pulls it onto real phones.

### U2.2 Test phrase set (H2–4)
- [ ] Create `data/translation-tests.json` with ~25 phrases in your demo languages, covering greetings, honorific cases, idioms, sarcasm, emotional messages, slang, code-switching, romanized text (pinyin), and names that must stay as-is.
- [ ] Create `src/translate/try.ts` (your file) that runs them all and prints text + confidence. Use it after every prompt change.

### U2.3 Confidence + emergencies (H4–5.5), `src/translate/confidence.ts`
- [ ] Calibrate: idioms, sarcasm and emotionally loaded lines should score below `REVIEW_CONFIDENCE_THRESHOLD`; plain lines above it. Tune with `try.ts`.
- [ ] Make sure low-confidence results always include 1–3 `alternatives` (the reviewer needs options).
- [ ] `isEmergency()`: add patterns for every demo language (救命, 我摔倒了, 医院…), or ask Claude for a cheap classification when the regex is unsure.

### U2.4 Glossary + learning (H5.5–7), `src/translate/glossary.ts`
- [ ] Seed per family from `data/glossary.example.json` (Nai Nai, dish names, dialect words).
- [ ] `needsReview()` returns false when the phrase was already answered by a reviewer (that's how Bridge "asks less over time").
- [ ] **S2:** agree with User 1 what `addEntry()` gets from a review answer, then show "asked once, never again" in the sim.
- [ ] Stretch: persist the glossary to a JSON file so it survives restarts.

### U2.5 Voice notes (H7–9), `src/media/voice.ts`
- [ ] Pick a speech-to-text provider that handles your demo languages (Whisper/OpenAI, Deepgram, ElevenLabs…). Put the key in `SPEECH_API_KEY`, and add its SDK per rule 4.
- [ ] iPhone voice notes arrive as `.caf`; convert first if the provider needs it (ffmpeg). Get a real `.caf` from User 1's smoke test to test with in the sim (`nainai: voice ./sample.caf`).
- [ ] `transcribe()` returns the text; the router already relays it as `🎤 Name: …` through translation.
- [ ] Stretch: `synthesize()` a voice note reply in the elder's language.

### U2.6 Photos (H9–10), `src/media/image.ts`
- [ ] `explainImage()` uses Claude vision: return "" for ordinary photos, and a translation plus plain-language explanation for letters, labels and forms.

### U2.7 Visa Direct sandbox (H10–13), `src/payments/visa.ts`
- [ ] Make `VISA_MODE=mock` work first. The demo must never depend on the sandbox.
- [ ] Visa Developer project: get the sandbox user ID/password and the mutual-TLS cert, key and CA (paths in `.env`).
- [ ] Foreign Exchange Rates API for the quote (USD → TWD), then Funds Transfer API push funds (OCT).
- [ ] Map Visa errors to `{ ok: false, error }` in plain words.

### U2.8 Payment conversation flow (H13–16), `src/payments/flow.ts`
- [ ] Cheap pre-check (regex for amounts / "send" / 钱) so normal chat isn't slowed.
- [ ] Parse the intent with Claude: `{ recipientId, amount, currency, note }`.
- [ ] Confirm with the sender via `ask()`: "Send Nai Nai $50 (≈ NT$1,600)? ❤️ to confirm".
- [ ] Scam check: requests *from* elders go through `trustedConfirmer()` + `ask()` first.
- [ ] Run `sendGift()`, then tell both sides **in their own language**, with the amount in their own currency and the note translated.
- [ ] Return `true` so the command isn't relayed as chat.
- **Done when:** `kevin: send Nai Nai $50 for New Year` in the sim runs the whole flow.

### U2.9 Help with real needs + language edge cases (H16–18)
- [ ] When an elder mentions needing medicine or groceries, `tryHandlePayment()` can **return false** (so the message still relays) and *also* `ask()` a family member: "Grandpa needs medicine. Send him $30? ❤️ to send".
- [ ] Tick the Language and Safety/money items in `docs/EDGE_CASES.md`.
- **Stretch:** currency formatting per locale.

---

## Phase 3: together (H18–24)

| Hour | User 1 | User 2 |
|---|---|---|
| 18–20 | Run live on demo phones; fix bugs both report | Full demo run in the sim, then on phones; file bugs to the owner |
| 20–22 | Record a **backup demo video** (in case of Wi-Fi or Photon trouble) | README update + Devpost writeup, screenshots |
| 22–24 | Rehearse the 3-minute demo (`docs/PLAN.md`) twice, timed | Rehearse; prepare answers on Photon edge cases and the Visa flow |

Bug fixing in Phase 3 still follows the ownership table: report the bug to the file's owner rather than fixing it yourself, unless they agree.

## If you fall behind, cut in this order

1. U2.6 photos, U2.5 TTS stretch, U1.6 persistence
2. U2.7 real Visa sandbox (keep `VISA_MODE=mock` for the demo and say so honestly)
3. U2.9 help-with-needs
4. U2.5 voice notes (then change demo step 2 to a typed message)
5. **Never cut:** live relay (U1.2), real translation (U2.1), human review (U1.3), and the tapback/edit/unsend sync shown in the demo.
