# Spec U2-04: Visa Direct sandbox (guide step 6)

Subagent: **visa** · Copy: `/home/claude/work/visa/` · Read first: `docs/specs/U2-00-master.md`, `docs/USER2_GUIDE.md` step 6, `src/payments/visa.ts`, `src/payments/flow.ts` (how you're called), `src/config.ts` (`visaMode`, `visaUserId`, `visaPassword`, `visaCertPath`, `visaKeyPath`, `visaCaPath`).

## Owns
`src/payments/visa.ts`, new `src/payments/visa.selftest.ts`.

## Goal
With `VISA_MODE=sandbox` and real sandbox credentials, a family gift becomes a real **Visa Direct sandbox** push payment with a live FX quote. With `VISA_MODE=mock` (the default), everything keeps working offline exactly as now.

## Requirements

### R1 Research first (WebSearch/WebFetch on developer.visa.com; cite the URLs in your report)
Confirm:
- sandbox base URL;
- auth: two-way TLS with the project cert, private key and Visa CA/root bundle, **plus** HTTP Basic auth with user ID/password;
- the Funds Transfer API **push funds** endpoint (OCT) and its required request fields (e.g. `systemsTraceAuditNumber`, `retrievalReferenceNumber`, `localTransactionDateTime`, `acquiringBin`, `acquirerCountryCode`, `businessApplicationId` (person-to-person), `transactionCurrencyCode`, `amount`, `recipientPrimaryAccountNumber`, sender fields, `cardAcceptor`, …);
- the response fields (`actionCode`, `approvalCode`, `transactionIdentifier`, …);
- the Foreign Exchange Rates API endpoint + fields.

If a doc page is unreachable, build from the best-confirmed info, mark the unverified fields with `// VERIFY:` comments, and list them in your report.

### R2 Implementation (node `https`, no new dependency)
- Read the cert/key/CA from the configured paths once (lazily). A missing file → a clear `error` and no crash.
- Extra settings, read via `process.env` in this module and documented in the header:
  - `VISA_BASE_URL` (default: the sandbox URL);
  - `VISA_ACQUIRING_BIN`, `VISA_ACQUIRER_COUNTRY` (sandbox test values from the docs);
  - `VISA_TEST_SENDER_PAN`, `VISA_TEST_RECIPIENT_PAN` (the sandbox **test** card numbers from Visa's docs; they live in `.env`, **never in code**).
  Our `FamilyMember` has no card data (types are frozen); for the demo every member maps to these test PANs. Say so in the header.
- `quote()`:
  - sandbox → call the FX API;
  - on any failure or in mock mode → the existing demo rate table;
  - add optional `source: "visa" | "demo"` to `Quote`.
- `sendGift()`:
  - sandbox → FX quote, then the push funds call;
  - generate a unique STAN/RRN per call;
  - set `localTransactionDateTime` in the required format;
  - map the response to `GiftResult`, adding optional `approvalCode`, `actionCode` and `raw?` (debug only).
  - **Never throws.**
- Map common `actionCode`s and HTTP errors to short plain-English `error` text (declined, invalid card, insufficient funds, sandbox auth failed, timeout).
- 15 s timeout. Log one line per call without secrets or full PANs (mask to the last 4 digits).
- Keep `formatMoney` and the mock path behaviour identical.

## Verification (no credentials exist)
- In `scratch/`, generate a throwaway CA, server cert and client cert with `openssl`. Run a local **HTTPS server that requires a client certificate** and Basic auth and mimics the push funds + FX endpoints (canned approve / decline / 401 responses).
- `src/payments/visa.selftest.ts` (env-driven: base URL, cert paths) asserts:
  - mTLS + Basic auth are sent;
  - the request body has the required fields, with a unique STAN per call;
  - approve → `ok: true` with `amountReceived` from the FX quote;
  - decline → `ok: false` with a friendly error;
  - 401 → "sandbox auth failed";
  - server down → timeout/connection error without throwing;
  - mock mode makes no network call.
- `npx tsc --noEmit`, `npm run sim:demo`, `npm run sim:u2` pass with no Visa env set.

## Out of scope
`flow.ts` (another agent owns it). Real card numbers of any kind.
