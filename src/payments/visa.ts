// Cross-border gifts with Visa Direct (sandbox only, never real accounts).

import type { FamilyMember } from "../types.js";

export interface GiftResult {
  ok: boolean;
  amountSent: number;
  sentCurrency: string;
  amountReceived: number;
  receivedCurrency: string;
  error?: string;
}

export async function sendGift(
  from: FamilyMember,
  to: FamilyMember,
  amount: number,
  currency: string,
): Promise<GiftResult> {
  // TODO: Visa Direct sandbox push payment + currency conversion
  throw new Error("not implemented");
}
