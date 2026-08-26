# HA.md — The House

Everything here is `node /home/hermes/data/workspace/bin/ha.mjs`, written `ha`.

`ha doctor` first, if anything looks wrong. It probes every surface this agent
depends on, including the two undocumented ones, and tells you which is broken.

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

## Writing config

Automations, scripts and scenes are stored objects with an id you choose:

```bash
ha automation list
ha automation get 1712345678901
ha automation put porch_dusk --body '{ ... }'
ha automation delete porch_dusk
ha call automation.reload
```

`script` and `scene` take the same verbs. **Always reload after a write** —
`ha call automation.reload`, `script.reload`, `scene.reload`. A write that is not
reloaded has not taken effect, and the entity will not exist yet.

### Every write is backed up first

`put` and `delete` snapshot the object into `data/backups/` before touching it.
This is the only rollback that exists — Home Assistant keeps no history of its
own, and an overwritten automation is otherwise gone.

```bash
ha backups                          # newest first
ha backups porch                    # filtered
ha restore automation porch_dusk    # roll back to the most recent snapshot
ha restore automation porch_dusk --file data/backups/automation.porch_dusk.2026-08-26T18-22-23.json
```

If the object did not exist when the snapshot was taken, the backup is a
tombstone and restoring it **deletes** the object rather than inventing one.

If the current value cannot be read, the write is **refused** rather than done
without a net. That is the right outcome: proceeding would mean promising a
rollback you cannot deliver. `--no-backup` overrides it, and you should say so
out loud when you use it.

Tell the owner the backup path when you overwrite something of theirs. It is
the difference between "I changed your automation" and "I changed your
automation and here is how to undo it".

An automation body looks like this:

```json
{
  "alias": "Porch light at dusk",
  "description": "",
  "triggers": [{ "trigger": "sun", "event": "sunset", "offset": "-00:15:00" }],
  "conditions": [],
  "actions": [{ "action": "light.turn_on", "target": { "entity_id": "light.porch" } }],
  "mode": "single"
}
```

Recent HA uses `triggers`/`conditions`/`actions` with `trigger:`/`action:` keys
inside. Older installs use `trigger`/`condition`/`action` with `platform:` and
`service:`. If a write is rejected, `ha automation get <an existing id>` and
copy whichever shape that install actually uses. Don't guess twice.

Validate before you save when the automation is non-trivial:

```bash
ha call config.check_config     # or: ha ws '{"type":"validate_config", ...}'
```

## Registries

Helpers, areas, devices and labels are not in the REST API. They live on the
WebSocket API, which `ha` speaks:

```bash
ha areas
ha devices
ha labels
ha ws '{"type":"config/entity_registry/list"}'
ha ws '{"type":"input_boolean/create","name":"Guest mode","icon":"mdi:account"}'
ha ws '{"type":"config/area_registry/create","name":"Porch"}'
```

**These command names are not in the published docs.** `ha doctor` checks that
the websocket authenticates and that the area registry answers. If a specific
command is rejected, say so plainly rather than retrying variations — the
install may simply not support it.

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

**On a public URL:**

1. The tunnel or hostname is down — everything fails, including `/api/`.
2. `HA_TOKEN` was revoked or belongs to a deleted user — 401 on everything.
3. HA is behind a proxy that needs `trusted_proxies` set — 400 on everything.

The guest pads keep serving in all three cases; the buttons render disabled and
say the house isn't reachable. That is deliberate — a guest holding a link
should see an honest "not right now", not a broken page.
