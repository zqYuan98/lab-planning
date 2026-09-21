# Weekly Plan Review and Deletion Implementation Plan

> **For agentic workers:** Use parallel bounded implementation tasks, then integration review and verification. Preserve all pre-existing workspace modifications.

**Goal:** Add administrator soft deletion and version-bound whole-sheet review of member next-week plans.

**Architecture:** Keep immutable submission/report history. Add business review records and per-row approval fingerprints, shared active/effective selectors, and tombstones. Separate plan decisions from execution progress and punctuality.

**Tech Stack:** TypeScript, React, Express, SQLite JSON entities, node:test.

---

### Task 1: Shared state and review backend

Files: `shared/types.ts`, `shared/weekly-submissions.ts`, new `shared/weekly-record-state.ts`, new `server/weekly-plan-review.ts`, `server/weekly-submissions.ts`, `server/weekly-duty-view.ts`, `server/weekly-submission-routes.ts`, new `tests/weekly-plan-review.test.ts`.

- [x] Test pending/approved/returned and submit revision history, stale decision guards, progress edits not invalidating plan, punctuality retained, and policy activation.
- [x] Implement shared helpers, persisted policy, review view and manager command. Preserve submitted meaning and immutable receipts. Exclude deleted rows from current duty manifests.
- [x] Expose deterministic hooks for WorkService to mark review-required rows. Approval compares plan fingerprints and row sets, not raw execution versions. Apply policy windows to pause/resume without changing historical paused cycles.
- [x] Run focused review/submission tests. Final combined regression remains below.

### Task 2: Deletion and business integration

Files: `server/domain-work.ts`, `server/domain.ts`, `server/app.ts`, report/overview/collaboration/notification selectors, new `tests/weekly-deletion.test.ts`.

- [x] Test member denial, reason/version validation, repeat deletion, same-week recreation, unchanged task/history, invalid deleted edits and non-active followups.
- [x] Add transactional deletion with tombstone and audit. Update uniqueness, relink, update/carry gates, assignment retry behavior.
- [x] Wire review-required metadata on normal writes without allowing client control. Filter current/effective surfaces consistently, preserve raw business export and frozen history.
- [x] Run focused deletion/review and integration tests including weekly assignment, collaboration, report metrics and notifications. Final combined regression remains below.

### Task 3: Migration packet compatibility

Files: `server/data-transfer-schema.ts`, `server/data-transfer.ts`, `server/data-restore.ts`, `server/weekly-submission-transfer.ts`, `tests/weekly-review-transfer.test.ts`.

- [x] Extend strict schemas, collection defaults, nested snapshots, references and user remapping for tombstones, approval and reviews/policy, including paused-cycle metadata.
- [x] Preserve deleted records for strong references; ignore them only in active business uniqueness. Reject inconsistent or invalidated live approval references and restore without sending notifications. Keep historical approval facts intact.
- [x] Test old packets, deleted+replacement rows, reviews with snapshots, member scoping and JSON roundtrip. Normalize applicable legacy current rows to pending in the shared preview/restore pass and validate suspension against policy windows.

### Task 4: UI and functional verification

Files: `src/pages/Weekly.tsx`, `src/components/WeeklySubmissionPanel.tsx`, `src/weekly-submission-flow.ts`, relevant CSS and shared selectors.

- [x] Show review and punctuality separately. Provide manager approve/return with mandatory return reason and frozen submitted preview/history. Display activation date.
- [x] Add admin delete confirmation and restart same task/week flow. Explain old report/receipt retention and resubmission need.
- [x] Use effective selectors for official counts and approval labels for pending rows. Keep progress input independent.
- [x] Run final `npm run build` and full `npm test` after integration changes settle: build passed, 510 tests passed.
- [x] Complete desktop and narrow-browser acceptance using isolated data; record the evidence. Verified return/revision/approval and deletion/relink/recreation, plus 390×844 dialogs.

### Task 5: Final review and documentation

- [x] Review implementation for bypasses, missing read paths, stale decision acceptance and packet reference regressions. Fixed assigned draft/progress bypasses and pending progress API behavior, with regression tests.
- [x] Review and fix transfer boundaries for invalidated live approvals, legacy-policy bypass, account mapping and paused-cycle exemptions, with focused regression coverage.
- [x] Update README, user operation guide, API contract, import guide and design spec. Describe undeployed code behavior without claiming production rollout.
- [x] Record final integrated tests/build and browser acceptance evidence in `docs/validation-2026-09-20-weekly-plan-review-deletion.md`.
- [x] Preserve pre-existing workspace changes. No commit is created for this documentation task.
