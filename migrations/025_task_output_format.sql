-- Historical records remain V1 PDF; only future tasks default to V2.
ALTER TABLE tasks ADD COLUMN output_format text NOT NULL DEFAULT 'pdf' CHECK(output_format IN ('pdf','docx')),
 ADD COLUMN normalization_version integer NOT NULL DEFAULT 1 CHECK(normalization_version IN (1,2));
ALTER TABLE tasks ALTER COLUMN normalization_version SET DEFAULT 2;
ALTER TABLE tasks ADD CONSTRAINT task_format_version CHECK(normalization_version<>1 OR output_format='pdf'),
 ADD CONSTRAINT task_normalized_format CHECK(normalization_summary IS NULL OR normalization_version=1 OR
 ((normalization_summary->>'outputFormat') IS NOT DISTINCT FROM output_format AND
 (normalization_summary->'normalizationVersion') IS NOT DISTINCT FROM '2'::jsonb));
CREATE FUNCTION protect_task_output_format() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.output_format,NEW.normalization_version) IS DISTINCT FROM (OLD.output_format,OLD.normalization_version) THEN
  RAISE EXCEPTION 'Task format is immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER task_output_format_guard BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION protect_task_output_format();
ALTER TABLE generation_jobs ADD COLUMN output_format text NOT NULL DEFAULT 'pdf' CHECK(output_format IN ('pdf','docx'));
CREATE OR REPLACE FUNCTION protect_job_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_pin jsonb; expected_model integer; pinned tasks%ROWTYPE; expected_request jsonb; expected_job jsonb;
BEGIN
 IF TG_OP='UPDATE' AND NEW.output_format IS DISTINCT FROM OLD.output_format THEN RAISE EXCEPTION 'Job format is immutable' USING ERRCODE='55000'; END IF;
 IF NEW.task_id IS NULL AND NEW.output_format<>'pdf' THEN RAISE EXCEPTION 'Legacy job requires PDF' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND NEW.task_id IS DISTINCT FROM OLD.task_id THEN RAISE EXCEPTION 'Task job ownership is immutable' USING ERRCODE='55000'; END IF;
 IF NEW.task_id IS NOT NULL THEN
  IF TG_OP='UPDATE' AND (NEW.template_version_id,NEW.original_input,NEW.prepared_input,NEW.warnings_json,NEW.skipped_indices) IS DISTINCT FROM (OLD.template_version_id,OLD.original_input,OLD.prepared_input,OLD.warnings_json,OLD.skipped_indices) THEN RAISE EXCEPTION 'Task job input is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO pinned FROM tasks WHERE id=NEW.task_id;
  expected_request := jsonb_build_object('contract','flowdoc-task-request/1','taskId',pinned.id,'inputDigest',pinned.input_digest);
  expected_job := jsonb_build_object('contract','flowdoc-task-job/1','taskId',pinned.id,'normalizedFileId',pinned.normalized_file_id,'normalizedDigest',pinned.normalized_digest,'core',jsonb_build_object('version',pinned.normalization_summary->>'coreVersion','sha256',pinned.normalization_summary->>'coreSha256'));
  IF pinned.normalization_version=2 THEN
   expected_request := expected_request || jsonb_build_object('contract','flowdoc-task-request/2','outputFormat',pinned.output_format);
   expected_job := expected_job || jsonb_build_object('contract','flowdoc-task-job/2','outputFormat',pinned.output_format);
  END IF;
  IF NEW.output_format IS DISTINCT FROM pinned.output_format OR pinned.normalized_at IS NULL OR NEW.template_version_id IS DISTINCT FROM pinned.template_version_id OR NEW.preview_template_id IS NOT NULL OR
   NEW.prepared_input IS DISTINCT FROM expected_job OR
   NEW.original_input IS DISTINCT FROM expected_request OR NEW.warnings_json<>'[]'::jsonb OR NEW.skipped_indices<>'[]'::jsonb
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

ALTER TABLE document_outputs ADD COLUMN output_format text NOT NULL DEFAULT 'pdf' CHECK(output_format IN ('pdf','docx'));
ALTER TABLE document_outputs DROP CONSTRAINT document_outputs_media_type_check;
ALTER TABLE document_outputs ADD CONSTRAINT document_output_format_media CHECK
 ((output_format='pdf' AND media_type='application/pdf') OR
 (output_format='docx' AND media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document' AND page_count IS NULL));
CREATE FUNCTION protect_output_format() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job_format text; task_version integer;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.output_format,NEW.job_id,NEW.media_type,NEW.page_count) IS DISTINCT FROM (OLD.output_format,OLD.job_id,OLD.media_type,OLD.page_count) THEN
  RAISE EXCEPTION 'Output identity is immutable' USING ERRCODE='55000';
 END IF;
 SELECT j.output_format,t.normalization_version INTO job_format,task_version FROM generation_jobs j LEFT JOIN tasks t ON t.id=j.task_id WHERE j.id=NEW.job_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF NEW.output_format IS DISTINCT FROM job_format OR (task_version=2 AND NEW.output_format='pdf' AND NEW.page_count IS NULL) THEN
  RAISE EXCEPTION 'Output does not match job format' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER output_format_guard BEFORE INSERT OR UPDATE ON document_outputs FOR EACH ROW EXECUTE FUNCTION protect_output_format();
