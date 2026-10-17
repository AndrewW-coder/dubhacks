// Photon connection test (User 1, step 1), using the same live client the app runs.
//
//   npm run photon:smoke -- +15551234567   (or no number: it waits for your first text)
//
// It messages that phone, then for 3 minutes (from the first message) prints every event Bridge would see
// and answers so you can check both directions:
//   • text      → ❤️ tapback on your message + a threaded reply "got: …"
//   • photo/voice → downloaded to .bridge-tmp/
//   • tapback, untapback, edit, unsend → logged (that's what the relay mirrors)
// It also edits its greeting after 15 s and sends + unsends a test message,
// to check outbound edit/unsend. Add PHOTON_DEBUG=1 to see raw payloads too.
//
// The shared line only talks to phones added on the dashboard's Users page,
// and that phone must have texted the line at least once.

import { LivePhotonClient } from "./live.js";

process.on("exit", (code) => console.log(`[smoke] exiting with code ${code}`));
process.on("uncaughtException", (err) => console.error("[smoke] uncaught exception", err));
process.on("unhandledRejection", (err) => console.error("[smoke] unhandled rejection", err));

let to = process.argv[2];
const im = new LivePhotonClient();
let outboundChecksStarted = false;

await im.start(async (msg) => {
  if (!to) to = msg.fromHandle;
  if (!outboundChecksStarted) void outboundChecks();
  console.log(`\n── ${msg.kind}`, { id: msg.id, from: msg.fromHandle, text: msg.text, replyTo: msg.replyToId, tapback: msg.tapback, removed: msg.tapbackRemoved, attachment: msg.attachment });
  if (msg.kind === "text") {
    await im.sendTapback(msg.fromHandle, msg.id, "love");
    console.log("   ❤️ sent on", msg.id);
    console.log("   replied:", await im.sendText(msg.fromHandle, `got: ${msg.text}`, { replyToId: msg.id }));
  }
  if (msg.attachment) {
    console.log("   downloaded to", await im.downloadAttachment(msg.attachment.id, msg.attachment.fileName));
  }
});

async function outboundChecks() {
  outboundChecksStarted = true;
  setTimeout(() => process.exit(0), 180_000); // 3 minutes from the first message
  console.log("Running for 3 minutes. Try the checklist in docs/PHOTON_SETUP.md §3.");
  const phone = to!;
  const greeting = await im.sendText(phone, "👋 Bridge smoke test. Text me, reply, tapback, edit, unsend, and send a photo and a voice note.");
  console.log("sent greeting:", greeting);
  const temp = await im.sendText(phone, "(this message should disappear in 5 seconds)");
  setTimeout(() => im.unsendMessage(phone, temp).then(() => console.log("unsent test message")).catch((e) => console.error("unsend failed", e)), 5_000);
  setTimeout(() => im.editMessage(phone, greeting, "👋 Bridge smoke test (edited ✏️). Keep going!").then(() => console.log("edited greeting")).catch((e) => console.error("edit failed", e)), 15_000);
}

if (to) await outboundChecks();
else console.log("Listening. Text the Bridge line from your phone to start.");

