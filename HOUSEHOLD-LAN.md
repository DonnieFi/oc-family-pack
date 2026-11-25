# Switching a Gateway to household LAN mode

This moves a Gateway from the shared token to one sign-in per family member, through a proxy on the same machine, and pairs with OpenClaw Multiplayer (native profile linking and live online presence in **People**, plus the Household Guest and invite-only `household-parent` access presets with account-aware DM isolation and sandbox tool denials). It stays local: nothing here makes the Gateway reachable from the internet.

When the Gateway uses trusted-proxy auth, Family Pack treats the household as LAN even if `accessMode` is unset; setting `accessMode: "lan"` makes it explicit. A device token with no device identity is refused by the Gateway before the plugin runs. After the printed LAN roles are applied, a paired device token with no verified user is refused at connect. If the host still accepts that session, the plugin treats it as a guest and shows shared calendars only. Revoke device tokens from shared and kid devices anyway: a token left behind still reaches the Gateway.

Start by printing your setup. Every step below uses its output.

```sh
openclaw family access lan --parent alex --kid riley
```

The command checks whether a Caddy executable can report its version. It does not establish that Caddy is trusted, configured, running, serving HTTPS, or correctly authenticating users. If no binary is found, Windows users can explicitly approve installation with `openclaw family access lan --install-caddy --confirm-install`. This uses winget's `CaddyServer.Caddy` package with user scope; review the package and its terms first. It does not configure or start Caddy, change the firewall or apply a Gateway patch. Re-run the access command after installation. On other platforms use [Caddy's installation guide](https://caddyserver.com/docs/install), or configure a compatible existing proxy. An unknown or failing detection is not treated as a missing package and is never overwritten automatically.

## 1. List what uses the shared token

The shared token stops working in LAN mode. Write down everything that connects with it today, plus anything else you gave the token to, like a script or another computer's CLI.

```sh
openclaw devices list
# For each shared/kid device token, then repeat for its role:
openclaw devices revoke --device <id> --role <role> --password '<gateway password>'
```

## 2. Back up the config

```sh
cp "$(openclaw config file)" "$(openclaw config file).before-lan"
```

## 3. How to undo

Restore the backup and restart. The shared token works again.

```sh
cp "$(openclaw config file).before-lan" "$(openclaw config file)" && openclaw gateway restart
```

## 4. Proxy

Save the printed Caddyfile. Replace `LAN_ADDRESS` with this machine's address on your home network, like `192.168.1.20`. Use the same address in the Caddyfile and in `allowedOrigins`. If you add a port to the Caddyfile, add it to the origin too. Run `caddy hash-password` once for each person and paste each hash in place of its placeholder. Then load it:

```sh
caddy reload --config ./Caddyfile
```

On Windows, install Caddy separately using its [official installation guide](https://caddyserver.com/docs/install). Family Pack prints this configuration but does not install Caddy, create a Windows service, or open a firewall port. `caddy reload` requires a running Caddy instance; for an initial foreground test in PowerShell, use `caddy run --config .\Caddyfile`, then run reload from another terminal if needed. A foreground process is not a persistent service.

Anything else running on this machine can sign in as any family member. Run only the proxy and the Gateway here.

Before changing Gateway authentication, validate the saved file with `caddy validate --config ./Caddyfile`, start the proxy, and verify its certificate and login from a family device. Confirm an unauthenticated request is rejected and each expected username can authenticate. A successful HTTPS page alone does not establish Gateway user identity or role restrictions. Keep the pre-LAN backup and a host-local recovery route ready; do not apply the Gateway blocks if the proxy checks fail.

From a device that can reach the proxy, the read-only preflight below checks the public CA, an anonymous 401, and an authenticated HTTP 204 on `/__openclaw_family_proxy_check`. The generated Caddyfile serves that endpoint after authentication without forwarding it to the Gateway, so the check works before the Gateway's auth mode changes. Another proxy must implement the same authenticated endpoint, or be checked manually. Run it once per username. The secret is read from the environment, not a command-line flag; avoid recording it in shell history, logs or source control. Replace the origin, username and public certificate path with your own. This command does not set up the proxy or change Gateway configuration.

```sh
read -rs -p 'Proxy password: ' OPENCLAW_FAMILY_PROXY_PASSWORD; echo
export OPENCLAW_FAMILY_PROXY_PASSWORD
openclaw family access lan --verify-proxy --proxy-url https://LAN_ADDRESS --proxy-user alex --proxy-ca ./caddy-root.crt
unset OPENCLAW_FAMILY_PROXY_PASSWORD
```

In Windows PowerShell, use the same command after securely reading the password, and remove it from the environment afterward:

```powershell
$env:OPENCLAW_FAMILY_PROXY_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Proxy password' -AsSecureString)).Password
try { openclaw family access lan --verify-proxy --proxy-url https://LAN_ADDRESS --proxy-user alex --proxy-ca .\caddy-root.crt }
finally { Remove-Item Env:OPENCLAW_FAMILY_PROXY_PASSWORD -ErrorAction SilentlyContinue }
```

The check verifies only the selected device's TLS trust and HTTP login. It does **not** verify the Gateway's forwarded identity, browser pairing, roles, or another device's certificate trust. Those require the post-cutover checks below.

## 5. Config

Save the printed Gateway config block as `family-gateway.json` and the Roles block as `family-roles.json`, with `LAN_ADDRESS` replaced the same way. Apply both:

```sh
openclaw config patch --file ./family-gateway.json && openclaw config patch --file ./family-roles.json
```

Keep `gateway.auth.password` set, because `users.setRole` uses it. Run `openclaw family access` to check. It should list nothing left to do.

## 6. Restart

```sh
openclaw gateway restart
```

## 7. Root certificate on each device

Caddy signs its own certificate, so every family phone and laptop needs Caddy's root certificate installed once, or the Family page won't load. It's `pki/authorities/local/root.crt` in Caddy's data folder. For the Caddy package on Linux, copy it out with:

```sh
sudo cp /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

Send `caddy-root.crt` to each device and install it as a trusted certificate.

On a typical Windows user installation, Caddy's data folder is `%AppData%\Caddy`; confirm its actual storage location before copying the **public** `pki\authorities\local\root.crt`. Never distribute the CA private key. Each client must trust the certificate separately.

## 8. First sign-in

Each person opens `https://LAN_ADDRESS` (your address, like `https://192.168.1.20`) and signs in with their own username and password. Until step 9 they can only read.

## 9. `setRole`

List the profiles to find each person's id:

```sh
openclaw gateway call users.list --json
```

Then set each role with the printed line, replacing the `PROFILE_` placeholder with that id:

```sh
openclaw gateway call users.setRole --params '{"profileId":"PROFILE_alex","role":"parent"}'
```

The person gets the new role the next time they load the page.

Verify a parent and a kid in separate browser profiles or devices. Confirm the names and role-limited calendar/People views, and deny contact details to the kid. If verification fails, restore the saved config and restart instead of leaving an unverified LAN cutover active. If the trusted-proxy Gateway will not accept the local CLI during recovery, stop it through its service owner before restoring the backup; do not delete or regenerate its original token.

A roster role and a Gateway role are separate. `openclaw family access lan` writes `identityScopes`, and `users.setRole` writes the host role. `members[].role` in the plugin config decides Discord calendar writes, page writes, People, and approvals. Run `openclaw family access role NAME=ROLE` when someone changes role to print all three updates together. `openclaw family setup` checks `identityScopes` against `members[].role`, and `openclaw family access check` compares `users.list`, `identityScopes`, and the roster.

## 10. Calendar approvals

If a kid will change a shared calendar, apply the `approvals.plugin` block that `openclaw family setup` prints in LAN mode. It routes the approval to the roster parents' Discord DMs. Only a parent has `operator.approvals`. The block is Gateway-wide: it also covers other plugin approvals.

Enable writes for the proof window, then have a kid change a shared event and confirm a parent gets the approval and the kid cannot approve it. Turn writes back off until the household is ready.
