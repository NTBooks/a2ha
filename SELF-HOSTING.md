# Self-hosting A2HA without Pinata

> ## ⚠️ Read this before you expose anything
>
> **The admin API on port 4322 can read every pad, mint guest links, and fire
> every device you have wired up. It is not a settings page — it is a remote
> control for your house.**
>
> On Pinata, the gateway demands a token before anything reaches it. **Off
> Pinata, there is no gateway.** A port-forward, a `docker run -p 4322:4322`, or
> a reverse proxy rule copied from the wrong line, and it is an unauthenticated
> remote control on the open internet.
>
> The code now defaults to safe, so you have to go out of your way to get this
> wrong:
>
> - **Off Pinata, the admin port binds to `127.0.0.1` by default.** Not
>   reachable from another machine at all.
> - To expose it you must set `ADMIN_HOST` **and** it will warn loudly on every
>   boot unless you also set `ADMIN_TOKEN`.
> - With `ADMIN_TOKEN` set, non-loopback requests need it — as `?token=`, a
>   `Bearer` header, or the cookie it sets on first use. Loopback stays exempt
>   so the CLIs keep working.
>
> **Port 4321 is the opposite and that is fine.** Guest pads are meant to be
> public; a link only reaches the buttons on one pad, expires, and can be
> revoked. Publish 4321. Do not publish 4322.

There are two modes, and most people want the first.

---

## Mode 1 — Guest pads only, no agent at all

**The pad server is a plain Node app with no dependencies and no LLM.** If what
you want is the guest-access feature — a link that expires, big buttons, no
access to the rest of the house — you do not need an agent, an API key, or
Pinata. Nothing in this mode costs anything to run.

```bash
git clone https://github.com/NTBooks/a2ha.git
cd a2ha/workspace/projects/speeddial
npm ci --omit=dev

HA_BASE_URL=http://homeassistant.local:8123 \
HA_TOKEN=your_long_lived_token \
PUBLIC_BASE_URL=https://pads.example.com \
node src/index.js
```

Two ports come up:

| Port | Serves | Who should reach it |
|---|---|---|
| 4321 | guest pads (`/r/<token>`) | the internet — that's the point |
| 4322 | config app and API | **you only** |

Build pads with the CLI, which talks to 4322 on loopback:

```bash
node ../../bin/pads.mjs new guest --title "Guest room"
node ../../bin/pads.mjs set guest 1 --entity "Porch light"
node ../../bin/pads.mjs share guest --ttl 7
```

`ha.mjs` works the same way for everything else — `ha assist "turn on the porch
light"`, `ha automation put`, `ha dashboard-create`, and so on. All of it is
plain HTTP to Home Assistant; none of it involves a model.

### Port 4322: see the warning at the top

Short version: off Pinata it binds to loopback by default and you should leave
it there. If you need it from another machine, set both:

```bash
ADMIN_TOKEN=$(openssl rand -hex 24) ADMIN_HOST=0.0.0.0 node src/index.js
```

Then reach it at `https://your-host/admin?token=<that value>` — it sets a
cookie on first use, so the token only appears in the URL once.

Better still, leave it on loopback and let a reverse proxy with its own auth be
the only way in. Belt and braces: do both.

### A reverse proxy that gets this right

```caddy
# Guest pads: public, and must stay reachable from anywhere.
pads.example.com {
    reverse_proxy 127.0.0.1:4321
}

# Config app: behind auth. Generate the hash with: caddy hash-password
admin.example.com {
    basic_auth {
        you $2a$14$...replace.me...
    }
    reverse_proxy 127.0.0.1:4322
}
```

Set `PUBLIC_BASE_URL=https://pads.example.com` so minted links point at the
public host. Routing tolerates a path prefix either way, so
`https://example.com/pad` works too if you'd rather use one hostname.

### Keeping it running

```ini
# /etc/systemd/system/a2ha.service
[Unit]
Description=A2HA guest pads
After=network-online.target

[Service]
WorkingDirectory=/opt/a2ha/workspace/projects/speeddial
Environment=HA_BASE_URL=http://homeassistant.local:8123
Environment=PUBLIC_BASE_URL=https://pads.example.com
EnvironmentFile=/etc/a2ha.env      # HA_TOKEN lives here, chmod 600
ExecStart=/usr/bin/node src/index.js
Restart=always
User=a2ha

[Install]
WantedBy=multi-user.target
```

State lives in `workspace/data/` — pads, share tokens and backups. Back that up;
it is the only copy.

---

## Mode 2 — The full agent, on self-hosted Hermes

[Hermes](https://github.com/NousResearch/hermes-agent) is open source and MIT
licensed, so the conversational half runs off Pinata too.

Install Hermes per its own docs, then treat `workspace/` here as its workspace:
copy `AGENTS.md`, `SOUL.md`, `HA.md`, `HA-BUILD.md`, `PADS.md`, `bin/` and
`projects/` into it, keeping the layout.

Four things change, because they were Pinata's job:

**`manifest.json` does nothing.** Hermes has its own config. Take from the
manifest only the list of environment variables — `HA_BASE_URL`, `HA_TOKEN`,
and optionally `HA_AGENT_ID`, `PUBLIC_BASE_URL`, `HA_SSH_*` — and set them
however your Hermes install expects.

**Nothing runs `scripts.build` / `scripts.start`.** Run `npm ci --omit=dev`
once in `workspace/` (the `ssh2` package, needed only for `ha file`) and once in
`workspace/projects/speeddial/`, then start `src/index.js` yourself — the systemd
unit above is fine alongside Hermes.

**Paths.** Every doc says `/home/hermes/data/workspace/...` because that is
where Pinata puts it. If yours differs, the tools still work — they resolve
their own location — but the paths written in `AGENTS.md` will be wrong, so
update them or the agent will report commands as missing.

**Channels.** Hermes has its own Telegram/Discord/Slack support; use it instead
of Pinata's Channels tab. The same warning applies: require pairing or an allow
list. This bot has admin control of a house.

**Tailscale.** `setup.sh` and `start.sh` bring up userspace Tailscale because
Pinata's container cannot reach a private network otherwise. Self-hosting on a
box that already sees Home Assistant, skip both: leave `TS_AUTHKEY` unset and
point `HA_BASE_URL` straight at it.

---

## What you give up

Honest list, since the point of self-hosting is knowing what you own:

- **TLS, DNS and uptime are yours.** Pinata's gateway did those.
- **`/admin` has no auth of its own.** See above. This is the one that bites.
- **No snapshots.** Pinata versioned the workspace; back up `workspace/data/`.
- **`self-update.sh` expects a git-backed workspace.** Self-hosted, `git pull`
  in your checkout instead.

## What you gain

- No per-agent cost, and the LLM provider is entirely your choice — including a
  local model on the same box.
- Home Assistant need never be reachable from outside your own network. Only
  port 4321 has to face the internet, and it only exposes buttons you chose.
