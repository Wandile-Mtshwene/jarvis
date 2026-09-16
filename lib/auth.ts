// Access control for the brain's API.
//
// Localhost is trusted: direct requests to the dev server (the Eye on your Mac,
// the menu-bar app, the Telegram bridge) are allowed with no token. Requests
// that arrive through the Cloudflare tunnel are *remote* — they carry Cloudflare
// forwarding headers — and must present the shared secret in `JARVIS_TOKEN`.
// Fail closed: if the tunnel is up but no token is configured, remote access is
// refused so the tunnel can never be an open remote shell.

export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

// A request is "tunneled" (remote) if it carries Cloudflare's forwarding
// headers. Direct localhost requests don't have these — cloudflared itself
// proxies to localhost, so we can't rely on the socket address.
function isTunneled(req: Request): boolean {
  const h = req.headers;
  return !!(h.get("cf-connecting-ip") || h.get("cf-ray") || h.get("x-forwarded-for"));
}

export function checkAuth(req: Request): AuthResult {
  if (!isTunneled(req)) return { ok: true }; // local — trusted

  const token = process.env.JARVIS_TOKEN;
  if (!token) {
    return {
      ok: false,
      status: 503,
      message: "Remote access is disabled. Set JARVIS_TOKEN and restart to reach Jarvis over the tunnel.",
    };
  }

  const auth = req.headers.get("authorization") || "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim() || req.headers.get("x-jarvis-token") || "";
  if (provided !== token) {
    return { ok: false, status: 401, message: "Bad or missing token." };
  }
  return { ok: true };
}
