CREATE TABLE upload_sessions (
 id uuid PRIMARY KEY DEFAULT uuidv7(), request_key text NOT NULL UNIQUE,
 manifest_digest text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','ready','expired')),
 reserved_bytes bigint NOT NULL CHECK(reserved_bytes>=0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 last_progress_at timestamptz NOT NULL, ready_at timestamptz,
 expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL,
 retired_at timestamptz, deleted_at timestamptz
);
CREATE TABLE upload_items (
 id uuid PRIMARY KEY DEFAULT uuidv7(), upload_id uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
 key text NOT NULL, source_kind text NOT NULL CHECK(source_kind IN ('upload','url')),
 media_type text, expected_bytes bigint, received_bytes bigint NOT NULL DEFAULT 0,
 source_url text, status text NOT NULL CHECK(status IN ('pending','declared','receiving','received','incomplete','expired')),
 storage_key text, checksum text, attempt_id uuid, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(upload_id,key), CHECK(received_bytes>=0),
 CHECK((source_kind='url' AND (source_url IS NOT NULL OR status='expired') AND expected_bytes IS NULL) OR
 (source_kind='upload' AND source_url IS NULL AND expected_bytes>0 AND media_type IN ('image/jpeg','image/png')))
);
CREATE INDEX upload_expiry ON upload_sessions(expires_at) WHERE deleted_at IS NULL;
