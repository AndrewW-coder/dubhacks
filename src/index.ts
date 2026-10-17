// Entry point: listens for iMessages and hands them to the relay. Owned by User 1.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Only one Bridge may listen on the live line, or every message is relayed twice.
const LOCK = ".bridge-tmp/live.lock";

async function claimLiveLock() {
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const holder = () => {
    try {
      const pid = Number(readFileSync(LOCK, "utf8"));
      return pid && pid !== process.pid && isAlive(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  };
  // Give a restarting watcher's old process a moment to exit before giving up.
  for (let i = 0; i < 10 && holder(); i++) await new Promise((r) => setTimeout(r, 300));
  const pid = holder();
  if (pid) {
    console.error(`Another Bridge (pid ${pid}) is already listening on the live line. Stop it first, or every message is relayed twice.`);
    process.exit(1);
  }
  mkdirSync(".bridge-tmp", { recursive: true });
  writeFileSync(LOCK, String(process.pid));
  process.on("exit", () => {
    if (holder() === undefined) rmSync(LOCK, { force: true });
  });
}

async function main() {
  console.log(`Bridge starting (PHOTON_MODE=${config.photonMode})…`);
  if (config.photonMode === "live") await claimLiveLock();
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
