# BeeHave

A database-connected local prototype for bee bioacoustic monitoring around coconut flowers. React/Vite web, Expo/React Native mobile, and a TypeScript/PostgreSQL API share one npm-workspaces repository.

For Terminal instructions on this Mac, see [Run BeeHave yourself](docs/RUNNING_LOCALLY.md).

## Run the web app

Requires Node 20.19.4+ (verified with Node 20.20.2), npm, PostgreSQL 16+, and Python 3 for the optional edge utility. PostgreSQL 16 is already running on this Mac and the `beehave` database has been created.

On a fresh Mac with Homebrew PostgreSQL 16 installed, run `brew services start postgresql@16` and `createdb -h localhost beehave` once before starting the app. The PostgreSQL role must be allowed to create tables.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. Select **Explore sample farm** to inspect clearly labeled synthetic records and demonstration tones, or **Create an account** for a private, initially empty farm. There are no default passwords. First sample initialization generates 30 days of persistent data and can take several seconds. The sample dashboard initially selects Week. Sample observations retain their original dates; use historical filters when revisiting later.

The API listens on `127.0.0.1:3001`. The database is PostgreSQL `beehave` on `localhost:5432`, using your local PostgreSQL role by default. Set `DATABASE_URL` if your installation needs a different host, username, or password. Restarting the server does not erase accounts or observations.

## PostgreSQL and the previous data

The existing prototype data was copied into PostgreSQL on September 23, 2026. The old `apps/api/data/beehave.sqlite` remains as a backup. The running API does not read or update that file.

To inspect the database locally:

```sh
psql -h localhost -d beehave
```

Inside psql, `\dt` lists tables. `SELECT count(*) FROM detections;` counts saved detections. Use `\q` to exit. The schema is readable in `apps/api/src/database/schema.sql`.

For a custom connection, export `DATABASE_URL` in the terminal that starts the API. For example, `export DATABASE_URL=postgresql://localhost:5432/beehave`. Set passwords through your local environment; do not commit them. The API reads shell environment variables; it does not automatically load an API `.env` file.

A one-time import command remains available for another copy of the old prototype:

```sh
# Stop the old API first. The destination PostgreSQL database must be empty.
npm run db:migrate-sqlite -w @beehave/api -- /absolute/path/to/beehave.sqlite
```

The import is atomic and refuses to overwrite a populated destination. `better-sqlite3` is a development dependency used only by this legacy importer. The optional Raspberry Pi outbox still uses its own local SQLite queue so unsent observations survive an internet outage; it synchronizes into the PostgreSQL API.

## What works

- Account registration, sign-in, persistent sessions, sign-out, password changes, and local operator password reset.
- Dashboard metrics, hourly patterns, historical daily summaries, date ranges, and station selection.
- Date/classification filtering, ordering, pagination, detection details, and CSV export.
- Recording library, authenticated WAV playback/download on web, native playback, pending/missing states, and links to related detections. No recording deletion endpoint or UI.
- Device registration with a one-time credential, reported health/sensor status, heartbeat freshness, and sync status.
- Authenticated edge ingestion, stable IDs, atomic retries, conflict detection, separate audio upload, and a durable Python outbox utility.
- Separate sample farm; real farm accounts never inherit synthetic measurements.

## iOS Simulator on this Mac

Xcode and the iOS 26.0 simulator runtime are installed. From the repository root, keep the backend running in one terminal and launch the native app in another:

```sh
# Terminal 1 (skip if BeeHave is already running)
npm run dev

# Terminal 2
npm run ios
```

This opens the React Native app in Simulator through the SDK-55-compatible Expo Go runtime. Accept Expo CLI’s matching-runtime installation prompt if shown. Simulator supports this version without a physical iPhone/TestFlight build. The shortcut uses a LAN Metro address to avoid the local IPv4/IPv6 mismatch found on this Mac; API requests use `127.0.0.1:3001`. Keep both terminals running. The native recording screen and API-backed sample content were verified on iPhone 17 Pro / iOS 26.0.

## Mobile

The mobile app targets **Expo SDK 55** / React Native 0.83.10. This explicit compatible version supports the installed Node runtime. Use an SDK-55-compatible Expo Go or a development build; a current Expo Go version may support a newer SDK instead.

```sh
# Start the API on your trusted LAN when using a physical phone.
HOST=0.0.0.0 npm run dev -w @beehave/api

# In another terminal; use the computer's actual LAN address.
EXPO_PUBLIC_API_URL=http://192.168.1.10:3001 npm run mobile
```

For an iOS simulator use `http://localhost:3001`; Android emulator uses `http://10.0.2.2:3001`. A physical phone must use the computer's LAN IP and the same network. An HTTPS endpoint is required for deployed builds. Local HTTP may require a development-build transport exception depending on device settings; do not disable transport security in production.

Mobile has platform-native screens, SecureStore sessions, automatic refresh while active, pull-to-refresh, historical summaries, daily record filters, detail navigation, native audio controls, CSV text sharing, device registration, and password changes. Five destinations are visible in a fixed bottom bar; settings opens from the header. Record dates use a calendar sheet, and station selection uses a compact menu. Web supports the fuller custom-range/export UI. Native binary/device testing is still required before distributing the mobile app.

## Verification

```sh
npm run check
npm run bundle -w @beehave/mobile
npm run format
```

Four Python outbox tests also verify durable enqueueing, network failure preservation, partial-upload resumption, and changed-audio rejection.

The API integration test runs against a newly generated `beehave_test_<id>` schema in PostgreSQL and a temporary local port. It removes only that test schema afterward; it does not clear the application tables. PostgreSQL must be running, and the test role must be allowed to create schemas. It checks session cookies, private farm access, concurrent ingestion retries/idempotency/conflicts, transaction rollback, sensor time association, audio upload/range requests, no delete route, CSV export, origin checks, and session revocation. `npm run bundle` produces iOS/Android JavaScript/Hermes bundles, not installable signed binaries.

## Architecture and integration

- [Read the code](docs/READ_THE_CODE.md): a beginner-friendly reading order, file map, and explanation of the detection flow.
- [Blueprint and review](docs/BLUEPRINT.md): product decisions, contradictions, data model, and roadmap.
- [Edge integration](docs/EDGE_INTEGRATION.md): event contract, audio uploads, and offline queue.
- `packages/shared`: types, Zod input schemas, API client, design tokens, timezone utilities.
- `apps/api`: Express API, PostgreSQL schema, sessions, sample generation, integration tests.
- `apps/web`: browser routes, query cache, responsive data views, HTML audio.
- `apps/mobile`: React Native views, native audio, secure session storage.

React state owns forms and UI choices; TanStack Query owns web server data. No Redux and no duplicated dashboard database. Report dates are Asia/Manila; exact event timestamps are stored as UTC. Environmental context uses its own timestamp and never changes model confidence. Detections are acoustic events, not validated unique visitor counts or evidence of increased coconut yield.

## Local account recovery

The sign-in screen can email a single-use password reset link to the account email address. Configure Resend in the API environment before starting the server:

```sh
export RESEND_API_KEY=your-resend-api-key
export PASSWORD_RESET_EMAIL_FROM='BeeHave <accounts@example.com>'
export APP_PUBLIC_URL=http://localhost:5173
```

Use a sender address verified in Resend. Set `APP_PUBLIC_URL` to the public web app URL (use HTTPS in production). Recovery links expire after 30 minutes, and requesting a new link invalidates the previous one. The endpoint uses the same response whether the email belongs to an account, to avoid exposing registered addresses.

If email delivery is not configured, an operator with access to this computer can still reset a local account. Set `BEEHAVE_NEW_PASSWORD` securely in the terminal, then run:

```sh
npm run reset-password -w @beehave/api -- your-email@example.com
```

The password must be at least 12 characters. All sessions for that account are revoked. Remove the environment variable afterward. The app also provides an authenticated password-change form.

## Push notifications

The API notifies a farm's members when one of its Edge Devices comes online (a heartbeat after more than three minutes without one, BeeHave's Online rule), and a farm's administrators when someone asks for access with the pairing code on a claimed device's label. Events are written in the same database transaction as the change, then delivered to every browser and phone each recipient has signed in and turned notifications on.

Web Push needs VAPID keys in the API environment. Generate them once and keep the private key secret:

```sh
npx -w @beehave/api web-push generate-vapid-keys
export VAPID_PUBLIC_KEY=...
export VAPID_PRIVATE_KEY=...
export VAPID_SUBJECT=mailto:you@example.com
```

Browsers allow Web Push only on HTTPS or `localhost`; the plain-HTTP LAN address cannot use it. On iPhone, Safari allows it only after BeeHave is added to the Home Screen. Turn it on in Settings → Preferences → Notifications.

The mobile app uses Expo's push service. It needs an EAS project ID (`npx eas init`, or `EXPO_PUBLIC_EAS_PROJECT_ID`), APNs credentials for iOS and FCM credentials for Android in that EAS project, and a native rebuild after installing `expo-notifications`. Simulators cannot receive remote pushes. Set `EXPO_ACCESS_TOKEN` only if the EAS project requires push security.

## Configuration

| Variable                           | Default                              | Purpose                                                                          |
| ---------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `PORT`                             | `3001`                               | API port                                                                         |
| `HOST`                             | `127.0.0.1`                          | Bind address; explicitly use LAN binding for hardware/phone testing              |
| `DATABASE_URL`                     | unset                                | Optional PostgreSQL connection URL; set it in your shell before starting the API |
| `PGHOST` / `PGDATABASE`            | `localhost` / `beehave`              | Connection defaults when no URL is supplied                                      |
| `PGUSER` / `PGPASSWORD` / `PGPORT` | local OS username / unset / `5432`   | Standard PostgreSQL connection settings                                          |
| `WEB_ORIGIN`                       | localhost and 127.0.0.1 on port 5173 | Comma-separated permitted browser origins                                        |
| `APP_PUBLIC_URL`                   | `http://localhost:5173`              | Public web app URL used in password recovery links                               |
| `RESEND_API_KEY`                   | unset                                | Resend API key used to deliver password recovery email                           |
| `PASSWORD_RESET_EMAIL_FROM`        | unset                                | Verified sender address for password recovery email                             |
| `DISABLE_DEMO`                     | unset                                | Set `true` to disable new sample sessions                                        |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | unset                          | Web Push keys; Web Push is offered only when both are set                        |
| `VAPID_SUBJECT`                    | `mailto:support@beehave.local`       | Contact sent to browser push services with each Web Push message                 |
| `EXPO_ACCESS_TOKEN`                | unset                                | Expo push access token, needed only when the EAS project enforces push security  |
| `EXPO_PUBLIC_EAS_PROJECT_ID`       | unset                                | Mobile EAS project ID when it is not in `app.json` (`extra.eas.projectId`)       |
| `EXPO_PUBLIC_API_URL`              | `http://localhost:3001`              | Non-secret mobile API address                                                    |
| `NODE_ENV`                         | unset                                | `production` enables secure-only session cookies                                 |

## Prototype boundaries

This is a working local prototype, not a production deployment or a trained AI classifier. Actual Pi microphone/sensor drivers and inference must feed the documented ingestion contract. The queue utility preserves metadata/audio references offline; field testing, storage alarms, scheduling with backoff, and hardware clock calibration remain integration work.

Email verification, invitations, account administration, cloud storage, and remote reboot/shutdown are not implemented. API data is farm-scoped, passwords use salted scrypt, and sessions/device keys are hashed at rest. Production work includes TLS, account enrollment policy, rate limits for device ingestion, session/device-key lifecycle tooling, backups, observability, a migration strategy, streaming/object audio storage, and efficient SQL aggregation for large deployments. The local prototype stores WAV bytes in PostgreSQL with a 20 MB upload limit and supports metadata-before-audio synchronization. CSV exports are capped at 50,000 rows.

Development dependencies use a narrow `xcode → uuid` override because the upstream xcode package uses the compatible `uuid.v4()` API but pins an old UUID release with an advisory. Keep the override under review when upgrading Expo.

Compatibility references: [Vite prerequisites](https://vite.dev/guide/), [Expo SDK 55 reference](https://docs.expo.dev/versions/v55.0.0/), [Expo SDK 55 release notes](https://expo.dev/changelog/sdk-55).
