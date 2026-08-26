# A2HA — Assistant to the Home Assistant

A Pinata agent that runs your house from chat, and hands guests a locked-down
pad of buttons through a link that expires when you say so.

Two halves, one agent:

**Talk to your house.** Ask what's on, turn things off, write an automation.
The agent holds a Home Assistant long-lived token and can read state, call
services, and create or edit automations, scripts, scenes and helpers.

**Hand out a pad.** Build a named set of numbered buttons — "porch light",
"living room lamp", "movie night" — and mint a link to it. Whoever opens the
link gets big buttons and nothing else. No account, no app, no access to the
rest of your house.

The pad idea is lifted from the speed dial feature in
[Fanad](https://fanad.org), where it earned its keep.

## Why the pad is safe

The security property is narrow and worth stating exactly: **a guest only ever
transmits a button number.** Nothing a guest types reaches Home Assistant,
because there is nothing to type.

Concretely, the guest page contains the button numbers and the labels you wrote
and nothing else — no entity ids, no service names, no on/off state, no other
pad. It's `noindex` and `no-store`, and loading it fires nothing, so a chat app
generating a link preview can't turn on your lights. Share tokens are stored as
a SHA-256 hash, so the link is shown to you once and cannot be recovered from
the agent afterwards. Expiry and revocation are checked on every single request,
not just at page load, so revoking kills a link on the guest's next tap.

There's also no LLM in the fire path. A button press is `token → slot lookup →
Home Assistant REST call`. That makes presses deterministic, fast, and free —
a house-sitter mashing buttons for a week costs no tokens at all. The model is
only involved when *you* talk to the agent.

## Setup

### 1. Decide how the agent reaches Home Assistant

The agent runs in Pinata's cloud, not on your LAN. Two ways to bridge that.

**Tailscale (recommended).** The agent joins your tailnet and Home Assistant
never gets a public URL at all. Set `TS_AUTHKEY` and the agent brings up
Tailscale on boot; `HA_BASE_URL` then points at a tailnet address.

Get Home Assistant onto your tailnet first, whichever fits:

- *Home Assistant OS* — install the **Tailscale add-on** (Settings → Add-ons →
  Add-on Store → Tailscale). HA gets its own node and MagicDNS name, so
  `HA_BASE_URL=http://homeassistant.your-tailnet.ts.net:8123`. This is the
  cleanest option: nothing else on your LAN becomes reachable.
- *HA behind another Tailscale machine* (e.g. a Proxmox host running HA in a
  VM) — make that machine a **subnet router**:
  `tailscale up --advertise-routes=192.168.1.0/24`, then approve the route in
  the [admin console](https://login.tailscale.com/admin/machines). The agent
  runs with `--accept-routes`, so `HA_BASE_URL=http://192.168.1.50:8123` then
  works. Note this exposes the whole advertised subnet to your tailnet, so
  prefer the add-on if HA can run one.

Generate the auth key at
[Settings → Keys](https://login.tailscale.com/admin/settings/keys). Mark it
**Reusable** and **Ephemeral** — the agent registers a throwaway node on each
boot and Tailscale reaps the old one, so no node key ever has to be persisted
into the workspace.

**Public URL.** Nabu Casa, Cloudflare Tunnel, DuckDNS — anything giving HA a
public HTTPS hostname. Leave `TS_AUTHKEY` blank and point `HA_BASE_URL` at it.
If you go through a proxy or tunnel, set `trusted_proxies` in your HA
`configuration.yaml` or every API call comes back 400.

### 2. Make a token

In Home Assistant: profile (bottom left) → **Security** → **Long-lived access
tokens** → **Create token**.

Use a **dedicated admin user** for this, not your own account. The agent needs
admin rights to write automations, and a separate user means you can revoke it
without disturbing your own sessions.

### 3. Create the agent

Point Pinata at this repo, then attach the secrets:

| Secret | Required | What it is |
|---|:--:|---|
| `HA_BASE_URL` | yes | tailnet address or public URL — no trailing slash |
| `HA_TOKEN` | yes | the long-lived token from step 2 |
| `TS_AUTHKEY` | no | Tailscale auth key — reusable + ephemeral |
| `TS_HOSTNAME` | no | what the agent is called in your tailnet (default `a2ha`) |
| `HA_AGENT_ID` | no | a specific HA Assist agent, for `--say` buttons |
| `HA_FILES_URL` | no | enables YAML editing — see below |
| `HA_FILES_USER` | no | File editor add-on username |
| `HA_FILES_PASSWORD` | no | File editor add-on password |
| `PUBLIC_BASE_URL` | no | only if you point a custom domain at the `/pad` route |

You'll also pick an LLM provider in the create wizard — your own Anthropic /
OpenAI / OpenRouter key, Pinata's hosted inference, or the free tier. The free
tier works; the prompt files are written to stay inside a small context.

Then connect Telegram (or Discord or Slack) in the Pinata dashboard.

### 4. Say hello

```
you:  what lights are on?
a2ha: Three. Kitchen, hall, and the good lamp in the living room.

you:  make a pad for the dog sitter with the porch light and the kitchen
a2ha: Done — two buttons. I tested both, they actually moved.
      Want a link? I'd go 3 days.

you:  yeah, 3 days
a2ha: https://<your-agent>.agents.pinata.cloud/pad/r/a2h1_...
      Porch light and Kitchen. Dies Thursday. Copy it now, I can't show it again.
```

## The two URLs

Both come from `routes` in `manifest.json`:

- **`/pad`** — public. Guest pads. Anyone with a valid link can use it; that's
  the point. Anyone without one gets a polite "this link isn't active".
- **`/admin`** — protected by Pinata's gateway. A config app for building pads
  by hand if you'd rather click than type. Same thing the agent does, same API.

## How it's built

No dependencies. The whole thing is Node's standard library, so `npm ci` pulls
nothing and there's no build step to rot.

```
manifest.json                     deployment contract
SOUL.md                           personality
workspace/
  setup.sh                        build: install Tailscale
  start.sh                        boot: join tailnet, then serve
  AGENTS.md                       how the agent works
  HA.md                           Home Assistant playbook
  PADS.md                         guest pad playbook
  bin/ha.mjs                      Home Assistant CLI (REST + WebSocket)
  bin/pads.mjs                    pads and links CLI
  bin/proxy.mjs                   points the CLIs at the tailnet forwarder
  bin/tsforward.mjs               TCP forwarder: loopback -> tailnet via SOCKS5
  data/                           pads.json, shares.json, state.json
  data/backups/                   automatic snapshots before every config write
  projects/speeddial/             the two servers
```

The config server is the **only writer** of `data/`. The agent manages pads by
calling that server over loopback rather than editing JSON, so the web app and
the agent can't race each other.

### Editing YAML (optional)

Off by default. Home Assistant has no file API, so this needs the **File
editor** add-on with a host port exposed:

1. Install the *File editor* add-on.
2. Configuration tab → Network → give port **3218** a host port. Options → set
   a username and password.
3. Start it, then set `HA_FILES_URL` (e.g.
   `http://homeassistant.your-tailnet.ts.net:3218`), `HA_FILES_USER` and
   `HA_FILES_PASSWORD` on the agent.

```bash
node workspace/bin/ha.mjs file read configuration.yaml
node workspace/bin/ha.mjs file write configuration.yaml --body '<text>'
```

**Writes are validated and rolled back if they break the config.** After each
write the agent asks Home Assistant whether the configuration is still valid; if
not, the previous contents go back and you get the error. A broken
`configuration.yaml` stops HA from starting, and you'd usually find out at the
next reboot rather than at the moment of the edit.

Access is confined to `/config`, and `..` is refused.

Studio Code Server is the nicer editor for a person, but it speaks the VS Code
server protocol rather than a REST API, so it can't be driven this way. File
editor is the one with an actual API.

Only expose that port on a network you trust — over the tailnet or your LAN. It
sits outside Home Assistant's own login.

### Backups

Every config write snapshots the object first, into `workspace/data/backups/`.
Home Assistant keeps no history of its own, so this is the only undo that
exists.

```bash
node workspace/bin/ha.mjs backups
node workspace/bin/ha.mjs restore automation porch_dusk
```

If the current value can't be read, the write is **refused** rather than
performed without a rollback. Creating something new records a tombstone, so
restoring it removes the object again instead of resurrecting a version that
never existed. Deleting a pad snapshots it too.

Backups are plain JSON and accumulate; prune the directory when it gets old.

### How the Tailscale path works

A sandboxed container has no `/dev/net/tun` and no `CAP_NET_ADMIN`, so a normal
`tailscaled` cannot run. Instead it runs in **userspace networking** mode, which
keeps the network stack in-process and exposes a SOCKS5 server.

`start.sh` then runs `bin/tsforward.mjs`, a small TCP forwarder that makes Home
Assistant reachable at `http://127.0.0.1:18123` by tunnelling each connection
through that SOCKS5 server. Everything else just talks to loopback.

Forwarding at the TCP layer is deliberate. The obvious alternative — setting
`HTTP_PROXY` — needs a Node new enough to support `--use-env-proxy`, and a real
deployment turned out to run one without it (`node: bad option:
--use-env-proxy`), which broke every command rather than degrading. A TCP
forwarder asks nothing of Node: no flags, no version floor, and it behaves
identically for `fetch`, WebSocket and `curl`.

MagicDNS names are resolved on the Tailscale side of the tunnel, so
`http://homeassistant.your-tailnet.ts.net:8123` works with no DNS setup in the
container.

Use `http`, not `https`, for a tailnet `HA_BASE_URL`. Forwarding presents the
certificate against `127.0.0.1` and validation fails; WireGuard already
encrypts the link, so plain HTTP over a tailnet is not a downgrade. `start.sh`
warns and skips forwarding if it sees `https`.

`ha doctor` reports which path is in use, so you never have to guess whether
you're on the tailnet or a public URL.

### Health check

```bash
node workspace/bin/ha.mjs doctor
```

Probes every surface the agent depends on — REST, templates, the automation
config API, and WebSocket auth — and names whichever one is broken.

Two of those are undocumented: `/api/config/automation/config/<id>` is what the
HA UI editor uses but isn't in Home Assistant's published REST reference, and
the registry commands (helpers, areas, labels) are WebSocket-only. They work on
current builds. `doctor` is how you find out if yours is the exception.

### Tests

```bash
cd workspace/projects/speeddial && npm test
```

26 tests, fully offline — no Home Assistant and no network needed. They pin the
invariants that make a share link safe to text to someone: hash-only token
storage, expiry and revocation, what the guest view is allowed to contain, and
the fact that an unrecognised action shape never reaches Home Assistant.

## Things worth knowing

**Don't put locks, garage doors or alarms on a pad** unless you really mean it.
A pad link is a URL with no identity behind it, and URLs get forwarded.

**A "never expires" link is a real commitment.** Fine for a housemate, bad for a
one-off visitor. Revocation is the off switch and it's immediate.

**Toggle state is a guess.** The agent records what it last *sent* to a toggle
button; it never reads Home Assistant back to check. That's why no on/off state
is ever shown to anyone — a stale badge is worse than no badge.

## License

MIT. See [LICENSE](LICENSE).

## Credits

The speed dial idea, and most of the invariants above, come from
[Fanad](https://fanad.org). Built as a
[Pinata agent template](https://docs.pinata.cloud/agents/overview).
