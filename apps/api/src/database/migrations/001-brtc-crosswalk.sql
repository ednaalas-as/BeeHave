-- Upgrade only the known, empty pre-Phase-1 crosswalk. Run inside the
-- initialization transaction/advisory lock; never rewrite existing identities.
DO $$
DECLARE actual_columns TEXT[]; actual_constraints TEXT[];
BEGIN
  LOCK TABLE brtc.beehave_recording_links IN ACCESS EXCLUSIVE MODE;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='brtc' AND table_name='beehave_recording_links'
      AND column_name='source_session_key'
  ) THEN
    IF EXISTS (SELECT 1 FROM brtc.beehave_recording_links) THEN
      RAISE EXCEPTION 'BRTC crosswalk migration requires review: legacy table is not empty';
    END IF;
    ALTER TABLE brtc.beehave_recording_links
      ADD COLUMN source_session_key UUID NOT NULL;
    -- Metadata and original-asset transfer are independent ingestion paths.
    -- Keep the device, BRTC recording and BRTC asset ownership references.
    ALTER TABLE brtc.beehave_recording_links
      DROP CONSTRAINT IF EXISTS beehave_recording_links_device_id_beehave_recording_id_fkey;
    ALTER TABLE brtc.beehave_recording_links
      DROP CONSTRAINT beehave_recording_links_pkey;
    ALTER TABLE brtc.beehave_recording_links
      ADD PRIMARY KEY (device_id, source_session_key, source_recording_key),
      ADD UNIQUE (device_id, beehave_recording_id);
  END IF;

  -- Fail startup visibly on any unsupported schema instead of silently accepting
  -- CREATE TABLE IF NOT EXISTS. Column order and generated constraint names do
  -- not affect the contract.
  SELECT array_agg(column_name || ':' || data_type || ':' || is_nullable ORDER BY column_name)
    INTO actual_columns
    FROM information_schema.columns
    WHERE table_schema='brtc' AND table_name='beehave_recording_links';
  IF actual_columns IS DISTINCT FROM ARRAY[
    'asset_id:uuid:NO', 'beehave_recording_id:text:NO',
    'brtc_recording_id:uuid:NO', 'device_id:text:NO',
    'source_recording_key:text:NO', 'source_session_key:uuid:NO'
  ] THEN RAISE EXCEPTION 'BRTC crosswalk columns do not match the Phase 1 contract'; END IF;

  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid))
    INTO actual_constraints FROM pg_constraint
    WHERE conrelid='brtc.beehave_recording_links'::regclass;
  IF actual_constraints IS DISTINCT FROM ARRAY[
    'FOREIGN KEY (asset_id) REFERENCES brtc.assets(id) ON DELETE RESTRICT',
    'FOREIGN KEY (brtc_recording_id) REFERENCES brtc.recordings(id) ON DELETE RESTRICT',
    'FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT',
    'PRIMARY KEY (device_id, source_session_key, source_recording_key)',
    'UNIQUE (asset_id)', 'UNIQUE (brtc_recording_id)',
    'UNIQUE (device_id, beehave_recording_id)'
  ] THEN RAISE EXCEPTION 'BRTC crosswalk constraints do not match the Phase 1 contract'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indrelid='brtc.beehave_recording_links'::regclass
      AND (NOT indisvalid OR NOT indisready)
  ) THEN RAISE EXCEPTION 'BRTC crosswalk has an invalid index'; END IF;
END $$;
