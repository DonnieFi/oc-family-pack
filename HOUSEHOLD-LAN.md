# Switching a Gateway to household LAN mode

This moves a Gateway from the shared token to one sign-in per family member, through a proxy on the same machine. It stays local: nothing here makes the Gateway reachable from the internet.

Start by printing your setup. Every step below uses its output.

```sh
openclaw family access lan --parent alex --kid riley
```

## 1. List what uses the shared token

The shared token stops working in LAN mode. Write down everything that connects with it today, plus anything else you gave the token to, like a script or another computer's CLI.

```sh
openclaw devices list
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

Anything else running on this machine can sign in as any family member. Run only the proxy and the Gateway here.

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
