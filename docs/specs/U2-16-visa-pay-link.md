# Spec U2-16: Pay with a real Visa checkout link (Visa track)

Owner: reallyrealistic (User 2). Files: `src/payments/visaAcceptance.ts` (new), `src/payments/visaAcceptance.selftest.ts` (new), `src/shop/checkout.ts` (`SHOP_MODE=paylink`), one wording branch in `src/shop/shopFlow.ts` (`winnerSentence`), `.env.example` (U2 shopping section), `docs/DEVPOST.md`. No U1 files.

## Why
The Visa track ("Reimagine Shopping") scores track fit at 30%. Until now checkout was mock, so no Visa technology ran in the shopping demo. This puts a real Visa payment step into the flow while keeping the core rule: **nothing is bought unless the buyer explicitly agrees**, and here that agreement is paying on Visa's own page.

## Flow
1. The family votes; the buyer is chosen as before (`shopFlow.ts`).
2. `checkout()` validates the price and runs the scam check exactly as before (a guard must OK gift cards for elders, etc.).
3. `SHOP_MODE=paylink`: instead of the "❤️ or yes" question, Bridge creates a **Visa Acceptance invoice** for the exact item and price (`POST /invoicing/v2/invoices`, `deliveryMode: "none"`, `sendImmediately: true`, no partial payments; not itemized and no customer details, since Visa requires an email for itemized invoices; the product is named in the description) and texts the buyer:
   ```
   💳 B · Big-Digit Upper Arm Blood Pressure Monitor · $39.98 for Nai Nai · Golden Years Health Co.
   To buy it, pay on Visa's secure checkout page below and I'll order it as soon as it's paid. Reply "no" to cancel. Visa test mode: use a test card, no real money.
   https://businesscentertest.cybersource.com/ebc2/invoicing/payInvoice/…
   ```
   The details line is never translated; the sentence is in the buyer's language; the link is alone on the last line (iMessage preview).
4. Bridge polls `GET /invoicing/v2/invoices/{id}` every `PAYLINK_POLL_MS` (4 s):
   - `PAID` → `OrderResult { ok, orderId: "visa-inv-<id>", charged, eta }` → `trackOrder` tells everyone.
   - `CANCELED` → nothing bought.
   - "no" / 👎 on the link, or `PAYLINK_TIMEOUT_MS` (10 min) passes → `POST …/cancelation`, then one last status check: if it was paid in the meantime, it's still an order (a paid link is never reported as not bought).
   - The cancel is retried 3 times. If Visa never confirms the link is closed → `maybeCharged: true` ("please don't pay it, and check before trying again"), never "nothing was charged".
   - If the link can't be sent to the buyer (an error after the invoice exists), the invoice is canceled straight away.
5. The invoice is always in **USD** (sandbox merchants are normally USD-only); a buyer with another currency also sees "≈ NT$…".
6. Only "no" (as a reply to the link, or a bare "no"/"cancel"/"不") or 👎 answer the link message; anything else the buyer writes is relayed as normal chat. "yes" or ❤️ don't buy (only paying does). The buyer's money slot is held while the link is open.

## Safety
- **Sandbox only.** Requests go only to `apitest.cybersource.com` / `apitest.visaacceptance.com` over HTTPS (or a local fake server, only when the selftest sets `VISA_ACCEPTANCE_ALLOW_LOCAL=1`). Any other host, including production `api.cybersource.com`, is refused. Sandbox payments use Visa's published test cards; no real money moves.
- Bridge never sees card numbers: the buyer types them on Visa's page.
- Credentials (`VISA_ACCEPTANCE_MERCHANT_ID`, `_KEY_ID`, `_SECRET_KEY`) live only in `.env`; they are never logged.
- Auth: Cybersource HTTP Signature (HMAC-SHA256 over `host date request-target digest v-c-merchant-id`, base64 secret).

## Why invoices, not Pay by Link
Pay by Link reports a payment only through a webhook, which needs a public HTTPS server. An invoice also gives a hosted Visa payment page, and its status can be polled from a laptop.

## Setup (User 2)
1. Free sandbox: developer.cybersource.com → create a sandbox account.
2. Business Center test (`businesscentertest.cybersource.com`) → Payment Configuration → Key Management → generate a **REST Shared Secret** key. Copy the key ID and the secret.
3. `.env`: `SHOP_MODE=paylink`, `VISA_ACCEPTANCE_MERCHANT_ID`, `VISA_ACCEPTANCE_KEY_ID`, `VISA_ACCEPTANCE_SECRET_KEY`. If invoices aren't enabled for the sandbox merchant, enable Invoicing in Business Center (or ask the Visa team).
4. Pay with a Visa test card, e.g. `4111 1111 1111 1111`, any future expiry, any CVV.
5. Demo backup: `SHOP_MODE=mock` (no network, same story).

## Acceptance
- `npx tsc --noEmit`; all selftests (incl. `visaAcceptance.selftest.ts`, 50 checks: signature verified by the fake server, request body, paid / no / 👎 / timeout / paid-at-the-last-second / create error / status blips / cancel failure / production host refused / no credentials / scam guard first / whole story from Nai Nai's message to the confirmation); all four sim scripts in mock mode.
- Live: one real sandbox invoice created, paid with a test card, and reported as ordered.

## Independent review (applied)
A separate reviewer found no way for real money to move and no order reported without PAID. Fixed from its findings: cancel retries + `maybeCharged` when a link can't be closed; cancel the invoice if the link can't be sent; "reply no to this message or 👎 it" wording; USD invoices; local test server only with `VISA_ACCEPTANCE_ALLOW_LOCAL=1`.

## Live sandbox run (Sun 18 Oct)
Against `apitest.cybersource.com` with the team's sandbox merchant: signature accepted; create → CREATED with a real `ebc2test.cybersource.com` checkout link; status read; cancel → CANCELED. Two fixes came out of it: `Accept: application/json` (the API answers 406 to `application/hal+json`), and no line items (itemized invoices require a customer email).
