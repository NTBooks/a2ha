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

### 1. Home Assistant has to be reachable from the internet

The agent runs in Pinata's cloud, not on your LAN. Any of these work:

- **Nabu Casa** — you already have a stable `https://xxx.ui.nabu.casa` URL.
- **Cloudflare Tunnel** or **DuckDNS** — your own hostname.
- Anything else that gives HA a public HTTPS URL.

If you're behind a proxy or tunnel, set `trusted_proxies` in your HA
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
| `HA_BASE_URL` | yes | `https://ha.example.com` — no trailing slash |
| `HA_TOKEN` | yes | the long-lived token from step 2 |
| `HA_AGENT_ID` | no | a specific HA Assist agent, for `--say` buttons |
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
  AGENTS.md                       how the agent works
  HA.md                           Home Assistant playbook
  PADS.md                         guest pad playbook
  bin/ha.mjs                      Home Assistant CLI (REST + WebSocket)
  bin/pads.mjs                    pads and links CLI
  data/                           pads.json, shares.json, state.json
  projects/speeddial/             the two servers
```

The config server is the **only writer** of `data/`. The agent manages pads by
calling that server over loopback rather than editing JSON, so the web app and
the agent can't race each other.

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

25 tests, fully offline — no Home Assistant and no network needed. They pin the
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

## Credits

The speed dial idea, and most of the invariants above, come from
[Fanad](https://fanad.org). Built as a
[Pinata agent template](https://docs.pinata.cloud/agents/overview).
