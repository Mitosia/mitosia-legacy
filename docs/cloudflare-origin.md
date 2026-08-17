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
| `dokploy.mitosia.cloud` | `72.61.169.154` | proxied, behind Access |

The panel was going to stay unproxied, on the reasoning that your recovery tool
must not sit behind the thing that might be broken. That is a real concern
aimed at the wrong tool. Leaving it unproxied leaves the origin IP reachable —
which is the entire problem this document exists to solve — and the actual
recovery path is **SSH on port 22**, which the origin lock never touches
(it writes only to `DOCKER-USER`; nothing here goes into `INPUT`). So the panel
is proxied like everything else, with Cloudflare Access in front:

| Access application | Path | Policy |
|---|---|---|
| `Dokploy` | `dokploy.mitosia.cloud` | Allow → your email |
| `Dokploy webhooks` | `/api/deploy` | **Bypass → Everyone** |
| `Dokploy webhooks 2` | `/api/webhook` | **Bypass → Everyone** |

The two bypasses exist because GitHub's webhook cannot log in. Keep them
path-scoped: they are the only unauthenticated surface on the panel.

**Access changes what your scripts see.** Anything hitting the Dokploy API now
gets a `302` to `*.cloudflareaccess.com` instead of the API — which naive
tooling reads as a success. For automation, create a Cloudflare **service
token** and add a Service Auth policy on the app; don't widen the bypass paths.

> This supersedes the note in AGENTS.md that `mitosia.cloud` stays on plain
> Hostinger DNS. That decision was made to keep Let's Encrypt issuance simple,
> and it was reasonable until an ISP proved the origin IP is not universally
> reachable. Staging shares the origin, so staging shares the problem.

### 2. Certificates: DNS-01 wildcard

Traefik issued via HTTP-01 (`certificatesResolvers.letsencrypt.acme.httpChallenge`).
**HTTP-01 breaks behind Cloudflare's proxy** — the challenge is answered by the
edge, not the origin.

Two ways through; **we chose DNS-01**, over a Cloudflare Origin Certificate.

The Origin Certificate is free, lasts 15 years and is trusted by Cloudflare —
genuinely simpler. But it is trusted by *Cloudflare only*. Anything that ever
reaches the origin outside the proxy sees an untrusted cert: a host you
deliberately leave unproxied, a `--resolve` health check, a debugging session,
or a future service that predates its DNS record. The failure mode is a cert
error at the moment you are already debugging something else. DNS-01 keeps a
publicly-trusted cert on the box, so the origin stays correct on its own terms
and the proxy is an optimisation rather than a prerequisite.

The cost is one scoped API token on the VPS. Constrain it hard: **Zone → DNS →
Edit, on `mitosia.cloud` only**, nothing else.

Add a second resolver in `/etc/dokploy/traefik/traefik.yml` (keep the HTTP-01
one; it costs nothing and stays available):

```yaml
certificatesResolvers:
  letsencrypt-dns:
    acme:
      email: <you>
      storage: /etc/dokploy/traefik/dynamic/acme-dns.json
      dnsChallenge:
        provider: cloudflare
        resolvers: ["1.1.1.1:53", "8.8.8.8:53"]
```

`CF_DNS_API_TOKEN` goes into Traefik's environment. Then serve the wildcard as
the default certificate, so every `*.mitosia.cloud` host is covered with no
per-host issuance:

```yaml
# /etc/dokploy/traefik/dynamic/wildcard-default.yml
tls:
  stores:
    default:
      defaultGeneratedCert:
        resolver: letsencrypt-dns
        domain:
          main: "mitosia.cloud"
          sans: ["*.mitosia.cloud"]
```

Set SSL mode to **Full (strict)**. Do **not** use "Flexible": it makes
Cloudflare talk to the origin over plain HTTP, so the padlock users see covers
only half the path.

`pnpm check:traefik` asserts this whole shape against the live box and fails on
drift — including a cert inside 21 days of expiry. Exit code 2 means the host
was unreachable, which is not the same as drift.

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

**Making it survive a reboot has a trap.** iptables rules are in memory only.
The obvious fix, `apt install iptables-persistent`, **removes `ufw`** — they
conflict, apt resolves it silently, and you lose whatever `ufw` was doing.
Here that was SSH rate limiting, which had to be rebuilt by hand afterwards:

```bash
# after iptables-persistent, restore rate limiting explicitly — BOTH families
iptables  -I INPUT -p tcp --dport 22 -m state --state NEW \
  -m recent --set --name SSH
iptables  -I INPUT -p tcp --dport 22 -m state --state NEW \
  -m recent --update --seconds 30 --hitcount 7 --name SSH -j DROP
ip6tables -I INPUT -p tcp --dport 22 -m state --state NEW \
  -m recent --set --name SSH
ip6tables -I INPUT -p tcp --dport 22 -m state --state NEW \
  -m recent --update --seconds 30 --hitcount 7 --name SSH -j DROP

netfilter-persistent save     # nothing above survives a reboot without this
```

The host is dual-stack: an IPv4-only rule leaves the IPv6 door unlatched.
Then reboot once and re-verify, rather than assuming the save worked.

### 5. Verify

```bash
# Direct to the origin, bypassing DNS: should hang until the timeout.
curl -m 10 -k --resolve staging.mitosia.cloud:443:72.61.169.154 \
  https://staging.mitosia.cloud/

# Through Cloudflare: should serve, and report a Cloudflare edge.
curl -m 10 -sI https://staging.mitosia.cloud/ | grep -iE '^(HTTP|server|cf-ray)'
```

Use `--resolve`, not a bare `https://<ip>/`: without SNI, Traefik answers with
its default cert and the result tells you nothing about the lock.

Then check the app still sees real client IPs — a session row written after the
cutover should carry your address, not a Cloudflare one:

```sql
select ip_address, created_at from session order by created_at desc limit 5;
```

That is the assertion that catches a missing `trustedIPs`, and it is invisible
in the UI: everything works, the addresses are just quietly wrong.

Verified 2026-08-17: a fresh sign-in recorded `2405:201:d014:c9bb::` — the
client's own network, not a Cloudflare range (`2400:cb00::/32`,
`2606:4700::/32`). Note the shape: **IPv6 is stored as the /64 prefix with the
interface identifier zeroed**, while Cloudflare's edge sees the full address
(check yours at `https://staging.mitosia.cloud/cdn-cgi/trace`). Nothing in
`lib/auth.ts` does that, so it comes from Better Auth's own resolution — and
/64 is the right unit anyway: IPv6 privacy extensions rotate the low 64 bits
constantly, so a full-address rate-limit bucket is evaded for free while a /64
maps to one subscriber. Don't read the zeros as a bug or "fix" them.

Two gotchas when re-running this check. A visit while already signed in only
**refreshes** the existing row — `updated_at` moves, `ip_address` does not,
because it is written at session *creation* only. So sign out first, or use a
private window. And an empty `ip_address` is the real failure signal: it means
Better Auth resolved no client IP at all, which also drops rate limiting into
one shared per-path bucket.

## What this does not fix

Cloudflare's edge still has to reach the origin. If Hostinger's address becomes
unroutable from Cloudflare's network too, the site is down regardless. That is
far less likely than one consumer ISP having a bad route, but it is the reason
the origin's own health still matters.
