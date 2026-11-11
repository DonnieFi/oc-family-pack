// Lobsterdex companions a parent can pin on a person's profile. Colors and
// names match the Control UI Lobsterdex. The drawing is the standard lobster
// silhouette from that dex: dome, claws, perky antennae, and glint eyes.

export const LOBSTER_LIMIT = 8;

export type Lobster = {
  id: string;
  name: string;
  shell: string;
  claw: string;
};

const NAMES: Record<string, string> = {
  blue: "Blueberry",
  gold: "Goldie",
  lumen: "Glimmer",
  magma: "Ember",
  oilslick: "Slick",
  aurora: "Borealis",
  nebula: "Cosmo",
  banana: "Peel",
  mood: "Ringo",
  bee: "Buzz",
  rubberduck: "Debuggy",
  watermelon: "Pips",
  clawtron: "Clawtron",
  selene: "Selene",
  geode: "Amethyst",
  ghost: "Boo",
  glass: "Prism",
  split: "Picasso",
  sourdough: "Boule",
  zombie: "Shambles",
  plush: "Buttons",
  balloon: "Squeaky",
  cottoncandy: "Taffy",
  cryptid: "Nessie",
  flatpack: "Skaldjur",
  tinfoil: "Mulder",
  actual: "Homarus",
  disco: "Boogie",
  chimera: "Frankie",
  blueprint: "Prototype",
  phosphor: "TTY",
  ascii: "Figlet",
  portal: "Warp",
  notexture: "Magenta",
  loading: "Spinner",
  eclipse: "Umbra",
  heisenbug: "Segfault",
  invisible: "Nobody",
  pixel: "Sprite",
  retro: "OG",
  goldenretro: "24K",
};

/** Theme-variable dex colors use the same fallbacks the Control UI documents. */
const COLORS: ReadonlyArray<readonly [string, string, string]> = [
  ["crimson", "#ff4f40", "#ff775f"],
  ["blue", "#4a7dfc", "#7fa4ff"],
  ["gold", "#f4b840", "#f9d47a"],
  ["lumen", "#1d2f4e", "#2e4a77"],
  ["magma", "#241214", "#3a1d18"],
  ["oilslick", "#15171d", "#23262e"],
  ["aurora", "#dce6f0", "#e9f0f7"],
  ["nebula", "#34255c", "#4a3a7d"],
  ["banana", "#f7e27d", "#f3d55b"],
  ["mood", "#7f77dd", "#9a93e8"],
  ["bee", "#f4c531", "#2b2b23"],
  ["rubberduck", "#ffd93b", "#ffb03b"],
  ["watermelon", "#3f9d63", "#4fb072"],
  ["clawtron", "#8d99a6", "#a2aeba"],
  ["selene", "#c9ced8", "#d8dde5"],
  ["geode", "#6b6474", "#7d7588"],
  ["ghost", "#dce8f2", "#ecf3fa"],
  ["glass", "#cfe4f4", "#e0eef8"],
  ["split", "#ff4f40", "#ff775f"],
  ["sourdough", "#d9a662", "#e6bc82"],
  ["zombie", "#9db08a", "#86a17a"],
  ["plush", "#e8967a", "#f2b09a"],
  ["balloon", "#ff5c8a", "#ff7ea1"],
  ["cryptid", "#6e6257", "#7d7263"],
  ["flatpack", "#d9c9a8", "#d9c9a8"],
  ["tinfoil", "#9aa4ad", "#a8b2bb"],
  ["actual", "#a63c28", "#8f3220"],
  ["cottoncandy", "#f6a8c9", "#a5c6f0"],
  ["disco", "#b8c4d8", "#cbd5e6"],
  ["chimera", "#b0685a", "#b0685a"],
  ["pixel", "#d84c3e", "#ef8f6a"],
  ["blueprint", "#123a66", "#123a66"],
  ["phosphor", "#0d2415", "#0f2b19"],
  ["ascii", "#d8dee6", "#d8dee6"],
  ["portal", "#4a9df8", "#ff9a2e"],
  ["notexture", "#ff00dc", "#111111"],
  ["loading", "#3a4150", "#454d5e"],
  ["eclipse", "#14161d", "#1d2026"],
  ["heisenbug", "#262a33", "#343945"],
  ["invisible", "rgba(127,140,160,0.07)", "rgba(127,140,160,0.07)"],
  ["retro", "#e8262c", "#f04a3e"],
  ["goldenretro", "#e8b422", "#f6cf5a"],
];

export const LOBSTERS: readonly Lobster[] = COLORS.map(([id, shell, claw]) => ({
  id,
  name: NAMES[id] ?? id.slice(0, 1).toUpperCase() + id.slice(1),
  shell,
  claw,
}));

const BY_ID = new Map(LOBSTERS.map((lobster) => [lobster.id, lobster]));

/** Known companions, in saved order, without duplicates. Unknown ids are skipped. */
export function applyLobsterChoices(ids: readonly string[] | undefined): Lobster[] {
  if (!ids) return [];
  const seen = new Set<string>();
  const applied: Lobster[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const lobster = BY_ID.get(id);
    if (!lobster) continue;
    applied.push(lobster);
    if (applied.length === LOBSTER_LIMIT) break;
  }
  return applied;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** The standard Lobsterdex lobster, painted with one companion's colors. */
export function lobsterArt(lobster: Lobster): SVGSVGElement {
  const svg = svgEl("svg", { viewBox: "0 0 120 105", "aria-hidden": "true", class: "ocfp-lobster-art" }) as SVGSVGElement;
  const antennae = svgEl("g", { fill: "none", stroke: lobster.shell, "stroke-width": "4", "stroke-linecap": "round" });
  antennae.append(svgEl("path", { d: "M46 14 Q38 4 31 7" }), svgEl("path", { d: "M74 14 Q82 4 89 7" }));
  svg.append(
    antennae,
    svgEl("path", { d: "M20 42 C5 37 0 47 5 57 C10 67 20 62 25 52 C28 45 25 42 20 42 Z", fill: lobster.claw }),
    svgEl("path", { d: "M100 42 C115 37 120 47 115 57 C110 67 100 62 95 52 C92 45 95 42 100 42 Z", fill: lobster.claw }),
    svgEl("path", {
      d: "M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z",
      fill: lobster.shell,
    }),
    svgEl("ellipse", { cx: "48", cy: "28", rx: "20", ry: "11", fill: "#ffffff", opacity: "0.1" }),
    svgEl("circle", { cx: "45", cy: "32", r: "5.5", fill: "#0a1014" }),
    svgEl("circle", { cx: "75", cy: "32", r: "5.5", fill: "#0a1014" }),
    svgEl("circle", { cx: "46.5", cy: "30.5", r: "2.2", fill: "#00e5cc" }),
    svgEl("circle", { cx: "76.5", cy: "30.5", r: "2.2", fill: "#00e5cc" }),
  );
  return svg;
}
