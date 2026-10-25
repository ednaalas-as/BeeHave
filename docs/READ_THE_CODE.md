# Reading the BeeHave code

Start with one screen. You do not need to understand every file before making a small change.

## The three running parts

The **web app** runs in a browser. The **mobile app** runs in Expo/React Native. Both ask the same **API server** for data. Only the API connects to **PostgreSQL**. Database credentials never belong in the web or mobile app.

```text
Browser screen ─┐
                ├── HTTP request ── Express API ── SQL query ── PostgreSQL
Mobile screen ──┘                      ↑
                                  Raspberry Pi upload
```

The optional Python utility keeps an offline queue on the Pi. Its small SQLite file is only an outbox for unsent uploads. The central accounts, devices, detections, sensor readings, and recordings are in PostgreSQL.

## Start with the dashboard

Open these files in this order:

1. `apps/web/src/pages/DashboardPage.tsx` — what appears on the web dashboard.
2. `apps/api/src/routes/summary.ts` — how its totals and charts are calculated.
3. `apps/api/src/database/schema.sql` — where the underlying records are stored.

In `DashboardPage.tsx`, `useState` remembers the selected period. `useQuery` calls the API and remembers the response. `query.isPending` displays loading, `query.isError` displays a retry message, and `query.data` contains the result.

The request is `/api/summary?from=...&to=...&device=...`. The server checks the signed-in account, finds records belonging to that farm, and returns a `Summary`. The dashboard reads `summary.total`, `summary.hourly`, and the other fields to draw the screen.

To change the dashboard heading, edit the `title` on `PageHeading`. To change how a total is calculated, read the summary route. Changing the heading does not require changing the database.

## Where each feature lives

| Feature             | Web                                                                | React Native                      | API                 |
| ------------------- | ------------------------------------------------------------------ | --------------------------------- | ------------------- |
| Sign in / register  | `pages/SignInPage.tsx`                                             | `screens/SignInScreen.tsx`        | `routes/auth.ts`    |
| Dashboard           | `pages/DashboardPage.tsx`                                          | `screens/OverviewScreen.tsx`      | `routes/summary.ts` |
| Historical activity | `pages/ActivityPage.tsx`                                           | `screens/OverviewScreen.tsx`      | `routes/summary.ts` |
| Detection list      | `pages/DetectionsPage.tsx`                                         | `screens/RecordsScreen.tsx`       | `routes/records.ts` |
| Recording list      | `pages/RecordingsPage.tsx`                                         | `screens/RecordsScreen.tsx`       | `routes/records.ts` |
| Record details      | `pages/DetectionDetailsPage.tsx`, `pages/RecordingDetailsPage.tsx` | `screens/RecordDetailsScreen.tsx` | `routes/records.ts` |
| Device registration | `pages/DevicesPage.tsx`                                            | `screens/DevicesScreen.tsx`       | `routes/devices.ts` |
| Device uploads      | —                                                                  | —                                 | `routes/edge.ts`    |

Web paths begin with `apps/web/src/`. Native paths begin with `apps/mobile/src/`. API paths begin with `apps/api/src/`.

`main.tsx` starts React in the browser. Web `App.tsx` decides whether to show sign-in or the signed-in layout. `layout/AppLayout.tsx` contains navigation and route selection. Native `apps/mobile/App.tsx` restores the session and chooses a screen.

Reusable buttons, fields, and cards are in `components/`. The native `hooks/useRemote.ts` fetches data and refreshes it while the app is active. Native `api.ts` handles the server address and securely stored session token. Web `api.tsx` holds the API client and shared workspace preferences.

## Follow one detection

1. A Pi sends JSON to `POST /api/edge/batch`, with its device key in `X-Device-Key`.
2. `services/devices.ts` checks the key and identifies the device. It stores a hash of the key rather than the original key.
3. `routes/edge.ts` checks the JSON against `batchSchema` from `packages/shared/src/index.ts`.
4. The route starts a database transaction. Readings, recording metadata, and detections are saved together; an invalid linked timestamp rolls back the whole batch.
5. Each record uses the pair `(device_id, id)` as its unique identity. Retrying the same payload is safe; changing an existing observation is rejected.
6. A web or mobile screen asks `GET /api/detections` for saved observations. The server checks farm ownership before returning them.
7. `services/records.ts` attaches any linked reading and recording metadata to each detection.
8. Audio is uploaded separately. A detection remains visible while its audio is pending.

A PostgreSQL row lock makes two simultaneous uploads for the same device wait their turn. This prevents conflicting requests from overwriting the same recording. `isDeepStrictEqual` compares the meaning of the JSON fields, because PostgreSQL JSONB may return the keys in a different order.

## Understand the database

| Table        | One row represents                             |
| ------------ | ---------------------------------------------- |
| `farms`      | A workspace that owns devices                  |
| `accounts`   | A person who belongs to a farm                 |
| `sessions`   | A hashed sign-in token and its expiry          |
| `devices`    | A registered Pi and its latest reported health |
| `readings`   | A temperature/humidity observation             |
| `detections` | An acoustic event and its classification       |
| `recordings` | Recording metadata and optional WAV bytes      |

`farm_id` and `device_id` connect related tables. A **primary key** prevents duplicate identities. A **foreign key** prevents references to a nonexistent owner. An **index** speeds up a lookup, such as finding one device's detections by observation time.

Events have indexed ownership and timestamp columns, plus a `data` JSONB column for their payload. JSONB means PostgreSQL validates and stores structured JSON. `audio` is BYTEA, which stores binary bytes. A future larger deployment could keep audio in object storage instead.

`database.ts` is a small wrapper around the `pg` driver:

- `one(sql, values)` returns the first row, or `undefined`.
- `many(sql, values)` returns a list of rows.
- `execute(sql, values)` runs a statement without using its returned rows.
- `transaction(async transaction => ...)` commits the whole operation or rolls it back on failure.

In SQL, `$1`, `$2`, and so on refer to the values supplied separately. Do not concatenate a user's input into SQL.

## Common syntax

| Syntax                    | Meaning here                                                               |
| ------------------------- | -------------------------------------------------------------------------- |
| `type Detection`          | The fields a detection is expected to have                                 |
| `async` / `await`         | Wait for a request or database operation without blocking the whole server |
| `useState(...)`           | Remember a UI choice, form value, or selected tab                          |
| `useEffect(...)`          | Start and clean up work such as refreshing data                            |
| `items.map(...)`          | Render or convert each item in a list                                      |
| `value?.field`            | Read a field only when the value exists                                    |
| `value ?? fallback`       | Use a fallback if the value is null or undefined                           |
| `{condition && <Card />}` | Display the card when the condition is true                                |
| `props`                   | Values a parent component passes to a child component                      |

## Logo and appearance

The original logo is in `packages/shared/assets/beehave-logo.png`. Both apps use this one file. Web placement is in `components/Logo.tsx` and `pages/SignInPage.tsx`; native placement is in `components/BrandLogo.tsx`.

Web styling is in `apps/web/src/styles.css`. Native styling is in `apps/mobile/src/styles.ts`. Shared colors and spacing are in `packages/shared/src/index.ts`. Keeping the logo colorful and the surrounding panels neutral makes it easier to read the measurements.

## Practice explaining the app

Try tracing these questions through the files above:

- What happens between pressing “Week” and seeing a new chart?
- How does the server stop one farm from reading another farm's recordings?
- Why can a detection exist without playable audio?
- What happens if a Pi retries an upload after losing its connection?
- Why is a detection count different from a count of unique bees?

The sample farm contains synthetic observations and generated tones. The app displays model outputs supplied by a device; it does not include a trained bee classifier or establish a relationship with coconut yield.

Run `npm run check` after a change. This checks TypeScript, lint rules, PostgreSQL API behavior, the offline queue, and the web production build. Run `npm run ios` with the API running to inspect the native screen.

## Mobile layout and lettering

The mobile app now has a fixed five-tab bar; settings opens from the header. The dashboard uses `PeriodControl`, `SelectionSheet`, and `ActivityChart` components. `CalendarSheet` selects dates in the records screens. The heading font is Space Grotesk, bundled locally by Expo. Body text uses the platform font.

`packages/shared/src/branding.ts` contains simple geometric letter paths inspired by the supplied BEEHAVE reference. Native `components/Wordmark.tsx` and web `components/Wordmark.tsx` render those paths. The original reference is preserved in `packages/shared/assets/beehave-wordmark-original.svg`.
