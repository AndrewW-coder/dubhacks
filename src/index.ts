// Entry point: listens for iMessages and hands them to the relay. Owned by User 1.

import { config } from "./config.js";
import { onMessage } from "./photon/client.js";
import { handleIncoming } from "./relay/router.js";
import { tryResolvePrompt } from "./relay/prompts.js";
import { isEmergency } from "./translate/confidence.js";
import type { IncomingMessage } from "./types.js";

// One queue per sender: each person's messages are relayed in the order they sent them,
// while different people's messages are handled in parallel.
const queues = new Map<string, Promise<void>>();

function enqueue(msg: IncomingMessage): Promise<void> {
  const next = (queues.get(msg.fromHandle) ?? Promise.resolve())
    .then(() => handleIncoming(msg))
    .catch((err) => console.error("Failed to handle message", msg.id, err));
  queues.set(msg.fromHandle, next);
  return next;
}

async function main() {
  console.log(`Bridge starting (PHOTON_MODE=${config.photonMode})…`);
  await onMessage(async (msg) => {
    if (config.photonMode === "live") console.log(`[in] ${msg.kind} from ${msg.fromHandle} (${msg.id})`);
    // Answers to Bridge's own questions are handled immediately, never queued or relayed.
    // (Queuing them could deadlock: a sender's queue may be waiting on exactly this answer.)
    if (tryResolvePrompt(msg)) return;
    // Emergencies jump the queue: they must never wait behind a message that is waiting for a reviewer.
    if (msg.kind === "text" && isEmergency(msg.text ?? "")) {
      return handleIncoming(msg).catch((err) => console.error("Failed to handle emergency", msg.id, err));
    }
    return enqueue(msg);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
