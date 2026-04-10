import chalk from "chalk";

// ─── Constants ──────────────────────────────────────────────────────────────

const GRID_W = 51;
const GRID_H = 21;
const CX = 25;
const CY = 10;
const RX_OUTER = 24;
const RY_OUTER = 10;
const RX_HUB = 7;
const RY_HUB = 3.0;
const NUM_SPOKES = 24;

const FIRE_COLORS = [
  "#ff1100", "#ff2200", "#ff4400", "#ff6600", "#ff8800", "#ffaa00",
  "#ffcc00", "#ffee00", "#ffcc00", "#ffaa00", "#ff8800", "#ff6600",
  "#ff4400", "#ff2200",
];

const RIM_GRADIENT = [
  "#ffaa00", "#ff9900", "#ff8811", "#ff7711", "#ff5533", "#ff4422", "#ff3333",
];

const TITLE_CHARS: Array<{ ch: string; color: string }> = [
  { ch: "S", color: "#ff2200" }, { ch: " ", color: "" }, { ch: "H", color: "#ff3311" },
  { ch: " ", color: "" }, { ch: "A", color: "#ff4422" }, { ch: " ", color: "" },
  { ch: "K", color: "#ff6633" }, { ch: " ", color: "" }, { ch: "T", color: "#ff8844" },
  { ch: " ", color: "" }, { ch: "I", color: "#ffaa55" }, { ch: " ", color: "" },
  { ch: "M", color: "#ffbb44" }, { ch: " ", color: "" }, { ch: "A", color: "#ffcc33" },
  { ch: " ", color: "" }, { ch: "A", color: "#ffdd22" }, { ch: " ", color: "" },
  { ch: "N", color: "#ffee11" }, { ch: " ", color: "" }, { ch: " ", color: "" },
  { ch: "A", color: "#ffaa00" }, { ch: "I", color: "#ffcc00" },
];

// ─── Vortex frames (Phase 1) ────────────────────────────────────────────────

const BUILDUP_FRAMES: string[][] = [
  ["     ·     ", "     ●     ", "     ·     "],
  ["    · · ·    ", "   · ─●─ ·   ", "    · · ·    "],
  [
    "   · · · · ·   ",
    "   ░  ╲|╱  ░   ",
    "   ░  ─●─  ░   ",
    "   ░  ╱|╲  ░   ",
    "   · · · · ·   ",
  ],
  [
    "     · ░ · ░ ·     ",
    "   · ░ ▒ ╲|╱ ▒ ░ ·   ",
    "   ░ ▒ ▓ ─ ●─ ▓ ▒ ░   ",
    "   · ░ ▒ ╱|╲ ▒ ░ ·   ",
    "     · ░ · ░ ·     ",
  ],
];

const VORTEX_FRAMES: string[][] = [
  [
    "                    ·  ·                    ",
    "              · ░  ·  ·  ░ ·              ",
    "          ·  ░ ▒  ╲     ╱  ▒ ░  ·          ",
    "        ░ ▒ ▓  ╲   ╲ | ╱   ╱  ▓ ▒ ░        ",
    "      ░ ▒ ▓ █ ──── ─╳─ ──── █ ▓ ▒ ░      ",
    "        ░ ▒ ▓  ╱   ╱ | ╲   ╲  ▓ ▒ ░        ",
    "          ·  ░ ▒  ╱     ╲  ▒ ░  ·          ",
    "              · ░  ·  ·  ░ ·              ",
    "                    ·  ·                    ",
  ],
  [
    "                    ·  ·                    ",
    "              · ░  ·  ·  ░ ·              ",
    "          ·  ░ ▒  │     │  ▒ ░  ·          ",
    "        ░ ▒ ▓  ╲   │ │ │   ╱  ▓ ▒ ░        ",
    "      ░ ▒ ▓ █ ════ ═●═ ════ █ ▓ ▒ ░      ",
    "        ░ ▒ ▓  ╱   │ │ │   ╲  ▓ ▒ ░        ",
    "          ·  ░ ▒  │     │  ▒ ░  ·          ",
    "              · ░  ·  ·  ░ ·              ",
    "                    ·  ·                    ",
  ],
  [
    "                    ·  ·                    ",
    "              · ░  ·  ·  ░ ·              ",
    "          ·  ░ ▒  ╱     ╲  ▒ ░  ·          ",
    "        ░ ▒ ▓  ╱   ╱ | ╲   ╲  ▓ ▒ ░        ",
    "      ░ ▒ ▓ █ ──── ─╳─ ──── █ ▓ ▒ ░      ",
    "        ░ ▒ ▓  ╲   ╲ | ╱   ╱  ▓ ▒ ░        ",
    "          ·  ░ ▒  ╲     ╱  ▒ ░  ·          ",
    "              · ░  ·  ·  ░ ·              ",
    "                    ·  ·                    ",
  ],
  [
    "                    ·  ·                    ",
    "              · ░  ·  ·  ░ ·              ",
    "          ·  ░ ▒  ─     ─  ▒ ░  ·          ",
    "        ░ ▒ ▓  │   ─ ─ ─   │  ▓ ▒ ░        ",
    "      ░ ▒ ▓ █ ╲╲╲╲ ╲●╱ ╱╱╱╱ █ ▓ ▒ ░      ",
    "        ░ ▒ ▓  │   ─ ─ ─   │  ▓ ▒ ░        ",
    "          ·  ░ ▒  ─     ─  ▒ ░  ·          ",
    "              · ░  ·  ·  ░ ·              ",
    "                    ·  ·                    ",
  ],
];

const BURST_FRAME: string[] = [
  "        · ░ ▒ ▓ █ ▓ ▒ ░ ·        ",
  "    · ░ ▒ ▓ █ ███ █ ▓ ▒ ░ ·    ",
  "  · ░ ▒ ▓ █ ═══●═══ █ ▓ ▒ ░ ·  ",
  "    · ░ ▒ ▓ █ ███ █ ▓ ▒ ░ ·    ",
  "        · ░ ▒ ▓ █ ▓ ▒ ░ ·        ",
];

// ─── Chakra generation ──────────────────────────────────────────────────────

type CellType = "space" | "rim" | "hub" | "center" | "spoke";

interface ChakraGrid {
  chars: string[][];
  types: CellType[][];
}

function generateChakra(): ChakraGrid {
  const chars: string[][] = [];
  const types: CellType[][] = [];

  for (let y = 0; y < GRID_H; y++) {
    chars[y] = new Array(GRID_W).fill(" ");
    types[y] = new Array<CellType>(GRID_W).fill("space");
  }

  const inEllipse = (x: number, y: number, rx: number, ry: number): number => {
    const dx = (x - CX) / rx;
    const dy = (y - CY) / ry;
    return dx * dx + dy * dy;
  };

  // Outer rim
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const d = inEllipse(x, y, RX_OUTER, RY_OUTER);
      if (d >= 0.75 && d <= 1.15) {
        chars[y][x] = d >= 0.85 && d <= 1.05 ? "█" : d < 0.85 ? "▓" : "▒";
        types[y][x] = "rim";
      }
    }
  }

  // Hub ring
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const d = inEllipse(x, y, RX_HUB, RY_HUB);
      if (d >= 0.6 && d <= 1.4) {
        chars[y][x] = "█";
        types[y][x] = "hub";
      }
    }
  }

  // Center — hexagon shape
  //    ▄██▄
  //   ██████
  //    ▀██▀
  const hexRows: Array<{ dy: number; cells: Array<{ dx: number; ch: string }> }> = [
    { dy: -1, cells: [
      { dx: -1, ch: "▄" }, { dx: 0, ch: "██".charAt(0) }, { dx: 1, ch: "▄" },
    ]},
    { dy: 0, cells: [
      { dx: -2, ch: "█" }, { dx: -1, ch: "█" }, { dx: 0, ch: "█" },
      { dx: 1, ch: "█" }, { dx: 2, ch: "█" },
    ]},
    { dy: 1, cells: [
      { dx: -1, ch: "▀" }, { dx: 0, ch: "█" }, { dx: 1, ch: "▀" },
    ]},
  ];
  for (const { dy, cells } of hexRows) {
    for (const { dx, ch } of cells) {
      chars[CY + dy][CX + dx] = ch;
      types[CY + dy][CX + dx] = "center";
    }
  }

  // 24 spokes
  for (let i = 0; i < NUM_SPOKES; i++) {
    const angle = (i * 2 * Math.PI) / NUM_SPOKES;
    for (let t = 0.25; t <= 1.0; t += 0.02) {
      const px = CX + Math.cos(angle) * RX_OUTER * t;
      const py = CY + Math.sin(angle) * RY_OUTER * t;
      const ix = Math.round(px);
      const iy = Math.round(py);
      if (ix < 0 || ix >= GRID_W || iy < 0 || iy >= GRID_H) continue;

      const dHub = inEllipse(ix, iy, RX_HUB, RY_HUB);
      const dRim = inEllipse(ix, iy, RX_OUTER, RY_OUTER);
      if (dHub > 1.3 && dRim < 0.78 && chars[iy][ix] === " ") {
        const deg = ((angle * 180 / Math.PI) + 360) % 360;
        if ((deg >= 0 && deg < 22.5) || (deg >= 157.5 && deg < 202.5) || deg >= 337.5) {
          chars[iy][ix] = "─";
        } else if ((deg >= 22.5 && deg < 67.5) || (deg >= 202.5 && deg < 247.5)) {
          chars[iy][ix] = "╲";
        } else if ((deg >= 67.5 && deg < 112.5) || (deg >= 247.5 && deg < 292.5)) {
          chars[iy][ix] = "│";
        } else {
          chars[iy][ix] = "╱";
        }
        types[iy][ix] = "spoke";
      }
    }
  }

  return { chars, types };
}

// ─── Stage rendering ────────────────────────────────────────────────────────

function rimColorForRow(y: number): string {
  const d = Math.abs(y - CY) / CY;
  return RIM_GRADIENT[Math.min(Math.floor(d * 6), RIM_GRADIENT.length - 1)];
}

const SPOKE_DISPLAY: Array<{ ch: string | null; color: string }> = [
  { ch: "·", color: "#ff6600" },    // stage 0
  { ch: null, color: "#ffcc44" },    // stage 1 — use original char
  { ch: "░", color: "#ffaa33" },     // stage 2
  { ch: "▒", color: "#ffbb33" },     // stage 3
  { ch: "▓", color: "#ffcc44" },     // stage 4
  { ch: "█", color: "#ffdd44" },     // stage 5
];

const HUB_CHARS = ["·", "░", "▒", "▓", "█", "█"];
const RIM_STAGE_CHARS = ["·", "░", "▒", "▓", "█", "█"];

function renderStage(grid: ChakraGrid, stage: number): string[] {
  const lines: string[] = [];
  for (let y = 0; y < GRID_H; y++) {
    const rc = rimColorForRow(y);
    let line = "";
    for (let x = 0; x < GRID_W; x++) {
      const ch = grid.chars[y][x];
      const type = grid.types[y][x];

      if (type === "center") {
        line += stage >= 1 ? chalk.hex("#ff8811").bold(ch) : chalk.hex("#ff8811")("·");
      } else if (type === "hub") {
        line += chalk.hex("#ffdd44")(HUB_CHARS[stage]);
      } else if (type === "rim") {
        if (stage <= 1) {
          line += chalk.hex(rc)(RIM_STAGE_CHARS[stage]);
        } else {
          const actualWeight = "░▒▓█".indexOf(ch);
          const stageWeight = "░▒▓█".indexOf(RIM_STAGE_CHARS[stage]);
          line += chalk.hex(rc)(actualWeight <= stageWeight ? RIM_STAGE_CHARS[stage] : ch);
        }
      } else if (type === "spoke") {
        const sd = SPOKE_DISPLAY[stage];
        line += chalk.hex(sd.color)(sd.ch ?? ch);
      } else {
        line += " ";
      }
    }
    lines.push(line);
  }
  return lines;
}

// ─── Animation helpers ──────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const write = (s: string): void => { process.stdout.write(s); };
const hideCursor = (): void => { write("\x1b[?25l"); };
const showCursor = (): void => { write("\x1b[?25h"); };
const moveUp = (n: number): void => { if (n > 0) write(`\x1b[${n}A`); };
const clearLine = (): void => { write("\x1b[2K"); };

function termWidth(): number {
  return process.stdout.columns || 80;
}

/** Measure visible length of a string (strip ANSI escape codes) */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad a line to center it in the terminal */
function centerLine(line: string): string {
  const vLen = visibleLength(line);
  const pad = Math.max(0, Math.floor((termWidth() - vLen) / 2));
  return " ".repeat(pad) + line;
}

function writeFrame(lines: string[], prevLineCount: number): number {
  // Move up to overwrite previous frame
  moveUp(prevLineCount);
  for (let i = 0; i < lines.length; i++) {
    clearLine();
    write(centerLine(lines[i]) + "\n");
  }
  // Clear any leftover lines from a taller previous frame
  for (let i = lines.length; i < prevLineCount; i++) {
    clearLine();
    write("\n");
  }
  return Math.max(lines.length, prevLineCount);
}

function colorVortexLine(line: string, c1: string, c2: string, c3: string): string {
  let out = "";
  for (const ch of line) {
    if (ch === "●" || ch === "╳") out += chalk.hex("#ffffff").bold(ch);
    else if (ch === "█") out += chalk.hex(c3)(ch);
    else if (ch === "▓") out += chalk.hex(c2)(ch);
    else if (ch === "▒" || ch === "░") out += chalk.hex(c1)(ch);
    else if ("╲╱|─═".includes(ch)) out += chalk.hex(c2)(ch);
    else if (ch === " ") out += ch;
    else out += chalk.hex(c1)(ch);
  }
  return out;
}

function colorBurstLine(line: string): string {
  let out = "";
  for (const ch of line) {
    if (ch === "●") out += chalk.hex("#ffffff").bold(ch);
    else if (ch === "█") out += chalk.hex("#ffee00")(ch);
    else if (ch === "▓") out += chalk.hex("#ffcc00")(ch);
    else if (ch === "▒") out += chalk.hex("#ffaa00")(ch);
    else if (ch === "░") out += chalk.hex("#ff8800")(ch);
    else if (ch === " ") out += ch;
    else out += chalk.hex("#ff6600")(ch);
  }
  return out;
}

// ─── Phase 1: Spinning vortex ───────────────────────────────────────────────

async function phase1Spin(): Promise<number> {
  let lineCount = 0;

  // Buildup frames
  for (let i = 0; i < BUILDUP_FRAMES.length; i++) {
    const frame = BUILDUP_FRAMES[i];
    const c1 = FIRE_COLORS[i * 2 % FIRE_COLORS.length];
    const c2 = FIRE_COLORS[(i * 2 + 5) % FIRE_COLORS.length];
    const colored = frame.map((line) => colorVortexLine(line, c1, c2, c1));
    lineCount = writeFrame(colored, lineCount);
    await sleep(180);
  }

  // Vortex cycling
  for (let cycle = 0; cycle < 6; cycle++) {
    for (let f = 0; f < VORTEX_FRAMES.length; f++) {
      const frame = VORTEX_FRAMES[f];
      const ci = (cycle * VORTEX_FRAMES.length + f) % FIRE_COLORS.length;
      const c1 = FIRE_COLORS[ci];
      const c2 = FIRE_COLORS[(ci + 5) % FIRE_COLORS.length];
      const c3 = FIRE_COLORS[(ci + 9) % FIRE_COLORS.length];
      const colored = frame.map((line) => colorVortexLine(line, c1, c2, c3));
      lineCount = writeFrame(colored, lineCount);
      await sleep(55);
    }
  }

  // Flash burst
  for (let flash = 0; flash < 4; flash++) {
    if (flash % 2 === 0) {
      const colored = BURST_FRAME.map(colorBurstLine);
      lineCount = writeFrame(colored, lineCount);
    }
    await sleep(80);
  }

  return lineCount;
}

// ─── Phase 2: Chakra assembly ───────────────────────────────────────────────

async function phase2Chakra(
  stageFrames: string[][],
  prevLineCount: number,
): Promise<number> {
  let lineCount = prevLineCount;
  const holdTimes = [120, 100, 80, 65, 50, 40];

  // Rapid continuous morph through all 6 stages
  for (let s = 0; s <= 5; s++) {
    lineCount = writeFrame(stageFrames[s], lineCount);
    await sleep(holdTimes[s]);
  }

  // Kinetic bounce
  lineCount = writeFrame(stageFrames[3], lineCount);
  await sleep(35);
  lineCount = writeFrame(stageFrames[5], lineCount);
  await sleep(30);

  // Flash
  // (brief blank then back)
  moveUp(lineCount);
  for (let i = 0; i < lineCount; i++) { clearLine(); write("\n"); }
  await sleep(60);

  // Final: settle on stage 4
  lineCount = writeFrame(stageFrames[4], lineCount);

  return lineCount;
}

// ─── Phase 3: Title reveal ──────────────────────────────────────────────────

async function phase3Title(prevLineCount: number): Promise<void> {
  // Gap between chakra and title
  write("\n\n");

  // Type title letter by letter
  const titleVisibleLen = 23; // "S H A K T I M A A N  AI"
  let titleLine = "";
  for (const { ch, color } of TITLE_CHARS) {
    if (ch === " ") {
      titleLine += " ";
    } else {
      titleLine += chalk.hex(color)(ch);
    }
    clearLine();
    const pad = " ".repeat(Math.max(0, Math.floor((termWidth() - titleVisibleLen) / 2)));
    write(`\r${pad}${titleLine}${chalk.hex("#ffaa00")("▌")}`);
    await sleep(55);
  }
  // Remove cursor, write final title
  write("\r");
  clearLine();
  const titlePad = " ".repeat(Math.max(0, Math.floor((termWidth() - titleVisibleLen) / 2)));
  write(`${titlePad}${titleLine}\n`);

  await sleep(200);

  // Subtitle (no emoji decorations)
  const subtitle = "Agentic Development Pipeline";
  const subPad = " ".repeat(Math.max(0, Math.floor((termWidth() - subtitle.length) / 2)));
  write(`${subPad}${chalk.hex("#666666")(subtitle)}\n`);

  await sleep(250);

  // Version
  const version = "v0.1.0";
  const verPad = " ".repeat(Math.max(0, Math.floor((termWidth() - version.length) / 2)));
  write(`${verPad}${chalk.hex("#555555")(version)}\n`);

  // Trailing gap before next output
  write("\n\n");
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function showBanner(options?: { noBanner?: boolean }): Promise<void> {
  // Skip conditions
  if (options?.noBanner) return;
  if (!process.stdout.isTTY) return;
  if (process.env["NO_COLOR"]) return;

  // Pre-generate chakra and all stage frames
  const grid = generateChakra();
  const stageFrames: string[][] = [];
  for (let s = 0; s <= 5; s++) {
    stageFrames.push(renderStage(grid, s));
  }

  hideCursor();
  try {
    // Gap after command prompt
    write("\n\n");
    const spinLines = await phase1Spin();
    const chakraLines = await phase2Chakra(stageFrames, spinLines);
    await phase3Title(chakraLines);
  } finally {
    showCursor();
  }
}
