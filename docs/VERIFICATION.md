# Verification record

Verified locally on September 22–23, 2026 with Node 20.20.2.

- All four TypeScript workspaces typecheck.
- ESLint passes.
- Web production build passes.
- PostgreSQL API integration scenario passes in an isolated temporary schema (including three simultaneous retries of a new event): private accounts/farms, cookie and bearer sessions, idempotent ingestion, conflicting event rejection, invalid sensor-link rollback, linked record retrieval, summary consistency, WAV uploads and byte ranges, no deletion endpoint, CSV export, origin protection, password changes, and session revocation.
- Four Python outbox tests pass: durable duplicate-safe enqueue, network outage preservation, resumable partial uploads, and rejection of changed audio.
- Expo exports both iOS and Android Hermes bundles successfully.
- Browser verified: sample sign-in and restored session, dashboard, historical daily summaries, classification filter, oldest-first sort, detection details, separate original sensor timestamp, linked recording, and audio decoding (5-second duration, ready state 4, no media error).
- Responsive dashboard inspected at phone width. Wide tables remain inside their own horizontal scroll containers.
- npm audit reports zero known vulnerabilities after the narrow xcode/uuid override. xcode UUID generation was checked against the patched dependency.

Additional simulator verification: BeeHave launched in the iPhone 17 Pro simulator (iOS 26.0) using Expo Go 55.0.34. The native recording-detail screen displayed API-backed sample metadata and loaded playback controls. Metro uses LAN addressing because `--localhost` bound IPv6 while its generated URL used IPv4 on this Mac.

Not verified: physical iOS/Android runtime, installed native binaries, actual Raspberry Pi microphone/sensor/inference pipeline, field connectivity/storage conditions, or public deployment. No claim of model accuracy, unique bee visitation counts, or coconut-yield improvement is made.

## PostgreSQL and readability update — September 23

The central database is now PostgreSQL 16.12. Migration preserved 1 farm, 1 account, 1 device, 4,980 readings, 4,980 detections, and 4,597 recording metadata rows. The 4,327 available WAVs contain 346,350,388 bytes. An aggregate of the per-recording audio checksums matched the read-only SQLite backup. The old database was retained.

The web entry point is now 28 lines, the API assembly file is 65 lines, and native app navigation is about 200 lines. Feature implementations live in separate pages/screens and route modules. `READ_THE_CODE.md` explains their reading order and the database/request flow.

The original logo is shared from `packages/shared/assets/beehave-logo.png`. The web sign-in page and dashboard were visually checked; the requested promotional wording is removed. A migrated recording decoded with a 5-second duration, ready state 4, and no media error. Both Expo bundles include the logo, and the native dashboard loaded from PostgreSQL in the iPhone 17 Pro simulator.

## Mobile presentation update — September 23

Verified the new geometric wordmark, bundled Space Grotesk headings, fixed five-tab navigation, weekly summary card, and compact environment readings on iPhone 17 Pro. Opening Events, choosing September 22 in the calendar, and displaying that day’s detections succeeded. The app was launched with `npm run ios -- --clear` from its new location, `/path/to/BeeHave`.
