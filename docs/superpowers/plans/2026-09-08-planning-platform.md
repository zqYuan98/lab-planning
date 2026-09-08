# Department Planning Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Tasks are divided by file ownership; the API contract is authoritative.

**Goal:** Deliver a working member monthly submission → manager review/publication → personal weekly execution → saved management report application.

**Architecture:** Independent single-host web application with authenticated server APIs, SQLite transactions and persistent audit/publication/report snapshots. React UI uses the same backend data for all views. Annual goals remain independent; all formal weekly work links to monthly items.

**Tech Stack:** Node 24, TypeScript, Express 5, SQLite, React 19, Vite, docx. SQLite storage is replaceable behind Store. Initial service binds loopback; hosted deployment requires HTTPS and persistent data volume.

## Task 1 Domain and access control

Files: server/store.ts, auth.ts, domain.ts, app.ts, index.ts, tests/domain.test.ts, tests/api.test.ts.

- [x] Write tests for member ownership, monthly submission/review/publication, rejected edits, publication snapshots, weekly submission gate, carry state, archived projects and optimistic concurrency.
- [x] Implement Store transactions and scrypt password sessions; first-run manager setup; protect mutations by same-origin checks.
- [x] Implement routes in docs/api-contract.md; first use starts empty, no fake production records. Demo fixture only in tests or an explicit development seed script.
- [x] Run npm test; tests use in-memory SQLite and real HTTP where authentication matters. Verify cross-user update denial and immutable historical snapshots.

## Task 2 Interface

Files: src/main.tsx, App.tsx, api.ts, ui.tsx, styles.css, pages/Overview.tsx, Monthly.tsx, Weekly.tsx, Projects.tsx, Goals.tsx, Team.tsx.

- [x] Build a Chinese interface with dark forest sidebar, paper-toned workspace, strong typography and restrained amber accents; avoid decorative dashboard noise.
- [x] Implement first manager setup/login and role-aware navigation.
- [x] Build monthly proposal forms, review/return/publish workflow, version history, changes and result confirmation; grouping retains each responsibility.
- [x] Build personal weekly decomposition, evidence/result updates, carry and temporary work; show linked month and manager exceptions.
- [x] Build project archive, independent annual goal records and team member management. All controls perform real API work, with empty/loading/error/success states and keyboard-friendly dialogs.
- [x] Run npm run build and verify desktop/mobile and full member-to-manager flow in browser.

## Task 3 Report engine and UI

Files: server/reports.ts, report-routes.ts, scheduler.ts, src/pages/Reports.tsx, tests/reports.test.ts.

- [x] Write regression tests for full-scope statistics independent of selected highlights, annual independence, cutoff snapshot immutability, editing/finalize, repeated generation and period-based schedule idempotency.
- [x] Generate deterministic Chinese report drafts from published monthly plans, weekly facts and independent annual records. Distinguish self-reported weekly work from accepted monthly outcomes; record reasons, owners and next steps only when supplied.
- [x] Add saved revisions, editable prose, finalization, Markdown/Word export with snapshot metrics. Optional configured AI polishing preserves metrics and does not run automatically before credentials are provided.
- [x] Add opt-in Asia/Shanghai schedules generating saved drafts with durable per-period idempotency.
- [x] Build report history/editor/source tables/export/schedule controls and verify downloads.

## Task 4 Integration and delivery

Files: README.md, .env.example, Dockerfile, scripts/backup.ts, docs/validation.md.

- [x] Review spec compliance, then code quality; fix material defects and rerun affected checks.
- [x] Run npm test, npm run build and real-browser workflow: initialize manager, create member, member proposal, manager publish, member weekly completion, manager result confirmation, report save/export/finalize. Project creation and return/resubmit are additionally verified through real HTTP integration tests; see docs/validation.md for the tested scope.
- [x] Verify restart persistence; document startup, HTTPS deployment, environment configuration, backups and known limitations.
- [x] Commit clean standalone source. Create private GitHub repository on authenticated user account after secret and tracked-file inspection; push no old company source, credentials, database or supplied attachments.

## Verification commands

- npm test: all domain/API/report assertions pass, no dependency on production database.
- npm run build: strict TypeScript and production bundling pass.
- npm run dev: backend http://127.0.0.1:4310 and frontend http://127.0.0.1:5173. Production npm start serves dist from one origin.
- Browser scenarios must use isolated database; clear only verified task-specific test data, never user-created application data.

Documentation references: [Node SQLite](https://nodejs.org/api/sqlite.html), [Vite guide](https://vite.dev/guide/), [Express installation](https://expressjs.com/en/starter/installing/).
