# Spec U2-07: Independent review of the merged User 2 work

Subagent: **review** (wave 2, read-only; it hasn't seen the work being produced) · Works in `/home/claude/work/review/` (a fresh copy of the merged tree).

## Scope
`src/translate/*`, `src/media/*`, `src/payments/*`, `data/*.json`, `data/demo-u2.txt`, plus how they plug into `src/relay/router.ts`, `src/relay/prompts.ts` and `src/index.ts`.

## Check
1. **Contracts:** every signature in `docs/specs/U2-00-master.md` is unchanged, and the "never throws" functions really can't throw (look for unguarded awaits, JSON.parse, file reads).
2. **Ownership:** no file outside User 2's ownership changed versus `/home/claude/work/base/` (the pre-merge snapshot), except what the orchestrator merged on purpose (`.env.example`, `.gitignore`).
3. **Safety:**
   - no secrets, real card numbers or real phone numbers in code;
   - PANs masked in logs;
   - no money sent without an explicit yes;
   - the scam path can't be bypassed;
   - the needs flow can't pay twice.
4. **Robustness:**
   - works with no keys at all;
   - timeouts on every network call;
   - temp files go to `.bridge-tmp/`;
   - Windows paths and line endings are OK (`path.join`, no shell-specific commands, spawn without a shell).
5. **Behaviour:** run `npx tsc --noEmit`, `npm run sim:demo`, `npm run sim:u2`, and every `src/**/*.selftest.ts`. Read the sim output as a user would: is anything confusing, duplicated or in the wrong language?

## Report
A ranked list:
- **must-fix** (bugs, contract breaks, safety), each with file:line, the failure scenario and a suggested fix;
- **should-fix**;
- **nits**.
Don't edit files. Under 500 words.
