# Spec U2-06: README + Devpost draft (guide step 9, drafted early)

Subagent: **writeup** (wave 2, after the merge) · Works in `/home/claude/work/writeup/` (a fresh copy of the merged tree) · Read first: `docs/specs/U2-00-master.md`, `README.md`, `docs/PLAN.md`, `docs/EDGE_CASES.md`, `docs/USER2_GUIDE.md`, and the code in `src/` (enough to describe it accurately).

## Owns
`README.md`, new `docs/DEVPOST.md`.

## Requirements
- **README.md:** keep the structure and voice.
  - Update "How Bridge works" and "Getting started" to match what the code actually does now (simulator commands, `try:translate`, `sim:u2`, the env vars that exist in `.env.example`).
  - Add a short "Status" table: built, built and needs credentials, planned. **Only claim what the code does**; anything untested with real keys is "built, needs credentials".
- **docs/DEVPOST.md:** a Devpost draft with the standard sections (Inspiration, What it does, How we built it, Challenges, Accomplishments, What we learned, What's next, Built with).
  - Mention the Photon track (Advanced iMessage Kit: tapbacks, replies, edits, unsends, hub-and-spoke relay) and the Visa track (Visa Direct push payments, FX, scam protection).
  - Plain, specific, under ~700 words. Leave `[TODO: …]` for facts only the team knows (demo languages, real family story, screenshots).
- Don't invent metrics, user counts or results.

## Verification
Every command and env var named in either file exists (`package.json` scripts, `.env.example`). Every feature claimed maps to a file in `src/`. Report the list of claims → files.
