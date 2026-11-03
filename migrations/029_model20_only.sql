-- Pre-use model20 cutover. Never relabel or delete a legacy graph/job in place.
-- A new namespace must contain explicitly converted definitions and new jobs.
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM template_current WHERE (payload->'nodeModelVersion') IS DISTINCT FROM '20'::jsonb)
 OR EXISTS(SELECT 1 FROM template_versions WHERE (definition_json->'nodeModelVersion') IS DISTINCT FROM '20'::jsonb)
 OR EXISTS(SELECT 1 FROM template_snapshots WHERE (payload->'nodeModelVersion') IS DISTINCT FROM '20'::jsonb)
 OR EXISTS(SELECT 1 FROM generation_jobs WHERE
   (preview_definition IS NOT NULL AND (preview_definition->'nodeModelVersion') IS DISTINCT FROM '20'::jsonb)
   OR (task_id IS NULL AND ((prepared_input->'schemaVersion') IS DISTINCT FROM '3'::jsonb
     OR (prepared_input->'template'->'nodeModelVersion') IS DISTINCT FROM '20'::jsonb)))
 THEN RAISE EXCEPTION 'Legacy FlowDoc data requires a new model20 namespace before migration029' USING ERRCODE='FD020'; END IF;
END;
$$;

ALTER TABLE template_current ADD CONSTRAINT template_current_model20_only
 CHECK ((payload->'nodeModelVersion') IS NOT DISTINCT FROM '20'::jsonb);
ALTER TABLE template_versions ADD CONSTRAINT template_versions_model20_only
 CHECK ((definition_json->'nodeModelVersion') IS NOT DISTINCT FROM '20'::jsonb);
ALTER TABLE template_snapshots ADD CONSTRAINT template_snapshots_model20_only
 CHECK ((payload->'nodeModelVersion') IS NOT DISTINCT FROM '20'::jsonb);
ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_model20_preview
 CHECK (preview_definition IS NULL OR (preview_definition->'nodeModelVersion') IS NOT DISTINCT FROM '20'::jsonb);
ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_model20_prepared
 CHECK (task_id IS NOT NULL OR ((prepared_input->'schemaVersion') IS NOT DISTINCT FROM '3'::jsonb
   AND (prepared_input->'template'->'nodeModelVersion') IS NOT DISTINCT FROM '20'::jsonb));

-- Model20 formats belong to explicit Area variables, never legacy Section maps.
ALTER TABLE formats ADD CONSTRAINT formats_model20_area_owner
 CHECK (owner_area_variable_id IS NOT NULL AND source_definition_id IS NOT NULL);
ALTER TABLE format_versions ADD CONSTRAINT format_versions_model20_area_owner
 CHECK (owner_area_variable_version_id IS NOT NULL AND source_definition_id IS NOT NULL);
