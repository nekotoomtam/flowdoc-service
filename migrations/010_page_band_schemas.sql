ALTER TABLE variable_schemas ADD COLUMN scope text;
UPDATE variable_schemas SET scope=CASE WHEN format_id IS NULL THEN 'global' ELSE 'format' END;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE variable_schemas ALTER COLUMN scope SET NOT NULL;
ALTER TABLE variable_schemas ADD CONSTRAINT variable_schemas_scope_check CHECK ((scope='format' AND format_id IS NOT NULL) OR (scope IN ('global','header','footer') AND format_id IS NULL));
ALTER TABLE variable_schema_versions ADD COLUMN scope text;
ALTER TABLE variable_schema_versions DISABLE TRIGGER immutable_schema_version;
UPDATE variable_schema_versions SET scope=CASE WHEN format_version_id IS NULL THEN 'global' ELSE 'format' END;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE variable_schema_versions ENABLE TRIGGER immutable_schema_version;
ALTER TABLE variable_schema_versions ALTER COLUMN scope SET NOT NULL;
ALTER TABLE variable_schema_versions ADD CONSTRAINT variable_schema_versions_scope_check CHECK ((scope='format' AND format_version_id IS NOT NULL) OR (scope IN ('global','header','footer') AND format_version_id IS NULL));
-- Resolve old owner-uniqueness by its columns rather than PostgreSQL's truncated name.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conrelid::regclass AS tbl,conname FROM pg_constraint WHERE contype='u' AND conrelid IN ('variable_schemas'::regclass,'variable_schema_versions'::regclass) AND cardinality(conkey)=2 AND pg_get_constraintdef(oid) IN ('UNIQUE NULLS NOT DISTINCT (template_id, format_id)','UNIQUE NULLS NOT DISTINCT (template_version_id, format_version_id)') LOOP
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.tbl,c.conname);
 END LOOP;
END $$;
ALTER TABLE variable_schemas ADD CONSTRAINT variable_schemas_owner_unique UNIQUE NULLS NOT DISTINCT(template_id,scope,format_id);
ALTER TABLE variable_schema_versions ADD CONSTRAINT variable_schema_versions_owner_unique UNIQUE NULLS NOT DISTINCT(template_version_id,scope,format_version_id);
