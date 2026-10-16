-- Proposals are separate from drafts; confirmation uses authoring receipts.
CREATE TABLE font_height_adjustment_proposals (
 id uuid PRIMARY KEY,
 template_id text NOT NULL REFERENCES templates(id),
 principal text NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '15 minutes')
);
CREATE INDEX font_height_proposals_owner ON font_height_adjustment_proposals(template_id,principal);
