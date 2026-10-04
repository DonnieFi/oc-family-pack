import crypto from "node:crypto";
import type { TableDecision } from "./write-gate.ts";

/**
 * The one tool parameter the before_tool_call hook writes and the calendar tools read. It is
 * not in any tool schema the model sees, the hook overwrites it on every call, and the tool
 * strips it before deriving the key, so it is never hashed, stamped on an event, or logged.
 */
export const STAMP_PARAM = "ocfpStamp";

const DECISIONS: readonly TableDecision[] = ["write", "approved"];

/** What the hook read for a parent's approval: the event's version (its etag, else its updated time) and its name. */
export type Seen = { version: string; title: string };

export type Stamper = {
  /**
   * The hook's stamp for one call: what the table decided, for this key and this tool. With
   * `seen`, the stamp is `<mac>.<base64url JSON [version, title]>`: the tool reads what the hook
   * saw in the clear, and the MAC covers it. Without, it is the MAC alone (an empty version).
   */
  stamp(base: string, decision: TableDecision, tool: string, seen?: Seen): string;
  /** The decision a stamp proves for this key and tool, or undefined for a missing, malformed, forged or mismatched one. Never throws. */
  verify(value: unknown, base: string, tool: string): TableDecision | undefined;
  /** `verify`, plus what the hook saw when the stamp carries it. */
  open(value: unknown, base: string, tool: string): { decision: TableDecision; seen?: Seen } | undefined;
};

/** A fixed-order JSON array, so no field can run into the next. */
function message(base: string, decision: TableDecision, tool: string, seen?: Seen): string {
  return JSON.stringify(["ocfp-stamp-v1", tool, decision, base, ...(seen ? [seen.version, seen.title] : [])]);
}

function carry(seen: Seen): string {
  return Buffer.from(JSON.stringify([seen.version, seen.title]), "utf8").toString("base64url");
}

function uncarry(text: string): Seen | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && parsed[0] && typeof parsed[1] === "string") return { version: parsed[0], title: parsed[1] };
  } catch {
    // Not ours.
  }
  return undefined;
}

/**
 * HMAC-SHA256 under a secret made when the plugin registers. The secret lives in this closure
 * only: never logged, never in config or the database. A Gateway restart makes a new one, so a
 * stamp never outlives the process that made it.
 */
export function createStamper(secret: Buffer = crypto.randomBytes(32)): Stamper {
  const mac = (base: string, decision: TableDecision, tool: string, seen?: Seen) => crypto.createHmac("sha256", secret).update(message(base, decision, tool, seen)).digest("hex");
  const open: Stamper["open"] = (value, base, tool) => {
    if (typeof value !== "string") return undefined;
    const dot = value.indexOf(".");
    const seen = dot === -1 ? undefined : uncarry(value.slice(dot + 1));
    if (dot !== -1 && !seen) return undefined;
    const given = Buffer.from(dot === -1 ? value : value.slice(0, dot), "utf8");
    for (const decision of DECISIONS) {
      const expected = Buffer.from(mac(base, decision, tool, seen), "utf8");
      // timingSafeEqual throws on a length mismatch, so a wrong-length stamp stops here.
      if (given.length !== expected.length) return undefined;
      if (crypto.timingSafeEqual(given, expected)) return seen ? { decision, seen } : { decision };
    }
    return undefined;
  };
  return {
    stamp: (base, decision, tool, seen) => (seen ? `${mac(base, decision, tool, seen)}.${carry(seen)}` : mac(base, decision, tool)),
    verify: (value, base, tool) => open(value, base, tool)?.decision,
    open,
  };
}
