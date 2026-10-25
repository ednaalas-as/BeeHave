# Phase 1: nearby BeeHave setup

This package is **not installed on the physical Pi automatically**. It is separate
from `beehave-continuous.service`, its virtual environment, and every monitoring
file. It does not enumerate, open, convert, upload, move, or delete recordings,
CSVs, detections, sensor history, queues, or RabbitMQ data.

## User flow after one-time installation

1. Power on the Pi. Existing NetworkManager Wi-Fi profiles remain in use.
2. On the same network, open **Edge Device → Register device → Set up a nearby
   BeeHave Pi** on web, or **Devices → Set up a nearby BeeHave Pi** on mobile.
3. Native mobile discovers `_beehave._tcp` with Bonjour/Android NSD. Web tries the
   printed `.local` name (default `beehave-pi.local`); this is a known-host lookup,
   not browser-wide mDNS service enumeration. No manually found IP is needed.
4. If Wi-Fi remains disconnected for approximately 90 seconds, the separate
   service first tries every saved Wi-Fi profile that is in range (autoconnect
   enabled, most recently used first). Only if none connects does it activate its
   protected `BeeHave-Setup-…` hotspot. While the hotspot is up and no device is
   using it, the service checks every 5 minutes for a saved network that has come
   back and rejoins it automatically. Join using the
   printed label. Open the printed `.local:8765` setup address in a browser, or
   select **Set up Wi-Fi** in mobile. Enter the setup code, SSID, and password.
5. Rejoin the chosen Wi-Fi on the phone/computer, find the Pi again, and enter
   its setup code, device name, and installation label. Select **Pair with this
   farm**. The account's current farm is used; it cannot be supplied by the Pi.
6. The Pi appears in Edge Device after signed confirmation. It deliberately
   retains an unknown monitoring connection: Phase 1 sends no health reports,
   sensor readings, audio, historical data, or other monitoring payloads.

The Wi-Fi form supports WPA/WPA2 personal networks with 8–63 character passwords.
It does not claim enterprise/open-network support. Failed attempts leave previous
profiles unchanged and try to restore the previous connection. New failed setup
profiles remain disabled for autoconnection; nothing pre-existing is deleted.

## One-time administrator installation (not an end-user step)

Prerequisites: NetworkManager, Avahi, `dnsmasq` executable (for NetworkManager's
shared hotspot), Python with `venv`, and network access for the isolated Python
dependency. Inspect these first; the installer does not install OS packages.

Build `portal.js` from the repo if changing `portal.ts` or the shared setup protocol:

```sh
NODE_PATH=packages/shared/node_modules node_modules/.bin/esbuild scripts/nearby_setup/portal.ts --bundle --minify --format=iife --outfile=scripts/nearby_setup/portal.js
```

Transfer **only this package** to a new directory outside the Pi's existing
monitoring directory. Run `install.py` with the exact trusted BeeHave web origin,
for example `sudo python3 install.py --web-origin https://YOUR-BEEHAVE-HOST`.
Replace that example with the actual origin; do not run it literally. Multiple
`--web-origin` arguments allow explicitly trusted development origins.

The installer creates only:

- `/opt/beehave-setup/`: isolated code and Python virtual environment.
- `/var/lib/beehave-setup/`: root-only identity, pairing state, setup label,
  allowed origins, and Wi-Fi setup status.
- `/etc/systemd/system/beehave-setup.service`: a separate boot service.
- `/etc/avahi/services/beehave-setup.service`: a discovery advertisement.
- `/etc/NetworkManager/system-connections/beehave-setup.nmconnection`: a new,
  protected hotspot profile. It is loaded without activating it during install.

Later explicit Wi-Fi setup creates a **new** `beehave-wifi-<uuid>.nmconnection`.
Neither the installer nor the daemon edits existing Wi-Fi profiles. The installer
refuses pre-existing setup paths instead of overwriting them. Partial installation
requires review, not blind re-running. It checks hotspot subnet conflicts.

Privately print `/var/lib/beehave-setup/setup-label.txt` for the owner. It contains
secrets; do not paste it into chat, commit it, or send it to logs. This is a physical
possession credential. From agent 0.4.2, a paired Pi also reports this label to BeeHave
(sealed at rest with the API's setup-label key, `SETUP_LABEL_KEY` or `apps/api/data/setup-label.key`),
and the device's farm owners can read it under Edge Device → Advanced settings → Setup label,
even while the Pi is offline in setup mode. A secure label/reset lifecycle is required before sharing
or transferring a device; this Phase 1 package provides no remote reset or transfer.

The setup service is denied `/home` access with `ProtectHome=true`. It writes only
its own state and new NetworkManager profiles. It never restarts the monitoring
service. NetworkManager/Avahi are reused, not replaced or restarted.

## Security and recovery

- Each Pi generates an Ed25519 identity and a random 128-bit printed setup code.
- Local commands and responses use AES-256-GCM with HKDF-derived per-request keys,
  random client entropy, separate request/response nonces, and one-use 30-second
  server challenges. Codes and Wi-Fi passwords never enter API requests or logs.
- HTTP local transport carries encrypted command payloads; discovery metadata is
  public. Origin and Host checks reject untrusted browser origins and DNS rebinding
  hosts. The Wi-Fi HTML page is served only through the protected setup hotspot.
- The Pi generates its device key locally and persists it before signing receipt.
  The key never crosses the network. The backend stores only its SHA-256 hash.
- The farm administrator relays a Pi-signed invitation and confirmation through
  the existing authenticated API. Account/session credentials never go to the Pi.
- The separate `device_pairings` table expires incomplete challenges after ten
  minutes. Expired pending rows are removed on subsequent pairing starts.
  Completed rows retain identity/association for duplicate prevention and recovery;
  challenge and nonce are cleared. No monitoring-table schema changes occur.
- Pairing creates the device only after proof of possession. Concurrent retries
  serialize in PostgreSQL; an already claimed Pi cannot be claimed by another farm.
- Do not port-forward the setup server or expose it through remote access tunnels.
  No remote discovery, cloud device polling, or miles-away pairing is implemented.

## Platform limits and deployment

Native discovery requires a new iOS/Android build containing `react-native-zeroconf`;
Expo Go cannot gain native discovery through a JavaScript update. iOS declares the
Bonjour type and local-network purpose. Android permits local HTTP only for `.local`
hosts via a scoped network-security configuration. All sensitive setup payloads are
encrypted independently of transport. No broad arbitrary-load exception is added.

Browser local-network/mixed-content policies differ. Supporting browsers request
local-network permission. If blocked, the UI directs users to the installed mobile
app. A web page does not have a general Bonjour enumeration API. The standalone
hotspot Wi-Fi page works without contacting the BeeHave backend; pairing follows
once the user rejoins their regular network. Guest Wi-Fi client isolation can block
nearby connectivity on either platform.

## Verification

- `node_modules/.bin/tsx --test apps/api/src/pairing.test.ts`: temporary PostgreSQL
  schema only; tests auth, signatures, expiry, cross-farm rejection, retries,
  idempotence, legacy registration, and absence of monitoring writes.
- In a test venv with `cryptography==46.0.5`, run
  `python -m unittest discover -s scripts/nearby_setup -p 'test_*.py' -v`.
- Set `SETUP_TEST_PYTHON` to that venv's Python, then run
  `node_modules/.bin/tsx --test scripts/nearby_setup/protocol.test.ts` for a real
  Python/TypeScript encrypted protocol test with synthetic temporary state.

Physical acceptance is still required: verify installed native discovery on both
OSes, hotspot availability on this Pi's wireless driver, DHCP, Wi-Fi success/failure,
reboot recovery, allowed browser origins, and pairing under interrupted connections.
Do not use actual monitoring files as test fixtures or upload them for these checks.

## Multiple saved networks and failover

NetworkManager autoconnects to the best saved Wi-Fi in range: highest
`connection.autoconnect-priority` first, then the most recently used. The setup
service follows the same order. If Wi-Fi stays down for about 90 seconds it tries
every saved network in range before raising the setup hotspot; while the hotspot is
idle (no device joined), it steps aside every 2 minutes to look for a saved network
again, e.g. a phone hotspot switched on later. A network added through the setup
page is saved for automatic use only after it connects, with an optional priority
(0–100, default 50). Existing profiles are never deleted.

On the setup hotspot, open `http://192.168.77.1:8765` (or the `.local` address). The
page asks the Pi for a scan (SSID, signal, security only; while the radio serves the
hotspot this is the scan taken just before setup mode started), supports hidden and
open networks, and reports distinct results: incorrect password, network not found,
no IP address, timed out, or connected with BeeHave Cloud reachable / unreachable /
no internet / captive portal. Credentials that associate and obtain an address are
kept even if the internet or BeeHave Cloud is down; a failed attempt removes only the
profile it created and restores the previous network or the setup hotspot. The
cloud check is an unauthenticated `GET /api/health` against `BEEHAVE_API_URL`.

Install on a Pi that already runs nearby setup (do not rerun `install.py`):

```sh
sudo python3 update_network_failover.py            # verifies hashes, backs up, renames hotspot to BeeHave-01-Setup, restarts only beehave-setup
sudo python3 update_network_failover.py --rollback # restores the previous files
```

Manage saved networks with `/opt/beehave-setup/wifi_profiles.py` (sudo for changes):
`list`, `priority "PROFILE" N`, `autoconnect "PROFILE" on|off`, and
`add "SSID" [--priority N] [--hidden] [--open]`, which asks for the password without
echo and saves the network for later without switching the current connection.
It never deletes profiles and never modifies the setup hotspot.

## Device management

Administrators can disconnect a registration from Edge Device on web or mobile,
with explicit confirmation. This revokes its credential immediately at the API,
including a recheck at existing upload transaction locks. The historical device row
keeps its original farm ownership and becomes disconnected. Historical records and
Pi files are not removed. The Pi can be offline when its access is revoked.

Deletion requires a disconnected registration with no readings, recordings/audio,
or detections. The API locks the device, checks all references, and retains existing
foreign-key protections. It never cascades deletion. Completed/released pairing
identity state remains separate so revoked credentials cannot be reused even after
an empty registration is deleted.

For an already-installed Phase 1 Pi, use the separately packaged
`update_management.py` with its matching `service.py`. The updater verifies the
original installed script hash, backs up only that script, and restarts only
`beehave-setup.service`. It does not modify Wi-Fi, setup identity, current pairing
state, the monitoring service, or any monitoring file. Do not rerun `install.py`.

On subsequent nearby pairing, the client verifies with the API that the identity
has been released, then uses the encrypted setup-code channel to ask the Pi for a
fresh credential. This changes only its own `pairing.json`. Re-pairing creates a
new device ID; the old farm's historical ownership is never transferred. Already
installed mobile binaries need the updated application bundle/build as appropriate.
