-- Internal task processor only; public negotiation remains a later stage.
ALTER TABLE generation_jobs DROP CONSTRAINT task_job_stage4_gate;
ALTER TABLE generation_jobs ADD COLUMN task_warning_count integer CHECK(task_warning_count>=0);
ALTER TABLE tasks ADD COLUMN processing_started_at timestamptz, ADD COLUMN send_started_at timestamptz,
 ADD COLUMN child_pid integer, ADD COLUMN child_host text, ADD COLUMN writer_start_identity text;
ALTER TABLE document_outputs ADD COLUMN sha256 text CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'), ADD COLUMN page_count integer CHECK(page_count>0);
ALTER TABLE task_files DROP CONSTRAINT task_files_storage_key_check;
ALTER TABLE task_files ADD CONSTRAINT task_files_storage_key_check CHECK(storage_key IS NULL OR storage_key ~ '^[0-9a-f-]{36}/(input|normalized|prepared)/[0-9a-f-]{36}\.bin(\.part)?$');
CREATE OR REPLACE FUNCTION protect_job_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_pin jsonb; expected_model integer; pinned tasks%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND NEW.task_id IS DISTINCT FROM OLD.task_id THEN RAISE EXCEPTION 'Task job ownership is immutable' USING ERRCODE='55000'; END IF;
 IF NEW.task_id IS NOT NULL THEN
  IF TG_OP='UPDATE' AND (NEW.template_version_id,NEW.original_input,NEW.prepared_input,NEW.warnings_json,NEW.skipped_indices) IS DISTINCT FROM (OLD.template_version_id,OLD.original_input,OLD.prepared_input,OLD.warnings_json,OLD.skipped_indices) THEN RAISE EXCEPTION 'Task job input is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO pinned FROM tasks WHERE id=NEW.task_id;
  IF pinned.normalized_at IS NULL OR NEW.template_version_id IS DISTINCT FROM pinned.template_version_id OR NEW.preview_template_id IS NOT NULL OR
   NEW.prepared_input IS DISTINCT FROM jsonb_build_object('contract','flowdoc-task-job/1','taskId',pinned.id,'normalizedFileId',pinned.normalized_file_id,'normalizedDigest',pinned.normalized_digest,'core',jsonb_build_object('version',pinned.normalization_summary->>'coreVersion','sha256',pinned.normalization_summary->>'coreSha256')) OR
   NEW.original_input IS DISTINCT FROM jsonb_build_object('contract','flowdoc-task-request/1','taskId',pinned.id,'inputDigest',pinned.input_digest) OR NEW.warnings_json<>'[]'::jsonb OR NEW.skipped_indices<>'[]'::jsonb
  THEN RAISE EXCEPTION 'Invalid task job pin' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
 OR NEW.original_input IS DISTINCT FROM OLD.original_input
 OR NEW.prepared_input IS DISTINCT FROM OLD.prepared_input
 OR NEW.warnings_json IS DISTINCT FROM OLD.warnings_json
 OR NEW.skipped_indices IS DISTINCT FROM OLD.skipped_indices) THEN
  RAISE EXCEPTION 'Accepted job input is immutable' USING ERRCODE='55000';
 END IF;
 SELECT jsonb_build_object('templateId',v.template_id,'docKey',t.doc_key,
  'version',v.version,'fingerprint',v.fingerprint), (v.definition_json->>'nodeModelVersion')::integer INTO expected_pin,expected_model
 FROM template_versions v JOIN templates t ON t.id=v.template_id WHERE v.id=NEW.template_version_id;
 IF expected_pin IS NULL THEN RETURN NEW; END IF;
 IF expected_model=19 THEN
  expected_pin:=expected_pin||jsonb_build_object('nodeModelVersion',19);
  IF NEW.prepared_input->'schemaVersion' IS DISTINCT FROM '2'::jsonb THEN RAISE EXCEPTION 'Invalid model19 prepared schema' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.prepared_input->'template' IS DISTINCT FROM expected_pin
 OR NEW.prepared_input->'warnings' IS DISTINCT FROM NEW.warnings_json
 OR NEW.prepared_input->'skippedContentIndices' IS DISTINCT FROM NEW.skipped_indices THEN
  RAISE EXCEPTION 'Prepared job does not match selected version or metadata' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
