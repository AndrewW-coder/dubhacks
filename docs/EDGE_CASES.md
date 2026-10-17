# Edge Cases

Photon judges specifically look at edge case handling. Check items off as they're built, and pick 1–2 to show live in the demo.
Each section has one owner (see `docs/PARALLEL_PLAN.md`), so **only tick your own section** to avoid merge conflicts.

## User 1: Relay and sync
- [ ] Threaded replies point at the right relayed copy in every thread
- [ ] Tapbacks relayed to every copy of the original message
- [ ] Edits update every relayed copy (and fall back to a "correction" reply after iMessage's 15-minute edit window)
- [ ] Unsends remove every relayed copy (and fall back to "(message removed)" after the 2-minute unsend window)
- [ ] New family member joins mid-conversation
- [ ] Messages arrive out of order or at the same moment (per-sender queue)
- [ ] Bridge's own messages are never relayed back (echo loop)
- [ ] Event stream drops and reconnects without losing or duplicating messages (catch-up replay)

## User 1: Human check
- [ ] Bilingual member doesn't answer → send the best translation with a note that it's uncertain
- [ ] Two bilingual members answer differently
- [ ] Same question for several recipients in one language → reviewer asked only once
- [ ] A reviewer's answer ("A", tapback) is never relayed to the family as chat

## User 2: Language
- [ ] Mixed-language messages (code-switching)
- [ ] Romanized text (e.g. pinyin, romaji)
- [ ] Words that should stay untranslated: names, brands, family glossary terms
- [ ] Emoji-only or sticker-only messages (relay without translating)
- [ ] Slang and abbreviations from younger family members
- [ ] Bridge learns from corrections and stops asking about the same phrase
- [ ] Translation API fails or times out → message still gets through

## User 2: Safety and money
- [ ] Emergency messages ("I fell", "help") skip the human check, go to everyone right away, and get flagged (in every demo language)
- [ ] Money requests *from* a grandparent are confirmed with a trusted family member first
- [ ] Payment fails or is declined → clear message in the sender's language
