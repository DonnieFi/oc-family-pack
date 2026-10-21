/** The live Gateway's own port. The smoke never binds or contacts it. */
export const LIVE_GATEWAY_PORT = 18789;

/** Ports the live Gateway holds: its own and the sidecar it opens 10 above it. */
export const LIVE_PORTS = [LIVE_GATEWAY_PORT, LIVE_GATEWAY_PORT + 10];

/**
 * Why a smoke Gateway port can't be used, or undefined when it can. The
 * smoke Gateway also opens a sidecar 10 above its port, so both must be
 * off the live Gateway's ports and free.
 */
export async function pickRefusal(port: number, isFree: (port: number) => Promise<boolean>): Promise<string | undefined> {
  for (const needed of [port, port + 10]) {
    if (LIVE_PORTS.includes(needed)) return `port ${port} would use ${needed}, which belongs to the live Gateway`;
    if (!(await isFree(needed))) return `port ${port} needs ${needed}, and something already listens there`;
  }
  return undefined;
}
