ALTER TABLE font_families DROP CONSTRAINT font_families_default_release_id_check;
ALTER TABLE font_releases ADD COLUMN deleted_at timestamptz;
ALTER TABLE font_faces ADD COLUMN conflict_resolution jsonb;
CREATE TABLE font_reviews (
 id uuid PRIMARY KEY, release_id uuid NOT NULL REFERENCES font_releases(id),
 purpose text NOT NULL DEFAULT 'font-review' CHECK(purpose='font-review'),
 mode text NOT NULL CHECK(mode IN ('initial','reactivation')),
 status text NOT NULL CHECK(status IN ('pending','running','succeeded','failed','approved','withdrawn')),
 manifest_digest text NOT NULL, snapshot jsonb NOT NULL, renderer jsonb NOT NULL, suite_digest text NOT NULL,
 report jsonb, report_digest text, approved_by text, approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX font_review_open ON font_reviews(release_id) WHERE status IN ('pending','running','succeeded','approved');
CREATE FUNCTION check_font_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.default_release_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM font_releases WHERE id=NEW.default_release_id AND family_id=NEW.id AND state='active' AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Font default requires an active same-family release'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER font_default_guard BEFORE INSERT OR UPDATE ON font_families FOR EACH ROW EXECUTE FUNCTION check_font_default();
CREATE FUNCTION check_font_default_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state<>'active' AND EXISTS(SELECT 1 FROM font_families WHERE default_release_id=NEW.id) THEN RAISE EXCEPTION 'Font default must be replaced or cleared before retirement'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER font_default_retirement_guard BEFORE UPDATE ON font_releases FOR EACH ROW EXECUTE FUNCTION check_font_default_retirement();
ALTER TABLE font_releases DROP CONSTRAINT font_releases_family_id_manifest_digest_key;
CREATE UNIQUE INDEX font_release_live_manifest ON font_releases(family_id,manifest_digest) WHERE deleted_at IS NULL;
