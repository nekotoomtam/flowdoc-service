INSERT INTO variable_types(id,code,name) VALUES(110006,'area','พื้นที่โครงย่อย');
ALTER TABLE formats ADD COLUMN owner_area_variable_id uuid REFERENCES variables(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 ADD COLUMN source_definition_id text,
 ADD CONSTRAINT formats_area_pair CHECK ((owner_area_variable_id IS NULL)=(source_definition_id IS NULL)),
 ADD CONSTRAINT formats_area_source_nonempty CHECK (source_definition_id IS NULL OR length(btrim(source_definition_id))>0);
ALTER TABLE formats DROP CONSTRAINT formats_template_id_key_key;
CREATE UNIQUE INDEX formats_top_key ON formats(template_id,key) WHERE owner_area_variable_id IS NULL;
CREATE UNIQUE INDEX formats_area_key ON formats(owner_area_variable_id,key) WHERE owner_area_variable_id IS NOT NULL;
CREATE UNIQUE INDEX formats_source_id ON formats(template_id,source_definition_id) WHERE source_definition_id IS NOT NULL;
CREATE FUNCTION check_area_current_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM formats f LEFT JOIN variables v ON v.id=f.owner_area_variable_id
 LEFT JOIN variable_schemas s ON s.id=v.schema_id LEFT JOIN formats host ON host.id=s.format_id
 WHERE f.owner_area_variable_id IS NOT NULL AND
 ((TG_TABLE_NAME='formats' AND f.id=NEW.id) OR (TG_TABLE_NAME='variables' AND v.id=NEW.id) OR (TG_TABLE_NAME='variable_schemas' AND s.id=NEW.id))
 AND (v.id IS NULL OR v.type_id<>110006 OR s.template_id IS DISTINCT FROM f.template_id OR host.owner_area_variable_id IS NOT NULL))
 THEN RAISE EXCEPTION 'Invalid area ownership' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER formats_area_owner AFTER INSERT OR UPDATE ON formats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_area_current_owner();
CREATE CONSTRAINT TRIGGER variables_area_owner AFTER INSERT OR UPDATE ON variables DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_area_current_owner();
CREATE CONSTRAINT TRIGGER variable_schemas_area_owner AFTER INSERT OR UPDATE ON variable_schemas DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_area_current_owner();
ALTER TABLE format_versions ADD COLUMN owner_area_variable_version_id uuid REFERENCES variable_versions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 ADD COLUMN source_definition_id text,
 ADD CONSTRAINT format_versions_area_pair CHECK ((owner_area_variable_version_id IS NULL)=(source_definition_id IS NULL)),
 ADD CONSTRAINT format_versions_area_source_nonempty CHECK (source_definition_id IS NULL OR length(btrim(source_definition_id))>0);
ALTER TABLE format_versions DROP CONSTRAINT format_versions_template_version_id_key_key;
CREATE UNIQUE INDEX format_versions_top_key ON format_versions(template_version_id,key) WHERE owner_area_variable_version_id IS NULL;
CREATE UNIQUE INDEX format_versions_area_key ON format_versions(owner_area_variable_version_id,key) WHERE owner_area_variable_version_id IS NOT NULL;
CREATE UNIQUE INDEX format_versions_source_id ON format_versions(template_version_id,source_definition_id) WHERE source_definition_id IS NOT NULL;
CREATE FUNCTION check_area_version_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM format_versions f LEFT JOIN variable_versions v ON v.id=f.owner_area_variable_version_id
 LEFT JOIN variable_schema_versions s ON s.id=v.schema_version_id LEFT JOIN format_versions host ON host.id=s.format_version_id
 WHERE f.owner_area_variable_version_id IS NOT NULL AND
 ((TG_TABLE_NAME='format_versions' AND f.id=NEW.id) OR (TG_TABLE_NAME='variable_versions' AND v.id=NEW.id) OR (TG_TABLE_NAME='variable_schema_versions' AND s.id=NEW.id))
 AND (v.id IS NULL OR v.type_id<>110006 OR s.template_version_id IS DISTINCT FROM f.template_version_id OR host.owner_area_variable_version_id IS NOT NULL))
 THEN RAISE EXCEPTION 'Invalid area ownership' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER format_versions_area_owner AFTER INSERT OR UPDATE ON format_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_area_version_owner();
CREATE CONSTRAINT TRIGGER variable_versions_area_owner AFTER INSERT OR UPDATE ON variable_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_area_version_owner();
CREATE CONSTRAINT TRIGGER variable_schema_versions_area_owner AFTER INSERT OR UPDATE ON variable_schema_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_area_version_owner();
