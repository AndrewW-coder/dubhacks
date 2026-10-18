# Bridge 🌉

**Bridge shops for the people you love.**

Bridge is an iMessage agent, built on Photon, for families separated by language. It sits in the family's chats, relays every message in each person's own language, and helps the family shop for a grandparent together: when Nai Nai says her blood pressure monitor broke, Bridge finds 3 options that fit *her*, shows them to everyone in their own language and currency, lets the family talk it over and vote with a tapback, checks out under the buyer's limit, and tells everyone what was bought.

Translation with human review, emergency detection, photo and voice-note relay, and Visa money gifts are still there as supporting features.

> Built at **DubHacks 2026** for the **Visa "Reimagine Shopping"** track and the **Photon** track.

---

## The problem

Millions of families have a language gap between generations. Kids raised abroad, or in immigrant households, often can't fully talk to their grandparents. Translation apps exist, but:

- They lose **tone**: honorifics, warmth, and humor disappear.
- They don't know **family context**: nicknames, dialect words, inside jokes.
- They guess at idioms and emotional messages, which are the ones that matter most.
- Grandparents won't install a new app, but they already use texting.
- Buying things for a grandparent abroad is hard from both sides: she can't use English-language stores, and the grandkids can't read her language or tell what she actually needs.

## How Bridge works

### 1. Hub-and-spoke relay (the core design)
In a normal group chat, everyone sees the same message, so you can't show each person a different language. Instead, **each family member has a 1:1 iMessage thread with Bridge**. When someone sends a message, Bridge translates it and **relays it into everyone else's thread in their own language**. To each person, it feels like a normal family group chat entirely in their language.

Threaded replies, tapbacks, edits, and unsends are relayed to the matching copy in every thread. Photos and voice notes are relayed too (see 5). Each sender's messages are relayed in order, and different people's messages are handled in parallel.

### 2. Shopping for the people you love (Visa "Reimagine Shopping")
The whole flow runs inside the family's iMessage threads (`src/shop/`):

1. **Need.** A grandparent mentions something she can buy ("我的血压计坏了，想买个新的，字要大一点"), or anyone asks ("find Nai Nai a tablet with big buttons", "帮奶奶找个血压计"). Her message is still relayed as normal chat; an explicit "find/buy X for Y" command to Bridge is not. Rent and bills still get the money offer instead (section 6).
2. **3 options, in each language, with links.** Bridge pulls out who it's for, what, and any budget, then gets candidates from **SerpApi Google Shopping** (real stores, real links) or, without a key or on any search error, the curated offline catalog `data/catalog.json` (fictional products and merchants, marked "demo product"). It filters by budget, shipping country and the cultural rules below, ranks elder-friendly features higher (large display, simple buttons, Chinese voice or screen), and sends a heading plus one card per option: letter, name, price in the reader's currency, merchant, a short summary and "why this one", and the link alone on the last line so iMessage previews it.
3. **The family talks and votes.** Everyone keeps chatting normally while the vote is open. A letter (A/B/C) or a tapback on a card is a vote (👍 A · ❤️ B · 😂 C on the heading). Votes are never relayed. It closes on a majority, when everyone has voted, or after `SHOP_VOTE_TIMEOUT_MS` (most votes wins; nobody voted → the buyer picks).
4. **Checkout under limits.** The buyer is whoever asked (if they're not the elder), else the family member trusted with money. Under the buyer's limit (default $50, `SHOP_DEFAULT_LIMIT_USD`) the vote is the approval. Over it, the buyer must answer ❤️ or "yes" to a line with the price in their currency; anything else buys nothing. Purchases involving an elder that look like scam targets (gift cards, prepaid cards, crypto, wire transfers) need a trusted member's approval first.
5. **Confirmation.** Everyone gets "✅ Mei bought Nai Nai a gift 🎁, arriving …" in their own language. If nothing fits, Bridge says so and suggests sending money instead.

**Cultural rules**, enforced in code (`src/shop/catalog.ts`), for gifts to an elder or a Chinese-speaking member: no clocks (送钟 sounds like attending a funeral), no sets of four (四 sounds like 死), no pears (分梨, separation), no white or black flowers or chrysanthemums.

One shopping decision is open per family at a time. With an AI key, the AI extracts the need and writes each "why"; without one, regex extraction and tag/keyword scoring do the same job.

### 3. Tone-aware translation
- The AI model gets the sender/recipient relationship (for honorifics and tone), the family glossary, and the last few messages of the conversation, so "that" and "it" make sense.
- A **family glossary** (nicknames like "Nai Nai", dish names, dialect words) is seeded from `data/glossary.example.json`. Terms marked `keepAsIs` are never translated.
- Emoji-only messages, links, and messages between people who share a language are passed through untouched.
- Reply `?` to any relayed message to see the original text and the cultural note ("She's not upset. This is how she shows she cares.").
- **Emergencies** ("救命，我摔倒了", "help I fell", and patterns in Spanish, Korean and Vietnamese) are flagged 🚨, skip review, and jump ahead of any message waiting for a reviewer. Laughter ("救命这个好好笑", "lol") turns most of them off.

### 4. Human checks for hard translations (hybrid intelligence)
Every translation gets a **confidence score**. When it's below `REVIEW_CONFIDENCE_THRESHOLD` (idioms, sarcasm, emotional weight, unclear dialect), Bridge **privately DMs the family's bilingual member**:

> 🤔 Nai Nai said: "…". Which en meaning is right?
> A) … B) …
> Reply A / B (or type a better translation).

If the model only offered one meaning, Bridge adds a word-for-word translation as option B, so there is always something to compare. Only after the answer does the message send. If nobody answers in time (`REVIEW_TIMEOUT_MS`), the best guess goes out marked "translation unsure". Each answer is saved to the glossary (`data/glossary.json`), and **the same phrase is never asked about again**.

**AI handles the messages that are easy. Your bilingual family members handle the ones that matter most.**

### 5. Voice and photos
- **Voice notes:** Bridge converts iPhone audio with ffmpeg, transcribes it (OpenAI speech-to-text), translates it, and relays it as text marked 🎤.
- **Photos** of letters, prescription labels, or forms: the AI model reads the text and sends each person a short explanation in their language, as a reply under the photo. iPhone HEIC photos are converted first. Ordinary photos (selfies, food) get no extra message.

### 6. Money across the language gap (Visa)
- **Cross-border gifts:** "send Nai Nai $50 for New Year" or "给Kevin发个红包，100块". Bridge asks the sender to confirm (❤️ or "yes") with the amount in the recipient's currency, sends it through Visa Direct, and the recipient gets a 🧧 message with the note in her language. Gifts are capped at $1,000 for the demo, and messages that only *mention* money ("I spent $20 on groceries") stay normal chat.
- **Help with real needs:** when a grandparent mentions running out of medicine, groceries, a bill, or a broken appliance, the message is relayed as usual and the other members are each offered "Send her $30? ❤️ to send". The first yes pays, and everyone else is told it's handled.
- **Scam protection:** any gift or money request *from* a grandparent, any gift over 200 in the sender's currency, and anything with scam markers (gift cards, wire transfers, crypto, urgency, secrecy) is first approved by the family's trusted member, with the reasons spelled out. Nothing is ever paid without a person saying yes.

## Status

What the code does today. "Needs credentials" means the code is written and tested against local fake servers, but not yet against the real service.

| Feature | Status | Where |
|---|---|---|
| Relay of text, replies, tapbacks, edits, unsends, photos, voice notes (terminal simulator) | Built | `src/relay/router.ts`, `src/photon/mock.ts` |
| Live iMessage through Photon (Spectrum SDK) | Verified on real phones by User 1 (`SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`; check with `npm run photon:smoke`) | `src/photon/live.ts` |
| Bilingual-member review by letter or typed correction; learning from answers | Built | `src/review/bridgeReview.ts`, `src/translate/glossary.ts` |
| Confidence threshold, emergency detection, `?` for the original | Built | `src/translate/confidence.ts`, `src/relay/explain.ts` |
| Shopping: need detection, 3 option cards per reader's language and currency, vote, checkout, confirmation, using the offline catalog (`SHOP_SEARCH=catalog`, the default without a key) | Built (`npm run sim -- data/demo-shopping-u2.txt`) | `src/shop/shopFlow.ts`, `catalog.ts`, `data/catalog.json` |
| Cultural gift rules, elder-friendly ranking, budget and shipping filters | Built | `src/shop/catalog.ts` |
| Live product search with real links (SerpApi Google Shopping) | Built, needs credentials (`SERPAPI_API_KEY`) | `src/shop/search.ts` |
| AI need extraction and "why this one" ranking | Built, needs credentials (`LLM_API_KEY`); tested against a fake AI server, otherwise falls back to keyword scoring | `src/shop/catalog.ts` |
| Checkout with buyer limit, ❤️/"yes" confirm and scam check, mock payment (`SHOP_MODE=mock`, the default) | Built | `src/shop/checkout.ts` |
| Checkout with a real Visa sandbox (`SHOP_MODE=sandbox`) | Needs the Visa booth's API: for now it sends a Visa Direct push to a merchant stand-in, so it also needs `VISA_MODE=sandbox` and the `VISA_*` credentials | `src/shop/checkout.ts`, `src/payments/visa.ts` |
| `familyVote` / `trackOrder` (User 1's vote and order tracking, with shipped/delivered updates) | User 1, in progress. Bridge uses simple stand-ins until they merge (letter/tapback vote; a one-off confirmation, no shipping updates) | `src/shop/u1.ts` |
| Shopping flow on real phones | [TODO: not yet run live] | `src/photon/live.ts` |
| Gift flow, needs offers, scam checks with mock Visa (`VISA_MODE=mock`, demo FX rates) | Built | `src/payments/flow.ts`, `needs.ts`, `scamCheck.ts`, `visa.ts` |
| Tone-aware translation, literal alternative, photo explanations, payment intent parsing | Built; translation spot-checked with a real Gemini key (needs `LLM_API_KEY`, or `ANTHROPIC_API_KEY` with `TRANSLATE_PROVIDER=anthropic`) | `src/translate/claude.ts`, `src/translate/translator.ts`, `src/media/image.ts` |
| Voice note transcription (OpenAI) | Built, needs credentials (`SPEECH_API_KEY`) | `src/media/voice.ts` |
| Visa Direct sandbox: FX rates + push funds, two-way TLS (`VISA_MODE=sandbox`) | Built, needs credentials (`VISA_*`) | `src/payments/visa.ts` |
| Voice note replies (text-to-speech): `synthesize()` exists, not yet sent by the router | Planned | `src/media/voice.ts` |
| Answering a review question with a tapback (👍 = A, ❤️ = B) | Planned | `src/review/bridgeReview.ts` |
| `?` explanation written in the asker's language | Planned | `src/relay/explain.ts` |

Without any keys everything still runs: translations show as placeholders like `[zh→en] 你吃饭了吗？`, voice notes show "(transcription not set up)", money commands are parsed with a regex fallback, and shopping uses the offline catalog with keyword scoring.

---

## Architecture

```
iMessage (each family member)
        ↕  Photon Spectrum SDK (hosted by Photon; no Mac needed)
   Bridge server (Node + TypeScript)
     ├─ photon/       the only code that knows about Photon (live client + terminal simulator)
     ├─ relay/        maps messages, replies, and tapbacks across threads; asks-and-waits prompts
     ├─ translate/    AI (Gemini by default, or Claude / any OpenAI-compatible model) + family glossary + relationship context
     ├─ review/       low-confidence → bilingual-member DM queue
     ├─ media/        speech-to-text, text-to-speech, photo translation
     ├─ shop/         need → options (SerpApi or catalog) → vote → checkout → confirmation
     ├─ payments/     Visa Direct (sandbox) + scam checks
     └─ db/           family members, languages
```

## Repo layout

```
.
├── README.md                 ← you are here
├── docs/
│   ├── PARALLEL_PLAN.md      User 1 / User 2 split, file ownership, merge rules
│   ├── USER1_ROLES.md        short brief for User 1 (AndrewW-coder)
│   ├── USER2_GUIDE.md        step-by-step guide for User 2 (reallyrealistic)
│   ├── PHOTON_SETUP.md       how to get Photon credentials and run live
│   ├── PLAN.md               priorities, timeline, demo script
│   ├── EDGE_CASES.md         edge cases we handle (and show judges)
│   ├── DEVPOST.md            Devpost draft
│   └── specs/                step briefs for the User 2 build
├── data/
│   ├── family.example.json   demo family (fake numbers); copy to family.json for real phones
│   ├── glossary.example.json seed glossary (learned entries go to data/glossary.json, git-ignored)
│   ├── translation-tests.json  phrases for `npm run try:translate`
│   ├── catalog.json          curated demo products (fictional merchants), the offline fallback for search
│   ├── demo-shopping-u2.txt  the shopping story, for `npm run sim -- data/demo-shopping-u2.txt`
│   ├── demo-script.txt       relay paths, for `npm run sim:demo`
│   └── demo-u2.txt           translation, glossary and money flows, for `npm run sim:u2`
├── src/
│   ├── index.ts              entry point: per-sender queues, emergencies first
│   ├── sim.ts                `npm run sim`: same app against the terminal simulator
│   ├── config.ts             loads environment variables
│   ├── types.ts              shared types (FamilyMember, IncomingMessage, Translation, …)
│   ├── photon/               port.ts (interface), client.ts (picks mode), live.ts, mock.ts, smoke.ts
│   ├── relay/                router.ts, messageMap.ts, prompts.ts (ask & wait), explain.ts ("?")
│   ├── translate/            claude.ts, translator.ts, confidence.ts, glossary.ts, try.ts
│   ├── review/bridgeReview.ts    bilingual-member approval
│   ├── media/                voice.ts, image.ts
│   ├── shop/                 shopFlow.ts (the conversation), catalog.ts (finder + cultural rules), search.ts (SerpApi), checkout.ts, u1.ts (stand-ins for User 1's vote/orders)
│   ├── payments/             flow.ts (money conversations), needs.ts, visa.ts, scamCheck.ts
│   └── db/store.ts           in-memory storage loaded from data/family*.json
│   (*.selftest.ts files next to the code run offline with `npx tsx <file>`)
├── .env.example              copy to .env and fill in
├── package.json
└── tsconfig.json
```

## Getting started

```bash
git clone https://github.com/AndrewW-coder/dubhacks.git
cd dubhacks
npm install
cp .env.example .env     # every key is optional; the simulator runs with none

npm run sim -- data/demo-shopping-u2.txt   # the shopping story: need → cards → vote → checkout (no keys)
npm run sim:demo         # scripted relay run in the terminal, no iMessage needed
npm run sim:u2           # scripted translation, glossary, gift, scam and needs run
npm run sim              # type as any family member: "nainai: 你吃饭了吗"  (/help for commands)
npm run try:translate    # run data/translation-tests.json through the translator (needs an AI key)
npm run typecheck        # tsc --noEmit
npm run photon:smoke -- +15551234567   # Photon connection test (needs SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET)
npm run dev              # live iMessage (PHOTON_MODE=live in .env, see docs/PHOTON_SETUP.md)
```

The keys in `.env` that turn features on:

| Variable | Turns on |
|---|---|
| `PHOTON_MODE=live`, `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | real iMessage through Photon |
| `LLM_API_KEY` (Gemini, the default; free key at aistudio.google.com) or `TRANSLATE_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | real translation, photo explanations, payment intent parsing |
| `SPEECH_API_KEY` (`SPEECH_PROVIDER=openai`) | voice note transcription; needs ffmpeg on PATH or `FFMPEG_PATH` |
| `VISA_MODE=sandbox`, `VISA_USER_ID`, `VISA_PASSWORD`, `VISA_CERT_PATH`, `VISA_KEY_PATH`, `VISA_CA_PATH`, `VISA_TEST_SENDER_PAN`, `VISA_TEST_RECIPIENT_PAN` | Visa Direct sandbox instead of mock transfers (test cards only) |
| `SERPAPI_API_KEY` (optional `SHOP_SEARCH=serpapi\|catalog`, `SERPAPI_GL`, `SERPAPI_HL`, `SERPAPI_LOCATION`, `SERPAPI_TIMEOUT_MS`) | live product search with real links instead of the offline catalog |
| `SHOP_MODE=mock\|sandbox`, `SHOP_DEFAULT_LIMIT_USD`, `SHOP_VOTE_TIMEOUT_MS` | checkout mode (sandbox needs the `VISA_*` settings), the buyer's auto-approve limit (default 50), the vote window (default 120000 ms) |
| `REVIEW_CONFIDENCE_THRESHOLD`, `REVIEW_TIMEOUT_MS`, `PAYMENT_CONFIRM_TIMEOUT_MS` | when to ask a reviewer, how long to wait for answers |
| `GLOSSARY_FILE=off` | don't save learned phrases (keeps demo runs repeatable) |

The rest, including the shopping settings (`SERPAPI_*`, `SHOP_*`), are documented in `.env.example`. Photon's SDK runs against Photon's hosted server, so **no Mac is required**. Any laptop works. Only one process should run in live mode at a time.

## Team

| Name | Role | Focus |
|---|---|---|
| [AndrewW-coder](https://github.com/AndrewW-coder) | User 1 | Photon integration, relay, human review, live demo |
| [reallyrealistic](https://github.com/reallyrealistic) | User 2 | Translation, glossary, voice/photos, shopping, Visa payments, Devpost |
