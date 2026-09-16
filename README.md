# J.A.R.V.I.S

A voice- and text-controlled assistant that runs on your Mac and can actually
*do* things — shell, AppleScript (Mail/Calendar/Notes/Music/Finder), files,
clipboard, smart home — wrapped in **The Eye**: a futuristic interface of white
light-paths on black with a blue-tint glow that pulses as Jarvis listens,
thinks, and speaks.

- **The Eye** — a Next.js PWA. Runs on your Mac and installs on your iPhone
  home screen (same UI everywhere). Voice via the browser's Web Speech API, or
  type when you'd rather not speak.
- **The Brain** — a local agent loop (`@anthropic-ai/sdk`, `claude-opus-4-8`)
  that interprets commands and calls tools. Runs on your Mac, so its tools act
  on *your* machine.
- **The Hands** — local tools with a safety gate: read/open/query/play run
  automatically; destructive or outward actions (send, delete, push, pay,
  create events) pause for a one-tap confirmation on the Eye.
- **Anywhere** — a Telegram bridge (@wandileos_bot) for quick text from your
  phone, and a Cloudflare tunnel to reach the full Eye from cellular.

## Setup

```bash
cp .env.local.example .env.local     # then add your ANTHROPIC_API_KEY
npm install
npm run dev                          # http://localhost:3000
```

`ANTHROPIC_API_KEY` comes from https://console.anthropic.com (billed via the
console — separate from your Claude subscription). Restart the server after
editing `.env.local`.

On first use, macOS will ask for **Microphone** permission (voice input) and,
the first time Jarvis controls an app, **Automation** permission (AppleScript).
Allow both.

## Run as a local app

```bash
npm run build && npm run app     # builds Jarvis.app in the project root
```

Double-click `Jarvis.app` (or drag it to `/Applications`). It boots the server
itself and opens The Eye as a standalone, chrome-less window with its own Dock
icon — no browser tab, no address bar. It runs on Chrome's engine so the voice
still works. (For an even cleaner Dock icon you can also open it in Chrome and
click **Install** in the address bar to install the PWA.)

## Use it

- **Wake word:** click **Wake word** once to arm always-listening, then just say
  **"Jarvis"** (or *"Jarvis, are you there?"*) — he greets you and listens for
  your command. Or say it all at once: *"Jarvis, what's my battery?"*
- **Push-to-talk / type:** click **Speak** or type a command: *"open Spotify"*,
  *"what's on my calendar today"*, *"put 'ship it' on my clipboard"*,
  *"summarize the file at ~/notes.md"*.
- Risky actions surface an **Approve / Deny** card — nothing destructive runs
  without your tap.

## Phone

- **Telegram:** `TELEGRAM_BOT_TOKEN=... npm run telegram` — then message the bot.
  Risky actions surface inline **Approve / Deny** buttons right in the chat.
- **Full Eye on your phone:** `npm run tunnel` (needs `brew install cloudflared`)
  prints a public `https://…trycloudflare.com` URL. Open it on your iPhone and
  *Add to Home Screen* to install the PWA. Set **`JARVIS_TOKEN`** first (see
  Safety) — the tunnel won't serve the API without it, and the Eye asks you to
  paste it once on first remote load.

## Layout

- `components/Eye.tsx` — the visualization (SVG light-paths + blue bloom, reacts to state).
- `components/Jarvis.tsx` — voice (Web Speech), streaming, state machine, confirm UI.
- `lib/agent.ts` — the streaming agent loop.
- `lib/tools.ts` — tool schemas + local executors + the confirm policy.
- `lib/pending.ts` — in-process confirmation registry.
- `app/api/agent` — SSE endpoint. `app/api/confirm` — approve/deny endpoint.
- `scripts/telegram.mjs`, `scripts/tunnel.sh` — phone access.

## Safety

Jarvis has real power over your Mac. The confirm gate (`lib/tools.ts` →
`needsConfirm`) is a heuristic denylist, not a sandbox — review it, and don't
run Jarvis with `sudo`. It's a personal tool.

**Remote access requires a token.** Requests over the Cloudflare tunnel must
carry `JARVIS_TOKEN`; localhost is trusted and never needs it. If the tunnel is
running but no token is set, the API refuses remote calls (fail-closed) so a
leaked tunnel URL can't become an open remote shell. Generate one with
`openssl rand -hex 24`, put it in `.env.local`, and restart. The auth check
lives in `lib/auth.ts`.
