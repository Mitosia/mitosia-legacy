# Putting Cloudflare in front of the origin

## Why

On 2026-08-11 Reliance Jio could not reach the VPS at all — every port timed
out, traceroute died at `136.232.253.36` *inside Jio's own network*, while the
same address answered normally over Airtel and from other networks. The server
was healthy throughout (4 days uptime, load 0.01).

Nothing on the VPS can fix that. The problem is how one ISP routes to one IP,
and Jio is India's largest ISP for a product aimed at Indian users. Hostinger
recycles addresses, so an IP can carry history you will never see.

The fix is for users never to connect to that IP. They reach Cloudflare's
anycast edge — which has PoPs in Mumbai, Delhi and Chennai with direct Indian
ISP peering — and Cloudflare reaches the origin over its own transit. A single
ISP's route to one address stops being a single point of failure.

Side benefits: TLS terminates at the edge (a saved round trip on every new
connection, which matters more than it sounds at Indian mobile latencies),
plus WAF and DDoS protection the origin does not have today.

## Pre-flight: what a nameserver move would break

Moving a zone to Cloudflare replaces its nameservers, so **every record that
is not replicated stops existing**. Cloudflare's import scan catches most of
them; the ones it misses are the ones on arbitrary names, and mail is where
that hurts. Inventory taken 2026-08-11:

**`mitosia.cloud`** — nameservers at Hostinger (`*.dns-parking.com`). Only A
records: a wildcard `*` and the hosts under it, all pointing at the VPS. No
mail, no TXT. **Nothing to lose; safe to move.**

**`mitosia.com`** — registered at **Spaceship** (`*.spaceship.net`), no A
record yet, and it carries **live email**. These three must exist in
Cloudflare before the nameservers change, or mail breaks:

| Type | Name | Value |
|---|---|---|
| MX | `@` | `mx1.spacemail.com` (0), `mx2.spacemail.com` (0) |
| TXT | `@` | `v=spf1 include:spf.spacemail.com ~all` |
| TXT | `spacemail._domainkey` | `v=DKIM1;k=rsa;p=…` (copy the full value from Spaceship) |

No DMARC record exists, and there are no `mail`/`webmail`/`autodiscover`
hosts. Re-run the inventory before moving, in case that has changed:

```bash
dig +short NS mitosia.com; dig +short MX mitosia.com
dig +short TXT mitosia.com; dig +short TXT spacemail._domainkey.mitosia.com
```

Because `mitosia.com` has no A record yet, there is nothing to proxy on it
until production ships — so move `mitosia.cloud` first and treat `mitosia.com`
as a deliberate, separate step with the mail records checked afterwards by
sending a real message in and out.

## The order matters

Applying the origin lock before DNS is proxied makes the site unreachable.
Do these in order, verifying each.

### 1. DNS onto Cloudflare

Add the zone in Cloudflare, move the registrar's nameservers to the pair
Cloudflare assigns, and wait for the zone to go active.

Then set the records **proxied** (orange cloud):

| Record | Value | Proxy |
|---|---|---|
| `app.mitosia.com` | `72.61.169.154` | proxied |
| `staging.mitosia.cloud` | `72.61.169.154` | proxied |
| `dokploy.mitosia.cloud` | `72.61.169.154` | **DNS only** |

Leave the Dokploy panel unproxied and reachable directly. If Cloudflare or the
zone is ever misconfigured, the panel is how you fix it — putting your only
recovery tool behind the thing that might be broken is how a small outage
becomes a long one.

> This supersedes the note in AGENTS.md that `mitosia.cloud` stays on plain
> Hostinger DNS. That decision was made to keep Let's Encrypt issuance simple,
> and it was reasonable until an ISP proved the origin IP is not universally
> reachable. Staging shares the origin, so staging shares the problem.

### 2. Certificates: Origin Certificate, not Let's Encrypt

Traefik currently issues via HTTP-01 (`/etc/dokploy/traefik/traefik.yml`,
`certificatesResolvers.letsencrypt.acme.httpChallenge`). **HTTP-01 breaks
behind Cloudflare's proxy** — the challenge is answered by the edge, not the
origin.

Two ways through. Prefer the first:

**Cloudflare Origin Certificate.** SSL/TLS → Origin Server → Create
Certificate. Free, valid 15 years, trusted only by Cloudflare — which is all
the origin needs. Set SSL mode to **Full (strict)**.

Install it on the VPS and point Traefik at it:

```yaml
# /etc/dokploy/traefik/dynamic/origin-cert.yml
tls:
  stores:
    default:
      defaultCertificate:
        certFile: /etc/dokploy/traefik/dynamic/origin.pem
        keyFile: /etc/dokploy/traefik/dynamic/origin.key
```

Keep the `letsencrypt` resolver for any host that stays unproxied (the Dokploy
panel), so both paths keep working.

**Or DNS-01.** Keeps Let's Encrypt, needs a scoped Cloudflare API token in
Traefik's environment. More moving parts, and a token with DNS-edit rights
sitting on the box.

Do **not** use SSL mode "Flexible": it makes Cloudflare talk to the origin over
plain HTTP, so the padlock users see covers only half the path.

### 3. Teach Traefik who the client is

Behind a proxy, every request arrives from a Cloudflare address. Without
telling Traefik to trust the forwarded headers, rate limits, audit log entries
and any future IP-based rule all record Cloudflare instead of the user —
wrong in a way that looks fine.

In `/etc/dokploy/traefik/traefik.yml`, on both entry points:

```yaml
entryPoints:
  web:
    address: :80
    forwardedHeaders:
      trustedIPs: &cloudflare
        - 173.245.48.0/20
        - 103.21.244.0/22
        # … the full list from https://www.cloudflare.com/ips/
  websecure:
    address: :443
    forwardedHeaders:
      trustedIPs: *cloudflare
```

Trust **only** Cloudflare's ranges. Trusting everything lets any client forge
`X-Forwarded-For` and impersonate another IP.

Restart Traefik: `docker service update --force dokploy-traefik`.

### 4. Lock the origin

Until this step, anyone who knows the IP can bypass Cloudflare entirely — and
the IP is already public in DNS history.

```bash
sudo bash scripts/cloudflare-origin-lock.sh          # dry run, prints the plan
sudo bash scripts/cloudflare-origin-lock.sh --apply
```

It allows 80/443 only from Cloudflare's published ranges, removes the blanket
rules, and never touches port 22 — a bad run cannot lock you out of SSH.
`--open` reverses it.

Cloudflare adds ranges occasionally; re-run after any change to their list, or
the edge starts getting blocked by your own firewall.

### 5. Verify

```bash
# Direct to the IP: should now fail.
curl -m 10 -k https://72.61.169.154/

# Through Cloudflare: should serve, and report a Cloudflare edge.
curl -m 10 -sI https://app.mitosia.com/ | grep -iE '^(HTTP|server|cf-ray)'
```

Then check the app still sees real client IPs — an audit log entry written
after the cutover should not carry a Cloudflare address.

## What this does not fix

Cloudflare's edge still has to reach the origin. If Hostinger's address becomes
unroutable from Cloudflare's network too, the site is down regardless. That is
far less likely than one consumer ISP having a bad route, but it is the reason
the origin's own health still matters.
