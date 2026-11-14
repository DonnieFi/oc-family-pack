import path from "node:path";
/** Detect an executable, not a configured or trusted proxy. Never probe arbitrary network endpoints. */
export async function probeCaddy(run, platform = process.platform, localAppData = process.env.LOCALAPPDATA) {
    const candidates = platform === "win32"
        ? ["caddy.exe", ...(localAppData ? [path.win32.join(localAppData, "Microsoft", "WinGet", "Links", "caddy.exe")] : [])]
        : ["caddy"];
    for (const executable of candidates) {
        try {
            const { stdout } = await run(executable, ["version"]);
            const version = stdout.trim().split(/\s+/)[0] ?? "";
            if (!/^v?2\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))
                return { status: "unknown" };
            return { status: "installed", version, executable };
        }
        catch (error) {
            if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT")
                return { status: "unknown" };
        }
    }
    return { status: "missing" };
}
export function describeCaddy(probe, platform = process.platform, existingProxy = false) {
    const caveat = "A detected binary is not proof of a trusted, configured or running proxy. Verify HTTPS, identity headers and login before changing Gateway authentication.";
    const existing = existingProxy ? "The Gateway already has trusted-proxy authentication configured; inspect and preserve its existing proxy instead of replacing it automatically. Its readiness is unverified. " : "";
    if (probe.status === "installed")
        return `${existing}Caddy ${probe.version} is installed. ${caveat}`;
    if (probe.status === "unknown")
        return `${existing}Caddy status could not be verified; no install will be attempted. ${caveat}`;
    if (existingProxy)
        return `${existing}Caddy was not found; another compatible proxy may be in use. ${caveat}`;
    const offer = platform === "win32"
        ? "To install with Windows winget, review the publisher and run `openclaw family access lan --install-caddy --confirm-install`."
        : "Install Caddy using the official instructions at https://caddyserver.com/docs/install, or use an existing compatible proxy.";
    return `Caddy was not found. ${offer} Installation is optional and does not configure or start a proxy. ${caveat}`;
}
/** Installation only occurs after explicit flags and a missing-binary probe. */
export async function installCaddy(run, probe, confirmed, platform = process.platform) {
    if (!confirmed)
        return { ok: false, message: "No install attempted. Review the Windows winget installation and add --confirm-install to approve it." };
    if (probe.status === "installed")
        return { ok: true, message: "Caddy is already installed; no installation was attempted." };
    if (probe.status === "unknown")
        return { ok: false, message: "Caddy status is unknown; refusing to install over an unverified existing executable." };
    if (platform !== "win32")
        return { ok: false, message: "Automatic Caddy installation is not supported on this platform; see https://caddyserver.com/docs/install." };
    try {
        await run("winget.exe", ["install", "--id", "CaddyServer.Caddy", "--exact", "--source", "winget", "--scope", "user", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"]);
    }
    catch {
        return { ok: false, message: "Caddy installation did not complete. Check winget and permissions; no proxy or Gateway settings were changed." };
    }
    const after = await probeCaddy(run, platform);
    if (after.status !== "installed")
        return { ok: false, message: "Winget returned success, but Caddy could not be verified in this process. Refresh PATH or verify the installation before continuing." };
    return { ok: true, message: `Caddy ${after.version} is installed. It is not yet configured, started, trusted or verified for LAN login.` };
}
/** Verify only TLS and the proxy's HTTP authentication; no Gateway role or readiness claims. */
export async function verifyProxy(request, input) {
    let url;
    try {
        url = new URL(input.url);
    }
    catch {
        return { ok: false, message: "Enter a valid HTTPS origin with no path, query, fragment or credentials." };
    }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !input.username || /[:\r\n]/.test(input.username) || !input.password || !input.ca.trim()) {
        return { ok: false, message: "Enter an HTTPS origin, a username without a colon or newline, a password, and the proxy's public CA certificate." };
    }
    // This endpoint is served by the generated proxy before the Gateway, so it
    // works before the Gateway switches from token to trusted-proxy auth.
    url.pathname = "/__openclaw_family_proxy_check";
    try {
        const anonymous = await request(url, input.ca);
        if (anonymous !== 401)
            return { ok: false, message: `Proxy check failed: anonymous request returned HTTP ${anonymous}, not 401. Do not switch Gateway authentication.` };
        const authorization = `Basic ${Buffer.from(`${input.username}:${input.password}`, "utf8").toString("base64")}`;
        const authenticated = await request(url, input.ca, authorization);
        if (authenticated !== 204)
            return { ok: false, message: `Proxy check failed: authenticated request returned HTTP ${authenticated}, not the expected 204. Ensure the proxy serves the Family preflight endpoint; do not switch Gateway authentication.` };
        return { ok: true, message: "HTTPS certificate and proxy HTTP authentication passed for this username. This does not prove Gateway identity, browser pairing, role restrictions, or that another device trusts the certificate; verify each after cutover and keep the rollback ready." };
    }
    catch {
        return { ok: false, message: "Proxy check failed: HTTPS or the connection could not be verified. Check the URL, CA certificate and proxy; do not switch Gateway authentication." };
    }
}
