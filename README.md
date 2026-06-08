# DroneFarm

Isometric WebGL farming game. Static site — no build step, no dependencies.

The player programs an autonomous drone in a C#-like language, written in
floating script panels. The drone flies over an iso tile field, harvesting
resources that fly up into the resource bar.

## Run

```sh
python serve.py
```

Opens http://127.0.0.1:8123 with **hot reload** — any edit under `wwwroot/`
refreshes the browser automatically. `python serve.py 9000 --no-browser`
to change port / skip opening a tab. `?noreload=1` on any page URL skips the
reload script (used for headless screenshot tests).

## Playing

- Write code in the panels, press **▶** to run, **❚❚** to pause, **■** to stop
- One script runs at a time; pressing ▶ elsewhere queues it (current move
  finishes, then the switch happens). Editing any code stops the run.
- The executing instruction is highlighted live, following calls across panels
- **Left-click drag** pans the camera; **+** (top right) opens a new panel
- The "main" panel always exists; others can be renamed (double-click the
  title), minimized, closed, moved, and resized

## Scripting language (C#-like)

No `Main` needed — top-level statements run directly. Declare functions in
any panel; all panels share one namespace.

```csharp
void HarvestRow(int len) {
    for (int i = 0; i < len; i++) {
        harvest();
        east();
    }
}

HarvestRow(4);
```

Supported: `int/float/double/bool/string/var` (+ nullable `T?`, `null`,
`??`), `if/else`, `switch/case/default`, `for/while/do-while/foreach`,
`break/continue/return`, user functions with `ref`/`out` params, `enum`,
`class`/`struct` (fields, methods, constructors, static members),
collections (arrays, `List`, `Dictionary`, `HashSet`, `Queue`, `Stack`),
strings (methods + `$"interpolation"`), `Math.*`, `Random`, `++/--`,
compound assignment, `&&/||/!`, comments, C#-style integer division.
The in-game help (`?`) documents every function, method and property by
category: DRONE, LANGUAGE, MATH, COLLECTIONS, STRINGS.

**Builtins**

| Name | Effect |
| --- | --- |
| `north()` `south()` `east()` `west()` | Fly one tile (animated; wraps at map edges) |
| `harvest()` | Harvest the tile below; returns `true` if something was taken |
| `can_harvest()` | `true` when a harvest() right now is guaranteed to succeed; ~100ms sensor read |
| `has_resource(r)` | How many of `Resource.hay/bush_seed/tree_seed/wood/carrot` you hold; instant |
| `do_a_spin()` | 1s flourish: orbit the tile once, spin through all facings, settle back |
| `world_size()` | The world is always NxN — returns N (currently 9); instant |
| `get_ground()` | `Ground` enum of the tile below: `Dirt`, `Tilled`, `Grass`; instant |
| `get_entity()` | `Entity` enum of what's planted below (or `null`): `Hay`, `TreeSprout`, `Tree`, `BushSprout`, `Bush`; instant |
| `till()` | Till the tile below to tilled dirt; tilling again reverts to dirt |
| `seed()` | Seed the tile below back into grass |
| `plant(e)` | Plant `Entity.Tree` (4s), `Entity.Bush` (2s) or `Entity.Carrot` (3s, tilled soil only) on the empty tile below; sprouts swell ~15% then become the plant |
| `clear_map()` | Reset the field (all dirt, hay regrown); the drone flies home to (0,0) |

Land cycle: hay grows ONLY on grass (a new clump sprouts ~1s after harvest —
grass always produces hay). Planting a bush/tree claims grass as plain dirt;
tilling makes tilled soil for carrots. Harvesting a plant reverts the land
one step: dirt -> grass, tilled -> dirt. seed() turns any tile back to grass.
Bush/tree planting consumes a bush_seed/tree_seed (50% drops from hay
harvests once that plant is unlocked). Grown trees/bushes yield WOOD; grown
carrots yield CARROT (plants don't regrow — replant). Sprouts can't be
harvested.
| `pos_x`, `pos_y` | Read-only position; (0,0) = bottom corner, pos_x→east, pos_y→north |

Dev URL params: `?code=<urlencoded>` overrides main's code, `?autorun=1`
runs it on load, `?dir=0..7` forces a drone facing.

## Structure

```
serve.py            dev server (stdlib only, hot reload)
wwwroot/            web root — everything the browser sees
  index.html        canvas + HUD shell
  css/style.css     theme: HUD bars, panels, editor, scrollbars
  src/atlas.js      load-time sprite atlas builder (frames, pivots, rotor pods)
  src/tiles.js      tile type registry + sparse infinite tile map
  src/objects.js    world object registry (resources) + sparse object map
  src/csharp.js     C#-like language: lexer, parser, async interpreter
  src/ui.js         floating script panels: editor, highlighting, toolbar
  src/main.js       game: rendering, drone, camera, runner, builtins
  assets/           runtime art (served)
assets/             source art (PSD etc., not served)
_scratch/           Claude's scratch pad — safe to delete
```

## Engine notes

- Draw order: tiles → shadows (drone blob + object cast shadows) → objects
  → drone (sprite + four 3D WebGL propellers on atlas-detected rotor pods)
- Objects cast SE→NW silhouette shadows (their own sprite, sheared flat)
- Tiles have classifications (grass = dirt+grass), per-tile light levels,
  and mutable state flags (`tilled`); hay regrows 500ms after harvest
- The atlas builder reads pixels at load: frame bounds, centroid pivots,
  1px bleed padding, and rotor-pod detection via silhouette radial peaks
