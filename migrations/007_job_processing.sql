CREATE TABLE job_processing (
 job_id uuid PRIMARY KEY REFERENCES generation_jobs(id) ON DELETE CASCADE,
 stage text NOT NULL CHECK(stage IN ('preparing-resources','rendering','complete','failed')),
 completed integer NOT NULL DEFAULT 0 CHECK(completed>=0),
 total integer NOT NULL DEFAULT 0 CHECK(total>=completed),
 warnings_json jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(warnings_json)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
