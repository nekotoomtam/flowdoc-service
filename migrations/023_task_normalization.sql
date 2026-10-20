-- Forward-only Stage2 metadata. Document values remain in temporary files.
ALTER TABLE tasks ADD COLUMN validation_started_at timestamptz, ADD COLUMN normalized_at timestamptz, ADD COLUMN normalized_digest text,
 ADD COLUMN normalized_file_id uuid REFERENCES task_files(id) ON DELETE RESTRICT,
 ADD COLUMN normalization_summary jsonb CHECK(normalization_summary IS NULL OR (jsonb_typeof(normalization_summary)='object' AND octet_length(normalization_summary::text)<=8192));
ALTER TABLE tasks ADD CONSTRAINT task_normalized_complete CHECK((normalized_at IS NULL AND normalized_digest IS NULL AND normalized_file_id IS NULL AND normalization_summary IS NULL) OR (normalized_at IS NOT NULL AND normalized_digest ~ '^[a-f0-9]{64}$' AND normalized_file_id IS NOT NULL AND normalization_summary IS NOT NULL));
CREATE FUNCTION guard_task_normalization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.validation_started_at IS NOT NULL AND NEW.validation_started_at IS DISTINCT FROM OLD.validation_started_at THEN RAISE EXCEPTION 'Task validation start is immutable' USING ERRCODE='55000'; END IF;
 IF OLD.normalized_at IS NOT NULL AND (NEW.normalized_at,NEW.normalized_digest,NEW.normalized_file_id,NEW.normalization_summary) IS DISTINCT FROM (OLD.normalized_at,OLD.normalized_digest,OLD.normalized_file_id,OLD.normalization_summary) THEN
 RAISE EXCEPTION 'Task normalization pin is immutable' USING ERRCODE='55000'; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER task_normalization_guard BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION guard_task_normalization();
ALTER TABLE task_files DROP CONSTRAINT task_files_storage_key_check;
ALTER TABLE task_files ADD CONSTRAINT task_files_storage_key_check CHECK(storage_key IS NULL OR storage_key ~ '^[0-9a-f-]{36}/(input|normalized)/[0-9a-f-]{36}\.bin(\.part)?$');
CREATE TABLE task_findings (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
 sequence bigint NOT NULL CHECK(sequence>0),code text NOT NULL,section_id text,
 pointer text NOT NULL CHECK(octet_length(pointer)<=2048),locator_sha256 text CHECK(locator_sha256 IS NULL OR locator_sha256 ~ '^[a-f0-9]{64}$'),affected_placement_count bigint NOT NULL CHECK(affected_placement_count>=0),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,sequence)
);
CREATE TRIGGER task_findings_immutable BEFORE UPDATE OR DELETE ON task_findings FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();
