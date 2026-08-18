# Cloudflare in front of the origin

Complete record of why Mitosia sits behind Cloudflare, how it was built, how to
tell it is healthy, and what to do when it is not.

Built and verified **2026-08-17**. Origin: Hostinger KVM 8 at `72.61.169.154`
(Mumbai), SSH alias `mitosia-vps`.

---

## 1. Why

On 2026-08-11 **Reliance Jio could not reach the VPS at all.** Every port timed
out. `traceroute` died at `136.232.253.36` — an address *inside Jio's own
network*, never reaching Hostinger. The same IP answered normally over Airtel
and from other networks, and the box was healthy throughout: 4 days uptime,
load 0.01, every service running.

That combination is the whole story. Nothing was wrong with the server, so
nothing on the server could fix it. The fault was in how one ISP routed to one
address — and:

- **Jio is India's largest ISP**, for a product aimed at Indian users. "Some
  users can't reach us" is not a tolerable steady state.
- **Hostinger recycles addresses.** An IP arrives carrying history you cannot
  see and cannot appeal.
- **We had no lever.** You cannot file a routing complaint with a consumer ISP
  on behalf of an address you rent.

The fix is to make sure users never connect to that IP. They reach Cloudflare's
anycast edge — which has PoPs in Mumbai, Delhi and Chennai with direct Indian
ISP peering — and Cloudflare reaches the origin over its own transit. One
ISP's route to one address stops being a single point of failure.

Secondary benefits, which are real but were not the reason: TLS terminates at
the edge (a saved round trip per new connection, which matters at Indian mobile
latencies), plus WAF and DDoS protection the origin never had.

---

## 2. What we built

```
                                    ┌──────────────────────────────┐
  user ──── TLS ────▶  Cloudflare edge (anycast, ~15 IPv4 ranges)  │
                                    └──────────────┬───────────────┘
                                                   │ TLS, Full (strict)
                                                   │ sets cf-connecting-ip
                                                   ▼
                              ┌─────────────────────────────────────┐
                              │ origin 72.61.169.154                │
                              │                                     │
                              │  iptables DOCKER-USER               │
                              │    accept 80/443 from CF only       │◀── the lock
                              │    drop everything else             │
                              │                                     │
                              │  Traefik 3.6.7 (plain container)    │
                              │    trustedIPs = CF ranges           │
                              │    per-host certs (HTTP-01) + a     │
                              │    *.mitosia.cloud fallback (DNS-01)│
                              │           │                         │
                              │           ├──▶ staging app ──▶ Neon │
                              │           └──▶ Dokploy panel        │
                              │                                     │
                              │  iptables INPUT: :22 rate-limited   │◀── always open
                              └─────────────────────────────────────┘
```

Hostnames, all **proxied** (orange cloud):

| Host | Serves | Access control |
|---|---|---|
| `staging.mitosia.cloud` | staging app | app's own auth |
| `dokploy.mitosia.cloud` | Dokploy panel | **Cloudflare Access** |
| `app.mitosia.com` | production (when it ships) | app's own auth |

Zone nameservers: `brad.ns.cloudflare.com`, `haley.ns.cloudflare.com`.
Registrar is **Spaceship** — that detail matters in §6.

---

## 3. How it was built

Order matters. Applying the origin lock before DNS is proxied takes the site
offline. Each step was verified before the next.

### 3.1 DNS onto Cloudflare

Add the zone in Cloudflare, then change nameservers **at the registrar**
(Spaceship for `mitosia.cloud`, not Hostinger — Hostinger was only the DNS
host, and pointing NS at Cloudflare makes Hostinger's records irrelevant).
Cloudflare's scan imports existing records; verify them, then set the A records
proxied.

> **Before moving any zone**, inventory what would break. Changing nameservers
> means every record that is not replicated **stops existing**. Cloudflare's
> scan catches most, and misses records on arbitrary names — mail is where that
> hurts. `mitosia.cloud` had only A records, so nothing to lose. **`mitosia.com`
> carries live email** and needs these present in Cloudflare *before* its
> nameservers change:
>
> | Type | Name | Value |
> |---|---|---|
> | MX | `@` | `mx1.spacemail.com` (0), `mx2.spacemail.com` (0) |
> | TXT | `@` | `v=spf1 include:spf.spacemail.com ~all` |
> | TXT | `spacemail._domainkey` | `v=DKIM1;k=rsa;p=…` (copy from Spaceship) |
>
> Re-run the inventory before moving, in case it has changed:
> ```bash
> dig +short NS mitosia.com; dig +short MX mitosia.com
> dig +short TXT mitosia.com; dig +short TXT spacemail._domainkey.mitosia.com
> ```

Set SSL/TLS mode to **Full (strict)**. Never "Flexible" — that makes Cloudflare
talk to the origin over plain HTTP, so the padlock users see covers only half
the path.

### 3.2 Certificates: two resolvers, and what each one actually serves

Traefik was issuing per-host certificates over HTTP-01. **HTTP-01 is the
challenge a CDN can break**: the ACME request for
`/.well-known/acme-challenge/…` has to cross the edge and reach the origin, and
a forced redirect, a WAF rule, or the origin firewall can each stop it — months
before anyone notices, because a certificate fails at renewal, not at cutover.

So a second resolver was **added, not substituted**. Both are live, and they
cover different things:

| Resolver | Challenge | Issues | What it covers |
|---|---|---|---|
| `letsencrypt` | HTTP-01 | per-host certs | **`staging` and `dokploy` — the certificates actually served today** |
| `letsencrypt-dns` | DNS-01 | wildcard `*.mitosia.cloud` | `defaultGeneratedCert` — any hostname without its own |

Read that table before changing anything here. **The wildcard is a fallback, not
what the live hosts present.** Verified 2026-08-18: both hosts serve a
single-SAN certificate (`CN = staging.mitosia.cloud`, `CN = dokploy.mitosia.cloud`,
expiring 7 and 6 Nov), issued by the HTTP-01 resolver — so that resolver is
load-bearing, not legacy.

**And HTTP-01 still works through Cloudflare here** — also verified 2026-08-18.
The challenge path passes the edge and reaches Traefik rather than being
redirected or answered at the edge:

```bash
curl -m 15 -sS -D- http://staging.mitosia.cloud/.well-known/acme-challenge/probe
# HTTP/1.1 404 Not Found   ← from Traefik: unknown token, empty body
# cf-cache-status: DYNAMIC ← forwarded to origin, not served or blocked at the edge
# (no Location header — "Always Use HTTPS" is not intercepting this path)
```

Re-run that probe if you ever enable a redirect rule, a WAF rule, or a cache
rule that could match `/.well-known/`. A 403, an HTML body, or a redirect that
does not resolve means renewals will fail in roughly 60 days' time.

The wildcard's job is different: it makes a **new** subdomain work immediately,
with no issuance at all. It is wired as a default certificate rather than by
pointing each router at the DNS resolver because **Dokploy regenerates the
per-app router labels (`certresolver=letsencrypt`) on every deploy** and would
overwrite anything edited by hand.

> **Not used: a Cloudflare Origin Certificate.** Considered, rejected, and
> never installed. It is trusted by Cloudflare *only*, so any path reaching the
> origin outside the proxy — an unproxied host, a `--resolve` health check, the
> §5.3 C fallback — would show a certificate error. If you ever find one
> installed on this box, something has gone wrong.

The DNS-01 resolver costs one API token on the VPS. Scope it hard: **Zone → DNS
→ Edit, on `mitosia.cloud` only.** Nothing else. (If you also set an IP filter,
remember the VPS is dual-stack — an IPv4-only filter rejects its IPv6 source
address, and the error surfaces as a misleading "Invalid API Token".)

Both resolvers in `/etc/dokploy/traefik/traefik.yml`. **They must not share one
storage file:**

```yaml
certificatesResolvers:
  letsencrypt:                    # HTTP-01 — issued every current certificate
    acme:
      email: <you>
      storage: /etc/dokploy/traefik/dynamic/acme.json
      httpChallenge:
        entryPoint: web
  letsencrypt-dns:                # DNS-01 — the wildcard
    acme:
      email: <you>
      storage: /etc/dokploy/traefik/dynamic/acme-dns.json
      dnsChallenge:
        provider: cloudflare
        resolvers: ["1.1.1.1:53", "8.8.8.8:53"]
```

`CF_DNS_API_TOKEN` goes in the **Traefik container's** environment. Then the
wildcard as the default certificate:

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

### 3.3 Teach Traefik who the client is

Behind a proxy every request arrives from a Cloudflare address. Without
trusting the forwarded headers, rate limits, audit records and any future
IP-based rule all record **Cloudflare instead of the user** — wrong in a way
that looks completely fine.

On both entry points in `/etc/dokploy/traefik/traefik.yml`:

```yaml
entryPoints:
  web:
    address: :80
    forwardedHeaders:
      trustedIPs: &cloudflare
        - 173.245.48.0/20
        - 103.21.244.0/22
        # … all 22 ranges from https://www.cloudflare.com/ips/ (15 v4 + 7 v6)
  websecure:
    address: :443
    forwardedHeaders:
      trustedIPs: *cloudflare
```

Trust **only** Cloudflare's ranges. Trusting everything lets any client forge
`X-Forwarded-For` and impersonate another address.

The app then reads `cf-connecting-ip` first (`lib/auth.ts`). That header is set
by Cloudflare and cannot be influenced by the client — but it is trustworthy
*because* of the origin lock in §3.5. Without the lock, anyone reaching the
origin directly could set it to anything and forge their address in audit
records and rate-limit buckets.

### 3.4 The Dokploy panel: proxied, behind Access

The original plan left the panel unproxied, reasoning that your recovery tool
should not sit behind the thing that might break. Sound instinct, wrong tool:
leaving it unproxied leaves the origin IP reachable, which is the entire
problem being solved. **The real recovery path is SSH** — the lock writes only
to `DOCKER-USER` and never touches `INPUT`, so no Cloudflare or Access failure
can cost you the box.

So the panel is proxied like everything else, with Cloudflare Access in front.
Three applications on `dokploy.mitosia.cloud`:

| Application | Path | Policy | Why |
|---|---|---|---|
| `Dokploy` | whole host | **Allow** → your email | the panel itself |
| `Dokploy webhooks` | `/api/deploy` | **Bypass** → Everyone | GitHub cannot log in |
| `Dokploy webhooks 2` | `/api/webhook` | **Bypass** → Everyone | same |

Login uses the built-in **Cloudflare** identity provider — your Cloudflare
account and its MFA, not a one-time email PIN. The Access login page therefore
shows a single "Cloudflare" button which leads to the normal Cloudflare account
login. **That is correct, not a misconfiguration.**

Keep the bypasses path-scoped. They are the only unauthenticated surface on the
panel.

> **Access changed what your scripts see.** Any call to the Dokploy API now
> returns a `302` to `*.cloudflareaccess.com` instead of the API. Tooling that
> only checks for a non-error status reads the login page as success — the same
> failure shape as everything else in this system. For automation, create a
> Cloudflare **service token** and add a Service Auth policy. Do **not** widen
> the bypass paths to make a script work.

### 3.5 Lock the origin

Until this step anyone who knows the IP bypasses Cloudflare entirely — and the
IP is already public in DNS history.

```bash
sudo bash cloudflare-origin-lock.sh           # dry run, prints the plan
sudo bash cloudflare-origin-lock.sh --apply
sudo bash cloudflare-origin-lock.sh --status  # what is in force now
sudo bash cloudflare-origin-lock.sh --open    # undo
```

Run it **on the VPS as root** (`scripts/cloudflare-origin-lock.sh` in this
repo; stage a copy at `/root/`). Current state: **16 IPv4 + 8 IPv6 rules** in
`DOCKER-USER`.

**Why not ufw — this cost a full attempt.** Traefik's 80/443 are
*Docker-published*, so packets are DNAT'd into the container through Docker's
own chains and **never traverse `INPUT`**. A ufw rule for those ports is inert.
The first version of this script wrote ufw rules, reported success, and changed
nothing at all. Docker provides `DOCKER-USER` for exactly this, evaluated
before its own rules. For the same reason the Dokploy panel's port 3000 must
stay **unpublished** — publishing it would bypass any host firewall entirely.

### 3.6 Make it survive a reboot — and mind the trap

iptables rules live in memory. The obvious fix has a sharp edge:

> **`apt install iptables-persistent` removes `ufw`.** They conflict, apt
> resolves it silently, and whatever ufw was doing is gone. Here that was SSH
> rate limiting — which had to be rebuilt by hand, for **both** address
> families, on a dual-stack host.

```bash
# restore SSH rate limiting explicitly after installing iptables-persistent
iptables  -I INPUT -p tcp --dport 22 -m state --state NEW -m recent --set --name SSH
iptables  -I INPUT -p tcp --dport 22 -m state --state NEW \
  -m recent --update --seconds 30 --hitcount 7 --name SSH -j DROP
ip6tables -I INPUT -p tcp --dport 22 -m state --state NEW -m recent --set --name SSH
ip6tables -I INPUT -p tcp --dport 22 -m state --state NEW \
  -m recent --update --seconds 30 --hitcount 7 --name SSH -j DROP

netfilter-persistent save    # nothing above survives a reboot without this
```

Current state: **2 IPv4 + 2 IPv6** rules on port 22, saved to
`/etc/iptables/rules.v{4,6}`. Then **reboot once and re-verify** rather than
assuming the save worked.

Consequence to remember: port 22 allows 6 new connections per 30s, so **SSH
polling loops lock you out for minutes.** Poll over HTTPS or against the
database; keep SSH to single checks.

---

## 4. Verifying it is healthy

Run these after any change to Cloudflare, Traefik, or the firewall.

**Config shape, certificates, trusted IPs** — one command, asserts against the
live box:

```bash
pnpm check:traefik
```

Exit 0 = healthy. Exit 1 = drift. **Exit 2 = host unreachable**, which is not
the same as drift and should not be read as one. It checks `trustedIPs`, both
resolvers, the default wildcard cert, and fails if any certificate is inside 21
days of expiry.

**The origin refuses non-Cloudflare traffic.** Run this from a machine that is
not the VPS, and read curl's **exit code**, not its output:

```bash
out=$(curl -m 12 -sI -k --resolve staging.mitosia.cloud:443:72.61.169.154 \
  https://staging.mitosia.cloud/ 2>&1); rc=$?
case $rc in
  28) echo "blocked (expected)" ;;
   0) echo "SERVED — the lock is not working" ;;
   *) echo "other failure: $rc" ;;
esac
```

Two things that will fool you here:

- **Do not pipe curl into `head`** to read the result. `$?` then belongs to
  `head`, which succeeds, and a blocked origin reports exit 0 — the test says
  "reachable" precisely when it is not.
- **This test is meaningless from the VPS itself.** The lock rules match on the
  WAN interface, so traffic originating on the box bypasses them entirely and
  the origin answers normally — even on its public IP. That is expected and
  does *not* mean the lock is broken.

Use `--resolve`, not a bare `https://<ip>/`. Without SNI, Traefik answers with
its default certificate and the result tells you nothing about the lock.

**The site serves through Cloudflare:**

```bash
curl -m 10 -sI https://staging.mitosia.cloud/ | grep -iE '^(HTTP|server|cf-ray)'
# server: cloudflare
# cf-ray: …-SIN
```

**The app sees real client IPs.** This is the assertion that catches a broken
`trustedIPs`, and it is invisible in the UI — everything works, the addresses
are just quietly wrong:

```sql
select ip_address, created_at, updated_at from session order by created_at desc limit 5;
```

Two traps when re-running it:

- **A visit while already signed in only refreshes the row.** `updated_at`
  moves; `ip_address` does not, because it is written at session *creation*
  only. Sign out first, or use a private window — otherwise the check appears
  to run and proves nothing.
- **IPv6 is stored as the /64 prefix with the interface identifier zeroed**
  (`2405:201:d014:c9bb::`), while Cloudflare's edge sees the full address —
  compare at `https://staging.mitosia.cloud/cdn-cgi/trace`. Nothing in
  `lib/auth.ts` does that; it is Better Auth's own normalisation, and /64 is
  the right unit: privacy extensions rotate the low 64 bits constantly, so a
  full-address rate-limit bucket is free to evade while a /64 maps to one
  subscriber. **Not a bug — do not "fix" it.**

An **empty** `ip_address` is the real failure signal. It means no client IP was
resolved at all, which also silently drops rate limiting into a single shared
per-path bucket where one abusive client consumes the limit for everybody.

**Verified 2026-08-17:** fresh sign-in recorded `2405:201:d014:c9bb::` — the
client's own network, not a Cloudflare range (`2400:cb00::/32`,
`2606:4700::/32`).

---

## 5. When it breaks

### 5.0 The one thing to remember

**SSH always works.** Nothing in this system touches port 22 — the lock writes
only to `DOCKER-USER`, never `INPUT`. If you can think of nothing else:

```bash
ssh mitosia-vps
```

Do not start changing Cloudflare settings before you have looked at the origin.

### 5.1 Triage: which layer?

Work outside in. Each command isolates one layer.

```bash
# 1. DNS — are we still pointed at Cloudflare?
dig +short A staging.mitosia.cloud      # expect Cloudflare IPs (104.x / 172.6x)
dig +short NS mitosia.cloud             # expect brad/haley.ns.cloudflare.com

# 2. Edge — is Cloudflare answering at all?
curl -m 10 -sI https://staging.mitosia.cloud/ | head -1

# 3. Origin — is it up, and does it serve from behind the lock?
ssh mitosia-vps 'uptime -p; docker ps --format "{{.Names}}\t{{.Status}}"'

# 4. Origin TLS directly (from the VPS itself, which the lock does not block)
ssh mitosia-vps 'curl -m 10 -sI --resolve staging.mitosia.cloud:443:127.0.0.1 \
  https://staging.mitosia.cloud/ | head -1'
```

If 4 succeeds but 2 fails, the problem is between Cloudflare and the origin —
almost always the lock (§5.2). If 4 fails too, it is the origin's own stack,
and Cloudflare is innocent.

Step 4 uses loopback deliberately. From the VPS the lock does not apply (its
rules match the WAN interface), so this asks "is Traefik serving?" without the
firewall confounding the answer — which is exactly what you want to know first.

### 5.2 Cloudflare error codes — what each one means here

| Code | Meaning | Most likely cause in this system | Fix |
|---|---|---|---|
| **522** | Connection timed out | The lock is dropping Cloudflare — they added IP ranges we do not allow | Re-run the lock script (§5.3) |
| **521** | Web server is down | Traefik or the app container is not running | `docker ps`, restart |
| **525** | SSL handshake failed | Traefik not serving TLS on 443 | Check Traefik logs |
| **526** | Invalid SSL certificate | the origin's certificate expired or went invalid | `pnpm check:traefik`, §5.4 |
| **502/504** | Bad gateway / timeout | App container up but not answering | App logs; check the database |
| **302** to `cloudflareaccess.com` | Access is doing its job | A script hit the Dokploy API | Service token, §3.4 |

**522 is the one this architecture makes likely.** Cloudflare publishes new IP
ranges occasionally; when they do, edge servers in the new range get dropped by
our own firewall. The symptom is intermittent — only the new PoPs fail — which
makes it look like a flaky origin.

### 5.3 Emergency: get back online now

In increasing order of "gives up a property we wanted". Try in order.

**A. Re-run the origin lock** — fixes stale Cloudflare ranges, the most likely
cause of a sudden 522, and gives up nothing:

```bash
ssh mitosia-vps
sudo bash /root/cloudflare-origin-lock.sh --status   # look first
sudo bash /root/cloudflare-origin-lock.sh --apply    # re-fetch ranges, rewrite
sudo netfilter-persistent save
```

**B. Open the origin** — removes the Cloudflare-only restriction. The site is
reachable directly again; you have given up the guarantee that nobody bypasses
the edge, and gained a working site:

```bash
sudo bash /root/cloudflare-origin-lock.sh --open
sudo netfilter-persistent save
```

**C. Take Cloudflare out of the path.** Grey-cloud the record (Cloudflare
dashboard → DNS → click the orange cloud), or zone-wide via Overview →
Advanced → **Pause Cloudflare on Site**. DNS then points straight at
`72.61.169.154`.

> **This works because of the certificate choice in §3.2.** The origin holds a
> real, publicly trusted Let's Encrypt wildcard, so browsers reaching it
> directly see a valid certificate and nothing about this step is user-visible.
> Do **B** before **C**, or the direct traffic hits a locked origin.
>
> Understand what you are giving up: this restores the exact condition that
> started all of this. **Jio users will not be able to reach the site.** It is
> a diagnostic step and a short-term bridge, not a resting state.

**D. Nameservers back to Hostinger.** The bottom of the stack, for when you
have lost access to the Cloudflare account itself. Because the zone's NS point
at Cloudflare, losing that account means losing all DNS control — but the
**registrar is Spaceship**, and the registrar always wins. Change the
nameservers at Spaceship back to Hostinger's (`*.dns-parking.com`), where the
original A records still exist. Propagation is not instant; this is a last
resort, not a quick fix. Do **B** first.

### 5.4 Certificate problems

**Two renewal paths can fail, and they fail for different reasons** (§3.2):

- **Per-host certs, via HTTP-01** — what `staging` and `dokploy` actually
  serve. Breaks if a redirect, WAF or cache rule starts matching
  `/.well-known/acme-challenge/`, or if port 80 stops reaching the origin.
- **The wildcard, via DNS-01** — the fallback for hosts without their own.
  Breaks if `CF_DNS_API_TOKEN` is revoked, expires, or loses its zone scope.

Both fail **silently and late**: a certificate stops renewing now and stops
*working* up to 90 days later. `pnpm check:traefik` fails at 21 days remaining
specifically to turn that into a warning rather than an outage.

```bash
pnpm check:traefik            # expiry + config shape
ssh mitosia-vps 'docker logs dokploy-traefik --tail 100 2>&1 | grep -i "acme\|error"'

# which certificate is each host actually serving? (run on the VPS —
# through Cloudflare you would see the edge's cert, not the origin's)
ssh mitosia-vps 'echo | openssl s_client -connect 127.0.0.1:443 \
  -servername staging.mitosia.cloud 2>/dev/null \
  | openssl x509 -noout -issuer -subject -ext subjectAltName -enddate'

# is the HTTP-01 challenge path still reaching the origin?
curl -m 15 -sS -D- http://staging.mitosia.cloud/.well-known/acme-challenge/probe
# want: 404, empty body, cf-cache-status: DYNAMIC, no Location header
```

If the token is the problem, mint a new one (Zone → DNS → Edit, this zone
only), update `CF_DNS_API_TOKEN` in the Traefik container's environment, and
restart it. **Traefik is a plain container, not a swarm service:**

```bash
docker restart dokploy-traefik            # correct
docker service update --force dokploy-traefik   # WRONG — "no such service"
```

To force reissue, stop Traefik, move the relevant storage file aside —
`acme.json` for per-host HTTP-01 certs, `acme-dns.json` for the wildcard; they
are deliberately separate and must stay that way — then start it again. Let's
Encrypt rate limits apply, so do not loop on this.

### 5.5 Locked out of the Dokploy panel

Access sits in front of it, so a bad Access policy or a lost Cloudflare account
locks you out of the panel. It does **not** lock you out of the box.

```bash
ssh mitosia-vps
docker ps                                        # what is running
docker service ls
docker service logs mitosia-staging-uxa95i --tail 100
docker service update --force mitosia-staging-uxa95i   # redeploy current spec
```

Everything Dokploy does is `docker service …` underneath. The panel is
convenience, not control.

### 5.6 Deploys stopped firing

GitHub's webhook reaches `/api/deploy` and `/api/webhook` through the two
Bypass policies. If someone tightens or reorders those policies, deploys stop —
**silently**, because GitHub gets a `302` to a login page and considers it
delivered.

```bash
# both should pass through Access (401 from Dokploy itself, not a 302)
curl -m 10 -so /dev/null -w '%{http_code}\n' https://dokploy.mitosia.cloud/api/deploy/github
curl -m 10 -so /dev/null -w '%{http_code}\n' https://dokploy.mitosia.cloud/api/webhook/github
```

A `302` to `*.cloudflareaccess.com` means the bypass is broken. Confirm the
whole path by merging something and watching for a new task:

```bash
ssh mitosia-vps 'docker service ps mitosia-staging-uxa95i --format "{{.CurrentState}}" | head -3'
```

And check it did not deploy-then-rollback, which looks identical to never
having deployed:

```bash
ssh mitosia-vps 'docker service inspect mitosia-staging-uxa95i \
  --format "{{.UpdateStatus.State}} {{.UpdateStatus.Message}}"'
```

### 5.7 Client IPs wrong or empty

Symptom: `session.ip_address` empty, or carrying a Cloudflare address. Cause is
almost always `trustedIPs` — missing, or not covering a new Cloudflare range.
See §4 for the query and its two traps; `pnpm check:traefik` asserts the
config side.

---

## 6. Routine maintenance

| When | Do | Why |
|---|---|---|
| Cloudflare publishes new IP ranges | Re-run the lock script, `netfilter-persistent save` | Otherwise new edge PoPs get dropped → intermittent 522 |
| Any Traefik / firewall / Cloudflare change | `pnpm check:traefik` | Catches drift before users do |
| After any iptables change | `netfilter-persistent save` | Rules are in memory; a reboot loses them |
| Quarterly | Rotate `CF_DNS_API_TOKEN` | Scoped, but it is DNS-edit rights on a box |
| Before `mitosia.com` goes live | Replicate MX/SPF/DKIM **first**, then move NS | Unreplicated records stop existing at cutover |

---

## 7. What this does not fix

Cloudflare's edge still has to reach the origin. If Hostinger's address becomes
unroutable from Cloudflare's network too, the site is down regardless. That is
far less likely than one consumer ISP having a bad route — Cloudflare's transit
is not a consumer ISP — but it is why the origin's own health still matters,
and why §5.3 keeps a path back to a directly reachable origin.

It also does not fix a bad origin. Cloudflare will faithfully serve your 502.

---

## 8. Related decisions

- `AGENTS.md` → "Environments and deployment" — the short form of everything here.
- `scripts/cloudflare-origin-lock.sh` — the lock, with its reasoning in the header.
- `scripts/check-traefik-config.mjs` — the drift check.
- `infra/traefik/` — reference copies of the live Traefik config.
- `lib/auth.ts` — why `cf-connecting-ip` is read first, and why it is trustworthy.
