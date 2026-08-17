#!/usr/bin/env bash
# Restrict the origin's HTTP ports to Cloudflare, so the VPS IP stops being a
# way around the CDN.
#
# Why this exists: on 2026-08-11 Reliance Jio could not route to the VPS at
# all — traceroute died inside Jio's own network while Airtel reached the same
# address fine. Nothing on the server fixes that, because the problem is how
# an ISP routes to one IP. The fix is for users never to connect to that IP:
# they reach Cloudflare's edge, Cloudflare reaches the origin. Locking the
# origin to Cloudflare is what stops the old path quietly remaining available
# (the IP is already public in DNS history).
#
# WHY NOT ufw: Traefik's 80/443 are *Docker-published*, so packets are DNAT'd
# into the container through Docker's own chains and never traverse ufw's
# INPUT rules. A ufw allow/deny for these ports is inert — the first version of
# this script did exactly that, reported success, and changed nothing. Docker
# provides DOCKER-USER for precisely this, evaluated before its own rules.
#
# Run ON THE VPS, as root. Dry run by default — nothing changes until --apply.
#
#   sudo bash cloudflare-origin-lock.sh            # show the plan
#   sudo bash cloudflare-origin-lock.sh --apply    # do it
#   sudo bash cloudflare-origin-lock.sh --open     # undo
#   sudo bash cloudflare-origin-lock.sh --status   # what is in force now
#
# Port 22 is never touched: SSH does not go through Docker, and nothing here
# writes to the INPUT chain, so a bad run cannot lock you out of the box.

set -euo pipefail

MODE="${1:-plan}"
V4_URL="https://www.cloudflare.com/ips-v4"
V6_URL="https://www.cloudflare.com/ips-v6"
# Only traffic arriving from the internet is filtered. Docker's own bridges
# must be left alone or containers stop talking to each other.
WAN_IF="$(ip -4 route show default | awk '{print $5}' | head -1)"
MARK="cf-origin-lock"

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
  # Refuse to act on a truncated or hijacked response: an empty list would
  # otherwise produce a firewall that drops everything.
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

# Every rule we add carries a comment, so undo removes exactly ours and
# nothing Docker or Dokploy put there.
clear_ours() {
  local ipt
  for ipt in iptables ip6tables; do
    while $ipt -L DOCKER-USER -n --line-numbers 2>/dev/null | grep -q "$MARK"; do
      local line
      line="$($ipt -L DOCKER-USER -n --line-numbers | grep "$MARK" | head -1 | awk '{print $1}')"
      $ipt -D DOCKER-USER "$line"
    done
  done
}

show_status() {
  echo "DOCKER-USER (IPv4):"
  iptables -L DOCKER-USER -n --line-numbers 2>/dev/null | sed 's/^/  /'
  echo "DOCKER-USER (IPv6):"
  ip6tables -L DOCKER-USER -n --line-numbers 2>/dev/null | sed 's/^/  /'
}

if [ "$MODE" = "--status" ]; then
  show_status
  exit 0
fi

if [ "$MODE" = "--open" ]; then
  require_root
  echo "removing origin lock rules (undo)"
  clear_ours
  show_status
  echo
  echo "origin is publicly reachable again. Cloudflare still works; the"
  echo "difference is that the IP now also answers directly."
  exit 0
fi

RANGES="$(fetch_ranges)"
COUNT="$(printf '%s\n' "$RANGES" | wc -l | tr -d ' ')"

echo "Cloudflare ranges fetched: $COUNT"
echo "External interface: $WAN_IF"
echo
echo "plan (DOCKER-USER chain — ufw does not apply to Docker-published ports):"
echo "  1. RETURN (accept) tcp 80,443 arriving on $WAN_IF from each Cloudflare range"
echo "  2. DROP all other tcp 80,443 arriving on $WAN_IF"
echo "  3. leave Docker's bridges, the INPUT chain and port 22 untouched"
echo

if [ "$MODE" != "--apply" ]; then
  printf '%s\n' "$RANGES" | head -4 | sed "s|^|  iptables -I DOCKER-USER -i $WAN_IF -p tcp -m multiport --dports 80,443 -s |;s|$| -j RETURN|"
  echo "  … and $((COUNT - 4)) more, then a final DROP"
  echo
  echo "dry run only. re-run with --apply to make these changes."
  echo
  echo "BEFORE APPLYING: confirm Cloudflare is already proxying (orange cloud)"
  echo "and both hostnames load through it."
  exit 0
fi

require_root

if [ -z "$WAN_IF" ]; then
  echo "could not determine the external interface — refusing to continue" >&2
  exit 1
fi

clear_ours

# The catch-all DROP goes in first; each allow is then inserted above it, so
# the chain is never in a state where everything is dropped.
iptables -I DOCKER-USER -i "$WAN_IF" -p tcp -m multiport --dports 80,443 \
  -m comment --comment "$MARK deny" -j DROP
ip6tables -I DOCKER-USER -i "$WAN_IF" -p tcp -m multiport --dports 80,443 \
  -m comment --comment "$MARK deny" -j DROP

while read -r cidr; do
  case "$cidr" in
    *:*) ip6tables -I DOCKER-USER -i "$WAN_IF" -p tcp -m multiport --dports 80,443 \
           -s "$cidr" -m comment --comment "$MARK allow" -j RETURN ;;
    *)   iptables -I DOCKER-USER -i "$WAN_IF" -p tcp -m multiport --dports 80,443 \
           -s "$cidr" -m comment --comment "$MARK allow" -j RETURN ;;
  esac
done < <(printf '%s\n' "$RANGES")

echo "applied $COUNT allow rules plus a catch-all DROP"
echo
show_status
echo
echo "NOT PERSISTENT ACROSS REBOOT. iptables rules are in-memory; install"
echo "iptables-persistent (netfilter-persistent save) or re-run this after a"
echo "reboot, or the origin silently becomes reachable again."
echo
echo "verify from a machine that is NOT Cloudflare:"
echo "  curl -m 10 -k --resolve staging.mitosia.cloud:443:72.61.169.154 \\"
echo "    https://staging.mitosia.cloud/     # expect a timeout"
echo "  curl -m 10 -o /dev/null -w '%{http_code}\\n' https://staging.mitosia.cloud/"
echo
echo "Cloudflare publishes new ranges occasionally — re-run after any change"
echo "to their list, or the edge starts getting blocked."
