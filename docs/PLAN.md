# Build Plan

## Priorities
If we fall behind, cut from the bottom of this list first.

1. **Relay** between 2+ people over Photon (required, the core of the project)
2. **Tone-aware translation** with family profiles and glossary (required)
3. **Bilingual-member human check** with tapback approval (required, our main hybrid intelligence feature)
4. **Relaying tapbacks, replies, edits, and unsends** (key for Photon's "extensive use")
5. **Visa Direct** gift flow + scam check (key for the Visa track)
6. Voice notes and photo translation (nice to have)

## Timeline (24 hours)

| Hours | Goal | Owner |
|---|---|---|
| 0–3 | Photon setup, receive and send messages, basic relay between two people | |
| 3–8 | Translation with tone and relationships, family profiles, glossary | |
| 8–12 | Confidence check + bilingual-member DM flow with tapback approval | |
| 12–15 | Relaying replies, tapbacks, edits, and unsends | |
| 15–18 | Voice notes and photo translation | |
| 18–21 | Visa Direct sandbox gift flow + scam checks | |
| 21–24 | Edge case cleanup, demo rehearsal, Devpost writeup | |

## Things to ask sponsors early
- **Photon:** what's new in 2.0? Host setup requirements? Which features (tapbacks, edits, unsends, voice) are exposed by the SDK?
- **Visa:** which APIs and sandbox does the track expect (Visa Direct, others)? Can one project win multiple tracks?

## Demo script (about 3 minutes)
1. **The story** (20 seconds): a teammate and their grandparents, and what gets lost between them.
2. **Live:** a teammate acting as Grandma sends a voice note in her language. A judge receives it on their own phone, in English, with a natural tone.
3. **The judge replies with a tapback**, and it appears on "Grandma's" phone too.
4. **Human check:** Grandma sends an idiom. The bilingual teammate gets a private DM, picks the meaning, and only then does it send.
5. **Visa:** send a New Year gift, with the amount converted to her currency and a note in her language.
6. **Edge case:** unsend a message and show it disappear from everyone's view.

## Open questions
- Which languages do we demo? (Use a teammate's real family language.)
- Speech-to-text and text-to-speech provider?
- SQLite vs. in-memory store for the demo?
