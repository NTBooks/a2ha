# PADS.md — Guest Pads

A **pad** is a named set of numbered buttons. A **share link** points at one pad.
Whoever opens the link gets big buttons and nothing else — no entity names, no
text box, no way to reach anything you didn't put on that pad.

Everything here is `node /home/hermes/data/workspace/bin/pads.mjs`, written `pads`.

## The whole flow

```bash
pads new guest --title "Guest room"
pads set guest 1 --entity light.porch --label "Porch light"
pads set guest 2 --entity light.lamp  --label "Living room lamp"
pads test guest 1                      # fires it for real - watch the light
pads share guest --ttl 7 --label "dog sitter"
```

That last command prints the link **once**. Only a hash of it is stored, so it
cannot be recovered — send it in that same reply or mint another.

## Buttons

```bash
pads set <pad> <1-9> --entity light.porch --label "Porch light"
pads set <pad> <1-9> --entity scene.movie --label "Movie night" --once
pads set <pad> <1-9> --say "start movie night" --label "Movie night"
pads clear <pad> <1-9>
```

**`--entity` is the one to reach for.** It resolves to a real service call
stored on the button, which fires the same way every time — and because the
button names an entity, the pad can show its state and a toggle can read the
house before choosing which half to send. `--say` buttons can do neither.

For lights, switches, fans, media players, climate, humidifiers and input
booleans it makes a genuine on/off toggle. For anything else — scenes, scripts,
buttons, automations — it makes a single action, because inventing a "turn off"
for a scene produces a button that fails on every second press. `--once` forces
a single action for a domain that would otherwise toggle.

**`--say` sends a phrase to HA Assist** instead. Use it when there is no clean
entity, or when Assist already understands the household's own words for
something. It is slower and depends on Assist naming, so prefer `--entity`.

Slots run 1–9. Slot 0 exists in the data model but the editor doesn't offer it.

## Links

```bash
pads share <pad> --ttl 7 --label "dog sitter"    # 1, 7, 30, or never
pads links [pad]
pads revoke <link-id>
```

`--ttl never` mints a permanent link. That is fine for a housemate and a bad
idea for a one-off visitor — a link is a URL and URLs get forwarded. Revoking is
the off switch, and it takes effect on the guest's very next tap.

Deleting a pad revokes every link to it, and snapshots the pad into
`data/backups/` first so the buttons are recoverable. Say so when you delete
one — "gone" and "gone but recoverable" are different promises.

## What a guest can see

This is the part worth protecting. The guest page contains **the button numbers
and the labels you wrote, and nothing else**:

- not the entity id, not the service, not the pad's internal name
- not any other pad, and no way to reach one

Once open, the page asks separately for the current state of its own buttons and
shows a dot beside each. The HTML stays state-free, so a link preview still
reveals nothing. A button with no readable state — a `--say` button, or an
unavailable device — shows no dot rather than guessing.

The page title is the pad's `--title`, so it *is* visible — "Guest room" is
fine, "Back door code 4471" is not.

The page is `noindex`, `no-store`, and loading it never fires anything, so a
messaging app generating a link preview cannot turn on your lights.

An expired or revoked link shows a plain "this link isn't active" page rather
than an error, so a forwarded dead link looks calm instead of alarming.

## Before you hand over a link

1. `pads show <pad>` — read the buttons back and check the labels make sense to
   someone who does not live there. "Lamp 3" does not.
2. `pads test <pad> <n>` for each button. Watch the house.
3. Pick the shortest TTL that covers the visit.
4. Send the link and say what is on it and when it dies.

## What does not belong on a pad

Locks, garage doors, alarm panels, cameras. A pad link is a forwardable URL with
no identity behind it. If the owner asks for one of these, say that plainly
once; if they still want it, make it and use the shortest TTL they'll accept.
