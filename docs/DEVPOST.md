# Bridge: a family group chat where everyone speaks their own language

> Devpost draft. `[TODO: …]` marks facts only the team can fill in.

## Inspiration

[TODO: the real family story — whose grandparents, which languages, what got lost between them.]

Translation apps lose tone, don't know family nicknames, and guess at the emotional messages that matter most. And grandparents won't install a new app, but they already text.

## What it does

Bridge is an iMessage agent. Each family member has a 1:1 thread with Bridge. When someone writes, Bridge translates the message for each other member, using their relationship (respectful forms for elders, casual between cousins) and a family glossary, and relays it into their thread. To each person it looks like one family group chat in their own language.

- **Full iMessage, not just text.** Threaded replies, tapbacks, edits and unsends are relayed to the matching copy in every thread. Photos of letters or prescription labels get a short explanation in each reader's language. Voice notes are transcribed, translated and relayed.
- **Humans check the hard ones.** Every translation has a confidence score. Low-confidence ones (idioms, sarcasm, dialect) are sent privately to the family's bilingual member as "A or B?". The message only sends after they answer, and Bridge saves the answer so it never asks about that phrase again.
- **Emergencies skip the line.** "救命，我摔倒了" is flagged 🚨, skips review, and jumps ahead of any waiting message.
- **Money across the gap (Visa).** "send Nai Nai $50 for New Year" shows the amount in her currency, asks you to confirm with ❤️ or "yes", sends it through Visa Direct, and she gets a 🧧 with the note in Chinese. When a grandparent mentions running out of medicine, the family is offered a small gift. Money requests from a grandparent, or with scam markers (gift cards, wire, crypto, secrecy, urgency), are first approved by a trusted family member.

## How we built it

- **Photon track: Spectrum SDK** (`spectrum-ts`), plus the raw Advanced iMessage event stream for edits, unsends and tapback removals. Together they cover tapbacks, threaded replies, edits and unsends, with no Mac and no public webhook. The hub-and-spoke relay keeps a map from each original message to its copy in every thread, so a tapback, reply, edit or unsend on one copy is applied to all the others.
- **Gemini** (by default; Claude or any OpenAI-compatible model can be swapped in with one setting) for translation (function calls returning text, confidence, alternatives and a cultural note), payment intent parsing, and reading photos.
- **OpenAI speech-to-text** for voice notes, with ffmpeg converting iPhone `.caf` audio.
- **Visa track: Visa Direct** push funds (OCT) and the Foreign Exchange Rates API, over two-way TLS, sandbox test cards only, with a mock mode for the demo.
- A **terminal simulator** runs the same app with every member typed from one keyboard, plus scripted runs (`npm run sim:demo`, `npm run sim:u2`).

## Challenges we ran into

- **A group chat can't show each person a different language**, so we built the hub-and-spoke relay and had to keep replies, tapbacks, edits and unsends in sync across copies.
- **Asking and waiting inside a chat.** Answers to review and payment questions must never be relayed to the family, and emergencies must not wait behind a message stuck on a reviewer.
- **False alarms.** "救命这个好好笑" is internet slang for "this is hilarious", not an emergency, and "I spent $20 on groceries" is chat, not a payment.
- **Working without keys.** We had no API keys for most of the build, so every integration has a no-key fallback and was tested against local fake servers.
- [TODO: anything that went wrong with Photon or Visa sandbox setup on the day.]

## Accomplishments that we're proud of

- The hybrid loop: AI translates, a family member settles the hard cases, and Bridge learns from each answer.
- Scam protection designed around how grandparents actually get targeted.
- [TODO: what worked live on real phones in the demo.]

## What we learned

- Tone and family context matter more than word accuracy.
- [TODO: what the team learned about Photon, Visa Direct and working in parallel.]

## What's next

- Sending a voice reply back in each person's language (text-to-speech is written; the relay doesn't send it yet).
- Answering a review question with a tapback, and writing the `?` explanation in the asker's language.
- Persistent storage, onboarding new members, and real card linking instead of sandbox test cards.

## Built with

TypeScript · Node.js · Photon Spectrum SDK · Google Gemini API · OpenAI speech-to-text · ffmpeg · heic-convert · Visa Direct · Visa Foreign Exchange Rates API

[TODO: screenshots of a relayed conversation, a review question, and a 🧧 gift. Demo languages: [TODO]. Demo video link: [TODO].]
