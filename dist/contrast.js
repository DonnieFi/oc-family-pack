const SRGB_TO_LINEAR = (channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const LINEAR_TO_SRGB = (channel) => channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
const clamp01 = (channel) => Math.min(1, Math.max(0, channel));
const round3 = (value) => Math.round(value * 1000) / 1000;
/** CSS named colours the roster form accepts. Unknown words fall back to ink instead of throwing. */
const NAMED = {
    aqua: "#00ffff",
    black: "#000000",
    blue: "#0000ff",
    brown: "#a52a2a",
    coral: "#ff7f50",
    cyan: "#00ffff",
    fuchsia: "#ff00ff",
    gold: "#ffd700",
    gray: "#808080",
    green: "#008000",
    grey: "#808080",
    indigo: "#4b0082",
    khaki: "#f0e68c",
    lime: "#00ff00",
    magenta: "#ff00ff",
    maroon: "#800000",
    navy: "#000080",
    olive: "#808000",
    orange: "#ffa500",
    pink: "#ffc0cb",
    plum: "#dda0dd",
    purple: "#800080",
    rebeccapurple: "#663399",
    red: "#ff0000",
    salmon: "#fa8072",
    silver: "#c0c0c0",
    skyblue: "#87ceeb",
    tan: "#d2b48c",
    teal: "#008080",
    tomato: "#ff6347",
    turquoise: "#40e0d0",
    violet: "#ee82ee",
    white: "#ffffff",
    yellow: "#ffff00",
};
function parseHex(input) {
    const match = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(input);
    const hex = match?.[1];
    if (!hex)
        return undefined;
    const expanded = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const rgb = expanded.slice(0, 6);
    return [0, 2, 4].map((offset) => Number.parseInt(rgb.slice(offset, offset + 2), 16) / 255);
}
function unitByte(raw) {
    const percent = raw.endsWith("%");
    const value = Number(percent ? raw.slice(0, -1) : raw);
    if (!Number.isFinite(value))
        return undefined;
    const byte = percent ? (value / 100) * 255 : value;
    return Math.min(255, Math.max(0, byte)) / 255;
}
function parseRgb(input) {
    const match = /^rgba?\(\s*([+-]?[0-9.]+%?)\s*(?:,\s*|\s+)([+-]?[0-9.]+%?)\s*(?:,\s*|\s+)([+-]?[0-9.]+%?)(?:\s*(?:[,/])\s*[+-]?[0-9.]+%?)?\s*\)$/i.exec(input);
    if (!match)
        return undefined;
    const channels = [match[1], match[2], match[3]].map((part) => unitByte(part ?? ""));
    if (channels.some((channel) => channel === undefined))
        return undefined;
    return channels;
}
function parseHsl(input) {
    const match = /^hsla?\(\s*(-?[0-9.]+)(?:deg)?\s*(?:,\s*|\s+)([0-9.]+)%\s*(?:,\s*|\s+)([0-9.]+)%(?:\s*(?:[,/])\s*[+-]?[0-9.]+%?)?\s*\)$/i.exec(input);
    if (!match)
        return undefined;
    const hue = Number(match[1]) / 360;
    const sat = Number(match[2]) / 100;
    const light = Number(match[3]) / 100;
    if (![hue, sat, light].every(Number.isFinite))
        return undefined;
    if (sat === 0)
        return [light, light, light];
    const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
    const p = 2 * light - q;
    const channel = (offset) => {
        let t = hue + offset;
        if (t < 0)
            t += 1;
        if (t > 1)
            t -= 1;
        if (t < 1 / 6)
            return p + (q - p) * 6 * t;
        if (t < 1 / 2)
            return q;
        if (t < 2 / 3)
            return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [channel(1 / 3), channel(0), channel(-1 / 3)];
}
function parseOklch(input) {
    const match = /^oklch\(\s*([0-9.]+%?)\s+([0-9.]+%?)\s+(-?[0-9.]+)(?:deg)?(?:\s*\/\s*[0-9.]+%?)?\s*\)$/i.exec(input);
    if (!match)
        return undefined;
    const lightness = match[1] ?? "";
    const chroma = match[2] ?? "";
    const l = lightness.endsWith("%") ? Number(lightness.slice(0, -1)) / 100 : Number(lightness);
    // A chroma percentage is relative to 0.4, the CSS reference value.
    const c = chroma.endsWith("%") ? (Number(chroma.slice(0, -1)) / 100) * 0.4 : Number(chroma);
    const h = Number(match[3]);
    if (![l, c, h].every(Number.isFinite))
        return undefined;
    return { l, c, h };
}
function parseOklab(input) {
    const match = /^oklab\(\s*([0-9.]+%?)\s+(-?[0-9.]+)\s+(-?[0-9.]+)(?:\s*\/\s*[0-9.]+%?)?\s*\)$/i.exec(input);
    if (!match)
        return undefined;
    const lightness = match[1] ?? "";
    const l = lightness.endsWith("%") ? Number(lightness.slice(0, -1)) / 100 : Number(lightness);
    const a = Number(match[2]);
    const b = Number(match[3]);
    if (![l, a, b].every(Number.isFinite))
        return undefined;
    const hue = (Math.atan2(b, a) * 180) / Math.PI;
    return { l, c: Math.hypot(a, b), h: (hue + 360) % 360 };
}
function linearSrgbToOklab(r, g, b) {
    const lmsL = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const lmsM = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const lmsS = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {
        l: 0.2104542553 * lmsL + 0.793617785 * lmsM - 0.0040720468 * lmsS,
        a: 1.9779984951 * lmsL - 2.428592205 * lmsM + 0.4505937099 * lmsS,
        b: 0.0259040371 * lmsL + 0.7827717662 * lmsM - 0.808675766 * lmsS,
    };
}
function oklabToLinearSrgb(l, a, b) {
    const lmsL = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const lmsM = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const lmsS = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        4.0767416621 * lmsL - 3.3077115913 * lmsM + 0.2309699292 * lmsS,
        -1.2684380046 * lmsL + 2.6097574011 * lmsM - 0.3413193965 * lmsS,
        -0.0041960863 * lmsL - 0.7034186147 * lmsM + 1.707614701 * lmsS,
    ];
}
function namedRgb(input) {
    const hex = NAMED[input.toLowerCase()];
    return hex ? parseHex(hex) : undefined;
}
function toOklch(color) {
    const parsed = color.trim();
    return (parseOklch(parsed) ??
        parseOklab(parsed) ??
        rgbToOklch(parseHex(parsed) ?? parseRgb(parsed) ?? parseHsl(parsed) ?? namedRgb(parsed) ?? undefined));
}
function rgbToOklch(rgb) {
    if (!rgb)
        throw new Error("Unsupported color");
    const [r, g, b] = rgb.map(SRGB_TO_LINEAR);
    const lab = linearSrgbToOklab(r, g, b);
    const hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
    return { l: lab.l, c: Math.hypot(lab.a, lab.b), h: (hue + 360) % 360 };
}
/** Clip in encoded sRGB, then return linear channels for luminance. */
function linearSrgb(color) {
    const radians = (color.h * Math.PI) / 180;
    const linear = oklabToLinearSrgb(color.l, color.c * Math.cos(radians), color.c * Math.sin(radians));
    return linear.map((channel) => SRGB_TO_LINEAR(clamp01(LINEAR_TO_SRGB(channel))));
}
function luminance(color) {
    const [r, g, b] = linearSrgb(toOklch(color));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(foreground, background) {
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return round3((lighter + 0.05) / (darker + 0.05));
}
function hueLerp(from, to, amount) {
    const delta = ((to - from + 540) % 360) - 180;
    return (from + delta * amount + 360) % 360;
}
function formatOklch(color) {
    return `oklch(${color.l.toFixed(4)} ${color.c.toFixed(4)} ${color.h.toFixed(2)})`;
}
/** Mix `color` toward `ink` in oklch, the smallest step that reaches `minRatio` on `background`. */
export function mixTowardInk(color, ink, background, minRatio = 3.1) {
    let source;
    let target;
    try {
        source = toOklch(color);
        target = toOklch(ink);
    }
    catch {
        // A roster colour the mixer cannot read must not blank the week. Ink already clears the card.
        try {
            return { inkPercent: 100, ratio: contrastRatio(ink, background), color: ink };
        }
        catch {
            return { inkPercent: 100, ratio: 1, color: ink };
        }
    }
    for (let step = 0; step <= 1000; step += 1) {
        const amount = step / 1000;
        const mixed = {
            l: source.l + (target.l - source.l) * amount,
            c: source.c + (target.c - source.c) * amount,
            h: hueLerp(source.h, target.h, amount),
        };
        const ratio = contrastRatio(formatOklch(mixed), background);
        if (ratio >= minRatio) {
            return step === 0
                ? { inkPercent: 0, ratio: contrastRatio(color, background), color }
                : { inkPercent: round3(amount * 100), ratio, color: formatOklch(mixed) };
        }
    }
    const full = { l: target.l, c: target.c, h: target.h };
    return { inkPercent: 100, ratio: contrastRatio(formatOklch(full), background), color: formatOklch(full) };
}
