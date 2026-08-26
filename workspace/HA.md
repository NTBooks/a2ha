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
ha ws '{"type":"config/area_registry/create","name":"Porch"}'
```

Helpers have proper commands, and you should use them rather than raw `ha ws`:

```bash
ha helper list [input_number]
ha helper create input_number --name "Kitchen timer minutes" --min 0 --max 180 --step 1
ha helper create input_boolean --name "Guest mode" --icon mdi:account
ha helper delete input_number.kitchen_timer_minutes
```

**`ha helper create` refuses a name that already exists.** Home Assistant does
not: it silently appends `_2` and hands back a second entity, which is how a
retried attempt leaves a duplicate behind. If you hit that refusal, reuse the
existing helper — do not invent a new name to get around it.

Delete takes the entity id and handles the rest. The underlying API wants
`<domain>_id` rather than `entity_id`, which is the detail that makes helper
deletion look impossible when you drive it by hand.

Only helpers created through the UI or these commands can be deleted; ones
defined in YAML cannot, and `ha helper list` shows only the deletable kind.

**These command names are not in the published docs.** `ha doctor` checks that
the websocket authenticates and that the area registry answers. If a specific
command is rejected, say so plainly rather than retrying variations — the
install may simply not support it.

## Dashboards

Lovelace is WebSocket-only too:

```bash
ha dashboards                    # every dashboard, with its url_path
ha dashboard <url_path>          # that one's views and cards
ha dashboard                     # the default Overview
ha resources                     # custom cards installed via HACS etc.
```

The `url_path` from `ha dashboards` is the handle — the default dashboard is
addressed as `lovelace` or by omitting the argument entirely.

### Whose home screen you can change

```bash
ha whoami                        # which HA user this token belongs to
ha homescreen                    # that user's default dashboard
ha homescreen dashboard-office   # set it
ha homescreen --clear            # back to the HA default
```

Home Assistant stores the default dashboard per user, and the API applies it to
whoever the connection authenticated as — always your own account.

**That account is the kiosk.** The household's wall display logs in as the same
Home Assistant user whose token you hold, so your own home screen *is* the
screen people see. When the owner says "my dashboard" or "my home screen", they
mean yours. Set it without hedging.

The one case worth naming out loud: if they ask you to change what *their
personal* login shows — their phone, their laptop — you cannot. That is a
different HA user and only they can change it, from their own profile
(Settings → click their user → Dashboard). Say so rather than changing yours
and reporting success, which would look right and change nothing they see.

Check which account you are any time you are unsure: `ha whoami`.

## Building dashboards

You can create and lay out dashboards, which is how you change what the kiosk
shows:

```bash
ha dashboard-create kitchen-panel --title "Kitchen" --icon mdi:silverware --sidebar
ha dashboard-save kitchen-panel --body '<json>'
ha dashboard-update kitchen-panel --title "Kitchen Panel" --no-sidebar
ha dashboard-delete kitchen-panel
ha dashboard-restore kitchen-panel
ha homescreen kitchen-panel          # point the kiosk at it
```

`url_path` must be lowercase words joined by hyphens — `kitchen-panel`, not
`kitchen` or `kitchen_panel`. Home Assistant rejects anything else.

A config is `{"views": [...]}`, each view holding `cards`:

```json
{
  "views": [{
    "title": "Lights",
    "path": "lights",
    "cards": [
      { "type": "entities", "title": "Kitchen",
        "entities": ["light.kitchen", "light.island"] },
      { "type": "button", "entity": "scene.movie_night", "name": "Movie night" }
    ]
  }]
}
```

Useful card types: `entities`, `button`, `light`, `thermostat`, `weather-forecast`,
`markdown`, `picture-glance`, `grid`, `vertical-stack`, `horizontal-stack`.
`ha resources` shows custom cards this install has, which are also fair game.

**`dashboard-save` replaces the whole config.** To change one view, read the
current config with `ha dashboard <url_path> --json`, edit it, and save the
whole thing back. Every save and delete is backed up first — `ha backups` lists
them, `ha dashboard-restore` rolls back.

A dashboard you just created has no layout yet, and reads as "no views yet".
That is normal, not an error.

A dashboard showing "auto-generated by a strategy" has no stored layout: Home
Assistant builds its cards from areas and entities each time. There is nothing
to read and nothing to edit, so tell the owner that rather than reporting it as
empty.

## Editing YAML files

Off unless the owner has turned it on. `ha file ls` tells them how if they
haven't, so just run it rather than guessing whether it's available.

```bash
ha file ls [path]                   # list /config
ha file read configuration.yaml     # paths are relative to /config
ha file write configuration.yaml --body '<text>'
ha file rm packages/old.yaml
ha file restore configuration.yaml
ha file check                       # ask HA if the config is valid
```

**Every write is validated, and rolled back if it breaks the configuration.**
That is not a formality: an unusable `configuration.yaml` means Home Assistant
will not start, and the owner may not discover it until their next reboot, long
after they'd connect it to anything you did. If a write is rolled back, say so
and show them the error — do not quietly retry variations.

Reach for a UI-editable object first. An automation you can write with
`ha automation put` is safer than the same automation typed into
`automations.yaml`, because it cannot take Home Assistant down. YAML is for the
things that have no API: `configuration.yaml`, packages, template sensors,
`customize.yaml`, integrations configured in YAML.

Access is limited to `/config`. Anything else is refused, as is `..`.

Most YAML changes need a restart or a targeted reload to take effect — check
with `ha file check` first, then tell the owner what needs restarting rather
than restarting their house yourself.

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
