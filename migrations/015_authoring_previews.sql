CREATE TABLE authoring_templates (
 template_id text PRIMARY KEY REFERENCES templates(id),
 principal text NOT NULL CHECK(length(principal) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE upload_sessions ADD COLUMN authoring_principal text;
CREATE TABLE authoring_receipts (
 principal text NOT NULL,
 operation text NOT NULL,
 target text NOT NULL,
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
 digest text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(principal,operation,target,request_key)
);
CREATE TABLE authoring_audit (
 id uuid PRIMARY KEY DEFAULT uuidv7(),
 template_id text NOT NULL REFERENCES templates(id),
 principal text NOT NULL,
 revision integer NOT NULL,
 operation text NOT NULL,
 summary jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE generation_jobs ALTER COLUMN template_version_id DROP NOT NULL;
ALTER TABLE generation_jobs ADD COLUMN preview_template_id text REFERENCES authoring_templates(template_id);
ALTER TABLE generation_jobs ADD COLUMN preview_revision integer;
ALTER TABLE generation_jobs ADD COLUMN preview_definition jsonb;
ALTER TABLE generation_jobs ADD COLUMN preview_fingerprint text;
ALTER TABLE generation_jobs ADD CONSTRAINT job_source CHECK (
 (template_version_id IS NOT NULL AND preview_template_id IS NULL AND preview_revision IS NULL AND preview_definition IS NULL AND preview_fingerprint IS NULL)
 OR (template_version_id IS NULL AND preview_template_id IS NOT NULL AND preview_revision IS NOT NULL AND preview_revision>0 AND preview_definition IS NOT NULL AND jsonb_typeof(preview_definition)='object' AND preview_fingerprint IS NOT NULL AND preview_fingerprint ~ '^[0-9a-f]{64}$')
);
CREATE FUNCTION protect_preview_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_key text;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.preview_template_id IS DISTINCT FROM OLD.preview_template_id
 OR NEW.preview_revision IS DISTINCT FROM OLD.preview_revision OR NEW.preview_definition IS DISTINCT FROM OLD.preview_definition
 OR NEW.preview_fingerprint IS DISTINCT FROM OLD.preview_fingerprint) THEN
 RAISE EXCEPTION 'Preview input is immutable' USING ERRCODE='55000'; END IF;
 IF NEW.preview_template_id IS NOT NULL THEN
 SELECT doc_key INTO expected_key FROM templates WHERE id=NEW.preview_template_id;
 IF NEW.preview_definition->>'templateId' IS DISTINCT FROM NEW.preview_template_id
 OR NEW.preview_definition->>'docKey' IS DISTINCT FROM expected_key
 OR NEW.preview_definition->'version' IS DISTINCT FROM '1'::jsonb
 OR NEW.prepared_input->'template' IS DISTINCT FROM jsonb_build_object('templateId',NEW.preview_template_id,'docKey',expected_key,'version',1,'fingerprint',NEW.preview_fingerprint)
 OR NEW.prepared_input->'warnings' IS DISTINCT FROM NEW.warnings_json
 OR NEW.prepared_input->'skippedContentIndices' IS DISTINCT FROM NEW.skipped_indices THEN
 RAISE EXCEPTION 'Invalid preview pin' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER immutable_preview BEFORE INSERT OR UPDATE ON generation_jobs FOR EACH ROW EXECUTE FUNCTION protect_preview_input();
