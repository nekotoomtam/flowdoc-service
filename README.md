# FlowDoc Service

Development candidate `0.4.2-dev.2` supports model19 Section instance authoring
beside unchanged model18. `POST /authoring/drafts/:id/sections` creates an empty
authored Section; `POST /authoring/drafts/:id/sections/import` copies saved source
Sections into an owned target with new public/normalized IDs. Import accepts
an empty revision0 target, checks both revisions/owners, remaps owned resources
and references, and writes once atomically with an idempotent receipt.
Whole model19 draft clones also return `sectionIdMap`; model18 clones retain
legacy semantics. Generation input is an ID-addressed array for model19 only.
Migration021 extends ownership checks without rewriting existing records.
MCP tools expose the same operations. The contract reports Stage2 with
`coverArea:true`, `scopedToc:false`. Packaged Core supports fixed-height text in
top-level Area Formats; Section controls page/bands and overflow fails at preview.
Cell/repeat frames and nested Areas remain prohibited. No automatic conversion,
live draft edit, deployment or release is implied. Shared authority remains the
Project Control Section–Area contract; this paragraph covers this repository.

## Authority Boundary

Owner: flowdoc-service. Repository-owned commands, storage and local operation.
Shared scope: ../flowdoc-project-control/docs/domains/flowdoc-export-mvp-r4-api-plan-2026-10-08.md.
Package version: 0.4.2-dev.2. Its release identity is the matching annotated tag on the
snapshot branch; a package version alone does not establish release acceptance.
This development candidate pins Core 0.4.2-dev.2 for its opt-in pure
font-height calculation API and revision-bound proposal/confirmation endpoints.
It is untagged and not an installed Service release.
The local HTTP API includes a serial export processor,
temporary PDF lifecycle and JPEG/PNG resource preparation. Release/tag promotion
is separate. Font administration uses the CLI and scoped administrator permission;
an administrator UI and production scaling remain outside this slice.

Start with the Thai [usage guide](docs/usage.md): first PDF, draft publication,
API requests, uploads, Area examples, font administration/readiness and backup/upgrade.
It describes candidate 0.4.2-dev.2; shared release status remains in Project Control.

## Local setup and acceptance

Install dependencies with `npm ci --ignore-scripts`; build with `npm run build`.
With Docker Desktop's Linux engine ready, run `npm run check:database`.
It uses a fresh isolated PostgreSQL18 volume/internal network, pinned images and
the manifest-pinned Core tarball, without published DB ports or host source mounts. It verifies
fresh migration, populated R3 upgrade/rollback, constraints, publication concurrency,
CLI editing, source-versus-snapshot PDF equality and restart persistence.
Results are in `artifacts/<run>/result.json`. Success stops the environment but
retains its volume/network/images. Failures leave inspection data. Generated
`compose.env` contains a local password; never distribute it with reports.
`npm test` requires a fresh dedicated DATABASE_URL after build. Tests create
fixtures/isolated schemas and temporarily alter constraints; never use shared data.

For a persistent local registry, copy .env.example to .env and choose a random
URL-safe password. Set `FLOWDOC_REGISTRY_IMAGE=flowdoc-service:0.4.2-dev.2` explicitly
to identify the image built from this candidate; verify its image ID separately.
Apply migrations through 021 before
starting this package. For fonts/authoring, add the environment override in the
usage guide; base Compose does not pass those secrets to the API. Run:

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
ID-bearing draft-save also uses duplicate-key-aware parsing. Preserve unique
decoded JSON keys in raw template, draft and HTTP request input.

## Font-aware draft and job candidate

This candidate vendors Core 0.4.2-dev.2 with its verified checksum in `vendor/manifest.json`.
Schema 1 retains the four verified Sarabun hashes. Schema 2 uses exact library
release/weight/style references. Save/get/validate return `fontReadiness` separately
from the saved revision: `ready`, `blocked` or `incomplete`, with `checkedScope`
of `styles` or `actual_input`. A saved draft may remain blocked; malformed font
grammar, ownership, revision and idempotency errors still reject the operation.
`POST /authoring/drafts/:id/clone` accepts sourceRevision, name, docKey and
idempotencyKey; retained font rights come from server-held revision provenance.

Admission checks actual composed characters through a temporary Core font specimen;
authored pagination remains the worker's responsibility. Jobs persist immutable
definition/input/renderer/font/license identities in the admission transaction.
Workers use those exact hashes even after retirement and check file bytes again.
An identical upload/preview retry returns its original job. Font failures cross
the child boundary as bounded codes without server paths. Font assets are read
from `FONT_STORAGE_DIR` (default `staging/fonts`); API and worker must share this
directory. Automatic fallback remains disabled; defaults never rewrite document references.

Run `npm run build` and `node scripts/checkFontLifecycle.mjs` for isolated DB/container
checks, queue persistence across DB restart and legacy rendering fixtures. Optional
`FONT_FIXTURE_DIR` points to the supplied IBM_Plex_Sans_Thai/Pridi/Sarabun folder.
Results and local test credentials are separate under `artifacts/<run>`; share only
the result/PDF files. Shared stage acceptance remains in Project Control.

The administrator HTTP candidate requires migrations through 018 and both
`FONT_ADMIN_TOKEN` (32–512 characters) and `FONT_ADMIN_PRINCIPAL`. Without them
admin routes stay disabled; a partial configuration or a token equal to
`AUTHORING_TOKEN` rejects startup. The authoring token receives 403 on admin
routes. Actor identity comes from configuration, never request JSON.

Under `/admin/fonts`, create families/imports/releases (201), stream each declared
TTF/license via PUT imports/:id/files/:clientKey, then inspect. Mutations use
requestId/reason and expectedRevision of the release; family default uses its own
revision. Full candidate PATCH permits preparing/needs_changes only. An optional
face conflictResolution contains reason/sourceWeight/approvedWeight; Service
records the reviewer while preserving immutable source metadata.

Submit-review requires a resolved normal 400 and the current manifestDigest.
Run/approve requests carry that digest and the parent release revision. Every
face produces a real Thai/English specimen according to languageScope, with
original hash/license checks and pinned renderer/test-suite identities. Read the
report and its authenticated `/reviews/:id/artifacts/:hash` PDFs; approve with
reportDigest and all artifactHashes only after visual/source/license review.
Rendering alone leaves in_review. Approval makes ready; explicit activate makes
active. Any withdrawal/edit invalidates the previous result. Review preview uses
`/reviews/:id/previews` with purpose=font-review, reviewId and manifestDigest;
ordinary authoring previews cannot render preparing/in_review/ready releases.

Set family defaults explicitly to an active same-family release or null. Retiring
a current default requires expectedFamilyRevision and exactly one replacement
release or clearDefault=true in the same transaction. Existing references/jobs
retain their original font. Reactivation keeps retired eligibility during a new
review of the immutable original set. Activated members remain immutable forever.
Deletion tombstones only never-active preparing releases without review/reference
history; it preserves audit, shared files and version reservation. Admin reads
include bounded review/audit summaries. The font administrator CLI is `node dist/fonts/cli.js <command> --request <json-file>`.
Set FONT_ADMIN_BASE_URL and FONT_ADMIN_TOKEN in the operator environment; never
put tokens in arguments. Commands: import, import-inspect, family-create,
release-stage, release-edit, review-submit, review-withdraw, review-run,
review-approve, activate, retire, reactivation-review, default-set, release-delete,
show. Use id for the action target; show also needs entity=release/import/review.
Import uses files/licenseFiles entries {clientKey,path}; the client computes
actual length/hash, streams bytes, and returns the intake receipt. Source evidence
remains explicit. Inspect separately, then bind returned asset/evidence IDs.
A retry after inspection returns the original import identity; show reads current
state. Other action fields follow the administrator HTTP contract above.

The authenticated authoring catalog GET /authoring/fonts accepts cursor, limit
(1–100) and familyId. It returns active releases, exact available faces and
nextCursor. Defaults never rewrite document selections. The authoring MCP adds
get_font_catalog, get_draft_font_readiness and clone_template_draft only; it
contains no administrator commands. POST /authoring/drafts/:id/font-readiness
accepts expectedRevision and optional sampleRequest, resolves the owned saved
revision and server-held retained rights, and returns readiness separately.
Run `node scripts/checkFontTools.mjs` with FLOWDOCMAKE_PROJECT_ROOT pointing at
the candidate Project Control checkout for real CLI/API/installed-candidate MCP,
PDF and isolated database checks. The same operator review/approval requirement
applies. No Editor UI or deployment is established by this local candidate.


Changing a variable key keeps its ID. The existing Core key/path references in
fragments must also be updated by the author. Save allows unresolved content
refs; publish rejects them. Delete owned child rows from the record together:
removing a format also requires removing its schema/variables, and removing a
parent requires removing its children. No hidden text/reference cleanup occurs.
The SQL ownership FKs cascade. Area removal additionally prunes its owned
subformats, schemas, variables and placement; this is not generic reference cleanup.
New child entries require distinct UUID IDs; imported children/publication IDs
are allocated as v7 by DB. Existing IDs cannot move between owner schemas/kinds.

Publication takes an explicit request ID. Retrying the same template/request ID
returns the original version even after current changes. Use a new request ID for
an intentional new publication. The request token is scoped to the template.
A template lock serializes supported saves/publications/registration; callers
must not bypass these operations with arbitrary SQL edits during publication.
Examples are rebound to the selected publication version when assembling the
Core envelope. Master codes are string/object/array/image/link/area; object is only an envelope
or array item under Core's existing limits, not arbitrary nested-field support.

## Data and compatibility

Master variable_types uses numeric IDs 110001=string, 110002=object, 110003=array,
110004=image, 110005=link and 110006=area.
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
002/009 application backfill runs after pending migrations within that transaction. Use the matching release
CLI to migrate, not an SQL file alone. Do not edit migrations after applying them
outside isolated development tests. Never reset existing DBs to make tests pass.

Legacy `register <raw-template.json>` retains explicit-version registration;
it atomically writes snapshot rows too. It initializes current only if absent,
and never replaces an edited current draft. `show <docKey> [version]` selects an
exact version or latest once. Jobs must retain the returned versionId.
No hard-delete command is exposed. Version rows cannot be updated/deleted through
ordinary operations; admins disabling triggers are outside this guarantee.

## Package boundary

Core 0.4.2-dev.2 is installed solely from `vendor/flowdoc-core-0.4.2-dev.2.tgz`.
Its SHA256 and source commit are pinned in `vendor/manifest.json`;
`node scripts/verifyVendor.mjs` verifies the checksum. The package supports only Area model 18.
The lockfile pins dependencies. Linux runtime includes Node24, Python3.11/fontTools
and the Core-owned resources. Do not copy or fork Core validation/rendering logic.

## Release branches

Before preparing or promoting a release, follow the shared
[release rules and gates](../flowdoc-project-control/docs/domains/flowdoc-export-working-release-rules-draft-2026-10-09.md).
They also record the owner-authorized 2026-10-16 history repair; that exception
does not permit moving tags during normal releases.

`release` contains one snapshot commit per accepted version, identified by an
annotated `v<version>` tag. Never move released tags or replace published artifacts.
Development branches retain their detailed history. The first release has its own
root; subsequent snapshots must parent only the previous release commit. Never
merge or fast-forward development history into `release`; every reachable commit
must have its version tag on the remote, including commits through any additional parent. Record the
development source commit, verify candidate/release tree equality, and promote only
reviewed changes; do not merge unrelated histories blindly. Changes start on the
development branch and become a new release after affected checks pass.
Service versions are independent of Core versions. Every Service release pins the
exact Core artifact and checksum; changing Core requires verification of its Service
consumer. Send the snapshot branch and its annotated tag atomically, then verify
both remote targets. A development package version or a successful local installation
does not establish a release. Local release branches/tags do not publish images or deploy a public API.

Prepare this repo's `README.md` and `docs/usage.md` with the actual version,
Core pin, migrations, administrator setup, backup/recovery and post-install checks
before freezing the delivery candidate. Verify the vendored tarball with
`node scripts/verifyVendor.mjs`; retain its manifest/checksum with acceptance results.
The usage guide's upgrade procedure is preparation, not evidence that a new
deployment has passed. Complete the affected container/DB/PDF checks before promotion.


## Local export API

### Upload staging

Resource intake is separate from `/jobs`; accepted resources can be drawn in PDFs.
Migrate before starting the API; migration 004 adds
upload sessions/items. Compose persists source bytes in its separate staging volume.
Use `node examples/upload-client.mjs <local.png> image/png` against the running API.
POST `/uploads` declares a requestKey and items (key, source=upload, mediaType,
byteSize); URL items instead use source=url and url. Read the returned resourceId,
PUT binary to `/uploads/:id/items/:resourceId/content`, GET `/uploads/:id` to poll,
and POST `/uploads/:id/finalize` once every binary item has completed.
For small images, PUT `{data:"<base64>"}` to the item's `/base64` endpoint.

URL declarations are fetched during job resource preparation. ready means intake
is complete, not image decoding or rendering. HTTPS descriptors and every fetched
destination are checked by the preparation boundary described below. Completed item retries
must contain identical bytes; changed bytes conflict. Retry an interrupted item as a
whole file; byte-offset resume is unsupported. requestKey is local-service scoped.
Do not expose this unauthenticated localhost MVP publicly.

Trial limits: 50 MiB/file, 200 MiB/set, 20 items, 1 GiB reserved staging, 100 active
sets, two HTTP receive slots; small Base64 is at most 1 MiB decoded / 2 MiB JSON.
`UPLOAD_FILE_BYTES`, `UPLOAD_SET_BYTES`, `UPLOAD_STAGING_BYTES`, `UPLOAD_MAX_ITEMS`,
`UPLOAD_MAX_SESSIONS`, `UPLOAD_STREAMS`, `UPLOAD_BASE64_BYTES` configure these.
Binary data streams to disk; the limits are not a promise of decode/load capacity.

`UPLOAD_IDLE_MS` and `UPLOAD_READY_MS` default to one hour; `UPLOAD_ABSOLUTE_MS`
caps an open session at four hours. Only accepted byte progress renews idle time,
not polling. Request idle/total timeouts default to 60s/10min via
`UPLOAD_REQUEST_IDLE_MS` / `UPLOAD_REQUEST_MS`. Expiry retires bytes, then retains
minimal session/item metadata for 24h (`UPLOAD_METADATA_MS`) for bounded retry
identity. A requestKey may create a new set after that tombstone is purged.
`UPLOAD_STAGING_DIR` selects the owned root; never point it at unrelated files.
Interrupted receives become incomplete after recovery; missing finalized bytes
invalidate the set. Failed deletion retains quota until cleanup succeeds.
Finalized uploads are claimed by admitted jobs. Claimed source data is protected
through processing and for one hour after completion. PDF TTL is independent.

`npm run check:uploads` verifies actual large PNG intake and restart through a
separate server process; `check:database` also covers upload DB/HTTP/lifetime tests.
Artifacts retain experiment bytes/counts and server peak RSS, not a production SLA.

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

### Image variable master

Migration 005 adds master 110004 (image), shared by current and version variables.
Image variables bind resource UUID strings in global/local scope; URL and
file intake remain upload sources, not separate variable types. Image variables are supported in array items and table cells. The configured server accepts image jobs with a finalized `uploadId`;
image field values are resource IDs from that upload. Missing/wrong-set references
are rejected before admission. Ordinary text/table jobs remain supported.

Migration 006 adds the internal upload/job ownership boundary. `enqueueWithUpload`
accepts already validated/pinned input and server-derived resource references;
it locks the finalized upload and inserts the job and claim in one transaction.
Identical retries return the existing job ID; different input/version conflicts.
The configured HTTP admission calls this boundary for image resources.

Claimed uploads report `claimed`, with `expiresAt: null` while queued/running.
Original files are protected through queueing/recovery and for one hour after
the job finishes. Cleanup then releases their bytes and later expires metadata.
Migration 007 stores actual processing stages/counts and processing warnings
separately from immutable accepted input. Poll `/jobs/:id` for `processing.stage`
(`preparing-resources`, `rendering`, `complete`, `failed`), `completed`, `total`,
and `warningCount`. Counts describe image slots, not estimated overall completion.

Preparation uses 200 DPI, proportional fit and no pixel upscaling. JPEG and PNG
alpha are supported; repeated source/target sizes reuse a prepared derivative.
Image block props accept optional `align: "left" | "center" | "right"` for the
frame within printable page width. Omission preserves left alignment. Images stay
centered within their frame; this does not enable text wrapping around images.
Bad images or blocked/unavailable URLs keep their frame blank with a warning.
Resource/decoder/output budgets can also skip an image. Poll warnings before
accepting the document. Shutdown or the five-minute preparation deadline fails
the job; each decode/download is limited to 30 seconds.

Originals live at the staging root; downloads and derivatives are owned by
`jobs/<job-id>` below it, with shared quota reserved before writes. A single
prepared image reserves up to 32 MiB while it is being produced; unused reservation
is released. Original data plus prepared files may use up to the set byte budget
plus 64 MiB, still bounded by shared staging capacity. PDF image resources are
limited to 20 derivatives and 64 MiB per job. Low custom staging limits can skip
images even when their compressed upload fits.

Remote images require HTTPS with public unicast destinations, no credentials or
forwarded authorization, at most three redirects, and at most 50 MiB per download.
Every destination is checked and its address pinned. Compose adds `image-egress`
to the API only; the DB remains on the internal network. Protected sources must
be downloaded by the caller and sent through upload intake. Deployments without
outbound access receive warnings for remote images.

`tests/uat-image-trial.mjs` runs a synthetic UAT report through live local HTTP
upload, finalize, job polling and PDF download. It requires an isolated database
and writes the PDF and a result report to `FLOWDOC_UAT_OUTPUT`. It uses no customer
data. These fixtures do not claim production capacity or all-image visual quality.

`tests/image-limits-trial.mjs` checks 40 MP JPEG/alpha PNG preparation, rejection
above the input/target pixel budgets and partial-file cleanup. Run with the packaged
verification image, `--network none --memory 512m --memory-swap 512m`, an output
mount at `FLOWDOC_LIMIT_OUTPUT`, and `--entrypoint node` followed by the script path.
It records cgroup peak memory including fixture generation, not decoder-only RSS.
This bounded serial probe is separate from the regular database suite.

## Area 18 document contract

Only `nodeModelVersion: 18` is accepted. Models 4–17 are unsupported; there is
no automatic conversion. Existing SQL migration files remain immutable history.
An upgrade does not rewrite older stored definitions into supported templates.

Sections use an authored fragment (or a cover), an `inputSchema`, and `formats: {}`.
Reusable content belongs to a named `area` variable with formats in `areaFormats`.
Requests provide `data` and `sections.<key>.data`; Area values are ordered arrays
of `{format,data}` entries. Top-level and per-section `content` are rejected.
The graph supports static text, tables, images, links, contents, scoped bands,
page numbering and two-level arrays with row groups. Core owns validation and
rendering. Start with `examples/area-document-template.json` and its request.

## 0.3.0: queue admission, API client and memory changes

Service limits `queued` + `running` document jobs to
`JOB_MAX_OUTSTANDING` (default10, positive safe integer). With the serial
processor this allows one running plus nine waiting jobs. Set it in the server
or Compose environment and recreate the API after changing it. This is a local
backlog policy, not a measured ten-job throughput guarantee; use one consistent
setting for all callers sharing this service database.

A full queue returns HTTP503 with issue code `QUEUE_FULL`, without a new job or
upload claim. A finalized upload remains reusable until its normal expiry.
An identical upload-backed replay returns its existing job even when full;
changed input still conflicts. Completed/failed jobs no longer occupy a slot.
Upload stream saturation remains a separate429 `UPLOAD_BUSY` condition.

No automatic POST retry is provided: after an ambiguous connection failure the
first request may already have been accepted, especially for upload-free jobs
without general idempotency. Queue capacity does not bound request preparation
CPU, per-document RAM, queue wait time, or the size of retained historical jobs.
Version 0.3.0 includes this policy, processor crash/failure isolation checks,
and the local public-API example in `examples/api-client`. See the usage guide
for its one/two/six-request flow and failed-job handling.

Prepared jobs send only the document and required image input to the child.
Core validation and immutable snapshot integrity checks remain in place.
Apply migrations through 021 using the matching CLI before starting the API.

## Candidate Area18 authoring tools

This local setup section describes the candidate implementation only. Shared
scope and acceptance: ../flowdoc-project-control/docs/domains/flowdoc-template-authoring-tools-plan.md.
It does not establish a connected AI host or release readiness.

After building and applying migrations through 018 to the intended development
database, start the Service with its existing database/output configuration plus
AUTHORING_TOKEN (a secret of at least 32 characters) and AUTHORING_PRINCIPAL
(a stable owner name; default local-owner). Authoring stays disabled without a
token. Keep HOST at 127.0.0.1 for this prototype. Do not expose the Service directly
to the internet; this is a single configured principal, not multi-tenant login.

Configure the MCP host to launch Node with the absolute path to
 dist/tools/server.js (or npm run tools:authoring from this checkout), using
AUTHORING_URL=http://127.0.0.1:3000 and the same AUTHORING_TOKEN in host-managed
secret environment configuration. The adapter uses stdio; credentials are never
tool arguments. The model host must support MCP resource reads to retrieve PDFs.
Only grant this tool server and reference-document reads to the authoring model;
adding MCP does not remove shell/SQL/filesystem tools already granted by its host.
No host settings or credentials are installed by this repository change.

Call get_authoring_contract first for the example definition/request and limits.
The required sequence is create_template_draft({name,docKey,idempotencyKey}) →
receive templateId/revision0 → update_template_draft({templateId,
expectedRevision:0,definition,idempotencyKey}) → validate_template({definition,
sampleRequest}) → preview_template_draft({templateId,expectedRevision,
sampleRequest,idempotencyKey}) → get_preview_status({jobId}) →
get_preview_pdf({jobId}). Read the returned flowdoc-preview resource for PDF bytes.
Set definition.templateId/docKey to the returned identity and definition.version=1;
draft revision is a separate concurrency token. Include globalSchema and all
Section/Format schemas in the complete definition. Internal database IDs are
assigned/reconciled by Service. Whole-definition saves can remove omitted content;
review the returned diff and reload after STALE_CURRENT.

For images use create_preview_upload, upload_preview_image and
finalize_preview_upload, then put the owned uploadId and returned resource IDs
in sampleRequest. MCP uploads accept PNG/JPEG base64 within advertised limits;
use a fresh upload for a changed preview. HTTP upload routes remain under the
same authoring authentication and ownership checks.

Preview jobs share the existing serial worker and outstanding-job limit. A
preview pins revision, definition, fingerprint and sample input without creating
a published version. Preview PDFs can be downloaded repeatedly until the existing
output TTL expires, even with EXPORT_RETAIN_FILES=false. Expiry does not erase
the draft. Successful authoring retry receipts/audit are retained until explicit
administrative database cleanup; they are not pruned on PDF expiry. A replay
returns the original job, so request a fresh preview with a new key after expiry.

There is no publish tool or authoring publish route. Human approval and a future
revision-bound publication operation are outside this implementation. Existing
administrative CLI permissions must not be given to the model.

The full Thai authoring regression is in examples/thai-authoring-template.json
and examples/thai-authoring-request.json. tests/thai-authoring-layout.test.mjs
uses the real renderer (requires the Linux runtime), not a mocked PDF response.
The fixture retains the original trial text; body12 uses lineHeightPt20 and
bold16 headings use28. The former18/24 values were below actual glyph/font height
for this input. Validation/composition is not a substitute for rendering preview.
