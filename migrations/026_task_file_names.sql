-- Names are transport metadata. Storage keys and renderer/job pins stay unchanged.
ALTER TABLE tasks ADD COLUMN default_file_name text NOT NULL DEFAULT 'document',
 ADD COLUMN file_name text;
-- The backfill queues this deferred trigger even for nonterminal rows; drain it
-- before the following ALTER TABLE, then restore the normal deferred mode.
SET CONSTRAINTS task_terminal_facts IMMEDIATE;
UPDATE tasks SET file_name='document' WHERE sealed_at IS NOT NULL;
ALTER TABLE tasks ADD CONSTRAINT task_default_file_name_bound CHECK
 (char_length(default_file_name) BETWEEN 1 AND 200 AND octet_length(default_file_name)<=240),
 ADD CONSTRAINT task_file_name_bound CHECK
 (file_name IS NULL OR (char_length(file_name) BETWEEN 1 AND 200 AND octet_length(file_name)<=240)),
 ADD CONSTRAINT task_sealed_file_name CHECK ((sealed_at IS NULL)=(file_name IS NULL));
SET CONSTRAINTS task_terminal_facts DEFERRED;
CREATE FUNCTION protect_task_file_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.default_file_name IS DISTINCT FROM OLD.default_file_name OR
    (OLD.file_name IS NOT NULL AND NEW.file_name IS DISTINCT FROM OLD.file_name) THEN
  RAISE EXCEPTION 'Task output name is immutable' USING ERRCODE='55000';
 END IF;
 IF OLD.file_name IS NULL AND NEW.file_name IS NOT NULL AND
    NOT (OLD.status='receiving' AND NEW.status='validating' AND OLD.sealed_at IS NULL AND NEW.sealed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Task output name must be frozen at seal' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER task_file_name_guard BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION protect_task_file_name();
