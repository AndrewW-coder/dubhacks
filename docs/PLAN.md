# Build Plan

> **Who does what, and in what order:** see [`PARALLEL_PLAN.md`](PARALLEL_PLAN.md) (User 1 / User 2 split).
> **Photon setup:** see [`PHOTON_SETUP.md`](PHOTON_SETUP.md).

> 🛍️ **New direction for the Visa track ("Reimagine Shopping"):** Bridge shops for the people you love. A need in the chat leads to personalized options in each language, a family tapback vote, then Visa checkout and order updates. See [`specs/VISA-SHOPPING.md`](specs/VISA-SHOPPING.md) for the demo, ownership, contracts and build order. It replaces "Visa gifts" as the main Visa feature; gifts stay as a secondary option.

## Priorities
If we fall behind, cut from the bottom of this list first.

1. **Relay** between 2+ people over Photon (required, the core of the project)
2. **Tone-aware translation** with family profiles and glossary (required)
3. **Bilingual-member human check** with tapback approval (required, our main hybrid intelligence feature)
4. **Relaying tapbacks, replies, edits, and unsends** (key for Photon's "extensive use")
5. **Visa Direct** gift flow + scam check (key for the Visa track)
6. Voice notes and photo translation (nice to have)

## Timeline (24 hours)

Work runs in parallel; see PARALLEL_PLAN.md for the hour-by-hour split and sync points.

| Hours | User 1, AndrewW-coder (Photon, relay, review) | User 2, reallyrealistic (translation, media, payments) |
|---|---|---|
| 0–0.5 | Phase 0 together: scaffold pushed, keys shared | Phase 0 together |
| 0.5–4 | Photon credentials, smoke test, live relay on real phones | Claude translator with tone, relationships, glossary |
| 4–7 | Human review flow | Confidence scoring, emergencies, glossary learning |
| 7–10 | Relay sync edge cases | Voice notes, photos |
| 10–16 | Polish, hardening, live-testing User 2 features on phones | Visa Direct sandbox, payment conversation flow |
| 16–18 | Demo phones + demo script | Help-with-needs, language edge cases |
| 18–24 | Feature freeze → live testing, backup video, rehearsal | Feature freeze → Devpost, README, rehearsal |

## Things to ask sponsors early
- **Photon:** can we get a line **address + token** for `@photon-ai/advanced-imessage` (gRPC)? Do edit, unsend, tapbacks and threaded replies work on the shared line? Do all test phones reach the same Bridge number? Limits? (Full list in PHOTON_SETUP.md §1.)
- **Visa:** which APIs and sandbox does the track expect (Visa Direct, Foreign Exchange Rates, others)? Can one project win multiple tracks?

## Demo script (about 3 minutes)
1. **The story** (20 seconds): a teammate and their grandparents, and what gets lost between them.
2. **Live:** a teammate acting as Grandma sends a voice note in her language. A judge receives it on their own phone, in English, with a natural tone.
3. **The judge replies with a tapback**, and it appears on "Grandma's" phone too.
4. **Human check:** Grandma sends an idiom. The bilingual teammate gets a private DM, picks the meaning, and only then does it send.
5. **Visa:** send a New Year gift, with the amount converted to her currency and a note in her language.
6. **Edge case:** unsend a message and show it disappear from everyone's view.

## Open questions
- Which languages do we demo? (Use a teammate's real family language.) → decide in Phase 0
- Speech-to-text and text-to-speech provider? → User 2 decides in U2.5
- SQLite vs. in-memory store for the demo? → in-memory now; SQLite is a User 1 stretch goal
