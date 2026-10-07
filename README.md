# FlowDoc Service

## Authority Boundary

Owner: flowdoc-service. This file describes local registry/database setup and
repository-owned operations. Shared scope and acceptance are governed by
`../flowdoc-project-control/docs/domains/flowdoc-export-mvp-r3-registry-plan-2026-10-07.md`.
Release `0.1.0-dev.1` supplies a registry CLI and DB foundation. HTTP routes,
render jobs and downloads are subsequent R4 work; this is not full MVP readiness.

## Isolated acceptance

Install Node24 dependencies with `npm ci --ignore-scripts`, then `npm run build`.
With Docker Desktop's Linux engine running, run:

```text
npm run check:database
```

The check builds the pinned runtime/verification images, starts a new PostgreSQL
volume on its own internal network, migrates, runs real SQL tests, registers the
example through the CLI and reloads records after restarting the same DB. It
publishes no ports and mounts no host source. The same runtime image is used
before/after restart. Core comes only from the checksum-verified vendored tarball.

Results/logs/image identities are under `artifacts/<run>/`. On success the DB
container is stopped; its volume/network and images are retained for inspection.
On failure the isolated environment and logs remain. `compose.env` in this ignored
directory holds a generated local DB password; do not share it with reports.
No script deletes an existing DB or volume. A fresh project is used on each run.

`npm test` runs CLI and database tests and requires DATABASE_URL to a dedicated,
fresh test DB after building. These tests create fixtures and temporarily alter
a constraint; do not point them at a user or shared database. The Docker check
provides that isolation automatically. Tests never silently skip a missing DB.

## Local registry commands

Copy `.env.example` to `.env` and replace its value with a random URL-safe local
password. Compose owns a named volume; do not use `down -v` if you want to retain
registered templates and jobs.

```text
docker compose build registry
docker compose up -d --wait db
docker compose run --rm registry migrate
docker compose run --rm registry register examples/srs-template.json
docker compose run --rm registry show srs-table-trial 1
docker compose run --rm registry show srs-table-trial
docker compose stop
```

The example is included in the image. To register another file, mount only its
input directory read-only, then pass the path inside the container. The registry
reads raw JSON text before parsing, so duplicate keys are rejected by Core rather
than silently overwritten. CLI results are JSON; failures use exit status 1 and
never print SQL errors/connection strings. `show` is a developer registry command
returning the full validated definition, not the future public contract API.

Registration is atomic: a failure leaves no partial version or new parent.
Service versions are integers from 1 to 2147483647, matching the database column;
registration and lookup reject out-of-range values before accessing storage.
Repeating identical content at the same version returns `created:false` and its
existing ID; changed content at that version returns TEMPLATE_VERSION_CONFLICT.
Changing the templateId/docKey pairing returns TEMPLATE_IDENTITY_CONFLICT.
Adding a new version leaves existing versions untouched. Omitted version in
`show` selects the highest registered version once. A later job must store the
returned versionId, never select latest again when it runs.

## Database and migration boundaries

The four domain tables are templates, template_versions, generation_jobs and
document_outputs. schema_migrations is checksum/ordering metadata. Foreign keys,
version/output uniqueness and immutable template/job identities are enforced in
SQL, alongside basic JSON/status/type checks. Full template/data semantics stay
in Core. Job/output tables prepare R4 storage; no worker or state transition API
is implemented yet, and metadata alone does not prove a PDF file exists.

Migrations run in one transaction under an advisory lock. Re-running unchanged
files is safe; changed/unknown applied migration history is rejected. Schema 001
is the only compatible schema in this release. Do not edit an applied migration
after release. There is no automatic down migration or rollback of persisted data.

Pinned PostgreSQL18 stores data at `/var/lib/postgresql` in the official image.
Keep the volume when stopping/restarting; migration replay does not rebuild data.
Template versions cannot be updated/deleted through ordinary SQL; Core revalidates
stored definitions/fingerprints on load. These constraints are not a defense
against an administrator intentionally disabling triggers or changing the DB.

## Artifact boundary

Core `0.1.0-dev.4` is in `vendor/`, with its version/hash/source in manifest.json.
Run `node scripts/verifyVendor.mjs` to check it. `package-lock.json` also pins its
tarball integrity and all npm dependencies. Updating Core requires replacing the
artifact/manifest/dependency lock together and rerunning affected acceptance.
Native/fonts/Python helpers remain owned by that package; do not copy its source.
Runtime image includes Node24, Python3.11/fontTools4.58.2 and packaged resources,
but R3 itself proves registry/database behavior, not an HTTP-to-PDF release.
