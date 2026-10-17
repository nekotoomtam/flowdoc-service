-- Derived records never modify a released font manifest or its immutable assets.
CREATE TABLE font_height_profiles (
 id uuid PRIMARY KEY, release_id uuid NOT NULL REFERENCES font_releases(id),
 release_manifest_digest text NOT NULL CHECK(release_manifest_digest ~ '^[0-9a-f]{64}$'),
 -- Historical face identity survives preparing-release edits that replace face rows.
 regular_face_id uuid,
 asset_id uuid REFERENCES font_assets(id), sha256 text CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 method_id text NOT NULL CHECK(method_id='thai-bo-baseline-top-v1'), tool_version text NOT NULL,
 reference_code_point integer NOT NULL CHECK(reference_code_point=3610),
 units_per_em integer CHECK(units_per_em BETWEEN 16 AND 16384),
 baseline_design text NOT NULL CHECK(baseline_design='0'), top_design text,
 outcome text NOT NULL CHECK(outcome IN ('measured','unavailable')), reason text,
 schema_version integer NOT NULL CHECK(schema_version=1),
 reference_id text CHECK(reference_id IS NULL OR (reference_id='th-sarabun-new-1.35-regular'
  AND sha256 IS NOT NULL AND sha256='b248f824f3d7a8576bc396826a4d898070c1420564f6ce6aa716aa8ad24f824a')),
 profile_digest text NOT NULL UNIQUE CHECK(profile_digest ~ '^[0-9a-f]{64}$'),
 measured_at timestamptz NOT NULL DEFAULT now(),
 CHECK((outcome='measured' AND reason IS NULL AND regular_face_id IS NOT NULL AND asset_id IS NOT NULL
   AND sha256 IS NOT NULL AND units_per_em IS NOT NULL AND top_design IS NOT NULL AND top_design ~ '^[0-9]+(\.[0-9]+)?$'
   AND top_design::numeric>0) OR (outcome='unavailable' AND reason IS NOT NULL AND top_design IS NULL))
);
CREATE INDEX font_height_release ON font_height_profiles(release_id,method_id);
CREATE TABLE font_height_profile_reviews (
 id uuid PRIMARY KEY, profile_id uuid NOT NULL REFERENCES font_height_profiles(id),
 profile_digest text NOT NULL, decision text NOT NULL CHECK(decision IN ('approved','revoked')),
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 reviewer text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE font_height_profile_assignments (
 release_id uuid NOT NULL REFERENCES font_releases(id), method_id text NOT NULL,
 profile_id uuid NOT NULL REFERENCES font_height_profiles(id),
 profile_digest text NOT NULL, revision integer NOT NULL CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(release_id,method_id)
);
CREATE TRIGGER font_height_immutable BEFORE UPDATE OR DELETE ON font_height_profiles
 FOR EACH ROW EXECUTE FUNCTION protect_font_immutable();
CREATE TRIGGER font_height_review_immutable BEFORE UPDATE OR DELETE ON font_height_profile_reviews
 FOR EACH ROW EXECUTE FUNCTION protect_font_immutable();
