CREATE TABLE upload_job_claims (
 upload_id uuid PRIMARY KEY REFERENCES upload_sessions(id) ON DELETE CASCADE,
 job_id uuid NOT NULL UNIQUE REFERENCES generation_jobs(id) ON DELETE RESTRICT,
 resource_ids jsonb NOT NULL CHECK(jsonb_typeof(resource_ids)='array'),
 created_at timestamptz NOT NULL DEFAULT now()
);
