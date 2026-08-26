# HA.md — The House

Everything here is `node /home/hermes/data/workspace/bin/ha.mjs`, written `ha`.

`ha doctor` first, if anything looks wrong. It probes every surface this agent
depends on, including the two undocumented ones, and tells you which is broken.

## The cheap path

```bash
ha assist "turn on the office lamp"
ha assist "what lights are on"
```

Home Assistant parses and acts on plain words itself, for free. Try it before
anything below. Exit 2 means it could not, and only then do you resolve entities
and compose calls yourself.

## Reading

```bash
ha states                      # summary: how many entities, in which domains
ha states light                # entities matching a filter
ha get light.porch             # one entity in full
ha template '{{ states("light.porch") }}'
ha services light              # what services a domain offers
ha logs --lines 30             # tail the HA error log
```

`ha states` with no filter deliberately refuses to dump the house — a real
install is hundreds of entities and would fill your context in one command.
Filter, or ask for a domain.

**`ha template` is the best read primitive you have.** One call answers
questions that would otherwise cost a full state dump:

```bash
ha template '{{ states.light | selectattr("state","eq","on") | map(attribute="entity_id") | join(", ") }}'
ha template '{{ area_entities("Kitchen") | join(", ") }}'
ha template '{{ states.sensor | selectattr("attributes.device_class","eq","temperature") | map(attribute="entity_id") | join(", ") }}'
```

## Doing

```bash
ha call light.turn_on --entity light.porch
ha call light.turn_on --entity light.porch --data '{"brightness_pct":40}'
ha call climate.set_temperature --area kitchen --data '{"temperature":21}'
ha call scene.turn_on --entity scene.movie_night
```

`--entity`, `--area` and `--device` are shorthand; `--target '<json>'` takes the
full form when you need something they don't cover.

## Two things that will bite you

**The REST config endpoints are undocumented.** `/api/config/automation/config/<id>`
is what the HA UI editor uses, and it works on current builds, but it is not in
Home Assistant's published REST reference. `ha doctor` probes it. If it fails,
automation writing is unavailable on this install — tell the owner rather than
falling back to something clever.

**`ha states` is a snapshot, not a subscription.** You do not get told when
something changes. If the owner asks "is the door still open", check again.

## When Home Assistant is unreachable

`ha doctor` will say so, and its last line tells you which network path is in
use — `tailnet (...)` or `direct to HA_BASE_URL`. Check that first; it decides
which of these applies.

**On the tailnet:**

1. The agent is not on the tailnet — `cat /tmp/tailscaled.log`. Usually the auth
   key expired, or was single-use and already spent. Keys must be **reusable**
   and **ephemeral**.
2. The agent is on the tailnet but HA is not. If HA sits behind a subnet router,
   check the route is approved in the Tailscale admin console.
3. `TS_AUTHKEY` was added after the last build, so Tailscale was never
   installed. Redeploy to run `setup.sh` again.
4. The forwarder died — `cat /tmp/tsforward.log`. Home Assistant is reached at
   `http://127.0.0.1:18123`, tunnelled to the tailnet, so if that log is empty
   or full of SOCKS errors nothing else will work.
5. `HA_BASE_URL` is `https`. It cannot be forwarded without breaking
   certificate validation; use `http` — the tailnet already encrypts it.

**On a public URL:**

1. The tunnel or hostname is down — everything fails, including `/api/`.
2. `HA_TOKEN` was revoked or belongs to a deleted user — 401 on everything.
3. HA is behind a proxy that needs `trusted_proxies` set — 400 on everything.

The guest pads keep serving in all three cases; the buttons render disabled and
say the house isn't reachable. That is deliberate — a guest holding a link
should see an honest "not right now", not a broken page.
