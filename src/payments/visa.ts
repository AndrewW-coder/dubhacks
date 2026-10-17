// Cross-border gifts with Visa Direct (sandbox only, never real accounts). Owned by User 2.
//
// VISA_MODE=mock returns a fake successful transfer so the demo never depends on
// sandbox access; VISA_MODE=sandbox calls Visa Direct with mutual TLS.

import { config } from "../config.js";
import type { FamilyMember } from "../types.js";

export interface GiftResult {
  ok: boolean;
  amountSent: number;
  sentCurrency: string;
  amountReceived: number;
  receivedCurrency: string;
  transactionId?: string;
  error?: string;
}

export async function sendGift(
  from: FamilyMember,
  to: FamilyMember,
  amount: number,
  currency: string,
): Promise<GiftResult> {
  if (config.visaMode === "mock") {
    // TODO [U2] use a real (or hard-coded demo) exchange rate
    return { ok: true, amountSent: amount, sentCurrency: currency, amountReceived: amount, receivedCurrency: to.currency ?? currency, transactionId: `mock-${Date.now()}` };
  }
  // TODO [U2] Visa Direct sandbox: Foreign Exchange Rates API for the quote, then a
  // Push Funds Transaction (OCT) with the cert/key in VISA_CERT_PATH / VISA_KEY_PATH.
  throw new Error("Visa sandbox not implemented");
}
