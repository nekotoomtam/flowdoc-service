# FlowDoc Service Agent Guide

## Authority Boundary

Owner: flowdoc-service. Scope: service code, PostgreSQL migrations, local CLI,
container setup and repository tests. Shared MVP/roadmap/status belongs to
flowdoc-project-control. Read ../flowdoc-project-control/AGENTS.md first.
Current registry scope: ../flowdoc-project-control/docs/domains/flowdoc-export-mvp-current-version-plan-2026-10-08.md.
This guide does not claim HTTP, worker or full MVP readiness.

Import Core only from its versioned package root. Preserve its artifact checksum
and resource licenses. Do not copy Core validation or renderer logic here.
Migrations are forward-only, checksum-tracked and transactional. Never edit a
migration already released/applied outside the current isolated test round.
Use SQL parameters and one checked-out client per transaction. Do not expose
database errors, connection strings or filesystem paths in CLI/API diagnostics.
Keep HTTP, repository SQL, job processing and file storage responsibilities apart.
Tests must use isolated named databases/volumes; never clear user data to pass.
Commit after build and affected real-database/container checks pass. Keep shared
plans in Project Control; no docs/superpowers plans or synthetic Work registries.
