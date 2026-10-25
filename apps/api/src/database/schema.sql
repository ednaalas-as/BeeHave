-- Central BeeHave storage. Event payloads use JSONB because devices send
-- versioned measurements; ownership and observation time remain indexed columns.
CREATE TABLE IF NOT EXISTS farms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  demo BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  farm_id TEXT NOT NULL REFERENCES farms(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'administrator'
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS password_reset_account ON password_reset_tokens(account_id);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  farm_id TEXT NOT NULL REFERENCES farms(id),
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  model TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  last_seen TIMESTAMPTZ,
  last_sync TIMESTAMPTZ,
  health JSONB
);
CREATE TABLE IF NOT EXISTS readings (
  id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id),
  observed_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (device_id, id)
);
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id),
  observed_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  audio BYTEA,
  PRIMARY KEY (device_id, id)
);
CREATE TABLE IF NOT EXISTS detections (
  id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id),
  observed_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (device_id, id)
);
CREATE INDEX IF NOT EXISTS detection_time ON detections(device_id, observed_at);
CREATE INDEX IF NOT EXISTS detection_recording ON detections(device_id, (data->>'recordingId'));
CREATE INDEX IF NOT EXISTS detection_reading ON detections(device_id, (data->>'readingId'));
CREATE INDEX IF NOT EXISTS recording_time ON recordings(device_id, observed_at);
CREATE INDEX IF NOT EXISTS reading_time ON readings(device_id, observed_at);
CREATE INDEX IF NOT EXISTS device_farm ON devices(farm_id);
CREATE INDEX IF NOT EXISTS device_key ON devices(key_hash);

-- Nearby onboarding only: no monitoring payloads or raw device credentials.
CREATE TABLE IF NOT EXISTS device_pairings (
  id TEXT PRIMARY KEY,
  setup_id TEXT NOT NULL UNIQUE,
  farm_id TEXT NOT NULL REFERENCES farms(id),
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  nonce TEXT,
  challenge TEXT,
  expires BIGINT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT NOT NULL,
  location TEXT NOT NULL
);

-- Preserve historical ownership while revoking active device access.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;
ALTER TABLE device_pairings ADD COLUMN IF NOT EXISTS released BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE device_pairings ADD COLUMN IF NOT EXISTS revoked_keys TEXT[] NOT NULL DEFAULT '{}';

-- Remote commands wait here until the device collects them with its key.
-- They hold no monitoring history, so an empty registration may still be deleted.
CREATE TABLE IF NOT EXISTS device_commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS device_commands_device ON device_commands(device_id, created_at DESC);
-- Verified lifecycle (additive): when the device collected and claimed a request, when it
-- finished, and the deadline for its verified result after collection.
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS verify_until TIMESTAMPTZ;
-- When the stored health was reported (additive). Data uploads move last_seen without health,
-- so the health's own age decides whether Pi-dependent state is current.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS health_at TIMESTAMPTZ;
-- Data a verified command result carries (e.g. Wi-Fi scan results; never credentials).
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS result JSONB;
-- Wi-Fi requests (additive): non-secret options, and the password sealed to the device's key.
-- The sealed password is wiped as soon as the device claims the request or it ends.
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS params JSONB;
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS credential JSONB;

-- Farm access (additive): an account reaches a farm only through a membership, and the
-- role belongs to the membership. accounts.farm_id stays as the account's default farm
-- and accounts.role is kept for older clients; neither grants access any more.
CREATE TABLE IF NOT EXISTS farm_members (
  farm_id TEXT NOT NULL REFERENCES farms(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('owner','viewer')),
  granted_by TEXT REFERENCES accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (farm_id, account_id)
);
CREATE INDEX IF NOT EXISTS farm_members_account ON farm_members(account_id);
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Runs once, so a member an owner later removes is never re-added on restart.
-- Each account keeps its own farm with its existing role; sample farms only ever get viewers.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id='002-farm-members') THEN
    INSERT INTO farm_members (farm_id, account_id, role)
    SELECT a.farm_id, a.id, CASE WHEN a.role='administrator' AND NOT f.demo THEN 'owner' ELSE 'viewer' END
    FROM accounts a JOIN farms f ON f.id=a.farm_id
    ON CONFLICT DO NOTHING;
    INSERT INTO schema_migrations (id) VALUES ('002-farm-members');
  END IF;
END $$;

-- A viewer asks to connect to a whole farm; an owner approves (a viewer membership) or declines.
-- Additive: nothing here grants access until an owner approves.
CREATE TABLE IF NOT EXISTS farm_access_requests (
  farm_id TEXT NOT NULL REFERENCES farms(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by TEXT REFERENCES accounts(id),
  decided_at TIMESTAMPTZ,
  PRIMARY KEY (farm_id, account_id)
);

-- A human-readable farm location (e.g. "Sariaya, Quezon"); optional, no coordinates.
ALTER TABLE farms ADD COLUMN IF NOT EXISTS location TEXT;

-- An account may exist before it creates or joins any farm. accounts.farm_id only picks which
-- farm opens first and never grants access.
ALTER TABLE accounts ALTER COLUMN farm_id DROP NOT NULL;

-- Joining someone else's farm needs an invite code from one of its owners. Only a hash of the
-- code is kept; a code works once, expires, and an owner can revoke it before it is used.
CREATE TABLE IF NOT EXISTS farm_invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  farm_id TEXT NOT NULL REFERENCES farms(id),
  role TEXT NOT NULL CHECK (role IN ('owner','viewer')),
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  used_by TEXT REFERENCES accounts(id),
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS farm_invites_farm ON farm_invites(farm_id);

-- Edge devices provisioned before any farm claims them: no farm, no monitoring access. The key
-- only starts working once a farm owner claims the device with its pairing code, which creates
-- the devices row (and so the farm link). Codes are stored hashed.
CREATE TABLE IF NOT EXISTS device_registry (
  device_uid TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  claim_code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unclaimed' CHECK (status IN ('unclaimed','claimed')),
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_by TEXT REFERENCES accounts(id),
  claimed_at TIMESTAMPTZ
);

-- The Pi's setup label (setup hotspot name and password, setup code), reported by its agent so
-- the farm's owners can read it in the app instead of on the Pi. Sealed with the API's
-- setup-label key and bound to the device, so a database copy alone does not reveal it.
CREATE TABLE IF NOT EXISTS device_setup_labels (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  sealed TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Which farm a device belonged to and when. devices.farm_id is the one current farm; records
-- carry no farm of their own and belong to the farm that held their device when they were
-- observed, so a transfer never moves history. The first period starts at -infinity so data a
-- device recorded before it was registered stays with its first farm.
CREATE TABLE IF NOT EXISTS device_farm_assignments (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  farm_id TEXT NOT NULL REFERENCES farms(id),
  assigned_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  assigned_by TEXT REFERENCES accounts(id),
  PRIMARY KEY (device_id, assigned_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS device_farm_current ON device_farm_assignments(device_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS device_farm_assignments_farm ON device_farm_assignments(farm_id, device_id);
-- Every way a device is created or moved keeps the periods in step with devices.farm_id.
CREATE OR REPLACE FUNCTION device_farm_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO device_farm_assignments (device_id, farm_id, assigned_at) VALUES (NEW.id, NEW.farm_id, '-infinity');
  ELSIF NEW.farm_id IS DISTINCT FROM OLD.farm_id THEN
    UPDATE device_farm_assignments SET ended_at=clock_timestamp() WHERE device_id=NEW.id AND ended_at IS NULL;
    INSERT INTO device_farm_assignments (device_id, farm_id, assigned_at) VALUES (NEW.id, NEW.farm_id, clock_timestamp());
  END IF;
  RETURN NEW;
END$$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='device_farm_assignment' AND tgrelid='devices'::regclass) THEN
    CREATE TRIGGER device_farm_assignment AFTER INSERT OR UPDATE OF farm_id ON devices
      FOR EACH ROW EXECUTE FUNCTION device_farm_assignment();
  END IF;
END $$;
-- Devices registered before this table existed have always been in their current farm.
INSERT INTO device_farm_assignments (device_id, farm_id, assigned_at)
SELECT d.id, d.farm_id, '-infinity' FROM devices d
WHERE NOT EXISTS (SELECT 1 FROM device_farm_assignments a WHERE a.device_id=d.id);

-- A detection's exact classifier window inside its original recording.
-- Frames use the recording's own sample rate; the original audio is never copied.
-- Rows are immutable and keep the detection and recording they reference.
CREATE TABLE IF NOT EXISTS detection_audio_windows (
  device_id TEXT NOT NULL,
  detection_id TEXT NOT NULL,
  recording_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  window_index BIGINT NOT NULL CHECK (window_index >= 0),
  start_frame BIGINT NOT NULL CHECK (start_frame >= 0),
  frame_count BIGINT NOT NULL CHECK (frame_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, detection_id),
  FOREIGN KEY (device_id, detection_id) REFERENCES detections(device_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (device_id, recording_id) REFERENCES recordings(device_id, id) ON DELETE RESTRICT
);

-- Push notifications (additive). Nothing here grants access: who receives an event is decided
-- from farm_members when it is delivered.
-- The device whose pairing code a request was made with, so its owners know which one it was.
ALTER TABLE farm_access_requests ADD COLUMN IF NOT EXISTS device_id TEXT REFERENCES devices(id) ON DELETE SET NULL;
-- Where an account receives push notifications: one row per browser subscription or Expo push
-- token, so one account may have many. Each is tied to the session that registered it and stops
-- receiving once that session ends (sign-out, password change, expiry).
CREATE TABLE IF NOT EXISTS push_destinations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('web','expo')),
  -- The Web Push endpoint URL or the Expo push token.
  endpoint TEXT NOT NULL UNIQUE,
  -- Web Push encryption keys (p256dh, auth); none for Expo.
  keys JSONB,
  -- A stable ID the app keeps per installation, so a rotated token replaces the old one.
  installation_id TEXT,
  platform TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,
  -- Set when the push service reports the subscription or token as expired or invalid.
  disabled_at TIMESTAMPTZ,
  disabled_reason TEXT
);
CREATE INDEX IF NOT EXISTS push_destinations_account ON push_destinations(account_id);
-- One row per notifiable event. dedupe_key is unique, so a retried request or a repeated report
-- of the same event can never create a second one. Kept for auditing.
CREATE TABLE IF NOT EXISTS notification_events (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('device_online','access_request')),
  farm_id TEXT NOT NULL REFERENCES farms(id),
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Where tapping the notification leads (screen, farm, device).
  target JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When recipients were resolved; deliveries are created once, at that moment.
  fanned_out_at TIMESTAMPTZ,
  recipients INTEGER
);
CREATE INDEX IF NOT EXISTS notification_events_pending ON notification_events(created_at) WHERE fanned_out_at IS NULL;
-- One delivery per event and destination (the primary key prevents a second send).
CREATE TABLE IF NOT EXISTS notification_deliveries (
  event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL REFERENCES push_destinations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  -- Expo's ticket, checked later for a delivery receipt.
  ticket_id TEXT,
  receipt_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  PRIMARY KEY (event_id, destination_id)
);
CREATE INDEX IF NOT EXISTS notification_deliveries_due ON notification_deliveries(next_attempt_at) WHERE status='pending';
-- When the API last started and was last known running, so devices that only looked offline
-- because the API itself was down are not announced as coming online after a restart.
CREATE TABLE IF NOT EXISTS api_heartbeats (
  name TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  alive_at TIMESTAMPTZ NOT NULL
);

-- BRTC storage is isolated in its own PostgreSQL schema. The device row is a
-- minimal ownership cross-reference; credentials remain exclusively in BeeHave.
CREATE SCHEMA IF NOT EXISTS brtc;
CREATE TABLE IF NOT EXISTS brtc.devices (
  id TEXT PRIMARY KEY REFERENCES public.devices(id) ON DELETE RESTRICT,
  farm_id TEXT NOT NULL REFERENCES public.farms(id) ON DELETE RESTRICT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS brtc.sessions (
  id UUID PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES brtc.devices(id) ON DELETE RESTRICT,
  source_key UUID NOT NULL,
  body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(device_id, source_key)
);
CREATE TABLE IF NOT EXISTS brtc.recordings (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES brtc.sessions(id) ON DELETE RESTRICT,
  part BIGINT NOT NULL,
  source_key TEXT NOT NULL,
  asset_id UUID NOT NULL UNIQUE,
  body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(session_id, part),
  UNIQUE(session_id, source_key)
);
CREATE TABLE IF NOT EXISTS brtc.assets (
  id UUID PRIMARY KEY,
  recording_id UUID NOT NULL UNIQUE REFERENCES brtc.recordings(id) ON DELETE RESTRICT,
  expected JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS brtc.uploads (
  id UUID PRIMARY KEY,
  asset_id UUID NOT NULL REFERENCES brtc.assets(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('CREATED','UPLOADING','INTERRUPTED','UPLOADED','EXPIRED','VERIFYING','AVAILABLE','FAILED','INVALID')),
  revision BIGINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  frozen BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS brtc_one_active_upload_per_asset ON brtc.uploads(asset_id) WHERE active;
CREATE TABLE IF NOT EXISTS brtc.commitments (
  asset_id UUID NOT NULL REFERENCES brtc.assets(id) ON DELETE RESTRICT,
  idx INTEGER NOT NULL,
  byte_offset BIGINT NOT NULL,
  byte_length BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  first_ack TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(asset_id, idx)
);
CREATE TABLE IF NOT EXISTS brtc.presence (
  upload_id UUID NOT NULL REFERENCES brtc.uploads(id) ON DELETE RESTRICT,
  idx INTEGER NOT NULL,
  generation UUID NOT NULL UNIQUE,
  byte_length BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  ack TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(upload_id, idx)
);
CREATE TABLE IF NOT EXISTS brtc.capacity_reservations (
  upload_id UUID PRIMARY KEY REFERENCES brtc.uploads(id) ON DELETE RESTRICT,
  remaining_bytes BIGINT NOT NULL CHECK(remaining_bytes >= 0)
);
CREATE TABLE IF NOT EXISTS brtc.incoming_reservations (
  id UUID PRIMARY KEY,
  device_id TEXT REFERENCES brtc.devices(id) ON DELETE RESTRICT,
  byte_length BIGINT NOT NULL CHECK(byte_length >= 0)
);
CREATE TABLE IF NOT EXISTS brtc.idempotency (
  device_id TEXT NOT NULL REFERENCES brtc.devices(id) ON DELETE RESTRICT,
  route TEXT NOT NULL,
  key UUID NOT NULL,
  body_hash TEXT NOT NULL,
  resource_id UUID NOT NULL,
  PRIMARY KEY(device_id, route, key)
);
CREATE TABLE IF NOT EXISTS brtc.frozen_manifests (
  upload_id UUID PRIMARY KEY REFERENCES brtc.uploads(id) ON DELETE RESTRICT,
  id UUID NOT NULL UNIQUE,
  expected JSONB NOT NULL,
  entries JSONB NOT NULL,
  frozen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS brtc.verification_jobs (
  id UUID PRIMARY KEY,
  upload_id UUID NOT NULL UNIQUE REFERENCES brtc.uploads(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','SUCCEEDED','INVALID','FAILED')),
  generation BIGINT NOT NULL DEFAULT 0,
  owner UUID,
  lease_until TIMESTAMPTZ,
  attempt_number INTEGER NOT NULL DEFAULT 0,
  cycle_attempts INTEGER NOT NULL DEFAULT 0,
  not_before TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error JSONB,
  retryable BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS brtc.canonical_assets (
  asset_id UUID PRIMARY KEY REFERENCES brtc.assets(id) ON DELETE RESTRICT,
  verified JSONB NOT NULL,
  discrepancies JSONB NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  verified_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ NOT NULL,
  actual_byte_length BIGINT GENERATED ALWAYS AS ((verified->>'byte_length')::BIGINT) STORED,
  sha256 TEXT GENERATED ALWAYS AS (verified->>'sha256') STORED,
  container TEXT GENERATED ALWAYS AS (verified->>'container') STORED,
  codec TEXT GENERATED ALWAYS AS (verified->>'codec') STORED,
  sample_rate_hz INTEGER GENERATED ALWAYS AS ((verified->>'sample_rate_hz')::INTEGER) STORED,
  channels INTEGER GENERATED ALWAYS AS ((verified->>'channels')::INTEGER) STORED,
  bits_per_sample INTEGER GENERATED ALWAYS AS ((verified->>'bits_per_sample')::INTEGER) STORED,
  format_tag INTEGER GENERATED ALWAYS AS ((verified->>'format_tag')::INTEGER) STORED,
  block_align INTEGER GENERATED ALWAYS AS ((verified->>'block_align')::INTEGER) STORED,
  byte_rate INTEGER GENERATED ALWAYS AS ((verified->>'byte_rate')::INTEGER) STORED,
  data_byte_length BIGINT GENERATED ALWAYS AS ((verified->>'data_byte_length')::BIGINT) STORED,
  data_offset BIGINT GENERATED ALWAYS AS ((verified->>'data_offset')::BIGINT) STORED,
  frame_count BIGINT GENERATED ALWAYS AS ((verified->>'frame_count')::BIGINT) STORED,
  duration_seconds DOUBLE PRECISION GENERATED ALWAYS AS (((verified->>'frame_count')::DOUBLE PRECISION / (verified->>'sample_rate_hz')::DOUBLE PRECISION)) STORED,
  CHECK (container='WAV' AND format_tag=1 AND data_byte_length>0 AND duration_seconds>0 AND duration_seconds<=3600 AND (
    (codec='PCM_S32LE' AND sample_rate_hz=48000 AND channels=2 AND bits_per_sample=32 AND block_align=8 AND byte_rate=384000 AND data_byte_length%8=0 AND frame_count=data_byte_length/8) OR
    (codec='PCM_S16LE' AND sample_rate_hz=16000 AND channels=1 AND bits_per_sample=16 AND block_align=2 AND byte_rate=32000 AND data_byte_length%2=0 AND frame_count=data_byte_length/2)
  ))
);
CREATE TABLE IF NOT EXISTS brtc.verification_audit (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID REFERENCES brtc.verification_jobs(id) ON DELETE RESTRICT,
  generation BIGINT,
  event TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS brtc.incidents (
  id UUID PRIMARY KEY,
  upload_id UUID NOT NULL REFERENCES brtc.uploads(id) ON DELETE RESTRICT,
  generation UUID NOT NULL UNIQUE,
  idx INTEGER NOT NULL,
  detail JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS brtc.beehave_recording_links (
  device_id TEXT NOT NULL REFERENCES public.devices(id) ON DELETE RESTRICT,
  beehave_recording_id TEXT NOT NULL,
  brtc_recording_id UUID NOT NULL UNIQUE REFERENCES brtc.recordings(id) ON DELETE RESTRICT,
  asset_id UUID NOT NULL UNIQUE REFERENCES brtc.assets(id) ON DELETE RESTRICT,
  source_session_key UUID NOT NULL,
  source_recording_key TEXT NOT NULL,
  PRIMARY KEY(device_id, source_session_key, source_recording_key),
  UNIQUE(device_id, beehave_recording_id)
);
CREATE OR REPLACE FUNCTION brtc.immutable_commitment() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable BRTC commitment'; END$$;
CREATE OR REPLACE FUNCTION brtc.never_thaw() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF OLD.frozen AND NOT NEW.frozen THEN RAISE EXCEPTION 'manifest permanently frozen'; END IF; RETURN NEW; END$$;
CREATE OR REPLACE FUNCTION brtc.available_gate() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.state='AVAILABLE' AND (NOT NEW.frozen OR NOT EXISTS(SELECT 1 FROM brtc.canonical_assets WHERE asset_id=NEW.asset_id) OR NOT EXISTS(SELECT 1 FROM brtc.verification_jobs WHERE upload_id=NEW.id AND state='SUCCEEDED')) THEN RAISE EXCEPTION 'verification gate not satisfied'; END IF; RETURN NEW; END$$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='brtc_immutable_manifest') THEN CREATE TRIGGER brtc_immutable_manifest BEFORE UPDATE OR DELETE ON brtc.frozen_manifests FOR EACH ROW EXECUTE FUNCTION brtc.immutable_commitment(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='brtc_immutable_canonical') THEN CREATE TRIGGER brtc_immutable_canonical BEFORE UPDATE OR DELETE ON brtc.canonical_assets FOR EACH ROW EXECUTE FUNCTION brtc.immutable_commitment(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='brtc_never_thaw') THEN CREATE TRIGGER brtc_never_thaw BEFORE UPDATE ON brtc.uploads FOR EACH ROW EXECUTE FUNCTION brtc.never_thaw(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='brtc_available_gate') THEN CREATE TRIGGER brtc_available_gate BEFORE UPDATE ON brtc.uploads FOR EACH ROW EXECUTE FUNCTION brtc.available_gate(); END IF;
END $$;
