// Telegram bridge — drive Jarvis by text (and voice notes as text) from your
// phone anywhere. Long-polls @wandileos_bot and pipes messages to the local
// brain (/api/agent), streaming the reply back. No public webhook needed.
//
//   TELEGRAM_BOT_TOKEN=... [TELEGRAM_CHAT_ID=...] [JARVIS_URL=http://localhost:3000] \
//     node scripts/telegram.mjs

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ONLY_CHAT = process.env.TELEGRAM_CHAT_ID; // optional allowlist
const BASE = process.env.JARVIS_URL || "http://localhost:3000";
const JARVIS_TOKEN = process.env.JARVIS_TOKEN; // needed only if JARVIS_URL is remote
// Personalize Jarvis over Telegram (same profile the Eye passes).
const PROFILE = {
  ...(process.env.JARVIS_NAME ? { name: process.env.JARVIS_NAME } : {}),
  ...(process.env.JARVIS_NOTES ? { notes: process.env.JARVIS_NOTES } : {}),
};

const brainHeaders = () => ({
  "content-type": "application/json",
  ...(JARVIS_TOKEN ? { authorization: `Bearer ${JARVIS_TOKEN}` } : {}),
});

if (!TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const api = (m, body) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const send = (chat, text) => api("sendMessage", { chat_id: chat, text });

// Per-chat conversation history so Jarvis has context on Telegram too.
const histories = new Map();

async function ask(chat, userText) {
  const history = histories.get(chat) || [];
  history.push({ role: "user", content: userText });

  const res = await fetch(`${BASE}/api/agent`, {
    method: "POST",
    headers: brainHeaders(),
    body: JSON.stringify({ messages: history, profile: PROFILE }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const p of parts) {
      const line = p.replace(/^data: /, "").trim();
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === "text") full += ev.delta;
      else if (ev.type === "confirm") {
        // Inline Approve/Deny — the held /api/agent stream resumes when the
        // user taps (handled by the callback_query branch in the poll loop).
        await api("sendMessage", {
          chat_id: chat,
          text: `Confirm: ${ev.reason}`,
          reply_markup: {
            inline_keyboard: [[
              { text: "Approve", callback_data: `ok:${ev.id}` },
              { text: "Deny", callback_data: `no:${ev.id}` },
            ]],
          },
        });
      } else if (ev.type === "final") histories.set(chat, ev.messages);
      else if (ev.type === "error") full += `\n(error: ${ev.message})`;
    }
  }
  if (full.trim()) await send(chat, full.trim());
}

let offset = 0;
console.log(`Jarvis Telegram bridge running against ${BASE}`);
for (;;) {
  try {
    const { result } = await api("getUpdates", { offset, timeout: 50 });
    for (const u of result || []) {
      offset = u.update_id + 1;

      // Inline Approve/Deny taps resolve a held confirmation.
      if (u.callback_query) {
        const cq = u.callback_query;
        const [act, id] = String(cq.data || "").split(":");
        const approved = act === "ok";
        await fetch(`${BASE}/api/confirm`, {
          method: "POST",
          headers: brainHeaders(),
          body: JSON.stringify({ id, approved }),
        }).catch(() => {});
        await api("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: approved ? "Approved" : "Denied",
        });
        if (cq.message)
          await api("editMessageText", {
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: `${approved ? "Approved" : "Denied"}: ${cq.message.text.replace(/^Confirm: /, "")}`,
          });
        continue;
      }

      const msg = u.message;
      const text = msg?.text;
      const chat = msg?.chat?.id;
      if (!text || !chat) continue;
      if (ONLY_CHAT && String(chat) !== String(ONLY_CHAT)) continue;
      console.log(`> ${text}`);
      ask(chat, text).catch((e) => send(chat, "Error: " + e.message));
    }
  } catch (e) {
    console.error("poll error", e.message);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
