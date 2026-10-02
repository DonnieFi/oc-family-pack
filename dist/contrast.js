const SRGB_TO_LINEAR = (channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const LINEAR_TO_SRGB = (channel) => channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
const clamp01 = (channel) => Math.min(1, Math.max(0, channel));
const round3 = (value) => Math.round(value * 1000) / 1000;
function parseHex(input) {
    const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(input);
    const hex = match?.[1];
    if (!hex)
        return undefined;
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16) / 255);
}
function parseOklch(input) {
    const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s*\)$/i.exec(input);
    if (!match)
        return undefined;
    return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
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
function hexToOklch(hex) {
    const rgb = parseHex(hex);
    if (!rgb)
        throw new Error(`Unsupported color ${hex}`);
    const [r, g, b] = rgb.map(SRGB_TO_LINEAR);
    const lab = linearSrgbToOklab(r, g, b);
    const hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
    return { l: lab.l, c: Math.hypot(lab.a, lab.b), h: (hue + 360) % 360 };
}
function toOklch(color) {
    return parseOklch(color) ?? hexToOklch(color);
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
export function mixTowardInk(color, ink, background, minRatio = 3) {
    const source = toOklch(color);
    const target = toOklch(ink);
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
