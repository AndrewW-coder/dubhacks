# Hey Andrew 👋 you're User 1

**From reallyrealistic (User 2).** We split Bridge into two halves that barely touch each other, so we can both build at full speed without merge conflicts. Full details are in [`PARALLEL_PLAN.md`](PARALLEL_PLAN.md); this page is the short version for you.

## Your role: Photon, relay, human review, live demo

You make sure **every message reaches the right phones and stays in sync**. I handle what the messages *say* (translation) and the money.

| You (User 1, AndrewW-coder) | Me (User 2, reallyrealistic) |
|---|---|
| Photon / iMessage connection | Claude translation, tone, glossary |
| Relay: replies, tapbacks, edits, unsends | Confidence scoring + emergency detection |
| Bilingual-member review flow | Voice notes + photo translation |
| Running the **live bot** and the demo phones | Visa Direct payments + scam checks |
| Backup demo video | README + Devpost writeup |

**Why you got this half:** it's hands-on work (Photon booth, real phones, running the bot for 24 h). That suits your better laptop and uses less Claude, which fits the Pro plan's limits. My half is the code-heavy part, which suits my Claude Max plan.

## Files you own (only you edit these)

```
src/photon/     src/relay/     src/review/     src/db/
src/index.ts    src/sim.ts     data/family*.json    data/demo-script.txt
docs/PHOTON_SETUP.md
```

I own `src/translate/`, `src/media/`, `src/payments/`. **Frozen for both of us:** `src/types.ts`, `src/config.ts`, `.env.example`, `src/photon/port.ts`, `src/photon/client.ts`. If one of those must change, make it additive only, in its own commit, and message me.

## Get started (≈20 min)

1. Pull this branch/commit, then run:
   ```bash
   npm install
   cp .env.example .env
   npm run sim:demo      # the whole app runs in your terminal with placeholder translations
   ```
2. **Go to the Photon booth first.** We need a line **address + token** for `@photon-ai/advanced-imessage` (gRPC). The five questions to ask are in [`PHOTON_SETUP.md` §1](PHOTON_SETUP.md#1-get-credentials). **No Mac needed.** It talks to Photon's hosted server, so your laptop runs it.
3. Send me the Photon token privately (never commit `.env`). I'll send you the Anthropic API key.

## Your steps

| Hours | Step | Done when |
|---|---|---|
| 0.5–1.5 | **U1.1** Credentials + `npm run photon:smoke -- <your phone>`; fix field names in `src/photon/live.ts` | every action on your phone (reply, tapback, edit, unsend, photo, voice) logs the right event |
| 1.5–4 | **U1.2** Live relay between 2–3 real phones (`PHOTON_MODE=live`, `npm run dev`) | a message from phone A shows on B and C, with tapbacks/edits/unsends mirrored. **Sync S1:** pull my translator |
| 4–7 | **U1.3** Review flow (`src/review/bridgeReview.ts`): reviewer choice, tapback answers, two reviewers | messages containing `🧪` wait for the reviewer's A/B answer |
| 7–10 | **U1.4** Relay edge cases: edit/unsend time windows, reconnect, new member, ordering | your section of `docs/EDGE_CASES.md` is ticked |
| 10–13 | **U1.5–1.6** `?` explanations, typing indicator, urgent alerts, persist the message map | a restart mid-demo doesn't break replies |
| 13–16 | **U1.7** Test my features on real phones as they merge (voice, photos, payments) | bugs reported to me with `PHOTON_DEBUG=1` output |
| 16–18 | **U1.8** Demo phones + `data/demo-script.txt` + early backup video | **Feature freeze at H18** |
| 18–24 | Together: live runs, backup video, rehearse the 3-minute demo | 🏆 |

Each step's full checklist is in [`PARALLEL_PLAN.md`](PARALLEL_PLAN.md#user-1-plan-andreww-coder-photon-relay-review-live-demo).

## Four rules that keep us out of merge hell

1. **Only edit your own files.** Need something in mine? Message me, or leave a `// TODO [U2]` in your file.
2. **Branch per step** (`u1/<step>`), `git pull --rebase origin main` before each, and merge small and often.
3. **Only you run `PHOTON_MODE=live`.** Two listeners on one line relay every message twice. I use `npm run sim`.
4. **New npm package?** Put it in its own commit and push right away. On a lockfile conflict: `git checkout --theirs package-lock.json && npm install`.

## What you can rely on from me

The router you own already calls these. Until I replace them they return placeholders, so nothing blocks you:

```ts
translate(text, from, to, family) → { text, confidence, notes?, alternatives? }
needsReview(originalText, translation) → boolean
isEmergency(text) → boolean
tryHandlePayment(family, sender, msg) → true if it was a money command
transcribe(audioPath, language) → text
explainImage(imagePath, language) → explanation, or "" for normal photos
```

Typing `🧪` in any message forces a low-confidence translation, so you can test review before my translator is done.

## Saving your Claude Pro usage

- Use **Sonnet** in Claude Code, and clear the conversation between tasks.
- Ask for small, specific fixes ("map reaction events in `toIncoming()`"), not whole modules.
- Save Claude for the tricky Photon debugging. If you need a big chunk of code written, ping me and I'll run it on Max.
