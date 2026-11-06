-- Stable storage identity plus immutable origin runtime for guarded task recovery.
-- Historical unguarded rows stay NULL; they are not silently adopted.
ALTER TABLE tasks ADD COLUMN runtime_owner_id uuid, ADD COLUMN storage_identity uuid;
ALTER TABLE tasks ADD CONSTRAINT task_runtime_identity_pair
 CHECK ((runtime_owner_id IS NULL)=(storage_identity IS NULL));
CREATE FUNCTION protect_task_runtime_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.runtime_owner_id,NEW.storage_identity) IS DISTINCT FROM (OLD.runtime_owner_id,OLD.storage_identity) THEN
  RAISE EXCEPTION 'Task runtime origin is immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER task_runtime_identity_guard BEFORE UPDATE ON tasks
 FOR EACH ROW EXECUTE FUNCTION protect_task_runtime_identity();
