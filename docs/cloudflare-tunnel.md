# Exposing the local router to GitHub webhooks (Cloudflare Tunnel)

GitHub delivers webhooks by making an HTTPS request to a **public** URL. SWARM's
router (`src/router`, port `3000` by default) runs on your own machine inside the
Docker Compose stack (see [`README.md`](../README.md) → "Running the stack"), so it
has no public address of its own. A **Cloudflare Tunnel** bridges that gap: it opens
an outbound-only connection from your machine to Cloudflare's edge and gives you a
public HTTPS URL that forwards straight to `http://localhost:3000`. No inbound ports,
no port-forwarding, no static IP.

```
GitHub ──webhook──▶ https://<your-tunnel>.trycloudflare.com  (Cloudflare edge)
                                     │  (outbound tunnel, initiated by your machine)
                                     ▼
                         cloudflared ──▶ http://localhost:${ROUTER_PORT:-3000}  (Router)
```

> **Scope.** The tunnel is **external infrastructure, not SWARM code** — SWARM never
> builds, ships, or manages it, and this document is the whole of SWARM's involvement
> (`ai/ARCHITECTURE.md` calls the tunnel "external, not our concern — just a public
> HTTPS URL pointed at the router"). Everything else — router, worker, Postgres, Redis
> — stays local; the tunnel only ever forwards webhook payloads inbound and the
> router's responses back. Source code never crosses it.

---

## Prerequisites

- The SWARM Docker Compose stack running locally, with the router healthy:
  `curl http://localhost:3000/health` → `{"status":"ok","service":"router"}`.
  (Adjust the port if you set `ROUTER_PORT` in `.env`.)
- A Cloudflare account (free tier is enough).
- `cloudflared` installed:
  ```bash
  # macOS
  brew install cloudflared
  # Debian/Ubuntu
  # see https://pkg.cloudflare.com/ — or download the .deb from the cloudflared releases page
  ```
- **For a named tunnel only** (Path B): a domain managed by Cloudflare DNS (i.e. its
  nameservers point at Cloudflare). A quick tunnel (Path A) needs no domain.

---

## Path A — Quick tunnel (ephemeral, for local dev)

The fastest way to get a public URL. No account login, no domain, no config file.
The catch: the hostname is **random and changes every time you restart**
`cloudflared`, so you have to re-point the GitHub webhook each time. Fine for a
one-off test; annoying for day-to-day work (use Path B for that).

```bash
cloudflared tunnel --url http://localhost:3000
```

`cloudflared` prints a line like:

```
https://random-words-1234.trycloudflare.com
```

That is your public base URL. Leave the process running; it forwards to the router
for as long as it's up. Skip to [Configure the GitHub webhook](#configure-the-github-webhook).

---

## Path B — Named tunnel (stable URL, recommended for ongoing use)

A named tunnel is tied to your Cloudflare account and a DNS record you control, so the
hostname (e.g. `swarm.example.com`) stays the same across restarts — you configure the
GitHub webhook once and forget it.

1. **Authenticate** `cloudflared` with your Cloudflare account (opens a browser):
   ```bash
   cloudflared tunnel login
   ```
   Pick the zone (domain) you want to use; this writes a cert to `~/.cloudflared/`.

2. **Create the tunnel** (do this once; pick any name):
   ```bash
   cloudflared tunnel create swarm-router
   ```
   This prints a tunnel **UUID** and writes a credentials file to
   `~/.cloudflared/<UUID>.json`.

3. **Route a DNS hostname** to the tunnel:
   ```bash
   cloudflared tunnel route dns swarm-router swarm.example.com
   ```

4. **Write a config file** at `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: swarm-router
   credentials-file: /Users/<you>/.cloudflared/<UUID>.json

   ingress:
     - hostname: swarm.example.com
       service: http://localhost:3000   # match ROUTER_PORT if you changed it
     - service: http_status:404          # required catch-all
   ```

5. **Run the tunnel:**
   ```bash
   cloudflared tunnel run swarm-router
   ```
   To keep it running across reboots, install it as a service:
   `sudo cloudflared service install` (see the Cloudflare docs for your OS).

Your stable base URL is now `https://swarm.example.com`.

---

## Configure the GitHub webhook

The router will expose its webhook endpoint at **`/github/webhook`** (matching the
reference project, Cascade). So the GitHub **Payload URL** is your tunnel base URL plus
that path, e.g. `https://swarm.example.com/github/webhook`.

> **Status note.** The router's webhook receiver, signature verification, and job
> enqueue land in **SWARM-9** (issue #9). Until then the router only answers `/health`,
> so a delivery to `/github/webhook` returns `404` — that still proves the tunnel works
> end-to-end (the request reached your machine). Wire up the webhook now if you want the
> plumbing ready; expect real processing once SWARM-9 merges.

### Repo-level events (`pull_request`, `pull_request_review`, `issue_comment`, `check_suite`)

Repo Settings → **Webhooks** → **Add webhook**:

- **Payload URL**: `https://<your-tunnel>/github/webhook`
- **Content type**: `application/json`
- **Secret**: a strong random string. Keep it — the router verifies GitHub's
  HMAC-SHA256 signature (`X-Hub-Signature-256`) against it (SWARM-9; `PROJECT.md` §6.1,
  "Webhook verification: standard GitHub HMAC signature verification at the router").
  Store it wherever the router reads its config (e.g. an env var / Postgres project row),
  never commit it.
- **Which events**: "Let me select individual events" → tick **Pull requests**, **Pull
  request reviews**, **Issue comments**, and **Check suites**. These are the four repo
  events the router adapter parses (`ai/ARCHITECTURE.md`, SCM section).

### Projects v2 board event (`projects_v2_item`)

GitHub Projects (v2) boards are owned by the **user or org**, not the repo, so the
`projects_v2_item` event — the one that fires when a card's **Status** changes and drives
the pipeline — is **not** available on a repo webhook. It is **also not** available as a
plain user-account webhook: GitHub *"[cannot] create webhooks for individual user
accounts,"* and a personal account's **Settings → Developer settings** has no "Webhooks"
entry at all. The event's docs list it as an **organization** webhook event, or one
delivered to a **GitHub App** that holds the Projects org permission. So the second,
non-repo subscription depends on who owns the board:

- **User-owned board** (SWARM's default — project `3` is owned by user `jkwiecien`): there is
  no user-level webhook to add. Receive the event either via a **GitHub App** installed on
  the account and subscribed to `projects_v2_item` (the App has its own webhook URL — point
  it at the same tunnel path), or by recreating the board under an **org** (below).
- **Org-owned board:** **Org Settings → Webhooks → Add webhook** — same Payload URL, content
  type, and secret as the repo webhook; select the **Projects v2 item** event.

(This is the equivalent of Cascade's `pm:status-changed` trigger — see
`ai/ARCHITECTURE.md`, PM section. `docs/github-projects-v2-api.md` §5 is the authoritative
detail on this event's delivery scope.)

---

## Verify it works

1. **Tunnel reachable** — hit the router's health check *through* the tunnel:
   ```bash
   curl https://<your-tunnel>/health
   # → {"status":"ok","service":"router"}
   ```
   A `200` here means GitHub can reach your router.

2. **Webhook delivery** — in the webhook's settings page, open **Recent Deliveries**.
   GitHub sends a `ping` on creation; use **Redeliver** to replay it. A `2xx` (once
   SWARM-9 is in) or a `404` (before it) both confirm the request reached your machine;
   a timeout/`5xx` at the Cloudflare layer means the tunnel or the router is down.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `curl https://<tunnel>/health` times out | `cloudflared` not running, or pointed at the wrong port — confirm it forwards to the same port the router publishes (`ROUTER_PORT`). |
| Health check works locally but not via tunnel | Router is bound inside Docker but the host port isn't published, or `cloudflared` targets `localhost` on a machine where the port isn't mapped. Check `docker compose ps` and the `ROUTER_PORT` mapping. |
| GitHub delivery shows `couldn't connect` | Quick-tunnel URL changed after a restart (Path A) — grab the new URL and update the Payload URL, or switch to a named tunnel (Path B). |
| Deliveries arrive but signature checks fail (post-SWARM-9) | Webhook **Secret** in GitHub doesn't match the secret the router is configured with. |
| No `projects_v2_item` deliveries when moving cards | That event never rides the repo webhook — it comes via a **GitHub App** (user-owned board) or an **org** webhook, not a user-account webhook (which GitHub doesn't offer) — see above. |

---

## Teardown

- **Quick tunnel**: `Ctrl-C` the `cloudflared` process. The URL is gone immediately.
- **Named tunnel**: stop `cloudflared tunnel run` (or `sudo cloudflared service uninstall`),
  then optionally `cloudflared tunnel delete swarm-router` and remove the DNS record.
- Remove or disable the webhook(s) in GitHub if you no longer want deliveries queuing up
  failed attempts.
