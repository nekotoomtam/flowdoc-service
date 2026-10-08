ALTER TABLE document_outputs ADD COLUMN retain boolean NOT NULL DEFAULT false;
ALTER TABLE document_outputs ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now()+interval '24 hours');
ALTER TABLE document_outputs ADD COLUMN availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','consumed','expired'));
ALTER TABLE document_outputs ADD COLUMN deleted_at timestamptz;
CREATE INDEX document_outputs_cleanup ON document_outputs(expires_at) WHERE deleted_at IS NULL;
