# Feedback and Reliability Implementation Plan

> **For agentic workers:** Use subagent-driven-development with isolated file ownership and review of the integrated result. User has already requested implementation; proceed with the approved first batch.

**Goal:** Deliver feedback reporting, resolution verification, draft protection, traceable errors, and complete notification inbox pagination.

**Architecture:** Independent feedback domain with protected database attachments, explicit state transitions, command idempotency and existing in-app notifications. React components share typed contracts; parent owns app integration and reusable draft/error infrastructure. Preserve all pre-existing workspace changes using the saved baseline under output/feedback-20260921/baseline.

**Tech Stack:** React 19, TypeScript, Arco, Express, SQLite, node:test.

---

### Task 1: Feedback domain, API and notifications

Files: shared/feedback.ts, server/feedback-service.ts, server/feedback-routes.ts, server/feedback-notifications.ts, shared/notifications.ts, server/notifications.ts, server/notification-content.ts, server/user-deletion.ts; tests/feedback*.test.ts.

- [x] Add contract and tests for actor scope, attachment authorization, retry idempotency, stale versions and state transitions.
- [x] Implement transactions and protected attachment retrieval; no feedback binary in ordinary list/bootstrap/export.
- [x] Add permission-aware in-app notifications and user-deletion references; review duplicate propagation and backup coverage.
- [x] Run `node --import tsx --test tests/feedback*.test.ts` and existing related notification/account tests.

### Task 2: Feedback experience

Files: src/pages/Feedback.tsx, src/components/FeedbackComposer.tsx, src/feedback-draft.ts, src/feedback.css and focused tests.

- [x] Implement persistent composer with screenshot paste/drop/upload, preview/remove, retry-safe save and metadata preview.
- [x] Implement mine/manager list, filters, detail time line, append, assign, processing, defer, ready, confirm/reopen and reasoned closure.
- [x] Provide accessible mobile layouts and loading/error/conflict recovery.
- [x] Inspect contract compliance, then browser-test both roles.

### Task 3: Complete inbox

Files: server/notification-routes.ts, src/pages/Messages.tsx, tests/notification-pagination.test.ts.

- [x] Write regression for >200 rows, old pending records, stable cursors and account scope.
- [x] Apply server filters before pagination; return complete counts; connect filters and next-page UI.
- [x] Keep acknowledgement and open-all semantics; refresh after mutations without hiding outstanding items.
- [x] Run pagination and notification UI/API tests.

### Task 4: Root integration and reliability

Files: server/app.ts, src/App.tsx, src/api.ts, src/main.tsx, src/navigation.ts, src/notification-navigation.ts, src/components/WorkspaceShell.tsx, src/ui.tsx, src/pages/Monthly.tsx, src/pages/Weekly.tsx, src/draft-recovery.ts, src/error-context.ts, src/components/PageErrorBoundary.tsx, vite.config.ts; related tests.

- [x] Mount feedback routes with scoped body limit and global feedback overlay/navigation.
- [x] Add safe request IDs, recovery UI and version context; verify existing auth behavior.
- [x] Extend reusable drafts for field groups and controlled inputs; wire high-frequency forms and preserve work on navigation/failure.
- [x] Test isolated fixture requests and browser recovery scenarios.

### Task 5: Verify and document

- [x] Run `npm test`, `npm run build` and relevant static diff checks against the pre-turn baseline.
- [x] Browser-check member report with screenshot → manager processing → ready → member reopen and confirm, drafts, pagination, desktop and mobile.
- [x] Independent spec and quality review; address actionable defects and repeat affected checks.
- [x] Update README, API contract and validation record with exact results and remaining deployment boundary.
