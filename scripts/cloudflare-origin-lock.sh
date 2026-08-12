#!/usr/bin/env bash
# Restrict the origin's HTTP ports to Cloudflare, so the VPS IP stops being a
# way around the CDN.
#
# Why this exists: on 2026-08-11 Reliance Jio could not route to the VPS at
# all — traceroute died inside Jio's own network while Airtel reached the same
# address fine. Nothing on the server can fix that, because the problem is how
# an ISP routes to one IP. The fix is for users to never connect to that IP:
# they reach Cloudflare's edge, Cloudflare reaches the origin. Locking the
# origin to Cloudflare is what stops the old path quietly remaining available
# (the IP is already public in DNS history).
#
# Run ON THE VPS, as root. Dry run by default — nothing changes until --apply.
#
#   sudo bash cloudflare-origin-lock.sh            # show the plan
#   sudo bash cloudflare-origin-lock.sh --apply    # do it
#   sudo bash cloudflare-origin-lock.sh --open     # undo: reopen 80/443
#
# Port 22 is never touched: it keeps its existing LIMIT rule, so a bad run
# cannot lock you out of the box.

set -euo pipefail

MODE="${1:-plan}"
V4_URL="https://www.cloudflare.com/ips-v4"
V6_URL="https://www.cloudflare.com/ips-v6"

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "must run as root (sudo)" >&2
    exit 1
  fi
}

fetch_ranges() {
  local v4 v6
  v4="$(curl -fsSL --max-time 20 "$V4_URL")"
  v6="$(curl -fsSL --max-time 20 "$V6_URL")"

  # Refuse to act on a truncated or hijacked response: an empty or malformed
  # list would otherwise produce a firewall that allows nothing at all.
  if [ "$(printf '%s\n' "$v4" | grep -cE '^[0-9.]+/[0-9]+$')" -lt 5 ]; then
    echo "cloudflare IPv4 list looks wrong — refusing to continue" >&2
    exit 1
  fi
  if [ "$(printf '%s\n' "$v6" | grep -cE '^[0-9a-fA-F:]+/[0-9]+$')" -lt 3 ]; then
    echo "cloudflare IPv6 list looks wrong — refusing to continue" >&2
    exit 1
  fi
  printf '%s\n%s\n' "$v4" "$v6" | grep -E '/[0-9]+$'
}

if [ "$MODE" = "--open" ]; then
  require_root
  echo "reopening 80/443 to the world (undo)"
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  while read -r cidr; do
    ufw delete allow from "$cidr" to any port 80,443 proto tcp >/dev/null 2>&1 || true
  done < <(fetch_ranges)
  ufw status numbered | head -20
  echo
  echo "origin is publicly reachable again. Cloudflare will still work; the"
  echo "difference is that the IP now also answers directly."
  exit 0
fi

RANGES="$(fetch_ranges)"
COUNT="$(printf '%s\n' "$RANGES" | wc -l | tr -d ' ')"

echo "Cloudflare ranges fetched: $COUNT"
echo
echo "plan:"
echo "  1. allow 80,443/tcp from each Cloudflare range"
echo "  2. remove the blanket 'Anywhere' rules for 80/tcp, 443/tcp, 443/udp"
echo "  3. leave 22/tcp LIMIT untouched"
echo

if [ "$MODE" != "--apply" ]; then
  printf '%s\n' "$RANGES" | sed 's/^/  ufw allow from /;s|$| to any port 80,443 proto tcp|' | head -8
  echo "  … and $((COUNT - 8)) more"
  echo
  echo "dry run only. re-run with --apply to make these changes."
  echo
  echo "BEFORE APPLYING: confirm Cloudflare is already proxying (orange cloud)"
  echo "and the site loads through it. Applying first makes the origin"
  echo "unreachable until DNS is proxied."
  exit 0
fi

require_root

while read -r cidr; do
  ufw allow from "$cidr" to any port 80,443 proto tcp >/dev/null
done < <(printf '%s\n' "$RANGES")
echo "added $COUNT allow rules"

# Blanket rules last: if the loop above failed, the origin stays reachable.
ufw delete allow 80/tcp >/dev/null 2>&1 || true
ufw delete allow 443/tcp >/dev/null 2>&1 || true
ufw delete allow 443/udp >/dev/null 2>&1 || true
echo "removed blanket 80/443 rules"

echo
ufw status numbered | head -20
echo
echo "verify from a machine that is NOT Cloudflare — direct access should now"
echo "fail, while the hostname still works:"
echo "  curl -m 10 -k https://72.61.169.154/            # expect timeout/refused"
echo "  curl -m 10 -o /dev/null -w '%{http_code}\\n' https://app.mitosia.com/"
echo
echo "Cloudflare publishes new ranges occasionally — re-run this after any"
echo "change to their list, or the edge starts getting blocked."
