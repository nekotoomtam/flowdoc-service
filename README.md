# FlowDoc Service

## Authority Boundary

Owner: flowdoc-service. Repository-owned commands, storage and local operation.
Shared scope: ../flowdoc-project-control/docs/domains/flowdoc-export-mvp-r4-api-plan-2026-10-08.md.
Version 0.1.0-dev.3 adds a local HTTP API, serial export processor and temporary PDF lifecycle.
UI, permissions, media and production scaling remain out of scope.

## Local setup and acceptance

Install dependencies with `npm ci --ignore-scripts`; build with `npm run build`.
With Docker Desktop's Linux engine ready, run `npm run check:database`.
It uses a fresh isolated PostgreSQL18 volume/internal network, pinned images and
Core dev.4 tarball, without published DB ports or host source mounts. It verifies
fresh migration, populated R3 upgrade/rollback, constraints, publication concurrency,
CLI editing, source-versus-snapshot PDF equality and restart persistence.
Results are in `artifacts/<run>/result.json`. Success stops the environment but
retains its volume/network/images. Failures leave inspection data. Generated
`compose.env` contains a local password; never distribute it with reports.
`npm test` requires a fresh dedicated DATABASE_URL after build. Tests create
fixtures/isolated schemas and temporarily alter constraints; never use shared data.

For a persistent local registry, copy .env.example to .env and choose a random
URL-safe password. Run:

```text
docker compose build registry
docker compose up -d --wait db
docker compose run --rm registry migrate
docker compose run --rm registry draft-import examples/srs-template.json
docker compose run --rm registry draft-show tpl-srs-table-trial
docker compose run --rm registry publish tpl-srs-table-trial first-publication
docker compose run --rm registry show srs-table-trial 1
docker compose stop
```

CLI returns a Result JSON envelope. To edit, save the `value` returned by
`draft-show` as a JSON file, retain its IDs and revision, edit payload/variables,
then invoke `draft-save <file>`. Mount only the input folder read-only into the
container when supplying a host file. Save returns the new revision; reload
before editing again. A stale revision is rejected. Import creates current once;
repeat import reports CURRENT_EXISTS so it cannot accidentally replace IDs.
Raw template import/registration use Core duplicate-key-aware validation.
ID-bearing draft-save currently uses JSON.parse; provide a serialized record
with unique JSON keys, rather than hand-authored duplicate-key input.

Changing a variable key keeps its ID. The existing Core key/path references in
fragments must also be updated by the author. Save allows unresolved content
refs; publish rejects them. Delete owned child rows from the record together:
removing a format also requires removing its schema/variables, and removing a
parent requires removing its children. No hidden text/reference cleanup occurs.
The SQL ownership FKs cascade, but draft-save does not infer missing rows for you.
New child entries require distinct UUID IDs; imported children/publication IDs
are allocated as v7 by DB. Existing IDs cannot move between owner schemas/kinds.

Publication takes an explicit request ID. Retrying the same template/request ID
returns the original version even after current changes. Use a new request ID for
an intentional new publication. The request token is scoped to the template.
A template lock serializes supported saves/publications/registration; callers
must not bypass these operations with arbitrary SQL edits during publication.
Examples are rebound to the selected publication version when assembling the
Core envelope. Master codes remain string/object/array; object is only an envelope
or array item under Core's existing limits, not arbitrary nested-field support.

## Data and compatibility

Master variable_types uses numeric IDs 110001=string, 110002=object, 110003=array.
Current formats/schemas/variables are separately addressable. Each variable's
schema/parent scopes its key. Snapshot tables contain new IDs and owned JSONB
payloads. Snapshot relationships point to snapshot rows; master IDs stay the same.
Every table has created_at; editable current records have updated_at. No user IDs.

Migration 002 leaves original template/version IDs, stored definitions/fingerprints
and job pins unchanged. Legacy text template IDs remain compatible; they are not
silently converted to UUID. New child and newly registered/published version IDs
use v7. Historical source child identities did not exist: legacy imported/backfilled
snapshots have NULL source_* IDs. Real current publication records source IDs,
which remain provenance after current deletion and are not FK dependencies.

The original full definition_json is an immutable compatibility witness, not a
second editable template. Load validates it, assembles the snapshot rows and checks
the assembled fingerprint. Historical snapshots never load current content.
Migrations are checksummed and transactional with an advisory lock. Migration
002's application backfill runs within that transaction. Use the matching release
CLI to migrate, not an SQL file alone. Do not edit migrations after applying them
outside isolated development tests. Never reset existing DBs to make tests pass.

Legacy `register <raw-template.json>` retains explicit-version registration;
it atomically writes snapshot rows too. It initializes current only if absent,
and never replaces an edited current draft. `show <docKey> [version]` selects an
exact version or latest once. Jobs must retain the returned versionId.
No hard-delete command is exposed. Version rows cannot be updated/deleted through
ordinary operations; admins disabling triggers are outside this guarantee.

## Package boundary

Core dev.4 is installed solely from vendor/flowdoc-core-0.1.0-dev.4.tgz. Its SHA256
and source are in vendor/manifest.json; `node scripts/verifyVendor.mjs` verifies it.
The lockfile pins dependencies. Linux runtime includes Node24, Python3.11/fontTools
and the Core-owned resources. Do not copy or fork Core validation/rendering logic.


## Local export API

After migration and template publication/registration above, run `docker compose
up -d api`. It listens at http://127.0.0.1:3000 (override FLOWDOC_API_PORT).
No authentication is implemented in this localhost MVP; do not expose it publicly.

- GET /health: readiness.
- GET /templates/:docKey/contract?version=1: schemas and request examples.
- POST /jobs: send examples/srs-request.json; returns 202 and jobId.
- GET /jobs/:jobId: queued/running/succeeded/failed, warnings and available download URL.
- GET /jobs/:jobId/pdf: PDF; 409 if not successful, 410 after consumption/expiry.

Omitted request version selects latest once at admission; jobs keep that immutable
version. Validation errors do not create jobs. Jobs render serially in a child
process. One coordinator is supported; another fails startup. After interruption,
queued jobs continue and running jobs fail with PROCESS_INTERRUPTED; resubmit them.

`npm run check:api` builds an isolated deployment, exports three real PDFs, checks
consumption and restart recovery, and stops its containers. `check:database` runs
the full regression suite. Reports/PDFs remain in ignored artifacts directories.
These reports do not prove large-load capacity or full MVP acceptance.

### Output lifetime

Set these in .env for Compose; recreate api after changing configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| EXPORT_RETAIN_FILES | false | Delete output after successful HTTP transfer |
| EXPORT_FILE_TTL_HOURS | 24 | Retained output lifetime when retention is true |
| EXPORT_TEMP_FILE_TTL_HOURS | 24 | Unclaimed/default outputs and stale orphan lifetime |

Lifetimes are positive numbers up to 8760 hours, measured from output creation.
Policy is saved per output; changes apply to new outputs. Retained results permit
repeat downloads until expiry. Aborted transfers permit retry until expiry.
HTTP completion cannot prove that the client saved the file. Concurrent streams
already open can finish; no new streams start after retirement. Cleanup runs at
startup and every minute, excludes active streams and retries failed deletion.
Consumed/expired jobs stay succeeded, but no longer advertise a download URL.
The named output volume preserves pending results across restart, not permanently.

Direct server environment also supports EXPORT_OUTPUT_DIR (output), EXPORT_TEMP_DIR
(temp), EXPORT_BODY_LIMIT_BYTES (2097152), EXPORT_RENDER_TIMEOUT_MS (120000),
EXPORT_MAX_PDF_BYTES (52428800), HOST and PORT. Bounds reject oversized requests
or fail over-budget renders; they are not a large-document capacity guarantee.
The current renderer/runtime requires packaged Linux x64 dependencies.
