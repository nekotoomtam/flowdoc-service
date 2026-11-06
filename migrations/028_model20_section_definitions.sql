-- Model20 definitions reuse the modern section ownership rules; no stored rows are rewritten.
-- Retain the latest021 ownership/preview guards and025 task/output-format job guards.

CREATE OR REPLACE FUNCTION check_section_current_owner() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE owner_id text; modern boolean;
 BEGIN
 IF TG_TABLE_NAME='variables' THEN SELECT template_id INTO owner_id FROM variable_schemas WHERE id=NEW.schema_id;
 ELSE owner_id:=(to_jsonb(NEW)->>'template_id'); IF TG_TABLE_NAME='template_current' THEN owner_id:=NEW.template_id; END IF; END IF;
 SELECT COALESCE((payload->>'nodeModelVersion')::integer,0)IN (15,16,17,18,19,20) INTO modern FROM template_current WHERE template_id=owner_id;
 IF EXISTS(SELECT 1 FROM variable_schemas s LEFT JOIN formats f ON f.id=s.format_id WHERE s.template_id=owner_id AND
 ((s.format_id IS NOT NULL AND s.section_id IS DISTINCT FROM f.section_id) OR
 (modern AND s.scope IN ('section','header','footer') AND s.section_id IS NULL) OR
 (NOT modern AND (s.section_id IS NOT NULL OR s.scope='section')))) OR
 EXISTS(SELECT 1 FROM formats f LEFT JOIN variables v ON v.id=f.owner_area_variable_id LEFT JOIN variable_schemas s ON s.id=v.schema_id WHERE f.template_id=owner_id AND
 ((f.owner_area_variable_id IS NOT NULL AND f.section_id IS DISTINCT FROM s.section_id) OR (modern AND f.owner_area_variable_id IS NULL AND f.section_id IS NULL) OR (NOT modern AND f.section_id IS NOT NULL)))
 THEN RAISE EXCEPTION 'Invalid section ownership' USING ERRCODE='23514'; END IF;
 RETURN NULL; END; $$;

CREATE OR REPLACE FUNCTION check_section_version_owner() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE owner_id uuid; modern boolean;
 BEGIN
 IF TG_TABLE_NAME='variable_versions' THEN SELECT template_version_id INTO owner_id FROM variable_schema_versions WHERE id=NEW.schema_version_id;
 ELSE owner_id:=(to_jsonb(NEW)->>'template_version_id')::uuid; IF TG_TABLE_NAME='template_snapshots' THEN owner_id:=NEW.version_id; END IF; END IF;
 SELECT COALESCE((payload->>'nodeModelVersion')::integer,0)IN (15,16,17,18,19,20) INTO modern FROM template_snapshots WHERE version_id=owner_id;
 IF EXISTS(SELECT 1 FROM variable_schema_versions s LEFT JOIN format_versions f ON f.id=s.format_version_id WHERE s.template_version_id=owner_id AND
 ((s.format_version_id IS NOT NULL AND s.section_version_id IS DISTINCT FROM f.section_version_id) OR
 (modern AND s.scope IN ('section','header','footer') AND s.section_version_id IS NULL) OR
 (NOT modern AND (s.section_version_id IS NOT NULL OR s.scope='section')))) OR
 EXISTS(SELECT 1 FROM format_versions f LEFT JOIN variable_versions v ON v.id=f.owner_area_variable_version_id LEFT JOIN variable_schema_versions s ON s.id=v.schema_version_id WHERE f.template_version_id=owner_id AND
 ((f.owner_area_variable_version_id IS NOT NULL AND f.section_version_id IS DISTINCT FROM s.section_version_id) OR (modern AND f.owner_area_variable_version_id IS NULL AND f.section_version_id IS NULL) OR (NOT modern AND f.section_version_id IS NOT NULL)))
 THEN RAISE EXCEPTION 'Invalid section ownership' USING ERRCODE='23514'; END IF;
 RETURN NULL; END; $$;

CREATE OR REPLACE FUNCTION protect_preview_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_key text; expected_pin jsonb;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.preview_template_id IS DISTINCT FROM OLD.preview_template_id
 OR NEW.preview_revision IS DISTINCT FROM OLD.preview_revision OR NEW.preview_definition IS DISTINCT FROM OLD.preview_definition
 OR NEW.preview_fingerprint IS DISTINCT FROM OLD.preview_fingerprint) THEN
 RAISE EXCEPTION 'Preview input is immutable' USING ERRCODE='55000'; END IF;
 IF NEW.preview_template_id IS NOT NULL THEN
 SELECT doc_key INTO expected_key FROM templates WHERE id=NEW.preview_template_id;
 expected_pin:=jsonb_build_object('templateId',NEW.preview_template_id,'docKey',expected_key,'version',1,'fingerprint',NEW.preview_fingerprint);
 IF NEW.preview_definition->>'nodeModelVersion'='19' THEN
  expected_pin:=expected_pin||jsonb_build_object('nodeModelVersion',19);
  IF NEW.prepared_input->'schemaVersion' IS DISTINCT FROM '2'::jsonb THEN RAISE EXCEPTION 'Invalid model19 prepared schema' USING ERRCODE='23514'; END IF;
 ELSIF NEW.preview_definition->>'nodeModelVersion'='20' THEN
  expected_pin:=expected_pin||jsonb_build_object('nodeModelVersion',20);
  IF NEW.prepared_input->'schemaVersion' IS DISTINCT FROM '3'::jsonb THEN RAISE EXCEPTION 'Invalid model20 prepared schema' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.preview_definition->>'templateId' IS DISTINCT FROM NEW.preview_template_id
 OR NEW.preview_definition->>'docKey' IS DISTINCT FROM expected_key
 OR NEW.preview_definition->'version' IS DISTINCT FROM '1'::jsonb
 OR NEW.prepared_input->'template' IS DISTINCT FROM expected_pin
 OR NEW.prepared_input->'warnings' IS DISTINCT FROM NEW.warnings_json
 OR NEW.prepared_input->'skippedContentIndices' IS DISTINCT FROM NEW.skipped_indices THEN
 RAISE EXCEPTION 'Invalid preview pin' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END; $$;

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
 ELSIF expected_model=20 THEN
  expected_pin:=expected_pin||jsonb_build_object('nodeModelVersion',20);
  IF NEW.prepared_input->'schemaVersion' IS DISTINCT FROM '3'::jsonb THEN RAISE EXCEPTION 'Invalid model20 prepared schema' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.prepared_input->'template' IS DISTINCT FROM expected_pin
 OR NEW.prepared_input->'warnings' IS DISTINCT FROM NEW.warnings_json
 OR NEW.prepared_input->'skippedContentIndices' IS DISTINCT FROM NEW.skipped_indices THEN
  RAISE EXCEPTION 'Prepared job does not match selected version or metadata' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
