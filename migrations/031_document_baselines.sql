CREATE TABLE document_baselines (
  owner_key text NOT NULL,
  principal_id text NOT NULL,
  template_id text NOT NULL,
  version integer NOT NULL,
  PRIMARY KEY (owner_key, principal_id, template_id),
  FOREIGN KEY (template_id, version) REFERENCES template_versions(template_id, version)
);
