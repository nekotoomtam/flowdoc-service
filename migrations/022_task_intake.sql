-- Task foundation only. No task generation/public endpoint is enabled by this migration.
CREATE TABLE tasks (
 id uuid PRIMARY KEY DEFAULT uuidv7(), owner_key text NOT NULL CHECK(octet_length(owner_key) BETWEEN 1 AND 200),
 created_by_principal text NOT NULL CHECK(octet_length(created_by_principal) BETWEEN 1 AND 200),
 client_actor_ref text, external_reference text, billing_subject_key text,
 request_kind text NOT NULL DEFAULT 'export' CHECK(request_kind IN ('export','authoring_preview')),
 template_version_id uuid NOT NULL REFERENCES template_versions(id) ON DELETE RESTRICT,
 template_pin jsonb NOT NULL CHECK(jsonb_typeof(template_pin)='object'),
 contract_version text NOT NULL DEFAULT 'task-v1' CHECK(contract_version='task-v1'),
 resource_policy jsonb NOT NULL CHECK(jsonb_typeof(resource_policy)='object' AND octet_length(resource_policy::text)<8192),
 status text NOT NULL DEFAULT 'awaiting_input' CHECK(status IN ('awaiting_input','receiving','validating','queued','processing','sending','succeeded','failed','expired')),
 state_version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '3 hours'), terminal_at timestamptz,
 receive_started_at timestamptz, sealed_at timestamptz, input_digest text,
 request_bytes bigint CHECK(request_bytes>=0),
 lease_token uuid, lease_expires_at timestamptz, writer_pid integer, writer_host text,
 terminal_reason text, cleanup_status text NOT NULL DEFAULT 'not_due' CHECK(cleanup_status IN ('not_due','pending','running','done','retry_needed')),
 cleanup_completed_at timestamptz, stop_requested_at timestamptz,
 CHECK(expires_at=created_at+interval '3 hours'),
 CHECK((status IN ('succeeded','failed','expired'))=(terminal_at IS NOT NULL)),
 CHECK(client_actor_ref IS NULL OR octet_length(client_actor_ref) BETWEEN 1 AND 200),
 CHECK(external_reference IS NULL OR octet_length(external_reference) BETWEEN 1 AND 200)
);
CREATE INDEX tasks_owner_history ON tasks(owner_key,created_at,id);
CREATE INDEX tasks_expiry ON tasks(expires_at,id) WHERE status NOT IN ('succeeded','failed','expired');
CREATE INDEX tasks_cleanup ON tasks(expires_at,id) WHERE cleanup_status<>'done';
CREATE TABLE task_resource_reservations (
 task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
 storage_held_bytes bigint NOT NULL CHECK(storage_held_bytes>=0),
 storage_used_bytes bigint NOT NULL DEFAULT 0 CHECK(storage_used_bytes>=0 AND storage_used_bytes<=storage_held_bytes),
 queue_slot_held boolean NOT NULL DEFAULT true, policy_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz
);
CREATE TABLE task_files (
 id uuid PRIMARY KEY DEFAULT uuidv7(), task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
 role text NOT NULL CHECK(role IN ('payload','original_image','normalized','prepared_image')),
 section_id text, asset_key text, logical_path text NOT NULL CHECK(octet_length(logical_path)<=2048),
 part_order integer NOT NULL CHECK(part_order>=0), media_type text NOT NULL,
 expected_bytes bigint CHECK(expected_bytes>=0), received_bytes bigint NOT NULL DEFAULT 0 CHECK(received_bytes>=0),
 stored_bytes bigint NOT NULL DEFAULT 0 CHECK(stored_bytes>=0), checksum text,
 storage_key text, state text NOT NULL CHECK(state IN ('receiving','received','omitted','deleted')),
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, deleted_at timestamptz,
 UNIQUE(task_id,part_order), CHECK(storage_key IS NULL OR storage_key ~ '^[0-9a-f-]{36}/input/[0-9a-f-]{36}\.bin(\.part)?$')
);
CREATE INDEX task_files_inventory ON task_files(task_id,role,part_order,id);
CREATE TABLE task_events (
 id uuid PRIMARY KEY DEFAULT uuidv7(), task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
 sequence bigint NOT NULL CHECK(sequence>0), event_key text NOT NULL, event_type text NOT NULL,
 previous_state text, new_state text, actor text NOT NULL, reason text,
 detail jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(detail)='object' AND octet_length(detail::text)<=32768),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,sequence),UNIQUE(task_id,event_key)
);
CREATE TABLE task_usage (
 task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT, revision integer NOT NULL CHECK(revision>0),
 measurement_version integer NOT NULL DEFAULT 1, facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='object' AND octet_length(facts::text)<=32768),
 supersedes_revision integer, correction_reason text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(task_id,revision),
 CHECK((revision=1 AND supersedes_revision IS NULL AND correction_reason IS NULL) OR (revision>1 AND supersedes_revision<revision AND correction_reason IS NOT NULL))
);
ALTER TABLE generation_jobs ADD COLUMN task_id uuid UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT;
-- Task-backed prepared-input/processor support belongs to Stage 4, not placeholder JSON.
ALTER TABLE generation_jobs ADD CONSTRAINT task_job_stage4_gate CHECK(task_id IS NULL);
CREATE FUNCTION guard_task_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Task history is retained' USING ERRCODE='55000'; END IF;
 IF (NEW.id,NEW.owner_key,NEW.created_by_principal,NEW.billing_subject_key,NEW.request_kind,NEW.created_at,NEW.expires_at,NEW.template_version_id,NEW.template_pin,NEW.contract_version,NEW.resource_policy)
 IS DISTINCT FROM (OLD.id,OLD.owner_key,OLD.created_by_principal,OLD.billing_subject_key,OLD.request_kind,OLD.created_at,OLD.expires_at,OLD.template_version_id,OLD.template_pin,OLD.contract_version,OLD.resource_policy)
 OR (OLD.sealed_at IS NOT NULL AND (NEW.client_actor_ref,NEW.external_reference,NEW.sealed_at,NEW.input_digest) IS DISTINCT FROM (OLD.client_actor_ref,OLD.external_reference,OLD.sealed_at,OLD.input_digest))
 OR (OLD.status IN ('failed','expired','succeeded') AND (NEW.status,NEW.terminal_at,NEW.terminal_reason) IS DISTINCT FROM (OLD.status,OLD.terminal_at,OLD.terminal_reason)) THEN
 RAISE EXCEPTION 'Task pin or terminal outcome is immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER task_identity_guard BEFORE UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION guard_task_identity();
CREATE TRIGGER task_events_immutable BEFORE UPDATE OR DELETE ON task_events FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();
CREATE TRIGGER task_usage_immutable BEFORE UPDATE OR DELETE ON task_usage FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();
CREATE FUNCTION check_task_terminal_facts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN ('failed','expired','succeeded') AND NOT EXISTS(SELECT 1 FROM task_usage WHERE task_id=NEW.id AND revision=1) THEN
 RAISE EXCEPTION 'Terminal task requires usage facts' USING ERRCODE='23514'; END IF; RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER task_terminal_facts AFTER UPDATE ON tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_task_terminal_facts();
