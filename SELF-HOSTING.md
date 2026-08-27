# Self-hosting A2HA without Pinata

Pinata provides four things this template leans on: a container, secret
injection, a public HTTPS gateway with per-route auth, and the chat channel
plumbing. Replace those and everything here runs anywhere.

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

### Port 4322 has no authentication of its own

On Pinata, the gateway holds that door shut. Self-hosted, **nothing does.**
Anyone who reaches 4322 can read every pad, mint links, and fire your devices.

The right shape is to bind **both** ports to loopback and let a reverse proxy
decide what the world sees:

```bash
HOST=127.0.0.1 node src/index.js
```

`HOST` applies to both listeners, so nothing is reachable from outside the box.
The proxy then publishes 4321 and either keeps 4322 to itself or puts auth in
front of it. Verified: with `HOST=127.0.0.1` the servers bind `127.0.0.1` only.

If you skip the proxy entirely, bind loopback anyway and drive it over SSH with
the CLI — you lose the config app but nothing else.

Never publish 4322 the way you publish 4321.

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
and optionally `HA_AGENT_ID`, `PUBLIC_BASE_URL`, `HA_FILES_*` — and set them
however your Hermes install expects.

**Nothing runs `scripts.build` / `scripts.start`.** Run `npm ci --omit=dev`
once, and start `src/index.js` yourself — the systemd unit above is fine
alongside Hermes.

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
