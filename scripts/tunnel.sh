#!/bin/bash
# Expose your local Jarvis to your phone anywhere via a Cloudflare quick tunnel.
# Prints a public https URL that proxies to localhost:3000 — open it on your
# iPhone and "Add to Home Screen" to install the Eye as a PWA.
set -e
PORT="${1:-3000}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Install it with:"
  echo "  brew install cloudflared"
  exit 1
fi

echo "Starting Cloudflare tunnel to http://localhost:$PORT ..."
echo "(Grab the https://<random>.trycloudflare.com URL below and open it on your phone.)"
exec cloudflared tunnel --url "http://localhost:$PORT"
