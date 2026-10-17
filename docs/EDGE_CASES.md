# Edge Cases

Photon judges specifically look at edge case handling. Check items off as they're built, and pick 1–2 to show live in the demo.

## Language
- [ ] Mixed-language messages (code-switching)
- [ ] Romanized text (e.g. pinyin, romaji)
- [ ] Words that should stay untranslated: names, brands, family glossary terms
- [ ] Emoji-only or sticker-only messages (relay without translating)
- [ ] Slang and abbreviations from younger family members

## Relay and sync
- [ ] Threaded replies point at the right relayed copy in every thread
- [ ] Tapbacks relayed to every copy of the original message
- [ ] Edits update every relayed copy
- [ ] Unsends remove every relayed copy
- [ ] New family member joins mid-conversation
- [ ] Messages arrive out of order or at the same moment

## Human check
- [ ] Bilingual member doesn't answer → send the best translation with a note that it's uncertain
- [ ] Two bilingual members answer differently
- [ ] Bridge learns from corrections and stops asking about the same phrase

## Safety
- [ ] Emergency messages ("I fell", "help") skip the human check, go to everyone right away, and get flagged
- [ ] Money requests *from* a grandparent are confirmed with a trusted family member first
- [ ] Payment fails or is declined → clear message in the sender's language
