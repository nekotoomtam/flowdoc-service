-- Model16 keeps Section ownership. No stored documents are rewritten.
CREATE OR REPLACE FUNCTION check_section_current_owner() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE owner_id text; modern boolean;
 BEGIN
 IF TG_TABLE_NAME='variables' THEN SELECT template_id INTO owner_id FROM variable_schemas WHERE id=NEW.schema_id;
 ELSE owner_id:=(to_jsonb(NEW)->>'template_id'); IF TG_TABLE_NAME='template_current' THEN owner_id:=NEW.template_id; END IF; END IF;
 SELECT COALESCE((payload->>'nodeModelVersion')::integer,0)IN (15,16) INTO modern FROM template_current WHERE template_id=owner_id;
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
 SELECT COALESCE((payload->>'nodeModelVersion')::integer,0)IN (15,16) INTO modern FROM template_snapshots WHERE version_id=owner_id;
 IF EXISTS(SELECT 1 FROM variable_schema_versions s LEFT JOIN format_versions f ON f.id=s.format_version_id WHERE s.template_version_id=owner_id AND
 ((s.format_version_id IS NOT NULL AND s.section_version_id IS DISTINCT FROM f.section_version_id) OR
 (modern AND s.scope IN ('section','header','footer') AND s.section_version_id IS NULL) OR
 (NOT modern AND (s.section_version_id IS NOT NULL OR s.scope='section')))) OR
 EXISTS(SELECT 1 FROM format_versions f LEFT JOIN variable_versions v ON v.id=f.owner_area_variable_version_id LEFT JOIN variable_schema_versions s ON s.id=v.schema_version_id WHERE f.template_version_id=owner_id AND
 ((f.owner_area_variable_version_id IS NOT NULL AND f.section_version_id IS DISTINCT FROM s.section_version_id) OR (modern AND f.owner_area_variable_version_id IS NULL AND f.section_version_id IS NULL) OR (NOT modern AND f.section_version_id IS NOT NULL)))
 THEN RAISE EXCEPTION 'Invalid section ownership' USING ERRCODE='23514'; END IF;
 RETURN NULL; END; $$;
