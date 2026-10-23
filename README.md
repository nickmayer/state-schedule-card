# State Schedule Card

A Home Assistant dashboard card for painting a **weekly schedule of states** on a Mon–Sun grid.

Pick a state (for example *On*, *Slowdown*, *Off*), drag across the week, press **Save**. Every cell of the week always holds a state, so there is no "unscheduled" gap — time you don't paint is simply the default state.

It works with any `input_select` or `select` entity and needs nothing but Home Assistant itself. The time of every state except the default is kept in a built-in [`schedule` helper](https://www.home-assistant.io/integrations/schedule/), and an automation that the card creates copies the helpers to your entity.

<p align="center"><img src="docs/screenshot.png" alt="State Schedule Card showing a Mon-Sun grid painted with On, Slowdown and Off blocks" width="360"></p>

## Why

The built-in `schedule` helper is on/off only and edits one state at a time. This card gives you one picture of the whole week, with as many states as your entity has options, and keeps it in schedule helpers.

## Requirements

- Home Assistant
- The built-in Schedule integration (part of the default setup)
- An administrator account: the card creates and edits helpers and an automation, so it shows a warning and cannot save for other users
- An `input_select` / `select` entity whose options are the states you want to schedule

## Install (HACS custom repository)

1. HACS → ⋮ → **Custom repositories**
2. Repository: `https://github.com/nickmayer/state-schedule-card`, Type: **Dashboard**
3. Install **State Schedule Card**, then hard-refresh the browser.

## Use

Add it from the dashboard editor (**Add card → State Schedule Card**) and configure it in the visual editor, or use YAML. The per-state `states` option (custom labels/colors) is YAML-only.

```yaml
type: custom:state-schedule-card
entity: input_select.internet_cole
title: Cole – weekly internet schedule
```

| Option | Default | Description |
| --- | --- | --- |
| `entity` | *required* | `input_select.*` or `select.*` entity to schedule |
| `title` | entity name | Card title |
| `step` | `30` | Grid resolution in minutes: `10`, `15`, `20`, `30`, `60` |
| `default_state` | `On` if present, else first option | State used for time you don't paint, and for **All …** |
| `states` | – | Per-option `label` and `color`, e.g. `Off: {label: Blocked, color: "#b71c1c"}` |
| `name` | entity name | Base name for the schedule helpers the card creates |
| `apply_now` | `true` | After saving, immediately set the entity to what the grid says for the current time |
| `row_height` | `14` | Pixel height of a grid row |
| `collapsed` | `true` | Start collapsed to a single line (title + current state). Click the header to expand |
| `current` | `entity` | Entity shown in the "Now:" chip — the state actually in effect (see *Override*) |
| `override` | – | Enables the override controls, see below |
| `devices` | – | Optional sensor whose state is a device count; shown on the top line as "3 devices" |
| `traffic` | – | Optional numeric sensor (e.g. a data rate); shown on the top line with its unit |

Click a **day name** to fill that whole day with the selected state.

## Override

Temporarily replace the schedule without editing it. Add three helpers and the bundled automation blueprint:

| Helper | Role |
| --- | --- |
| `input_select.x_schedule` | What the **schedule** writes to — the card's `entity` |
| `input_select.x_override` | Options: a "follow the schedule" option (`Schedule`), then each state |
| `input_boolean.x_override_sticky` | The "keep until cleared" checkbox |
| `input_select.x_now` | The state **in effect** — use this one in the rest of your setup |

```yaml
type: custom:state-schedule-card
entity: input_select.x_schedule
current: input_select.x_now
override:
  entity: input_select.x_override
  sticky: input_boolean.x_override_sticky   # optional
  none_option: Schedule                      # optional, default: first option
```

Then create an automation from the blueprint
[`blueprints/automation/state_schedule_override.yaml`](blueprints/automation/state_schedule_override.yaml)
([import](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fnickmayer%2Fstate-schedule-card%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fstate_schedule_override.yaml))
and point its inputs at the helpers above. It copies *scheduled → now*, unless an override is active.

In the card, pick **On / Slowdown / Off** to override, or **Follow schedule** to clear it. The checkbox decides how long it lasts:

- **Unchecked** — the override ends the next time the *scheduled* state changes (a block boundary where the state stays the same does not count).
- **Checked** — the override stays until you switch back to **Follow schedule**.

## How it behaves

- **The card owns the helpers for its entity.** On save it creates (or updates) one schedule helper per state except the default, named `<name> <state>`, and an automation `State schedule: <name>` that sets the entity to the state whose helper is on, or to the default state when none is. Edit the helpers by hand and the card shows the result next time it loads.
- The automation waits two seconds before it acts, so one block ending where the next starts gives a single change, not a flicker to the default state in between.
- The schedule only acts when a helper switches on or off. A manual change to the entity holds until the next block starts.
- If you used an earlier version that was built on the Scheduler integration, its schedules are not read. Paint the week once and save; you can then remove the Scheduler entries and integration.

## Development

```bash
npm test      # unit tests for the grid <-> schedule helper conversion
```

The card is a single dependency-free ES module in `dist/state-schedule-card.js`.

## License

MIT
