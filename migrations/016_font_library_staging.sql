-- Phase 1 deliberately permits preparing only. Activation needs a later migration.
CREATE TABLE font_families (
 id uuid PRIMARY KEY, display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
 internal_names jsonb NOT NULL CHECK(jsonb_typeof(internal_names)='array'),
 source_identity jsonb NOT NULL CHECK(jsonb_typeof(source_identity)='object'),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 default_release_id uuid CHECK(default_release_id IS NULL),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX font_family_source ON font_families((source_identity->>'provider'),(source_identity->>'providerFamilyKey'));
CREATE TABLE font_assets (
 id uuid PRIMARY KEY,sha256 text NOT NULL UNIQUE CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 10485760),
 format text NOT NULL CHECK(format IN ('ttf-static','license-text')),
 storage_key text NOT NULL UNIQUE CHECK(storage_key ~ '^[0-9a-f]{64}\.bin$'),
 parsed_metadata jsonb NOT NULL CHECK(jsonb_typeof(parsed_metadata)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),CHECK(storage_key=sha256||'.bin'),
 CHECK(format<>'license-text' OR byte_length<=1048576)
);
CREATE TABLE font_imports (
 id uuid PRIMARY KEY,principal text NOT NULL CHECK(length(principal) BETWEEN 1 AND 200),
 manifest jsonb NOT NULL,revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 state text NOT NULL DEFAULT 'receiving' CHECK(state IN ('receiving','inspected')),
 inspection jsonb,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE font_import_files (
 import_id uuid NOT NULL REFERENCES font_imports(id),client_key text NOT NULL CHECK(client_key ~ '^[A-Za-z0-9_-]{1,100}$'),
 kind text NOT NULL CHECK(kind IN ('ttf-static','license-text')),
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 10485760),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 received boolean NOT NULL DEFAULT false,asset_id uuid REFERENCES font_assets(id),
 PRIMARY KEY(import_id,client_key),CHECK(kind<>'license-text' OR byte_length<=1048576)
);
CREATE TABLE font_source_evidence (
 id uuid PRIMARY KEY,import_id uuid NOT NULL REFERENCES font_imports(id),
 client_key text NOT NULL,asset_id uuid NOT NULL REFERENCES font_assets(id),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(import_id,client_key),UNIQUE(id,asset_id),
 FOREIGN KEY(import_id,client_key) REFERENCES font_import_files(import_id,client_key)
);
CREATE TABLE font_releases (
 id uuid PRIMARY KEY,family_id uuid NOT NULL REFERENCES font_families(id),
 version integer NOT NULL CHECK(version>=1),state text NOT NULL DEFAULT 'preparing' CHECK(state='preparing'),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
 language_scope jsonb NOT NULL,issues jsonb NOT NULL,ever_activated_at timestamptz CHECK(ever_activated_at IS NULL),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(family_id,version),UNIQUE(family_id,manifest_digest)
);
ALTER TABLE font_families ADD FOREIGN KEY(default_release_id) REFERENCES font_releases(id);
CREATE TABLE font_faces (
 id uuid PRIMARY KEY,release_id uuid NOT NULL REFERENCES font_releases(id),
 asset_id uuid NOT NULL REFERENCES font_assets(id),source_evidence_id uuid NOT NULL,
 raw_weight integer NOT NULL CHECK(raw_weight BETWEEN 1 AND 1000),
 source_weight integer CHECK(source_weight BETWEEN 1 AND 1000),
 approved_weight integer CHECK(approved_weight BETWEEN 1 AND 1000),
 style text NOT NULL CHECK(style IN ('normal','italic')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(release_id,approved_weight,style),UNIQUE(release_id,asset_id),
 FOREIGN KEY(source_evidence_id,asset_id) REFERENCES font_source_evidence(id,asset_id)
);
CREATE TABLE font_receipts (
 principal text NOT NULL,operation text NOT NULL,target text NOT NULL,request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 200),
 digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(principal,operation,target,request_id)
);
CREATE TABLE font_audit_events (
 id uuid PRIMARY KEY,actor text NOT NULL,action text NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 request_id text NOT NULL,release_id uuid REFERENCES font_releases(id),summary jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION protect_font_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Font immutable record cannot be changed'; END $$;
CREATE TRIGGER font_asset_immutable BEFORE UPDATE OR DELETE ON font_assets FOR EACH ROW EXECUTE FUNCTION protect_font_immutable();
CREATE TRIGGER font_evidence_immutable BEFORE UPDATE OR DELETE ON font_source_evidence FOR EACH ROW EXECUTE FUNCTION protect_font_immutable();
CREATE TRIGGER font_audit_immutable BEFORE UPDATE OR DELETE ON font_audit_events FOR EACH ROW EXECUTE FUNCTION protect_font_immutable();
CREATE FUNCTION check_font_face() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE asset jsonb; evidence jsonb; asset_kind text;
BEGIN
 SELECT parsed_metadata,format INTO asset,asset_kind FROM font_assets WHERE id=NEW.asset_id;
 SELECT metadata INTO evidence FROM font_source_evidence WHERE id=NEW.source_evidence_id AND asset_id=NEW.asset_id;
 IF asset_kind IS DISTINCT FROM 'ttf-static' OR (asset->>'rawWeight')::integer IS DISTINCT FROM NEW.raw_weight
 OR asset->>'style' IS DISTINCT FROM NEW.style OR evidence IS NULL
 OR (evidence->>'sourceWeight')::integer IS DISTINCT FROM NEW.source_weight THEN
  RAISE EXCEPTION 'Face binding differs from immutable asset or source evidence';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER font_face_metadata BEFORE INSERT OR UPDATE ON font_faces FOR EACH ROW EXECUTE FUNCTION check_font_face();
