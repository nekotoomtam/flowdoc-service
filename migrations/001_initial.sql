CREATE TABLE templates (
 id text PRIMARY KEY CHECK (length(btrim(id))>0),
 doc_key text NOT NULL UNIQUE CHECK (length(btrim(doc_key))>0),
 name text NOT NULL CHECK (length(btrim(name))>0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE template_versions (
 id uuid PRIMARY KEY,
 template_id text NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
 version integer NOT NULL CHECK (version>0),
 definition_json jsonb NOT NULL CHECK (jsonb_typeof(definition_json)='object'),
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(template_id,version)
);
CREATE TABLE generation_jobs (
 id uuid PRIMARY KEY,
 template_version_id uuid NOT NULL REFERENCES template_versions(id) ON DELETE RESTRICT,
 original_input jsonb NOT NULL CHECK (jsonb_typeof(original_input)='object'),
 prepared_input jsonb NOT NULL CHECK (jsonb_typeof(prepared_input)='object'),
 warnings_json jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings_json)='array'),
 skipped_indices jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(skipped_indices)='array'),
 errors_json jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(errors_json)='array'),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 finished_at timestamptz
);
CREATE INDEX generation_jobs_queued ON generation_jobs(created_at,id) WHERE status='queued';
CREATE INDEX generation_jobs_version ON generation_jobs(template_version_id);
CREATE TABLE document_outputs (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL UNIQUE REFERENCES generation_jobs(id) ON DELETE RESTRICT,
 path text NOT NULL CHECK (length(btrim(path))>0),
 media_type text NOT NULL CHECK (media_type='application/pdf'),
 byte_size bigint NOT NULL CHECK (byte_size>=0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION reject_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Registered versions are immutable' USING ERRCODE='55000'; END;
$$;
CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON template_versions
 FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();
CREATE FUNCTION protect_template_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.doc_key IS DISTINCT FROM OLD.doc_key THEN
  RAISE EXCEPTION 'Template identity is immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_template_identity BEFORE UPDATE ON templates
 FOR EACH ROW EXECUTE FUNCTION protect_template_identity();
CREATE FUNCTION check_version_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_key text;
BEGIN
 SELECT doc_key INTO expected_key FROM templates WHERE id=NEW.template_id;
 IF expected_key IS NULL THEN RETURN NEW; END IF; -- FK owns the missing-parent error.
 IF NEW.definition_json->>'templateId' IS DISTINCT FROM NEW.template_id
 OR NEW.definition_json->>'docKey' IS DISTINCT FROM expected_key
 OR NEW.definition_json->'version' IS DISTINCT FROM to_jsonb(NEW.version) THEN
  RAISE EXCEPTION 'Definition identity does not match version' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER version_identity BEFORE INSERT ON template_versions
 FOR EACH ROW EXECUTE FUNCTION check_version_identity();
CREATE FUNCTION protect_job_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_pin jsonb;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
 OR NEW.original_input IS DISTINCT FROM OLD.original_input
 OR NEW.prepared_input IS DISTINCT FROM OLD.prepared_input
 OR NEW.warnings_json IS DISTINCT FROM OLD.warnings_json
 OR NEW.skipped_indices IS DISTINCT FROM OLD.skipped_indices) THEN
  RAISE EXCEPTION 'Accepted job input is immutable' USING ERRCODE='55000';
 END IF;
 SELECT jsonb_build_object('templateId',v.template_id,'docKey',t.doc_key,
  'version',v.version,'fingerprint',v.fingerprint) INTO expected_pin
 FROM template_versions v JOIN templates t ON t.id=v.template_id WHERE v.id=NEW.template_version_id;
 IF expected_pin IS NULL THEN RETURN NEW; END IF;
 IF NEW.prepared_input->'template' IS DISTINCT FROM expected_pin
 OR NEW.prepared_input->'warnings' IS DISTINCT FROM NEW.warnings_json
 OR NEW.prepared_input->'skippedContentIndices' IS DISTINCT FROM NEW.skipped_indices THEN
  RAISE EXCEPTION 'Prepared job does not match selected version or metadata' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_job_input BEFORE INSERT OR UPDATE ON generation_jobs
 FOR EACH ROW EXECUTE FUNCTION protect_job_input();
