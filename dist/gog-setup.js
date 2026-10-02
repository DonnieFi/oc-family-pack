import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAccess } from "./access.js";
const execFileAsync = promisify(execFile);
export function execGogSetup(timeoutMs = 20_000) {
    return (file, args) => execFileAsync(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
}
const PLACEHOLDER_EMAIL = "you@example.com";
const FULL_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const ACCOUNT = /^[A-Za-z0-9.+_][A-Za-z0-9._+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const AUTH_URL = /^https?:\/\/[^\s'"`\\]+$/;
const OAUTH_CLIENT_MISSING = /OAuth client credentials missing|No OAuth client credentials stored/;
const AUTH_FAILURE = /missing --account|invalid_grant|\(401 authError\)|No OAuth client credentials stored/;
const READONLY_GRANT = /insufficient|ACCESS_TOKEN_SCOPE|calendar\.readonly/i;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asText(value) {
    if (typeof value === "string")
        return value;
    if (Buffer.isBuffer(value))
        return value.toString("utf8");
    return "";
}
/** An address cannot become a flag, a second argument, or shell syntax. */
export function gogAccount(value) {
    const email = value?.trim() || PLACEHOLDER_EMAIL;
    if (!ACCOUNT.test(email))
        return PLACEHOLDER_EMAIL;
    return email;
}
/** A redirect URL is printed inside single quotes, so a quote or space is rejected. */
function quotedAuthUrl(value) {
    const url = value?.trim() ?? "";
    if (!url)
        return { rejected: false };
    if (!AUTH_URL.test(url))
        return { rejected: true };
    return { url, rejected: false };
}
function captured(error) {
    const record = isRecord(error) ? error : {};
    return { ok: false, stdout: asText(record.stdout), stderr: asText(record.stderr), enoent: record.code === "ENOENT" };
}
async function call(run, file, args) {
    try {
        const { stdout } = await run(file, args);
        return { ok: true, stdout, stderr: "", enoent: false };
    }
    catch (error) {
        return captured(error);
    }
}
function checks(stdout) {
    try {
        const parsed = JSON.parse(stdout);
        if (!isRecord(parsed) || !Array.isArray(parsed.checks))
            return [];
        return parsed.checks.flatMap((check) => {
            if (!isRecord(check) || typeof check.name !== "string" || typeof check.status !== "string")
                return [];
            return [{ name: check.name, status: check.status }];
        });
    }
    catch {
        return [];
    }
}
function clientNames(stdout) {
    try {
        const parsed = JSON.parse(stdout);
        if (!isRecord(parsed) || !Array.isArray(parsed.clients))
            return undefined;
        return parsed.clients.flatMap((client) => (isRecord(client) && typeof client.client === "string" ? [client.client] : []));
    }
    catch {
        return undefined;
    }
}
function accountCalendar(account) {
    if (account.readonly === true)
        return false;
    const services = Array.isArray(account.services) ? account.services.filter((service) => typeof service === "string") : [];
    const scopes = Array.isArray(account.scopes) ? account.scopes.filter((scope) => typeof scope === "string") : [];
    // gog keeps services: ["calendar"] for a read-only grant and records the
    // limit only in scopes. A scope list decides; a service name alone does not.
    if (scopes.length > 0) {
        if (scopes.some((scope) => scope === FULL_CALENDAR_SCOPE))
            return true;
        if (scopes.some((scope) => scope.includes("calendar.readonly")))
            return false;
        if (!services.includes("calendar"))
            return false;
        return "unknown";
    }
    if (services.includes("calendar") || (services.length === 0 && scopes.length === 0))
        return "unknown";
    return false;
}
function accounts(stdout) {
    try {
        const parsed = JSON.parse(stdout);
        if (!isRecord(parsed) || !Array.isArray(parsed.accounts))
            return undefined;
        return parsed.accounts.flatMap((account) => (isRecord(account) ? [{ calendar: accountCalendar(account) }] : []));
    }
    catch {
        return undefined;
    }
}
function missing() {
    return {
        status: "missing",
        command: "brew install openclaw/tap/gogcli",
        message: "gog is not installed. After it is on PATH, run `openclaw family gog` again.",
    };
}
function noClient(headless) {
    return headless
        ? {
            status: "no-client",
            command: "gog auth credentials set client_secret.json",
            message: "gog has no OAuth client yet. Download a Desktop client JSON from Google Cloud and store it with the next command. On a machine with a browser, `gog auth setup` is the guided version of the same step.",
        }
        : {
            status: "no-client",
            command: "gog auth setup",
            message: "gog has no OAuth client yet. The next command guides Google Cloud and stores the client. Headless hosts use `gog auth credentials set client_secret.json` instead.",
        };
}
function keyring() {
    return {
        status: "keyring",
        command: "gog auth keyring file",
        message: "The keyring is not usable from this process. Use the file keyring, set GOG_KEYRING_PASSWORD for the user that runs the Gateway, then run `openclaw family gog` again.",
    };
}
function authAdd(email, headless, authUrl, force) {
    const consent = force ? " --force-consent" : "";
    if (!headless)
        return { command: `gog auth add ${email} --services calendar${consent}`, followUp: "" };
    const step2 = authUrl
        ? `gog auth add ${email} --services calendar --remote --step 2 --auth-url '${authUrl}'${consent}`
        : `gog auth add ${email} --services calendar --remote --step 2 --auth-url 'PASTE_REDIRECT_URL'${consent}`;
    if (authUrl)
        return { command: step2, followUp: "" };
    return { command: `gog auth add ${email} --services calendar --remote --step 1${consent}`, followUp: step2 };
}
function noAccount(email, headless, authUrl, rejectedUrl) {
    const { command, followUp } = authAdd(email, headless, authUrl, false);
    const rejected = rejectedUrl ? " The redirect URL was not a plain http(s) address, so it was left out." : "";
    const next = followUp ? ` After that command prints a URL, open it, then run:\n${followUp}` : "";
    return {
        status: "no-account",
        command,
        message: `No Google account is stored for Calendar. Authorize the calendar service. Leave off --readonly.${rejected}${next}`,
    };
}
function readonly(email, headless, authUrl, rejectedUrl) {
    const { command, followUp } = authAdd(email, headless, authUrl, true);
    const rejected = rejectedUrl ? " The redirect URL was not a plain http(s) address, so it was left out." : "";
    const next = followUp ? ` After that command prints a URL, open it, then run:\n${followUp}` : "";
    return {
        status: "readonly",
        command,
        message: `Calendar access is missing or read-only. Authorize the calendar service again. Leave off --readonly.${rejected}${next}`,
    };
}
function ready() {
    return {
        status: "ready",
        command: "gog calendar calendars --json --no-input",
        message: "gog can read calendars. Run the next command and add each calendar id to plugins.entries.oc-family-pack.config. The Family page lists that week once the plugin reloads.",
    };
}
/**
 * The next gog command for this host. Stops at the first missing step.
 * Doctor output is used only to choose the step; paths and tokens are not copied.
 */
export async function diagnoseGog(run, options = {}) {
    const file = options.gogPath?.trim() || "gog";
    const email = gogAccount(options.email);
    const headless = options.headless !== false;
    const redirect = quotedAuthUrl(options.authUrl);
    const doctor = await call(run, file, ["auth", "doctor", "--json", "--no-input"]);
    if (doctor.enoent)
        return missing();
    if (checks(doctor.stdout).some((check) => check.name.startsWith("keyring.") && check.status === "error"))
        return keyring();
    const credentials = await call(run, file, ["auth", "credentials", "list", "--json", "--no-input"]);
    if (credentials.enoent)
        return missing();
    const clients = clientNames(credentials.stdout);
    if ((clients !== undefined && clients.length === 0) || OAUTH_CLIENT_MISSING.test(credentials.stderr) || OAUTH_CLIENT_MISSING.test(doctor.stderr)) {
        return noClient(headless);
    }
    const listed = await call(run, file, ["auth", "list", "--json", "--no-input"]);
    if (listed.enoent)
        return missing();
    const stored = accounts(listed.stdout) ?? [];
    if (stored.length === 0)
        return noAccount(email, headless, redirect.url, redirect.rejected);
    if (stored.every((account) => account.calendar === false))
        return readonly(email, headless, redirect.url, redirect.rejected);
    const calendars = await call(run, file, ["calendar", "calendars", "--json", "--no-input"]);
    if (calendars.enoent)
        return missing();
    if (calendars.ok)
        return ready();
    if (READONLY_GRANT.test(calendars.stderr))
        return readonly(email, headless, redirect.url, redirect.rejected);
    if (AUTH_FAILURE.test(calendars.stderr))
        return noAccount(email, headless, redirect.url, redirect.rejected);
    return {
        status: "no-account",
        command: "gog auth doctor --json --no-input",
        message: "gog could not list calendars. The next command reports the auth check that failed.",
    };
}
export function formatGogSetup(plan) {
    return `${plan.message}\nNext: ${plan.command}`;
}
function gatewayPort(gateway) {
    const port = typeof gateway === "object" && gateway !== null ? gateway.port : undefined;
    return typeof port === "number" ? port : undefined;
}
/**
 * `openclaw family gog` prints the one command that moves gog setup forward.
 * `openclaw family access` reports the household sign-in mode, or prints the setup for one.
 */
export function registerFamilyCli(program, deps) {
    const write = deps.write ?? ((text) => console.log(text));
    const family = program.command("family").description("Family Pack setup");
    family
        .command("gog")
        .description("Print the next gog command for this host")
        .option("--account <email>", "Google account to authorize", PLACEHOLDER_EMAIL)
        .option("--desktop", "Print a browser login instead of the headless --remote flow")
        .option("--auth-url <url>", "Browser redirect URL from the headless auth step")
        .action(async (opts) => {
        const plan = await diagnoseGog(deps.run, {
            ...(deps.gogPath ? { gogPath: deps.gogPath } : {}),
            ...(opts.account ? { email: opts.account } : {}),
            ...(opts.authUrl ? { authUrl: opts.authUrl } : {}),
            headless: opts.desktop !== true,
        });
        write(formatGogSetup(plan));
        process.exitCode = plan.status === "ready" ? 0 : 1;
    });
    family
        .command("access")
        .description("Report the household sign-in mode, or print the setup for one")
        .argument("[mode]", "solo or lan")
        .argument("[names...]", "People with no role flag, set up as guests")
        .option("--parent <name...>", "Parents: full access and every session")
        .option("--kid <name...>", "Kids: read, and write their own sessions")
        .option("--guest <name...>", "Guests: read only")
        .action((mode, names, opts) => {
        const port = gatewayPort(deps.gateway);
        const result = runAccess(deps.gateway, mode, {
            ...(opts.parent ? { parent: opts.parent } : {}),
            ...(opts.kid ? { kid: opts.kid } : {}),
            ...(opts.guest ? { guest: opts.guest } : {}),
            ...(names ? { names } : {}),
        }, port !== undefined ? { port } : {});
        write(result.text);
        process.exitCode = result.ok ? 0 : 1;
    });
}
