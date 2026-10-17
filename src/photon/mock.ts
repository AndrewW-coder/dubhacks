// Terminal simulator: pretend to be any family member and watch what Bridge
// sends to everyone's phone. Lets BOTH people build and test without the
// shared Photon line (only one process can listen on that line at a time).
// Owned by User 1.
//
//   npm run sim                         interactive
//   npm run sim -- data/demo-script.txt run a script, one command per line
//
// Commands (type /help):
//   nainai: 你吃饭了吗?                   send a text as member "nainai"
//   kevin: reply b3 yes I ate!          threaded reply to message b3
//   kevin: tapback b3 love              tapback (love|like|dislike|laugh|emphasize|question)
//   kevin: untapback b3 love            remove a tapback
//   nainai: edit u1 新的文字               edit your own message u1
//   nainai: unsend u1                   unsend your own message u1
//   nainai: voice ./samples/note.m4a    send a voice note (any local audio file)
//   nainai: image ./samples/label.jpg   send a photo
//   /wait 500                           pause (useful in scripts)
//
// IDs: "u7" = a message a member sent; "b8" = a message Bridge sent.

import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { getAllMembers } from "../db/store.js";
import type { FamilyMember, IncomingMessage, TapbackKind } from "../types.js";
import type { MessagingPort } from "./port.js";

const TAPBACKS = ["love", "like", "dislike", "laugh", "emphasize", "question"];
const ICON: Record<string, string> = { love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓" };

export class MockPhotonClient implements MessagingPort {
  private seqs: Record<string, number> = { u: 0, b: 0 };
  private handler?: (m: IncomingMessage) => Promise<void>;

  private nameOf(handle: string) {
    return getAllMembers().find((m) => m.handle === handle)?.name ?? handle;
  }
  private out(handle: string, line: string) {
    console.log(`  📱 ${this.nameOf(handle).padEnd(10)} │ ${line}`);
  }

  async start(handler: (m: IncomingMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
    const members = getAllMembers();
    console.log("[photon] MOCK mode — you are typing as family members. /help for commands.");
    console.log("Members: " + members.map((m) => `${m.id} (${m.name}, ${m.language})`).join(", "));

    const scriptPath = process.argv[2];
    if (scriptPath) {
      const lines = (await readFile(scriptPath, "utf8")).split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim() || line.trim().startsWith("#")) continue;
        console.log(`\n» ${line}`);
        await this.command(line, members, true);
      }
      console.log("\n[sim] script finished");
      setTimeout(() => process.exit(0), 300);
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
    rl.prompt();
    rl.on("line", async (line) => {
      await this.command(line, members, false);
      rl.prompt();
    });
  }

  private async command(line: string, members: FamilyMember[], scripted: boolean) {
    const trimmed = line.trim();
    if (trimmed === "/help") return console.log(HELP);
    const wait = trimmed.match(/^\/wait\s+(\d+)/);
    if (wait) return new Promise((r) => setTimeout(r, Number(wait[1])));

    const m = trimmed.match(/^(\w+):\s*(.*)$/s);
    const member = m && members.find((x) => x.id === m[1]);
    if (!m || !member) return console.log(`  ? start with a member id, e.g. "${members[0]?.id}: hello"`);
    const body = m[2];
    const base = { fromHandle: member.handle, receivedAt: new Date() };
    let msg: IncomingMessage;

    const [verb, arg1, ...rest] = body.split(/\s+/);
    const restText = body.split(/\s+/).slice(2).join(" ");
    if (verb === "reply" && arg1) {
      msg = { ...base, id: this.newId("u"), kind: "text", text: restText, replyToId: arg1 };
    } else if ((verb === "tapback" || verb === "untapback") && arg1 && TAPBACKS.includes(rest[0] ?? "")) {
      msg = { ...base, id: arg1, kind: "tapback", tapback: rest[0] as TapbackKind, tapbackRemoved: verb === "untapback" };
    } else if (verb === "edit" && arg1) {
      msg = { ...base, id: arg1, kind: "edit", text: restText };
    } else if (verb === "unsend" && arg1) {
      msg = { ...base, id: arg1, kind: "unsend" };
    } else if ((verb === "voice" || verb === "image") && arg1) {
      const path = resolve(arg1);
      const mimeType = verb === "voice" ? "audio/x-m4a" : "image/jpeg";
      msg = { ...base, id: this.newId("u"), kind: verb, attachment: { id: path, fileName: basename(path), mimeType } };
    } else {
      msg = { ...base, id: this.newId("u"), kind: "text", text: body };
    }
    if (msg.kind === "text" || msg.kind === "voice" || msg.kind === "image") {
      console.log(`  ✉️  ${member.name} sent #${msg.id}`);
    }

    const work = this.handler!(msg);
    // In scripts, don't block forever on a message that is waiting for a reviewer's answer
    // (the answer is probably a later line of the script).
    await (scripted ? Promise.race([work, new Promise((r) => setTimeout(r, 1500))]) : work);
  }

  private newId(prefix: string) {
    return `${prefix}${++this.seqs[prefix]!}`;
  }

  // ── Port implementation: print what each phone would show ────────────────

  async sendText(toHandle: string, text: string, opts?: { replyToId?: string }) {
    const id = this.newId("b");
    const reply = opts?.replyToId ? ` ↪ (reply to #${opts.replyToId})` : "";
    this.out(toHandle, `#${id}${reply}  ${text.replace(/\n/g, "\n" + " ".repeat(16) + "│ ")}`);
    return id;
  }
  async sendTapback(toHandle: string, messageId: string, tapback: TapbackKind, remove = false) {
    this.out(toHandle, `${remove ? "removed " : ""}${ICON[tapback]} on #${messageId}`);
  }
  async editMessage(toHandle: string, messageId: string, newText: string) {
    this.out(toHandle, `✏️  #${messageId} edited → ${newText}`);
  }
  async unsendMessage(toHandle: string, messageId: string) {
    this.out(toHandle, `🗑  #${messageId} unsent`);
  }
  async sendFile(toHandle: string, filePath: string, opts?: { replyToId?: string; asVoiceNote?: boolean }) {
    const id = this.newId("b");
    this.out(toHandle, `#${id}  ${opts?.asVoiceNote ? "🎤" : "📎"} ${basename(filePath)}`);
    return id;
  }
  async downloadAttachment(attachmentId: string) {
    return attachmentId; // mock attachment IDs are already local paths
  }
  async setTyping() {}
}

const HELP = `
  <member>: <text>                 send a text
  <member>: reply <id> <text>      threaded reply
  <member>: tapback <id> <kind>    love | like | dislike | laugh | emphasize | question
  <member>: untapback <id> <kind>
  <member>: edit <id> <new text>
  <member>: unsend <id>
  <member>: voice <path>           voice note from a local audio file
  <member>: image <path>           photo from a local image file
  /wait <ms>
  Tip: include "🧪" in a text to force a low-confidence translation (tests the review flow).`;
