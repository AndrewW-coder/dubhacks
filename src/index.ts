// Entry point: listens for iMessages through Photon and hands them to the relay.

import { onMessage } from "./photon/client.js";
import { handleIncoming } from "./relay/router.js";

async function main() {
  console.log("Bridge starting…");
  onMessage(async (message) => {
    try {
      await handleIncoming(message);
    } catch (err) {
      console.error("Failed to handle message", message.id, err);
    }
  });
}

main();
