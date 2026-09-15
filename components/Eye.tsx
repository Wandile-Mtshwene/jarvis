"use client";

import { memo, useMemo } from "react";

export type EyeState = "idle" | "listening" | "thinking" | "speaking";

// Deterministic pseudo-random so server and client render identically.
const rand = (i: number, s = 1) => {
  const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// The Eye — a full-screen field of white light-paths and dots on black, with a
// blue-tint bloom that pulses when J.A.R.V.I.S listens, thinks, or speaks.
// Geometry renders ONCE; all motion is CSS-driven (`--level` set on the wrap),
// so audio amplitude never triggers a React re-render. Only `state` re-renders.
function EyeBase({ state }: { state: EyeState }) {
  const C = 500;

  const spokes = useMemo(() => {
    const N = 36;
    const out: { d: string; ex: number; ey: number; mx: number; my: number }[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const jitter = (rand(i, 3) - 0.5) * 0.12;
      const r0 = 145;
      const r1 = 560 + rand(i, 7) * 190;
      const x0 = C + Math.cos(a) * r0;
      const y0 = C + Math.sin(a) * r0;
      const ex = C + Math.cos(a + jitter) * r1;
      const ey = C + Math.sin(a + jitter) * r1;
      const mr = (r0 + r1) / 2;
      const mx = C + Math.cos(a + 0.14) * mr;
      const my = C + Math.sin(a + 0.14) * mr;
      out.push({ d: `M ${x0} ${y0} Q ${mx} ${my} ${ex} ${ey}`, ex, ey, mx, my });
    }
    return out;
  }, []);

  const rings = [170, 215, 270, 345, 440, 560, 700];

  const field = useMemo(() => {
    const dots: { x: number; y: number; r: number; o: number }[] = [];
    for (let i = 0; i < 80; i++) {
      const x = rand(i, 11) * 1000;
      const y = rand(i, 19) * 1000;
      if (Math.hypot(x - C, y - C) < 150) continue;
      dots.push({ x, y, r: 0.7 + rand(i, 23) * 1.6, o: 0.12 + rand(i, 29) * 0.32 });
    }
    return dots;
  }, []);

  const ringDots = useMemo(() => {
    const dots: { x: number; y: number }[] = [];
    [215, 345, 560].forEach((rr, ri) => {
      const k = 9 + ri * 5;
      for (let i = 0; i < k; i++) {
        const a = (i / k) * Math.PI * 2 + rr;
        dots.push({ x: C + Math.cos(a) * rr, y: C + Math.sin(a) * rr });
      }
    });
    return dots;
  }, []);

  return (
    <div className="eye-wrap" data-state={state}>
      <div className="bloom" />
      <svg
        viewBox="0 0 1000 1000"
        preserveAspectRatio="xMidYMid slice"
        style={{ position: "absolute", inset: 0, width: "100vw", height: "100vh" }}
      >
        <defs>
          <radialGradient id="core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#eaf6ff" stopOpacity="1" />
            <stop offset="45%" stopColor="var(--glow)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--glow-deep)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="spokeGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--glow)" stopOpacity="0.05" />
          </linearGradient>
        </defs>

        {/* full-screen dot field */}
        {field.map((d, i) => (
          <circle key={`f${i}`} cx={d.x} cy={d.y} r={d.r} fill="var(--line)" fillOpacity={d.o} />
        ))}

        <g className="paths">
          {spokes.map((s, i) => (
            <path key={`b${i}`} d={s.d} fill="none" stroke="var(--line)" strokeOpacity={0.09} strokeWidth={1} />
          ))}
          {spokes.map((s, i) => (
            <path
              key={`s${i}`}
              className="spoke"
              d={s.d}
              fill="none"
              stroke="url(#spokeGrad)"
              strokeWidth={1.5}
              strokeDasharray="10 30"
              style={{ animationDelay: `${(i % 9) * 0.16}s` }}
            />
          ))}
          {spokes.map((s, i) => (
            <circle key={`d${i}`} cx={s.ex} cy={s.ey} r={2} fill="#ffffff" fillOpacity={0.4} />
          ))}

          <g className="ring-rotate">
            {rings.map((r, i) => (
              <circle
                key={r}
                cx={C}
                cy={C}
                r={r}
                fill="none"
                stroke="var(--line)"
                strokeOpacity={0.13}
                strokeWidth={i === 1 ? 1.4 : 0.8}
                strokeDasharray={i % 2 ? "2 10" : "1 7"}
              />
            ))}
          </g>

          {ringDots.map((d, i) => (
            <circle key={`rd${i}`} cx={d.x} cy={d.y} r={1.6} fill="var(--glow)" fillOpacity={0.5} />
          ))}

          <circle cx={C} cy={C} r={455} fill="none" stroke="var(--glow)" strokeOpacity={0.16} strokeWidth={1} />
        </g>

        {/* core — scaled via CSS (.core) from --level when active */}
        <g className="core">
          <circle cx={C} cy={C} r={150} fill="url(#core)" />
          <circle cx={C} cy={C} r={70} fill="none" stroke="#eaf6ff" strokeOpacity={0.6} strokeWidth={1.2} />
          <circle cx={C} cy={C} r={44} fill="var(--glow)" opacity={0.7} />
          <circle cx={C} cy={C} r={12} fill="#ffffff" opacity={0.95} />
        </g>
      </svg>
    </div>
  );
}

// Only re-render when `state` changes (never per audio frame).
const Eye = memo(EyeBase);
export default Eye;
