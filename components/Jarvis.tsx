"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Mic, MicOff, Power, Volume2, VolumeX } from "lucide-react";
import Eye, { type EyeState } from "./Eye";

type Role = "user" | "assistant";
type Msg = { role: Role; content: unknown };
type Confirm = { id: string; tool: string; reason: string };

// Minimal typings for the Web Speech API (not in lib.dom for all TS versions).
type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
};

function getSRCtor(): (new () => SR) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SR;
    webkitSpeechRecognition?: new () => SR;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

// When reached over the Cloudflare tunnel, the API requires JARVIS_TOKEN. We
// keep it in localStorage (on localhost it's simply never needed / never asked).
function getToken(): string {
  try {
    return localStorage.getItem("jarvis.token") || "";
  } catch {
    return "";
  }
}
function promptForToken(): string {
  const t = window.prompt("This Jarvis needs an access token (JARVIS_TOKEN). Paste it:")?.trim();
  if (t) {
    try {
      localStorage.setItem("jarvis.token", t);
    } catch {}
    return t;
  }
  return "";
}
function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

export default function Jarvis() {
  const [state, setState] = useState<EyeState>("idle");
  const [reply, setReply] = useState("");
  const [heard, setHeard] = useState("");
  const [listening, setListening] = useState(false);
  const [muted, setMuted] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [text, setText] = useState("");
  const [awake, setAwake] = useState(false); // always-listening wake-word mode
  const [profile, setProfile] = useState<{ name?: string; notes?: string }>({});
  const [testing, setTesting] = useState(false);
  const profileRef = useRef<{ name?: string; notes?: string }>({});

  const history = useRef<Msg[]>([]);
  const recog = useRef<SR | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const raf = useRef<number>(0);
  const busy = useRef(false);
  const levelRef = useRef(0);
  const setLevelVar = (v: number) => {
    levelRef.current = v;
    if (typeof document !== "undefined")
      document.documentElement.style.setProperty("--level", v.toFixed(3));
  };
  // wake-word ("Jarvis") mode
  const wakeRecog = useRef<SR | null>(null);
  const awakeRef = useRef(false);
  const wakePaused = useRef(false); // suppress self-hearing while Jarvis speaks
  const cmdPending = useRef(false); // heard "Jarvis" alone — next utterance is the command
  const cmdTimer = useRef<number>(0);
  const arming = useRef(false); // guard against double-start (React strict mode)

  // ---- mic amplitude → glow (while listening) ----
  const startMeter = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      analyser.current = an;
      const data = new Uint8Array(an.frequencyBinCount);
      const tick = () => {
        an.getByteFrequencyData(data);
        let sum = 0;
        for (const v of data) sum += v;
        const avg = sum / data.length / 255; // 0..1
        setLevelVar(levelRef.current * 0.7 + Math.min(1, avg * 2.2) * 0.3);
        raf.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* mic denied — glow just won't be audio-reactive */
    }
  }, []);

  // ---- text-to-speech ----
  const speak = useCallback(
    (t: string) => {
      if (muted || !t.trim() || typeof speechSynthesis === "undefined") return;
      speechSynthesis.cancel();
      // Stop the wake mic while speaking so Jarvis doesn't hear himself.
      if (awakeRef.current) {
        wakePaused.current = true;
        try { wakeRecog.current?.stop(); } catch {}
      }
      const u = new SpeechSynthesisUtterance(t);
      u.rate = 1.03;
      u.pitch = 0.95;
      const v = speechSynthesis
        .getVoices()
        .find((x) => /daniel|arthur|male|google uk english male/i.test(x.name));
      if (v) u.voice = v;
      // fake amplitude pulse while speaking
      let phase = 0;
      const id = setInterval(() => {
        phase += 0.35;
        setLevelVar(0.35 + Math.abs(Math.sin(phase)) * 0.5);
      }, 60);
      u.onend = () => {
        clearInterval(id);
        setLevelVar(0);
        setState((s) => (s === "speaking" ? "idle" : s));
        // Resume the wake mic once he's done talking.
        if (awakeRef.current) {
          wakePaused.current = false;
          try { wakeRecog.current?.start(); } catch {}
        }
      };
      speechSynthesis.speak(u);
    },
    [muted],
  );

  // ---- send a turn to the brain, stream the reply ----
  const send = useCallback(
    async (userText: string) => {
      if (!userText.trim() || busy.current) return;
      busy.current = true;
      setHeard(userText);
      setReply("");
      setState("thinking");
      history.current.push({ role: "user", content: userText });

      let full = "";
      try {
        const post = () =>
          fetch("/api/agent", {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders() },
            body: JSON.stringify({ messages: history.current, profile: profileRef.current }),
          });
        let res = await post();
        // Remote access (over the tunnel) needs a token — ask for it once and retry.
        if (res.status === 401 && promptForToken()) res = await post();

        // If the brain isn't reachable / the key is missing, the body won't be
        // an SSE stream — read it as text and show it instead of crashing.
        const ct = res.headers.get("content-type") || "";
        if (!res.ok || !res.body || !ct.includes("text/event-stream")) {
          const body = await res.text().catch(() => "");
          full =
            "I couldn't reach my brain. " +
            (body.slice(0, 160) || `(HTTP ${res.status}) — is ANTHROPIC_API_KEY set?`);
          setReply(full);
          return;
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const chunks = buf.split("\n\n");
          buf = chunks.pop() ?? "";
          for (const c of chunks) {
            const line = c.replace(/^data: /, "").trim();
            if (!line) continue;
            let ev: Record<string, unknown>;
            try {
              ev = JSON.parse(line);
            } catch {
              continue; // ignore any non-JSON line rather than throwing
            }
            if (ev.type === "state") setState(ev.state as EyeState);
            else if (ev.type === "text") {
              full += ev.delta as string;
              setReply(full);
            } else if (ev.type === "confirm") {
              setConfirm({ id: ev.id as string, tool: ev.tool as string, reason: ev.reason as string });
            } else if (ev.type === "tool") {
              if (ev.status === "running") setState("thinking");
            } else if (ev.type === "final") {
              history.current = ev.messages as Msg[];
            } else if (ev.type === "error") {
              full = "Something went wrong: " + String(ev.message);
              setReply(full);
            }
          }
        }
      } catch (e) {
        full = "Connection dropped: " + (e instanceof Error ? e.message : String(e));
        setReply(full);
      } finally {
        busy.current = false;
        if (full.trim()) speak(full);
        else setState("idle");
      }
    },
    [speak],
  );

  // ---- speech recognition ----
  const ensureRecog = useCallback(() => {
    if (recog.current) return recog.current;
    const Ctor =
      (window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition;
    if (!Ctor) return null;
    const r = new Ctor();
    r.continuous = false;
    r.interimResults = true;
    r.lang = "en-US";
    r.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      const t = last[0].transcript;
      setHeard(t);
      if (last.isFinal) {
        setListening(false);
        r.stop();
        send(t);
      }
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recog.current = r;
    return r;
  }, [send]);

  const toggleListen = useCallback(() => {
    if (listening) {
      recog.current?.stop();
      setListening(false);
      return;
    }
    const r = ensureRecog();
    if (!r) {
      setReply("Voice input needs Safari or Chrome. You can still type.");
      return;
    }
    if (!analyser.current) startMeter();
    setReply("");
    setHeard("");
    setListening(true);
    setState("listening");
    r.start();
  }, [listening, ensureRecog, startMeter]);

  // ---- wake word ("Jarvis") ----
  const greet = useCallback(() => {
    const lines = ["At your service.", "I'm here.", "Yes?", "Listening.", "Go ahead, sir."];
    const g = lines[Math.floor(Math.random() * lines.length)];
    setHeard("");
    setReply(g);
    setState("speaking");
    speak(g);
  }, [speak]);

  // Returns the command after the wake word ("" = wake word alone / a greeting,
  // null = no wake word present). Tolerates common mis-hears of "Jarvis".
  const WAKE = /(jarv(?:is|iss|es|ic|ix|ish)?|jervis|jarris)/i;
  const afterWake = (t: string): string | null => {
    const m = t.match(WAKE);
    if (!m) return null;
    const idx = (m.index ?? 0) + m[0].length;
    return t
      .slice(idx)
      .replace(/^[\s,.?!-]*(are you (there|awake|up)|you there|wake up|hey|hi|hello)?[\s,.?!-]*/i, "")
      .trim();
  };

  const handleUtterance = useCallback(
    (t: string) => {
      if (busy.current || wakePaused.current || !t.trim()) return;
      if (cmdPending.current) {
        cmdPending.current = false;
        clearTimeout(cmdTimer.current);
        send(t);
        return;
      }
      const rest = afterWake(t);
      if (rest === null) return; // wake word not heard — ignore ambient speech
      if (rest.length > 1) {
        send(rest); // "Jarvis, what's my battery" → run it directly
      } else {
        greet(); // just "Jarvis" → greet and capture the next utterance
        cmdPending.current = true;
        setState("listening");
        cmdTimer.current = window.setTimeout(() => {
          cmdPending.current = false;
          setState("idle");
        }, 9000);
      }
    },
    [send, greet],
  );

  const stopWake = useCallback(() => {
    awakeRef.current = false;
    setAwake(false);
    try { wakeRecog.current?.stop(); } catch {}
    wakeRecog.current = null;
    setState("idle");
    setReply("");
  }, []);

  // Arm always-listening. Returns false if the mic isn't available/granted yet.
  const startWake = useCallback(async (): Promise<boolean> => {
    if (awakeRef.current || arming.current) return true;
    const Ctor = getSRCtor();
    if (!Ctor) {
      setReply("Always-listening needs Chrome or Safari.");
      return false;
    }
    arming.current = true;
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      arming.current = false;
      return false; // no mic permission yet — caller shows the one-tap hint
    }
    if (!analyser.current) startMeter();

    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    r.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      const t = last[0].transcript;
      if (!last.isFinal) {
        if (!busy.current && !wakePaused.current) setHeard(t);
        return;
      }
      handleUtterance(t);
    };
    r.onerror = (ev) => {
      const err = ev?.error || "";
      if (err === "not-allowed" || err === "service-not-allowed") {
        awakeRef.current = false;
        setAwake(false);
        setReply("Microphone is blocked for this window — allow it in site settings.");
      }
    };
    r.onend = () => {
      if (awakeRef.current && !wakePaused.current) {
        setTimeout(() => { try { wakeRecog.current?.start(); } catch {} }, 250);
      }
    };
    wakeRecog.current = r;
    awakeRef.current = true;
    setAwake(true);
    arming.current = false;
    const nm = profileRef.current.name;
    setReply(nm ? `Standing by, ${nm} — say “J.A.R.V.I.S”.` : "Standing by — say “J.A.R.V.I.S”.");
    try { r.start(); } catch {}
    return true;
  }, [handleUtterance, startMeter]);

  const toggleWake = useCallback(() => {
    if (awakeRef.current) {
      stopWake();
      return;
    }
    startWake().then((ok) => {
      if (!ok) setReply("Tap once more and allow the microphone so I can always listen.");
    });
  }, [startWake, stopWake]);

  // Always-listening by default: try to arm on load. If the mic isn't granted
  // yet (first run needs one gesture), show a hint; after that it auto-starts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await startWake();
      if (!ok && !cancelled) {
        setReply('Tap “Wake word” once to let me listen for “J.A.R.V.I.S”.');
      }
    })();
    return () => { cancelled = true; };
  }, [startWake]);

  // ---- voice recognition test + remember me ----
  const runVoiceTest = useCallback(async () => {
    if (testing) return;
    const Ctor = getSRCtor();
    if (!Ctor) {
      setReply("Voice needs Chrome or Safari.");
      return;
    }
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setReply("Microphone is blocked. Allow mic access, then run the test again.");
      return;
    }
    setTesting(true);
    setHeard("");
    setReply("Voice test — say a few words…");
    setState("listening");
    if (!analyser.current) startMeter();

    let got = "";
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    r.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      got = last[0].transcript;
      setHeard(got);
    };
    r.onerror = () => {};
    r.onend = () => {};
    try { r.start(); } catch {}

    setTimeout(() => {
      try { r.stop(); } catch {}
      setTesting(false);
      setState("idle");
      if (!got.trim()) {
        setReply("I didn't catch anything. Make sure this window has mic permission and the input isn't muted.");
        return;
      }
      if (!profileRef.current.name) {
        const name = window.prompt(`Heard you clearly: “${got.trim()}”.\n\nWhat should I call you?`)?.trim();
        if (name) {
          const p = { ...profileRef.current, name };
          profileRef.current = p;
          setProfile(p);
          try { localStorage.setItem("jarvis.profile", JSON.stringify(p)); } catch {}
          setReply(`Got it — I'll remember you, ${name}.`);
          speak(`Got it. I'll remember you, ${name}.`);
          return;
        }
      }
      const who = profileRef.current.name ? `, ${profileRef.current.name}` : "";
      setReply(`Heard you clearly${who}. Voice is working.`);
    }, 6000);
  }, [testing, startMeter, speak]);

  // ---- confirmation decision ----
  const decide = useCallback(async (approved: boolean) => {
    if (!confirm) return;
    await fetch("/api/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ id: confirm.id, approved }),
    });
    setConfirm(null);
  }, [confirm]);

  useEffect(() => {
    return () => cancelAnimationFrame(raf.current);
  }, []);

  // warm up voices list
  useEffect(() => {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.getVoices();
  }, []);

  // reset the glow when idle
  useEffect(() => {
    if (state === "idle" && typeof document !== "undefined")
      document.documentElement.style.setProperty("--level", "0");
  }, [state]);

  // cursor spotlight — brighten The Eye where the pointer is
  useEffect(() => {
    const root = document.documentElement;
    const onMove = (e: PointerEvent) => {
      root.style.setProperty("--mx", e.clientX + "px");
      root.style.setProperty("--my", e.clientY + "px");
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // load remembered profile
  useEffect(() => {
    try {
      const raw = localStorage.getItem("jarvis.profile");
      if (raw) {
        const p = JSON.parse(raw);
        profileRef.current = p;
        setProfile(p);
      }
    } catch {}
  }, []);

  return (
    <>
      <Eye state={state} />
      <div className="cursor-glow" />

      <div className="status-chip">
        {state === "idle" ? (profile.name ? profile.name.toUpperCase() : "J.A.R.V.I.S") : state}
      </div>

      {confirm && (
        <div className="confirm-card">
          <div className="label">Confirm · {confirm.tool}</div>
          <div className="reason">{confirm.reason}</div>
          <div className="row">
            <button className="btn danger" onClick={() => decide(true)}>Approve</button>
            <button className="btn" onClick={() => decide(false)}>Deny</button>
          </div>
        </div>
      )}

      <div className="transcript">
        {heard && <div className="user">“{heard}”</div>}
        <div>{reply}</div>
      </div>

      <div className="hud">
        <button
          className={`btn ${awake ? "active" : ""}`}
          onClick={toggleWake}
          title='Always listen for "Jarvis"'
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          <Power size={17} />
          {awake ? "Awake" : "Wake word"}
        </button>
        <button
          className={`btn ${listening ? "active" : ""}`}
          onClick={toggleListen}
          disabled={awake}
          style={{ display: "inline-flex", alignItems: "center", gap: 8, opacity: awake ? 0.4 : 1 }}
        >
          {listening ? <MicOff size={17} /> : <Mic size={17} />}
          {listening ? "Listening…" : "Speak"}
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = text;
            setText("");
            send(t);
          }}
        >
          <input
            className="text-input"
            placeholder="…or type a command"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </form>
        <button
          className={`btn ${testing ? "active" : ""}`}
          onClick={runVoiceTest}
          title="Check the mic + speech recognition, and remember your name"
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          <AudioLines size={17} />
          {testing ? "Testing…" : "Voice test"}
        </button>
        <button
          className={`btn ${muted ? "warn" : ""}`}
          onClick={() => setMuted((m) => !m)}
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
          {muted ? "Muted" : "Voice"}
        </button>
      </div>
    </>
  );
}
