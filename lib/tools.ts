// Jarvis's hands — local tools that execute on the Mac.
// Each tool has an Anthropic tool schema plus a local executor. Risky/outward
// actions are flagged by `needsConfirm` so the agent loop can gate them.

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

// ---- helpers ---------------------------------------------------------------

function run(
  cmd: string,
  args: string[],
  input?: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, out: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = (out || err).trim();
      resolve({ ok: code === 0, out: text || `(exit ${code})` });
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

const osa = (script: string) => run("osascript", ["-"], script);

// ---- tool schemas ----------------------------------------------------------

export const tools: ToolDef[] = [
  {
    name: "run_shell",
    description:
      "Run a shell command on the user's Mac and return stdout/stderr. Use for system queries (battery, disk, processes), file operations, launching CLIs, git, etc. Destructive commands require user confirmation automatically.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
        reason: { type: "string", description: "One short phrase on why" },
      },
      required: ["command"],
    },
  },
  {
    name: "applescript",
    description:
      "Run an AppleScript to control Mac apps (Mail, Calendar, Notes, Music, Finder, System Events UI scripting, Reminders, Messages). Powerful — use for anything without a simpler tool.",
    input_schema: {
      type: "object",
      properties: {
        script: { type: "string", description: "The AppleScript source" },
        reason: { type: "string", description: "One short phrase on why" },
      },
      required: ["script"],
    },
  },
  {
    name: "say",
    description:
      "Speak text aloud on the Mac's speakers using the macOS voice. Use for proactive spoken output when the user isn't looking at the screen.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "open_app",
    description: "Open a Mac application by name (e.g. 'Safari', 'Spotify').",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "open_url",
    description: "Open a URL in the default browser.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "get_calendar",
    description:
      "Read upcoming events from the Mac Calendar app for the next N days (default 1).",
    input_schema: {
      type: "object",
      properties: { days: { type: "integer", description: "How many days ahead" } },
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Create an event in the Mac Calendar. Requires user confirmation.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO datetime" },
        minutes: { type: "integer", description: "Duration in minutes (default 60)" },
      },
      required: ["title", "start"],
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from disk (first 40k chars).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List the entries in a directory.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "clipboard_get",
    description: "Get the current clipboard text contents.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "clipboard_set",
    description: "Set the clipboard to the given text.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "system_info",
    description:
      "Get a quick snapshot of the Mac: battery, memory, disk, uptime, current app.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "telegram_notify",
    description:
      "Send yourself a Telegram message via the wandileos bot (to your own chat).",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

// ---- confirmation policy ---------------------------------------------------

const SHELL_DANGER =
  /(\brm\b|\brmdir\b|\bmv\b|\bdd\b|mkfs|shutdown|reboot|\bkill\b|pkill|killall|\bsudo\b|chmod|chown|git\s+push|npm\s+publish|yarn\s+publish|vercel|launchctl|defaults\s+write|diskutil|>\s|>>|\bcurl\b.*-X\s*(POST|PUT|DELETE|PATCH)|\bformat\b|trash|--force|-f\b)/i;
const OSA_DANGER = /(delete|remove|\bsend\b|quit\b|trash|empty|shut down|restart|log ?out|make new outgoing message)/i;

export function needsConfirm(
  tool: string,
  input: Record<string, unknown>,
): { confirm: boolean; reason: string } {
  if (tool === "run_shell") {
    const cmd = String(input.command ?? "");
    if (SHELL_DANGER.test(cmd))
      return { confirm: true, reason: `Run shell: ${cmd}` };
  }
  if (tool === "applescript") {
    const s = String(input.script ?? "");
    if (OSA_DANGER.test(s))
      return { confirm: true, reason: "Run an AppleScript that changes or sends something" };
  }
  if (tool === "create_calendar_event") {
    return { confirm: true, reason: `Create event: ${input.title}` };
  }
  return { confirm: false, reason: "" };
}

// ---- executor --------------------------------------------------------------

export async function execTool(
  tool: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    switch (tool) {
      case "run_shell":
        return (await run("/bin/zsh", ["-lc", String(input.command)])).out;
      case "applescript":
        return (await osa(String(input.script))).out;
      case "say":
        return (await run("say", [String(input.text)])).ok ? "spoke" : "failed";
      case "open_app":
        return (await run("open", ["-a", String(input.name)])).out || "opened";
      case "open_url":
        return (await run("open", [String(input.url)])).out || "opened";
      case "get_calendar": {
        const days = Number(input.days ?? 1);
        const script = `
set output to ""
set now to current date
set later to now + (${days} * days)
tell application "Calendar"
  repeat with c in calendars
    repeat with e in (every event of c whose start date ≥ now and start date ≤ later)
      set output to output & (summary of e) & " — " & (start date of e as string) & linefeed
    end repeat
  end repeat
end tell
return output`;
        const r = await osa(script);
        return r.out || "No upcoming events.";
      }
      case "create_calendar_event": {
        const mins = Number(input.minutes ?? 60);
        const start = new Date(String(input.start));
        const asAppleDate = (d: Date) =>
          `date "${d.toLocaleString("en-US")}"`;
        const end = new Date(start.getTime() + mins * 60000);
        const script = `tell application "Calendar"
  tell calendar 1
    make new event with properties {summary:"${String(input.title).replace(/"/g, "'")}", start date:${asAppleDate(start)}, end date:${asAppleDate(end)}}
  end tell
end tell
return "created"`;
        return (await osa(script)).out;
      }
      case "read_file": {
        const buf = await readFile(String(input.path), "utf8");
        return buf.slice(0, 40_000);
      }
      case "list_dir": {
        const entries = await readdir(String(input.path), { withFileTypes: true });
        return entries
          .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
          .join("\n");
      }
      case "clipboard_get":
        return (await run("pbpaste", [])).out;
      case "clipboard_set":
        await run("pbcopy", [], String(input.text));
        return "clipboard set";
      case "system_info": {
        const r = await run("/bin/zsh", [
          "-lc",
          "echo BATTERY: $(pmset -g batt | tail -1); echo UPTIME: $(uptime); echo DISK: $(df -h / | tail -1); echo MEM: $(vm_stat | head -4 | tr '\\n' ' ')",
        ]);
        return r.out;
      }
      case "telegram_notify": {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chat = process.env.TELEGRAM_CHAT_ID;
        if (!token || !chat) return "Telegram not configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).";
        const res = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chat, text: String(input.text) }),
          },
        );
        return res.ok ? "sent" : `telegram error ${res.status}`;
      }
      default:
        return `Unknown tool: ${tool}`;
    }
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
