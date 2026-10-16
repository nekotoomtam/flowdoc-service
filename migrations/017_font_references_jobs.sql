-- Storage prerequisites only; lifecycle authorization/activation is a later phase.
ALTER TABLE font_releases DROP CONSTRAINT font_releases_state_check;
ALTER TABLE font_releases DROP CONSTRAINT font_releases_ever_activated_at_check;
ALTER TABLE font_releases ADD CHECK(state IN ('preparing','in_review','needs_changes','ready','active','retired'));
ALTER TABLE font_releases ADD CHECK(state NOT IN ('active','retired') OR ever_activated_at IS NOT NULL);
CREATE TABLE font_reference_sets (
 id uuid PRIMARY KEY,owner_kind text NOT NULL CHECK(owner_kind IN ('draft_revision','template_version')),
 template_id text NOT NULL REFERENCES templates(id),version_id uuid REFERENCES template_versions(id),
 revision integer,definition_fingerprint text NOT NULL CHECK(definition_fingerprint ~ '^[0-9a-f]{64}$'),
 legacy_bindings jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(legacy_bindings)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((owner_kind='draft_revision' AND revision>0 AND version_id IS NULL) OR
 (owner_kind='template_version' AND revision IS NULL AND version_id IS NOT NULL))
);
CREATE UNIQUE INDEX font_refs_draft ON font_reference_sets(template_id,revision) WHERE owner_kind='draft_revision';
CREATE UNIQUE INDEX font_refs_version ON font_reference_sets(version_id) WHERE owner_kind='template_version';
CREATE TABLE font_reference_bindings (
 reference_set_id uuid NOT NULL REFERENCES font_reference_sets(id),
 release_id uuid NOT NULL REFERENCES font_releases(id),weight integer NOT NULL CHECK(weight BETWEEN 1 AND 1000),
 style text NOT NULL CHECK(style IN ('normal','italic')),
 origin text NOT NULL CHECK(origin IN ('active_selection','inherited')),
 source_reference_set_id uuid REFERENCES font_reference_sets(id),source_binding_key text,
 PRIMARY KEY(reference_set_id,release_id,weight,style),
 CHECK((origin='active_selection' AND source_reference_set_id IS NULL AND source_binding_key IS NULL) OR
 (origin='inherited' AND source_reference_set_id IS NOT NULL AND source_binding_key IS NOT NULL))
);
CREATE TABLE job_font_snapshots (
 job_id uuid PRIMARY KEY REFERENCES generation_jobs(id),snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE job_font_assets (
 job_id uuid NOT NULL REFERENCES job_font_snapshots(job_id),asset_id uuid NOT NULL REFERENCES font_assets(id),
 PRIMARY KEY(job_id,asset_id)
);
CREATE TRIGGER font_refs_immutable BEFORE UPDATE OR DELETE ON font_reference_sets FOR EACH ROW EXECUTE FUNCTION protect_font_immutable();
CREATE TRIGGER font_bindings_immutable BEFORE UPDATE OR DELETE ON font_reference_bindings FOR EACH ROW EXECUTE FUNCTION protect_font_immutable();
CREATE TRIGGER job_fonts_immutable BEFORE UPDATE OR DELETE ON job_font_snapshots FOR EACH ROW EXECUTE FUNCTION protect_font_immutable();
CREATE TRIGGER job_font_assets_immutable BEFORE UPDATE OR DELETE ON job_font_assets FOR EACH ROW EXECUTE FUNCTION protect_font_immutable();
CREATE FUNCTION protect_activated_font() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='font_faces' THEN
  IF EXISTS(SELECT 1 FROM font_releases WHERE id=COALESCE(NEW.release_id,OLD.release_id) AND ever_activated_at IS NOT NULL)
   THEN RAISE EXCEPTION 'Activated font faces are immutable'; END IF;
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM font_releases WHERE id=OLD.release_id AND ever_activated_at IS NOT NULL)
   THEN RAISE EXCEPTION 'Activated font faces are immutable'; END IF;
 ELSE
  IF OLD.ever_activated_at IS NOT NULL AND (TG_OP='DELETE' OR
   (to_jsonb(NEW)-'state'-'revision'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'revision'-'updated_at'))
   THEN RAISE EXCEPTION 'Activated font content is immutable'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER activated_face_immutable BEFORE INSERT OR UPDATE OR DELETE ON font_faces FOR EACH ROW EXECUTE FUNCTION protect_activated_font();
CREATE TRIGGER activated_release_immutable BEFORE UPDATE OR DELETE ON font_releases FOR EACH ROW EXECUTE FUNCTION protect_activated_font();
