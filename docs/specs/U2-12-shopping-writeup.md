# Spec U2-12: README + Devpost around shopping
Owns `README.md` and `docs/DEVPOST.md`. Read `VISA-SHOPPING.md` (the pitch, demo, Visa section), `U2-10-shopping.md`, and the code in `src/shop/`, `src/payments/`, `src/translate/`, `src/photon/live.ts`.

- **Pitch:** "Bridge shops for the people you love", for the Visa track "Reimagine Shopping" and the Photon track. Keep translation, review, emergencies, photos and voice as supporting features.
- **README:**
  - update "How Bridge works" with a shopping section: need → 3 options in each language, with links → the family talks and votes by tapback → checkout under limits → confirmation;
  - update the Status table (built / built, needs credentials / planned): SerpApi live search = built, needs `SERPAPI_API_KEY`; checkout `SHOP_MODE=sandbox` = needs Visa booth API; `familyVote`/`trackOrder` = User 1 in progress (stand-ins in `src/shop/u1.ts`);
  - Getting started: add `npm run sim -- data/demo-shopping-u2.txt` and the new env vars.
- **DEVPOST:** rewrite around the shopping story, mapped to Visa's stages (discovery, personalization, decision-making, checkout, payments, post-purchase). Mention the cultural-awareness rules. No invented metrics; `[TODO]` for team-only facts. Under ~800 words.
- Only claim what the code does. Every command and env var you name must exist (package.json, .env.example, module headers).
Report: files changed, claim → file list. Under 300 words.
