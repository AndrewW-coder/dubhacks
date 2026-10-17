// Photon connection test (User 1, step 1). Sends one message, then prints every
// raw event for 2 minutes so you can see the exact payloads Photon delivers.
//
//   npm run photon:smoke -- +15551234567
//
// While it runs, from that phone: reply, add a tapback, edit and unsend a
// message, and send a photo and a voice note. Check that each one shows up and
// that src/photon/live.ts reads the right fields.

import "dotenv/config";
import { createClient } from "@photon-ai/advanced-imessage/grpc";

const to = process.argv[2];
const { IMESSAGE_ADDRESS, IMESSAGE_TOKEN, IMESSAGE_TLS } = process.env;
if (!to || !IMESSAGE_ADDRESS || !IMESSAGE_TOKEN) {
  console.error("Usage: npm run photon:smoke -- <phone or Apple ID>   (needs IMESSAGE_ADDRESS and IMESSAGE_TOKEN in .env)");
  process.exit(1);
}

const im = createClient({ address: IMESSAGE_ADDRESS, token: IMESSAGE_TOKEN, tls: IMESSAGE_TLS !== "false" });

console.log("iMessage available:", await im.addresses.isIMessageAvailable(to).catch((e) => `error: ${e}`));
const { chat } = await im.chats.create([to]);
console.log("chat guid:", chat.guid);
const sent = await im.messages.sendText(chat.guid, "👋 Bridge smoke test. Reply, tapback, edit, and unsend to test events.");
console.log("sent:", sent.guid);

setTimeout(async () => {
  await im.close();
  process.exit(0);
}, 120_000);

for await (const event of im.messages.subscribeEvents()) {
  console.log("\n──", event.type, "seq", event.sequence);
  console.dir(event, { depth: 6 });
}
