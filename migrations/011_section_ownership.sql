-- Section owners are additive: legacy payloads and published fingerprints are untouched.
CREATE TABLE sections(
 id uuid PRIMARY KEY,template_id text NOT NULL REFERENCES template_current(template_id),
 source_definition_id text NOT NULL CHECK(length(btrim(source_definition_id))>0),
 key text NOT NULL CHECK(length(btrim(key))>0),label text,position integer NOT NULL CHECK(position>=0),payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,template_id),UNIQUE(template_id,source_definition_id),UNIQUE(template_id,key),
 UNIQUE(template_id,position) DEFERRABLE INITIALLY DEFERRED);
 ALTER TABLE formats ADD COLUMN section_id uuid, ADD CONSTRAINT formats_section_fk FOREIGN KEY(section_id,template_id) REFERENCES sections(id,template_id) DEFERRABLE INITIALLY DEFERRED;
 ALTER TABLE variable_schemas ADD COLUMN section_id uuid, ADD CONSTRAINT variable_schemas_section_fk FOREIGN KEY(section_id,template_id) REFERENCES sections(id,template_id) DEFERRABLE INITIALLY DEFERRED;
 DROP INDEX formats_top_key;
 CREATE UNIQUE INDEX formats_top_key ON formats(template_id,section_id,key) NULLS NOT DISTINCT WHERE owner_area_variable_id IS NULL;
 ALTER TABLE variable_schemas DROP CONSTRAINT variable_schemas_owner_unique;
 ALTER TABLE variable_schemas ADD CONSTRAINT variable_schemas_owner_unique UNIQUE NULLS NOT DISTINCT(template_id,section_id,scope,format_id);
 ALTER TABLE variable_schemas DROP CONSTRAINT variable_schemas_scope_check;
 ALTER TABLE variable_schemas ADD CONSTRAINT variable_schemas_scope_check CHECK(
 (scope='format' AND format_id IS NOT NULL) OR
 (scope='global' AND format_id IS NULL AND section_id IS NULL) OR
 (scope='section' AND format_id IS NULL AND section_id IS NOT NULL) OR
 (scope IN ('header','footer') AND format_id IS NULL));
 CREATE FUNCTION check_section_current_owner() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE owner_id text; modern boolean;
 BEGIN
 IF TG_TABLE_NAME='variables' THEN SELECT template_id INTO owner_id FROM variable_schemas WHERE id=NEW.schema_id;
 ELSE owner_id:=(to_jsonb(NEW)->>'template_id'); IF TG_TABLE_NAME='template_current' THEN owner_id:=NEW.template_id; END IF; END IF;
 SELECT COALESCE((payload->>'nodeModelVersion')::integer,0)=15 INTO modern FROM template_current WHERE template_id=owner_id;
 IF EXISTS(SELECT 1 FROM variable_schemas s LEFT JOIN formats f ON f.id=s.format_id WHERE s.template_id=owner_id AND
 ((s.format_id IS NOT NULL AND s.section_id IS DISTINCT FROM f.section_id) OR
 (modern AND s.scope IN ('section','header','footer') AND s.section_id IS NULL) OR
 (NOT modern AND (s.section_id IS NOT NULL OR s.scope='section')))) OR
 EXISTS(SELECT 1 FROM formats f LEFT JOIN variables v ON v.id=f.owner_area_variable_id LEFT JOIN variable_schemas s ON s.id=v.schema_id WHERE f.template_id=owner_id AND
 ((f.owner_area_variable_id IS NOT NULL AND f.section_id IS DISTINCT FROM s.section_id) OR (modern AND f.owner_area_variable_id IS NULL AND f.section_id IS NULL) OR (NOT modern AND f.section_id IS NOT NULL)))
 THEN RAISE EXCEPTION 'Invalid section ownership' USING ERRCODE='23514'; END IF;
 RETURN NULL; END; $$;
 CREATE CONSTRAINT TRIGGER formats_section_owner AFTER INSERT OR UPDATE ON formats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_section_current_owner();
 CREATE CONSTRAINT TRIGGER variable_schemas_section_owner AFTER INSERT OR UPDATE ON variable_schemas DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_section_current_owner();
CREATE TABLE section_versions(
 id uuid PRIMARY KEY,template_version_id uuid NOT NULL REFERENCES template_snapshots(version_id),
 source_section_id uuid,source_definition_id text NOT NULL CHECK(length(btrim(source_definition_id))>0),
 key text NOT NULL CHECK(length(btrim(key))>0),label text,position integer NOT NULL CHECK(position>=0),payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,template_version_id),UNIQUE(template_version_id,source_definition_id),UNIQUE(template_version_id,key),
 UNIQUE(template_version_id,position) DEFERRABLE INITIALLY DEFERRED);
 ALTER TABLE format_versions ADD COLUMN section_version_id uuid, ADD CONSTRAINT format_versions_section_fk FOREIGN KEY(section_version_id,template_version_id) REFERENCES section_versions(id,template_version_id) DEFERRABLE INITIALLY DEFERRED;
 ALTER TABLE variable_schema_versions ADD COLUMN section_version_id uuid, ADD CONSTRAINT variable_schema_versions_section_fk FOREIGN KEY(section_version_id,template_version_id) REFERENCES section_versions(id,template_version_id) DEFERRABLE INITIALLY DEFERRED;
 DROP INDEX format_versions_top_key;
 CREATE UNIQUE INDEX format_versions_top_key ON format_versions(template_version_id,section_version_id,key) NULLS NOT DISTINCT WHERE owner_area_variable_version_id IS NULL;
 ALTER TABLE variable_schema_versions DROP CONSTRAINT variable_schema_versions_owner_unique;
 ALTER TABLE variable_schema_versions ADD CONSTRAINT variable_schema_versions_owner_unique UNIQUE NULLS NOT DISTINCT(template_version_id,section_version_id,scope,format_version_id);
 ALTER TABLE variable_schema_versions DROP CONSTRAINT variable_schema_versions_scope_check;
 ALTER TABLE variable_schema_versions ADD CONSTRAINT variable_schema_versions_scope_check CHECK(
 (scope='format' AND format_version_id IS NOT NULL) OR
 (scope='global' AND format_version_id IS NULL AND section_version_id IS NULL) OR
 (scope='section' AND format_version_id IS NULL AND section_version_id IS NOT NULL) OR
 (scope IN ('header','footer') AND format_version_id IS NULL));
 CREATE FUNCTION check_section_version_owner() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE owner_id uuid; modern boolean;
 BEGIN
 IF TG_TABLE_NAME='variable_versions' THEN SELECT template_version_id INTO owner_id FROM variable_schema_versions WHERE id=NEW.schema_version_id;
 ELSE owner_id:=(to_jsonb(NEW)->>'template_version_id')::uuid; IF TG_TABLE_NAME='template_snapshots' THEN owner_id:=NEW.version_id; END IF; END IF;
 SELECT COALESCE((payload->>'nodeModelVersion')::integer,0)=15 INTO modern FROM template_snapshots WHERE version_id=owner_id;
 IF EXISTS(SELECT 1 FROM variable_schema_versions s LEFT JOIN format_versions f ON f.id=s.format_version_id WHERE s.template_version_id=owner_id AND
 ((s.format_version_id IS NOT NULL AND s.section_version_id IS DISTINCT FROM f.section_version_id) OR
 (modern AND s.scope IN ('section','header','footer') AND s.section_version_id IS NULL) OR
 (NOT modern AND (s.section_version_id IS NOT NULL OR s.scope='section')))) OR
 EXISTS(SELECT 1 FROM format_versions f LEFT JOIN variable_versions v ON v.id=f.owner_area_variable_version_id LEFT JOIN variable_schema_versions s ON s.id=v.schema_version_id WHERE f.template_version_id=owner_id AND
 ((f.owner_area_variable_version_id IS NOT NULL AND f.section_version_id IS DISTINCT FROM s.section_version_id) OR (modern AND f.owner_area_variable_version_id IS NULL AND f.section_version_id IS NULL) OR (NOT modern AND f.section_version_id IS NOT NULL)))
 THEN RAISE EXCEPTION 'Invalid section ownership' USING ERRCODE='23514'; END IF;
 RETURN NULL; END; $$;
 CREATE CONSTRAINT TRIGGER format_versions_section_owner AFTER INSERT OR UPDATE ON format_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_section_version_owner();
 CREATE CONSTRAINT TRIGGER variable_schema_versions_section_owner AFTER INSERT OR UPDATE ON variable_schema_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_section_version_owner();
CREATE TRIGGER immutable_section_version BEFORE UPDATE OR DELETE ON section_versions FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();

CREATE CONSTRAINT TRIGGER variables_section_owner AFTER INSERT OR UPDATE ON variables DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_section_current_owner();
CREATE CONSTRAINT TRIGGER template_current_section_owner AFTER INSERT OR UPDATE ON template_current DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_section_current_owner();

CREATE CONSTRAINT TRIGGER variable_versions_section_owner AFTER INSERT OR UPDATE ON variable_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_section_version_owner();
CREATE CONSTRAINT TRIGGER template_snapshots_section_owner AFTER INSERT OR UPDATE ON template_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_section_version_owner();
