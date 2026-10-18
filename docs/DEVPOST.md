# Bridge: shops for the people you love

> Devpost draft. `[TODO: …]` marks facts only the team can fill in.

## Inspiration

[TODO: the real family story — whose grandparent, which languages, what was hard about buying for them.]

Buying for a grandparent abroad is hard from both sides: she can't use English-language stores, and the grandkids can't read her language or tell what she needs. She won't install a new app, but she already texts.

## What it does

Bridge is an iMessage agent. Each family member has a 1:1 thread with Bridge, which relays every message to everyone else in their own language, so it feels like one family group chat. On top of that, it helps the family **shop for the people they love**:

- **Discovery.** Nai Nai writes "我的血压计坏了，想买个新的，字要大一点" ("my blood pressure monitor broke, I want a new one with bigger numbers"). It's relayed as chat, and Bridge recognizes a buyable need. Anyone can also ask: "find Nai Nai a tablet with big buttons".
- **Personalization.** Bridge searches Google Shopping through SerpApi (real links), or an offline catalog without a key, and picks **3 options that fit her**: in budget, ships to her country, elder-friendly features (large display, simple buttons, Chinese voice) ranked higher, each with a "why this one". Cultural rules are enforced in code: no clocks as gifts (送钟 sounds like attending a funeral), no sets of four (四 sounds like 死), no pears (分梨, separation), no white or black flowers.
- **Decision-making.** Every member gets the same 3 options as cards A/B/C **in their own language and currency** (Nai Nai sees NT$, Kevin sees $), with the link on its own line for an iMessage preview. The family talks it over, then votes with a tapback or a letter. Votes are never relayed.
- **Checkout.** The buyer is whoever asked, or the member trusted with money. Under their limit, the vote is the approval; over it, they must answer ❤️ or "yes". Scam-target purchases involving a grandparent (gift cards, crypto, wire transfers) need a trusted member's approval first.
- **Payments.** Checkout is mock for the demo; a sandbox mode is wired to Visa Direct until we have the Visa booth's card API. [TODO: what we used from the Visa booth.]
- **Post-purchase.** Everyone gets "✅ Mei bought Nai Nai a gift 🎁, arriving Wednesday" in their own language. A photo of the manual gets explained in Chinese. If nothing fits, Bridge suggests sending money instead.

Supporting features: tone-aware translation with a family glossary, a bilingual member who settles low-confidence translations (Bridge learns from each answer), 🚨 emergency detection, photo and voice-note relay, and Visa Direct money gifts with scam checks.

## How we built it

- **Photon track: Spectrum SDK** (`spectrum-ts`) plus the raw Advanced iMessage stream for edits and unsends. The relay maps each message to its copy in every thread, so a tapback on Kevin's card B counts as a vote for B. A family and an AI deciding a purchase together is the track's hybrid intelligence.
- **Product search: SerpApi Google Shopping**, with `data/catalog.json` (fictional products) as the offline fallback.
- **Gemini** by default (or Claude / any OpenAI-compatible model) for translation, need extraction and ranking; regex and tag scoring without a key.
- **Visa track:** Visa Direct and Foreign Exchange Rates over two-way TLS (sandbox test cards only), plus mock mode.
- A **terminal simulator**: `npm run sim -- data/demo-shopping-u2.txt` plays the shopping story with no keys.

## Challenges we ran into

- **Voting inside a chat.** Votes and confirmations must never be relayed, while people chat freely during the vote; a bare "ok" must not count.
- **Cultural rules without false alarms.** The "clock" rule must not block a monitor with a clock display.
- **Working without keys.** Every integration has a no-key fallback and was tested against fake servers; SerpApi and the Visa sandbox still need real credentials.
- [TODO: anything that went wrong with Photon or Visa setup on the day.]

## Accomplishments that we're proud of

- The full loop, need → options in every language → tapback vote → checkout → confirmation, in plain iMessage.
- Nothing is bought without a person: the vote is the approval, and over the limit the buyer confirms.
- [TODO: what worked live on real phones in the demo.]

## What we learned

- Personalizing for an elder is about who she is (language, eyesight, customs), not purchase history.
- [TODO: what the team learned about Photon, Visa and working in parallel.]

## What's next

- Shipped/delivered updates and a fuller family vote (`familyVote` / `trackOrder`, in progress).
- Paying through the Visa booth's card API instead of mock checkout.
- A family wallet that earns points toward the next gift.

## Built with

TypeScript · Node.js · Photon Spectrum SDK · SerpApi Google Shopping · Google Gemini API · OpenAI speech-to-text · ffmpeg · heic-convert · Visa Direct · Visa Foreign Exchange Rates API

[TODO: screenshots of the option cards in Chinese and English, a tapback vote, and the confirmation. Demo video link: [TODO].]
