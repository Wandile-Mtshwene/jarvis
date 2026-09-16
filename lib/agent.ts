// Jarvis's brain — the agentic loop. Streams text, runs tools locally, and
// pauses for confirmation on risky/outward actions.

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tools, execTool, needsConfirm } from "./tools";
import { createPending } from "./pending";

const MODEL = "claude-sonnet-4-6";

// Cap how much history we send so a long session doesn't balloon cost/latency
// or eventually blow the context window. We keep the most recent messages but
// back up to a real user turn (a plain-string user message, not a tool_result)
// so we never start mid tool_use/tool_result pair, which the API rejects.
const MAX_HISTORY = 24;

function isUserTurnBoundary(m: Msg): boolean {
  return m.role === "user" && typeof m.content === "string";
}

function capHistory(messages: Msg[]): Msg[] {
  if (messages.length <= MAX_HISTORY) return messages;
  let start = messages.length - MAX_HISTORY;
  while (start < messages.length && !isUserTurnBoundary(messages[start])) start++;
  // If no clean boundary was found in the window, keep the last message only if
  // it's a valid start; otherwise fall back to the whole tail we computed.
  if (start >= messages.length) start = messages.length - MAX_HISTORY;
  return messages.slice(start);
}

function buildSystem(profile?: { name?: string; notes?: string }): string {
  const who = profile?.name
    ? `\nThe person you're speaking with is ${profile.name}. Address them by name naturally (not every sentence).`
    : "";
  const notes = profile?.notes ? `\nThings to remember about them: ${profile.notes}` : "";
  return `You are J.A.R.V.I.S, a witty, capable voice-and-text assistant living on the user's Mac.
You can control the machine through tools: shell, AppleScript (Mail/Calendar/Notes/Music/Finder), files, clipboard, and more.

Style:
- You are usually SPOKEN aloud. Keep replies short, natural, and conversational — one or two sentences unless asked for detail. No markdown, no bullet lists, no code fences when speaking.
- Be proactive and decisive. Pick sensible defaults instead of asking clarifying questions for small things.
- Address the user lightly as "sir" or by name occasionally — never obsequious.

Tools:
- Prefer a dedicated tool over shell when one fits (e.g. get_calendar, open_app, system_info).
- Destructive or outward actions (deleting, sending, pushing, paying, creating events) will prompt the user to confirm — just call the tool; the system handles the gate. If denied, acknowledge and stop.
- After doing something, confirm it briefly ("Done — opened Spotify").
Current time: ${new Date().toString()}.${who}${notes}`;
}

export type Msg = Anthropic.MessageParam;

export type AgentEvent =
  | { type: "state"; state: "thinking" | "speaking" }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; status: "running" | "ok" | "denied"; detail?: string }
  | { type: "confirm"; id: string; tool: string; reason: string }
  | { type: "final"; messages: Msg[] }
  | { type: "error"; message: string };

// Read the Claude Code OAuth token that macOS Keychain stores for the user's
// subscription. Claude Code keeps it fresh, so we read it per request.
function keychainToken(): string | null {
  try {
    const out = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8" },
    );
    const j = JSON.parse(out);
    return j?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

// --- Usage guard (subscription/oauth only) --------------------------------
type Usage = { weekly: number; session: number; weeklyReset?: string; sessionReset?: string; locked: boolean };
let usageCache: { at: number; usage: Usage | null } | null = null;
let lastWarnAt = 0;

async function fetchUsage(token: string): Promise<Usage | null> {
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, { utilization?: number; resets_at?: string; locked_reason?: string | null }>;
    return {
      weekly: j.seven_day?.utilization ?? 0,
      session: j.five_hour?.utilization ?? 0,
      weeklyReset: j.seven_day?.resets_at,
      sessionReset: j.five_hour?.resets_at,
      locked: !!(j.seven_day?.locked_reason || j.five_hour?.locked_reason),
    };
  } catch {
    return null;
  }
}

async function getUsage(token: string): Promise<Usage | null> {
  if (usageCache && Date.now() - usageCache.at < 60_000) return usageCache.usage;
  const usage = await fetchUsage(token);
  usageCache = { at: Date.now(), usage };
  return usage;
}

function shortTime(iso?: string): string {
  if (!iso) return "later";
  const d = new Date(iso);
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  return days >= 1 ? `in about ${days} day${days > 1 ? "s" : ""}` : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Prefer a console API key; otherwise fall back to the subscription token.
function makeClient(): { client: Anthropic; oauth: boolean } | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return { client: new Anthropic(), oauth: false };
  }
  const tok = keychainToken();
  if (tok) {
    return {
      client: new Anthropic({
        authToken: tok,
        defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
      }),
      oauth: true,
    };
  }
  return null;
}

export async function* runAgent(
  history: Msg[],
  profile?: { name?: string; notes?: string },
): AsyncGenerator<AgentEvent> {
  const messages: Msg[] = capHistory([...history]);

  const made = makeClient();
  if (!made) {
    yield {
      type: "text",
      delta:
        "My brain isn't connected. Sign into Claude Code (so the subscription token is in your Keychain), or add ANTHROPIC_API_KEY to .env.local, then restart me.",
    };
    yield { type: "final", messages };
    return;
  }
  const { client, oauth } = made;

  // Usage guard: on the subscription path, refuse when the limit is hit and
  // warn (at most every 15 min) when close, so Jarvis doesn't silently burn
  // through the same limits the usage widget tracks.
  if (oauth) {
    const tok = keychainToken();
    const u = tok ? await getUsage(tok) : null;
    if (u) {
      if (u.locked || u.weekly >= 100 || u.session >= 100) {
        const which =
          u.weekly >= 100 || (u.locked && u.weekly >= u.session)
            ? `weekly limit (resets ${shortTime(u.weeklyReset)})`
            : `5-hour limit (resets ${shortTime(u.sessionReset)})`;
        yield { type: "text", delta: `We've reached your Claude ${which}. I can't think until it resets.` };
        yield { type: "final", messages };
        return;
      }
      const hot = Math.max(u.weekly, u.session);
      if (hot >= 90 && Date.now() - lastWarnAt > 15 * 60_000) {
        lastWarnAt = Date.now();
        yield { type: "text", delta: `Heads up — you're at ${Math.round(hot)}% of your Claude limit. ` };
      }
    }
  }

  // The OAuth (subscription) path requires the Claude Code system identifier as
  // the first system block; our real instructions follow it.
  const jarvis = buildSystem(profile);
  const system = oauth
    ? [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: jarvis },
      ]
    : jarvis;

  try {
    for (let turn = 0; turn < 12; turn++) {
      yield { type: "state", state: "thinking" };

      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 4096,
        system,
        tools: tools as Anthropic.Tool[],
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        messages,
      });

      let started = false;
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          if (!started) {
            started = true;
            yield { type: "state", state: "speaking" };
          }
          yield { type: "text", delta: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      messages.push({ role: "assistant", content: final.content });

      if (final.stop_reason !== "tool_use") break;

      const toolUses = final.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of toolUses) {
        const input = (tu.input ?? {}) as Record<string, unknown>;
        const gate = needsConfirm(tu.name, input);

        if (gate.confirm) {
          const id = randomUUID();
          yield { type: "confirm", id, tool: tu.name, reason: gate.reason };
          const approved = await createPending(id, tu.name, input, gate.reason);
          if (!approved) {
            yield { type: "tool", name: tu.name, status: "denied" };
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: "User denied this action. Do not retry it.",
              is_error: true,
            });
            continue;
          }
        }

        yield { type: "tool", name: tu.name, status: "running" };
        const out = await execTool(tu.name, input);
        yield { type: "tool", name: tu.name, status: "ok", detail: out.slice(0, 120) };
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: out || "(no output)",
        });
      }

      messages.push({ role: "user", content: results });
    }

    yield { type: "final", messages };
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
