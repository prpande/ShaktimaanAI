# CLI Banner & Animation Design

Adds an animated ASCII art welcome banner to the ShaktimaanAI CLI, inspired by Shaktimaan's spinning red-yellow entrance and the Ashoka Chakra from the Indian flag.

## Deliverables

1. **Banner module** (`src/ui/banner.ts`) — async function that renders a 3-phase animated banner to stdout
2. **Integration** into `shkmn start` and `shkmn init` commands
3. **VHS tape file** (`demo.tape`) for reproducible GIF recording
4. **README update** with the recorded GIF

## Banner Module: `src/ui/banner.ts`

### API

```typescript
export async function showBanner(): Promise<void>
```

Single exported function. Writes directly to `process.stdout`. Uses ANSI escape codes for color and cursor control.

### Auto-skip conditions

Banner is silently skipped when any of:
- `process.stdout.isTTY` is falsy (piped output)
- `NO_COLOR` environment variable is set
- `--no-banner` flag is passed to the command

### Dependencies (new)

- `chalk` (v5+, ESM) — RGB hex color support for fire gradient. Already widely used in Node CLI tools.

No other new deps. Animation uses raw `process.stdout.write` with ANSI cursor codes:
- `\x1b[?25l` / `\x1b[?25h` — hide/show cursor
- `\x1b[{N}A` — move cursor up N lines (to overwrite frames in place)

### Three-Phase Animation

**Phase 1: Spinning Vortex (~1.5s)**

Simulates Shaktimaan's red-yellow spinning blur entrance. Four buildup frames expand from a center point, then four vortex frames cycle 6 times with fire-color shifts (red `#ff1100` through gold `#ffee00`). Ends with a bright burst flash.

Frame data is hardcoded string arrays using `· ░ ▒ ▓ █ ╲ ╱ │ ─ ═ ● ╳` characters. Frames are 9 lines tall, ~44 chars wide.

**Phase 2: Chakra Assembly (~0.7s)**

The Ashoka Chakra materializes through rapid continuous morphing. The wheel is generated mathematically: 24 spokes plotted on a 51x21 character grid with outer rim (radius 24x10), inner hub (radius 8x3.5), and center `☸`.

Six density stages rendered as full-frame swaps (no per-line reveal):
- Stage 0: faint dots `·`
- Stage 1: thin line chars `─ │ ╲ ╱`
- Stage 2: light blocks `░`
- Stage 3: medium blocks `▒`
- Stage 4: heavy blocks `▓`
- Stage 5: solid blocks `█`

Timing accelerates: 120ms, 100ms, 80ms, 65ms, 50ms, 40ms. Quick bounce (stage 3 → 5) for kinetic feel. Flash burst. Settles on **stage 4** (▓ spokes) as the final stationary frame.

**Phase 3: Title Reveal (~0.8s)**

Letter-by-letter typing of `S H A K T I M A A N  AI` with per-letter fire gradient (`#ff2200` → `#ffee11`, "AI" in `#ffaa00`/`#ffcc00`). Blinking cursor `▌` during typing. Subtitle "☸ Agentic Development Pipeline ☸" fades in, then version string.

### Color Palette

```
fire gradient:  #ff1100 → #ff4400 → #ff8800 → #ffaa00 → #ffcc00 → #ffee00
rim:            row-distance gradient #ffaa00 (center) → #ff3333 (edges)
spokes:         #ffcc44 (stage 4 final: #ffcc44)
hub:            #ffdd44
center ☸:       #ffffff bold
title:          per-letter #ff2200 → #ffee11
subtitle:       #666666
```

### Chakra Generation Algorithm

```
Grid: 51 wide x 21 tall
Center: (25, 10)
Outer rim: ellipse rx=24, ry=10, ring where 0.75 <= d <= 1.15
Hub: ellipse rx=8, ry=3.5, ring where 0.6 <= d <= 1.4
Spokes: 24 lines at 15-degree intervals, plotted from hub edge to rim edge
Spoke char selection by angle: ─ (0/180), ╲ (45/225), │ (90/270), ╱ (135/315)
```

Pre-rendered into 6 stage frames at module load time.

## Integration Points

### `shkmn start` (`src/commands/start.ts`)

Call `showBanner()` after config/env loading but before the "pipeline started" log:

```typescript
// After step 2 (verify runtime dirs), before step 3
await showBanner();
```

### `shkmn init` (`src/commands/init.ts`)

Replace `intro("ShaktimaanAI Setup")` with:

```typescript
await showBanner();
intro("ShaktimaanAI Setup");
```

### `--no-banner` Flag

Added as a global option on the root commander program in `cli.ts`:

```typescript
program.option("--no-banner", "Skip the animated banner");
```

Passed to `showBanner()` which checks `program.opts().banner === false`.

## GIF Recording

### `demo.tape` (repo root)

```tape
Output assets/banner.gif
Set FontSize 14
Set Width 80
Set Height 28
Set Theme "Dracula"
Type "shkmn start"
Enter
Sleep 5s
```

Run with `vhs demo.tape` to produce `assets/banner.gif`.

### README

```markdown
<p align="center">
  <img src="./assets/banner.gif" alt="ShaktimaanAI CLI Banner" width="600">
</p>
```

## File Changes Summary

| File | Change |
|------|--------|
| `src/ui/banner.ts` | New — banner module |
| `src/commands/start.ts` | Add `showBanner()` call |
| `src/commands/init.ts` | Add `showBanner()` call before intro |
| `src/cli.ts` | Add `--no-banner` global option |
| `package.json` | Add `chalk` dependency |
| `demo.tape` | New — VHS recording script |
| `README.md` | Add banner GIF |
| `assets/` | New directory for banner.gif |
