# Personal task scope and Friday submissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Isolate personal work, use shared monthly goals, and record current-week progress / next-week plan submissions due Friday 16:00 Asia/Shanghai.

**Architecture:** Keep MonthlyPlan -> Task -> WeeklyRecord. Centralize member-safe goal projections and own-only personal reads. Add a weekly-submission service with immutable revisions, frozen roster and durable deadline facts; expose a standalone panel using new routes, then extend existing business migration format.

**Tech Stack:** TypeScript, React, Express, node:sqlite Store, node:test via tsx.

**Approved specification:** ../specs/2026-09-11-personal-task-scope-weekly-deadline-design.md

## Task 1 — Personal scope and monthly-goal responsibility

Files: server/domain.ts, server/domain-common.ts, server/domain-plans.ts, server/domain-work.ts, server/data-transfer.ts, server/import-service.ts; new server/plan-visibility.ts; tests/personal-scope.test.ts and affected existing domain/import/export tests.

- [x] Add regression tests with manager and two members sharing a published goal: bootstrap, exports and candidate options never expose the other member's Task/WeeklyRecord. Former participants receive only authorized history, not later plan changes. Shared merged goals do not expose other people's source prose.
- [x] Run `npx tsx --test tests/personal-scope.test.ts` and observe the failing visibility assertions.
- [x] Replace bootstrap task/weekly filters with `isManager || row.ownerId === actor.id`; remove collaborator historical task backfill. Introduce `visiblePlans(store, actor)` and `visiblePlanHistory(store, actor, id)` safe snapshot projection; use them in bootstrap/history and ensure export doesn't recursively restore hidden raw references.
- [x] Monthly goal create/edit/submit/carry management becomes manager-only (result submission remains owner or manager, acceptance manager). Keep import for members' own historical/weekly records, but member imports cannot create team goals through draft or existing routes. Existing member goal drafts stay readable and manager-operable.
- [x] Keep Task owner fixed to actor for nonmanagers; validate eligible goal; inherit association through monthlyPlanId. Match tests and UI terminology after changed responsibility.
- [x] Run focused permission, import and domain tests and inspect failures for intentional legacy expectations; commit scoped changes after review.

## Task 2 — Deadline facts, API and scheduling

Files: new shared/weekly-submissions.ts, server/weekly-submissions.ts, server/weekly-submission-routes.ts; server/app.ts, server/scheduler.ts; tests/weekly-submissions.test.ts, tests/api.test.ts.

- [x] Write injected-clock tests for Friday 15:59:59 vs 16:00:00 Shanghai, two independent duties, draft vs whole submission, late fill before scanner, reboot catch-up, duplicate/concurrent requests, roster start boundaries, exemption and permission.
- [x] Add shared types: rule (enabled/effectiveWeek/timezone), cycle (week/roster/needsReview), duty (ownerId/cycleWeek/kind/deadlineAt), immutable revision (records snapshot, note, submittedAt, actor/reason/requestId), missing-at-deadline fact and append-only exemption/correction events. Duty unique identity is owner+cycle+kind; result targets W, plan targets W+7.
- [x] Add Shanghai week/date helpers with explicit UTC+08 deadlines, independent of host timezone. Enable defaults first full week after first initialization, provide manager enable/disable with saved effective week; no historic liabilities.
- [x] Freeze eligible roster as of Monday via user events; missing trustworthy history sets needsReview, exposing manager confirmation. Reconcile all due cycles since enabled week on scheduler startup/tick and related reads/writes. Recover from recorded submissions, never mark an on-time submission late because scanning ran late.
- [x] `submit(actor, input)` validates server identity, effective/started cycle, expected duty version, request ID, all official records and explicit draft decisions. The preview returns an ID/version manifest for every source record (including drafts); submit must send that complete manifest and compare it transactionally, rejecting added, removed, withdrawn or edited records with 409 and no partial writes. Results require actual progress and appropriate blocker details; plans require commitments and existing WorkService publish/month constraints. Empty records require explanation. Transactionally submit included drafts and freeze whole snapshot. Retrying same request returns same receipt; later revisions do not overwrite first submission or missing fact. Test each intervening edit/add/withdraw case.
- [x] Manager-only exemption / revocation / invalidation or correction append actor+reason history; by-proxy submit also records reason. Read response derives due/on_time/missing/late/exempt plus first/latest times and changed-since-submit from versions/content.
- [x] Mount `/api/weekly-submissions` routes: GET cycle view; PUT rule; POST submit; POST exemption; POST roster confirmation; POST correction. Return self-only for members and all roster rows for manager. Keep existing weekly record endpoints usable, but never equate their submitted boolean to whole-sheet receipt.
- [x] Hook independent reconciliation into scheduler with isolated error handling so report scheduling remains unchanged. Run `npx tsx --test tests/weekly-submissions.test.ts tests/api.test.ts`, then review and commit.

## Task 3 — Member and manager flows

Files: new src/components/WeeklySubmissionPanel.tsx and associated CSS; src/pages/Weekly.tsx, src/pages/Monthly.tsx, src/pages/MergeProposals.tsx, src/App.tsx, src/components/WorkspaceSearch.tsx, src/pages/Overview.tsx, src/overview-data.ts, src/ui.tsx where wording requires it.

- [x] Reuse existing UI elements/styles. Monthly page calls the data monthly goals, hides member creation/edit/merge/import-team-goal actions, and offers eligible goal -> own task creation. Remove old dashboard prompts asking members to create/review team goals.
- [x] Insert a focused weekly submission panel with two distinct cards (W completion, W+7 plan), explicit deadline, statuses and whole-sheet confirmation. Show outstanding drafts and a include/retain decision, empty explanation when applicable, version conflicts and changed-since-submit.
- [x] Manager panel presents per-person two statuses, missing people vs missing items, late time and exemption reason; selection of a member allows proxy submission with mandatory reason. Provide bounded rule activation, roster confirmation and correction controls.
- [x] Members never see other users' personal work options. Existing weekly work editing stays available; ongoing Friday work can be submitted honestly without closing task.
- [x] Run `npm run build`, smoke-test manager/member main flows with isolated local data and browser tool. No real employee data used for testing; no production deployment in this task without established authorization.

## Task 4 — Migration, regression and documentation

Files: server/data-transfer-schema.ts, server/data-transfer.ts, server/data-restore.ts, server/data-routes.ts as needed; shared/types.ts, server/reports.ts and existing report rendering/export; tests/data-transfer.test.ts, tests/weekly-submissions.test.ts, tests/reports.test.ts; README.md, docs/api-contract.md, docs/validation.md.

- [x] Extend versioned business packets for rule/cycle/duties/revisions/deadline/exemption facts. Export authorized facts only, map user IDs and stable duty references during restore, preserve immutable timestamps. Strict schemas validate new collections, references and permissions; accept v1 with empty new facts (never fabricate compliance).
- [x] Test v2 round-trip, v1 compatibility, member export redaction, missing references/collisions, tampered timestamps/revisions and migrated request IDs. Full SQLite backups already include generic entities; verify no extra file-side persistence needed.
- [x] Add optional frozen weekly submission summary to new ReportSnapshot and generateReport, including the relevant cutoff cycles for the weekly/monthly report. Render it in the report narrative/export as a separate management record (two duty statuses, cutoff/late facts), never feed it into delivery metrics. Extend report transfer schema/reference mapping for these snapshots. Tests prove existing reports without this field still read/export, saved snapshots do not change after later fills/exemptions, and report delivery totals remain unchanged.
- [x] Run `npm test` and `npm run build`, fix regressions without weakening legitimate permission or schedule checks. Run browser smoke after final UI changes, then perform spec compliance and code-quality review and resolve actionable issues.
- [x] Update documentation with Friday cutoff, whole submission vs record draft, on-time vs task completion, first effective cycle, exemption/recovery and goal permissions. Mark completed plan items, run `git diff --check`, and report actual checks and remaining deployment status.


## Completion evidence — 2026-09-11

All four tasks completed, with independent specification and code-quality reviews approved. Final `npm test`: 154 passed, 0 failed; `npm run build`: passed; real member/manager browser flows: passed. Review corrections include multi-generation merged-goal redaction, partially reassigned import batches, cached deadline reconciliation, retained-draft change detection, manager filters/counts, safe default-rule migration and canonical weekly timestamps. Final routes consolidate exemptions and corrections under `/weekly-submissions/adjust`.

Code remains on `codex/personal-weekly-submissions`; no production deployment performed. See `docs/validation.md` for validation scope and limitations.
