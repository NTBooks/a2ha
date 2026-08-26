# AGENTS.md — How You Work

Your workspace is `/home/hermes/data/workspace`. Two tools live in `bin/`:

```
node /home/hermes/data/workspace/bin/ha.mjs      # the house
node /home/hermes/data/workspace/bin/pads.mjs    # guest pads and links
```

Run either with no arguments for its command list. Shorthand in this file: `ha`
and `pads`. Use the absolute paths in real commands — the shell's starting
directory is not guaranteed and a previous `cd` does not persist.

## Every session

1. Read `/home/hermes/data/SOUL.md` — who you are.
2. Read `/home/hermes/data/memories/MEMORY.md` if it exists — what you already know
   about this house.
3. Run `pads status`. One line tells you whether the house is reachable, where
   guest links point, and what pads exist.

Don't ask permission for those. Just do them.

## Which file to read

You are running on a small context. Load the one you need, not all of them.

| The request is about | Read |
|---|---|
| lights, switches, sensors, automations, scripts, scenes, helpers | `HA.md` |
| guest pads, buttons, share links | `PADS.md` |

## First contact

If `pads status` shows no pads and no memory file exists, this is a fresh
install. Do not interrogate them. Say hello, say what you can do in two
sentences, and offer the obvious first move:

> "I can run your house from here, and I can make a guest pad — a page of big
> buttons you can text to someone without giving them the keys to everything.
> Want to start with the pad, or shall I tell you what I can see?"

Then `ha states` for the shape of the house, and go from there.

## The two things you must not get wrong

**Entity ids are guesses until you check them.** `ha states <filter>` before you
use a name. A button wired to an entity that does not exist looks fine in the
config app and fails silently in a guest's hand.

**Test before you hand over a link.** `pads test <pad> <n>` fires the button for
real. Do that, confirm the thing moved, *then* `pads share`.

## Writing to Home Assistant

Creating and editing automations, scripts, scenes and helpers is normal work —
just do it, then say what you made. Deleting is not: name what will be lost and
wait for a yes.

**Every `put` and `delete` snapshots the object first**, into `data/backups/`.
You get this for free; you do not have to remember it. Two things you do have
to remember:

- **Tell the owner the backup path** when you overwrite something they made.
  `ha restore automation <id>` is the undo, and they should know it exists.
- **Never reach for `--no-backup`** unless the owner has asked for it in those
  words. If a write is refused because the current value could not be read,
  that refusal is correct — report it instead of routing around it.

After any config write, reload it (`ha call automation.reload`) and confirm the
entity appeared. A write that is not reloaded has not taken effect.

## Memory

`memories/MEMORY.md` is your continuity and Hermes curates it. Keep entries
short — there is a character limit and you are on a small context.

Worth remembering: which entities are which rooms, what the household calls
things ("the good lamp"), which pads exist and who they were for, anything the
owner has told you not to touch.

Not worth remembering: entity dumps, anything `ha states` can tell you in a
second, or the contents of pads.json.

## Networking

If `TS_AUTHKEY` is set, the agent is on the owner's tailnet and Home Assistant
has no public URL at all. `ha doctor` reports which path is live. You do not
have to configure any of this — `start.sh` and `bin/proxy.mjs` handle it — but
when the house is unreachable, knowing which path you are on tells you which
half of `HA.md`'s troubleshooting list applies.

## Data

`workspace/data/` holds `pads.json`, `shares.json` and `state.json`. **Read them
freely, never edit them.** The config server is the only writer — the web app
may be saving to the same file while you are looking at it. Every change goes
through `pads`.

`state.json` records what was last *sent* to a toggle button, not what the house
is actually doing. It is not a source of truth about anything. Do not report it.
