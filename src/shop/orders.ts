// Order updates after a family purchase. Owned by User 1 (docs/specs/VISA-SHOPPING.md).
// Used by the shopping flow through src/shop/u1.ts.
//
// 1. Right away, to everyone in their own language:
//      "✅ Kevin ordered a new blood pressure monitor for Nai Nai, arriving Thursday, October 22."
//      (a gift occasion: "✅ Kevin bought Nai Nai a gift 🎁, …"). The buyer also sees the price
//      and order number. Product names come from the catalog in the reader's language.
// 2. Simulated "shipped" and "delivered" updates, as threaded replies to that confirmation,
//    for the buyer and the person it's for. On delivery, the recipient is invited to send a
//    photo of the manual (media/image.ts explains it in their language).
//
// Settings (optional, read here): SHOP_SHIP_DELAY_MS (default 20000) and SHOP_DELIVER_DELAY_MS
// (default 40000), both counted from the confirmation, so the demo shows the whole story.

import { sendText } from "../photon/client.js";
import { say } from "../relay/say.js";
import { formatMoney } from "../payments/visa.js";
import type { Family, FamilyMember } from "../types.js";
import type { Product } from "./catalog.js";
import type { OrderResult } from "./checkout.js";
import type { OrderInfo } from "./u1.js";

const delay = (key: string, fallback: number) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function trackOrder(
  family: Family,
  buyer: FamilyMember,
  forMember: FamilyMember,
  product: Product,
  order: OrderResult,
  info: OrderInfo = {},
): void {
  if (!order.ok) return; // checkout already told the buyer what went wrong
  void run(family, buyer, forMember, product, order, info).catch((err) => console.error("[orders] update failed", err));
}

async function run(family: Family, buyer: FamilyMember, forMember: FamilyMember, product: Product, order: OrderResult, info: OrderInfo) {
  const day = order.eta ? weekday(order.eta) : undefined;
  const arriving = day ? `, arriving ${day}` : "";
  const thing = (info.what ?? "").replace(/^(a|an|the|some)\s+/i, "").trim();
  // `info` comes from shop/u1.ts; without it, say "placed an order" (the product name follows anyway).
  const ordered = thing && !/^something\b/i.test(thing) ? `ordered a new ${thing} for` : "placed an order for";

  // 1. Confirmation to everyone. Remember each thread's confirmation so updates thread under it.
  const confirmations = new Map<string, string>(); // member id → confirmation message ID
  await Promise.all(
    family.members.map(async (reader) => {
      const who = reader.id === buyer.id ? "You" : buyer.name;
      const to = reader.id === forMember.id ? "you" : forMember.name;
      const sentence = info.isGift ? `${who} bought ${to} a gift 🎁${arriving}.` : `${who} ${ordered} ${to}${arriving}.`;
      const paid = reader.id === buyer.id && order.charged ? ` · ${formatMoney(order.charged.amount, order.charged.currency)}` : "";
      const ref = reader.id === buyer.id && order.orderId ? ` · #${order.orderId}` : "";
      const id = await sendText(reader.handle, `✅ ${await say(family, reader, sentence)}\n🛍️ ${nameFor(product, reader)}${paid}${ref}`);
      confirmations.set(reader.id, id);
    }),
  );

  // 2. Simulated shipping, for the two people who care: the buyer and the recipient.
  const followers = forMember.id === buyer.id ? [buyer] : [buyer, forMember];
  const update = (reader: FamilyMember, text: string) =>
    say(family, reader, text)
      .then((t) => sendText(reader.handle, t, { replyToId: confirmations.get(reader.id) }))
      .catch((err) => console.error("[orders] update failed for", reader.id, err));

  later(delay("SHOP_SHIP_DELAY_MS", 20_000), () => {
    for (const reader of followers) void update(reader, `📦 Shipped: it's on its way to ${reader.id === forMember.id ? "you" : forMember.name}.`);
  });
  later(delay("SHOP_DELIVER_DELAY_MS", 40_000), () => {
    for (const reader of followers) {
      const text =
        reader.id === forMember.id
          ? "🏠 It arrived! Send me a photo of the manual or the box if you'd like help using it."
          : `🏠 Delivered to ${forMember.name}.`;
      void update(reader, text);
    }
  });
}

/** Product name in the reader's language, falling back to English, then the ID. Never translated by AI. */
function nameFor(product: Product, reader: FamilyMember): string {
  return product.name[reader.language] ?? product.name[reader.language.split("-")[0]!] ?? product.name.en ?? product.id;
}

function later(ms: number, fn: () => void) {
  setTimeout(fn, ms).unref?.(); // don't keep the simulator or tests alive just for these
}

function weekday(iso: string): string | undefined {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
