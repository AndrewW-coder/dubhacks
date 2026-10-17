# Bridge 🌉

**A family group chat where everyone speaks their own language.**

Bridge is an iMessage agent, built on Photon, for families separated by language. Grandparents write in their language and grandkids write in theirs. Bridge translates every message with the right tone and cultural context. When a translation is too risky to guess, it asks a bilingual family member to confirm before sending. It also lets family members send money to each other across borders with Visa.

> Built at **DubHacks 2026** for the **Visa** track and the **Photon** side track.

---

## The problem

Millions of families have a language gap between generations. Kids raised abroad, or in immigrant households, often can't fully talk to their grandparents. Translation apps exist, but:

- They lose **tone**: honorifics, warmth, and humor disappear.
- They don't know **family context**: nicknames, dialect words, inside jokes.
- They guess at idioms and emotional messages, which are the ones that matter most.
- Grandparents won't install a new app, but they already use texting.

## How Bridge works

### 1. Hub-and-spoke relay (the core design)
In a normal group chat, everyone sees the same message, so you can't show each person a different language. Instead, **each family member has a 1:1 iMessage thread with Bridge**. When someone sends a message, Bridge translates it and **relays it into everyone else's thread in their own language**. To each person, it feels like a normal family group chat entirely in their language.

Replies, tapbacks, edits, unsends, photos, and voice notes are all relayed and kept in sync across every thread.

### 2. Tone-aware translation
- Uses honorifics and respectful forms for elders, and casual language between cousins.
- Learns a **family glossary** (nicknames like "Nai Nai", dish names, dialect words) and never translates terms that should stay as-is.
- Reply `?` to any relayed message to see the original text and cultural context ("She's not upset. This is how she shows she cares.").

### 3. Human checks for hard translations (hybrid intelligence)
Every translation gets a **confidence score**. When it's low (idioms, sarcasm, emotional weight, unclear dialect), Bridge **privately DMs the family's bilingual member**:

> Grandpa said "…". I think he means **A** or **B**. Which one?

They answer with a tapback, and only then does the message send. Bridge learns from each answer and asks less often over time.

**AI handles the 90% of messages that are easy. Your bilingual family members handle the 10% that matter most.**

### 4. Voice and photos first
- Grandparents can send **voice notes**. Bridge transcribes, translates, and relays them as text, and can optionally send back a voice note in their language.
- **Photos** of letters, prescription labels, or forms get translated and explained.

### 5. Money across the language gap (Visa)
- **Cross-border gifts:** "Send Grandma $50 for New Year." Bridge sends it through Visa Direct, shows the amount in each person's currency, and includes a note in her language.
- **Help with real needs:** when Grandpa mentions he needs medicine or groceries, Bridge suggests that a family member pay, and they confirm with a tapback.
- **Scam protection:** any money request *from* a grandparent is first confirmed with a trusted family member.

---

## Architecture

```
iMessage (each family member)
        ↕  Photon Advanced iMessage Kit (gRPC, hosted by Photon; no Mac needed)
   Bridge server (Node + TypeScript)
     ├─ photon/       the only code that knows about Photon (live client + terminal simulator)
     ├─ relay/        maps messages, replies, and tapbacks across threads; asks-and-waits prompts
     ├─ translate/    Claude + family glossary + relationship context
     ├─ review/       low-confidence → bilingual-member DM queue
     ├─ media/        speech-to-text, text-to-speech, photo translation
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
│   ├── PHOTON_SETUP.md       how to get Photon credentials and run live
│   ├── PLAN.md               priorities, timeline, demo script
│   └── EDGE_CASES.md         edge cases we handle (and show judges)
├── data/
│   ├── family.example.json   demo family (fake numbers); copy to family.json for real phones
│   └── demo-script.txt       scripted end-to-end run for the simulator
├── src/
│   ├── index.ts              entry point: per-sender queues, starts the listener
│   ├── sim.ts                `npm run sim`: same app against the terminal simulator
│   ├── config.ts             loads environment variables
│   ├── types.ts              shared types (FamilyMember, IncomingMessage, Translation, …)
│   ├── photon/               port.ts (interface), client.ts (picks mode), live.ts, mock.ts, smoke.ts
│   ├── relay/                router.ts, messageMap.ts, prompts.ts (ask & wait), explain.ts ("?")
│   ├── translate/            translator.ts, confidence.ts, glossary.ts
│   ├── review/bridgeReview.ts    bilingual-member approval
│   ├── media/                voice.ts, image.ts
│   ├── payments/             flow.ts (money conversations), visa.ts, scamCheck.ts
│   └── db/store.ts           in-memory storage loaded from data/family*.json
├── .env.example              copy to .env and fill in
├── package.json
└── tsconfig.json
```

## Getting started

```bash
git clone https://github.com/AndrewW-coder/dubhacks.git
cd dubhacks
npm install
cp .env.example .env     # add ANTHROPIC_API_KEY; Photon keys only needed for live mode

npm run sim:demo         # scripted run in the terminal, no iMessage needed
npm run sim              # type as any family member: "nainai: 你吃饭了吗"
npm run dev              # live iMessage (PHOTON_MODE=live in .env, see docs/PHOTON_SETUP.md)
```

Photon's Advanced iMessage Kit runs against Photon's hosted server, so **no Mac is required**. Any laptop works. Only one process should run in live mode at a time.

## Team

| Name | Role | Focus |
|---|---|---|
| [AndrewW-coder](https://github.com/AndrewW-coder) | User 1 | Photon integration, relay, human review, live demo |
| [reallyrealistic](https://github.com/reallyrealistic) | User 2 | Translation, glossary, voice/photos, Visa payments, Devpost |
