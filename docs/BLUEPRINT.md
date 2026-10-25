# BeeHave project blueprint and brief review

## Product understanding

BeeHave is a read-only monitoring and research interface for Raspberry Pi bee bioacoustic detections around coconut flowers in Quezon. Web and mobile show different views of the same detection, recording, environmental, and device data. It is not a social application or a manual monitoring-record editor.

## Review findings and decisions

- A detection is a model event, not necessarily a unique bee or a flower visit. Use “detections” and “detections/hour”; do not claim visitor counts without a validated event-merging protocol.
- A 50–80% coconut production increase is an unverified motivation, not an app result. A yield study needs harvest measurements, controls, and a study protocol outside this prototype.
- Environmental context does not contribute to model confidence. Preserve its own measurement time; accept an explicit reading reference only if from the same device and within 60 seconds. Otherwise expose missing context.
- The document requests a database-connected prototype while also postponing backend work. The user explicitly selected a local database prototype, resolving that conflict.
- The document asks to stop at a blueprint, but the current user explicitly asks to review and create the application. Record this blueprint first and implement the authorized prototype.
- The six-item bottom navigation guidance conflicts with evaluating crowded mobile tabs. Web uses a sidebar; mobile uses a horizontally scrollable destination strip so labels remain readable.
- Internet disconnection does not establish whether local collection stopped. Display last reported state and last sync separately, and mark old health reports stale.

## Smallest architecture

Use npm workspaces, React/Vite/TypeScript, Expo/React Native/TypeScript, and a TypeScript Express API with PostgreSQL. Both clients share this database through the API. PostgreSQL stores the observations and WAV bytes; object storage remains a possible future option for larger audio collections. No microservices, Redux, or realtime infrastructure. Use polling and explicit last-refresh/last-sync labels.

```text
apps/
  web/       # browser routes, charts, accessible tables, HTML audio
  mobile/    # native screens, navigation, secure credentials, native audio
  api/       # authentication, PostgreSQL, ingestion, aggregation, audio access
packages/
  shared/    # domain contracts, validation, API client, design tokens
docs/        # blueprint and integration guidance
```

## Assumptions and open integration details

- One farm per account in the prototype, with administrator/viewer roles. Creating an account creates a private farm. Researchers can use a viewer account once an invitation system is added.
- Local development on a trusted computer; public deployment requires TLS, verified-email delivery/recovery, operational backups, and managed secrets.
- The edge classifier already exists outside this app. Its exact labels, calibration, microphone configuration, and event protocol must be confirmed against actual hardware.
- Timestamps use ISO UTC in storage and Asia/Manila for reports.
- Synthetic sample data is isolated from real farms and explicitly marked. Real farms start empty.
- Reboot/shutdown are deferred until an authenticated device command/acknowledgment transport exists. No pretend remote commands.

## Feature map, screens, and user flow

Both clients: sign in/create account → dashboard → detection detail → associated recording. Activity → daily summary → date-filtered detections. Recordings → player/metadata → detection. Device → health/sensors/sync. Settings → account/session/preferences.

| Domain      | Screen purpose                                              | Backend responsibility                         |
| ----------- | ----------------------------------------------------------- | ---------------------------------------------- |
| Dashboard   | Current metrics, hourly pattern, recent detections          | Period aggregations from detections            |
| Activity    | Historical range, daily summaries, trend comparison         | Aggregation using the same event records       |
| Detection   | Date/classification filters, sorting, pagination, detail    | Farm-scoped queries and sensor/recording joins |
| Recordings  | Evidence library, playback, download, related events        | Authenticated range-capable audio delivery     |
| Edge Device | Last heartbeat, health, sensor and synchronization state    | Device registration, authenticated ingestion   |
| Settings    | Account, refresh preference, integration guidance, sign out | Session/account information                    |

Empty datasets, unavailable API, loading, expired session, stale edge state, absent sensor values, queued/missing audio, and playback failures must be explicit. A missing recording never deletes a detection. There is no recording deletion API or UI.

## Data model

- Account: id, name, email, password hash, farm id, role; private administrative identity.
- Farm: account-access boundary and human-readable installation label.
- Edge device: stable id, farm id, name, model, last heartbeat/sync, reported collection/sync state, health and sensor status.
- Environmental reading: stable id, device id, original observed time, nullable temperature/humidity.
- Recording: stable id, device id, observed time, duration, format, storage state, private file reference; supports multiple associated detections.
- Detection: stable id, device id, observed time, classification, frequency, confidence, optional reading and recording references, model version.
- Sessions: hashed opaque credentials, account id, expiry. Browser credentials in HttpOnly cookies; native credentials in SecureStore.
- Dashboard/activity: derived queries, never independently edited datasets.

## Shared versus platform-specific

Share strict types, input schemas, network client, design values, and date formatting. Keep DOM/native components, navigation, charts, audio, and credential storage platform-specific. Local state owns filters/dialogs/forms. A context owns session and selected device. Query state owns fetched data; preferences alone belong in ordinary local storage. Never store passwords or monitoring datasets there.

## Ingestion and synchronization

Device credentials are separate from user sessions and scoped to one device/farm. Atomic batches carry stable IDs. Replaying an identical event is safe; conflicting content is rejected. Metadata and audio can arrive separately. The edge retains a durable local queue until the API acknowledges success and retries with backoff. This repository supplies the server protocol and a small edge queue client, not microphone drivers or the AI classifier. Offline storage capacity and hardware behavior require field validation.

## Roadmap and prototype boundary

1. Monorepo foundation and shared contracts.
2. PostgreSQL/API, secure local sessions, and one real detection ingestion/read slice.
3. Dashboard/history derived from those records; recordings and device state.
4. Platform-appropriate web/mobile clients and persistent preferences.
5. Integration tests, web production build, native bundle verification, and setup documentation.
6. Hardware validation, email verification/recovery, deployment hardening, and optional alerts. Native simulator/device runtime testing remains a separate verification if no simulator is available.

All files are CREATE in this empty repository. There are no generated starter screens to KEEP/MODIFY/REMOVE. Configuration is introduced only to run/build/typecheck the workspaces.
