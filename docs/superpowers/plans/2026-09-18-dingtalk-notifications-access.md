# DingTalk Notifications and Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan. User has approved implementation; preserve the existing working tree.

**Goal:** Add internal DingTalk H5 access, explicit account binding, reliable personal notifications and mobile entry to the existing department system.

**Architecture:** Existing Express / SQLite remains authoritative. Business transactions persist notifications atomically. A single-process durable worker sends to the DingTalk adapter; provider acceptance, delivery, opening and acknowledgement remain distinct. A new public server will host the complete application; never deploy to server 37 in this task.

**Tech Stack:** React / TypeScript / Vite, Express, node:sqlite, bundled DingTalk JS SDK, node:test.

---

- [x] Identity and adapter: implement `server/dingtalk.ts`, `server/dingtalk-routes.ts`; server-only credentials, cached access tokens, verified code exchange, browser-bound one-use binding challenge, existing active accounts and session policy, session revocation on unbind. Add mocked security tests.
- [x] Notification core: implement `shared/notifications.ts`, `server/notifications.ts`, `server/notification-routes.ts`, `server/notification-worker.ts`; recipient filtering, permission rechecks, explicit acknowledgement, opt-in settings and pilot scope, durable retry/lease/unknown handling, no historical send.
- [x] Business hooks: update monthly/work services; grouped publish events, assigned task/week events, meaningful changes and temporary proposal review. Add idempotent atomic task + weekly-record endpoint.
- [x] Weekly reminders: derive Friday reminders/summary from formal weekly duty views; skip submitted/exempt/inactive users and disputed rosters; deterministic event keys and no old-cycle blast.
- [x] Frontend: messages/inbox, account binding, administrator settings and delivery status, `/entry` and `/work` navigation, bounded DingTalk SSO and explicit acknowledgement, atomic weekly creation; preserve responsive workspace UI.
- [x] Wiring: register routes without weakening origin guard, start/stop worker alongside scheduler, keep external send disabled without deployment credentials and explicit settings.
- [x] Verification: `npm run typecheck`, targeted notification/auth/business tests, full `npm test`, `npm run build`, isolated browser smoke test. Review authorization, privacy and failure recovery.
- [x] Document env variables, new public server checklist, internal app settings, pilot and rollback; distinguish mocked verification from pending real DingTalk integration.

## Local verification and remaining launch acceptance

2026-09-18: full suite 288/288 passing; TypeScript and production build passed (existing Vite large-chunk advisory remains). Mock API tests cover one-use identity proof, account state, corporate identity, session revocation, shared-office rate limits, atomic rollback/replay, recipient permissions, acknowledgement versions, grouping, formal reminder receipts, leases, provider uncertainty, retry limits and expiry. Independent review corrected draft sends, irrelevant acknowledgement resets, stale reminders, clock changes and shutdown handling.

An isolated in-memory server on loopback was used for browser checks: member inbox/open/ack, unchanged business status after ack, controlled target links, refresh/back and login recovery, manager settings/status and 390 px mobile layout. No production data or real DingTalk delivery was used. Screenshots and command logs are under ignored `output/notification-*` and `output/dingtalk-*`.

The deployment ID must be replaced and external sending disabled before every clone/restore. Re-enabling never broadcasts old inbox rows. Bulk historical notification previews, native DingTalk to-dos and automatic contact synchronization are not included in this first delivery.

Real enterprise-app/API access, HTTPS/public-server setup, DingTalk iOS/Android/PC behavior and delivery acceptance remain launch checks after credentials and infrastructure are available; see `docs/dingtalk-public-server.md`.

## Frontend API contract

- `GET /api/auth/dingtalk/config` → `{configured,corpId,clientId}`.
- `POST /api/auth/dingtalk/exchange` `{code}` → `{authenticated:true,user}` or `{authenticated:false,bindingRequired:true}` with short-lived browser challenge cookie.
- `GET /api/dingtalk/binding` → `{bound,corpId?,boundAt?}`. `POST /api/dingtalk/bind` `{}` consumes challenge after ordinary login; `POST /api/dingtalk/unbind` `{}` revokes sessions.
- `GET /api/notifications` → `{items:NotificationView[],unreadCount}`; `GET /api/notifications/:id` returns permission-projected view, never marks opened.
- `POST /api/notifications/:id/open` and `/acknowledge` `{}` → view. `POST /api/notifications/open-all` `{}` marks only recipient's messages opened.
- `GET /api/notification-settings` → `NotificationSettingsView`; `PUT` `{version,externalEnabled,pilotUserIds,sendStartHour,sendEndHour}`. `POST /api/notification-deliveries/:id/retry` only retries definitive failures, never uncertain sends.
- `POST /api/weekly-assignments` `{requestId, taskId?, task?:{...createTaskInput}, record:{...createWeeklyRecordInput}}` → `{task,record}`. Existing task ID or new task, never both. Actor scoped idempotency key; same key with different payload rejected.

Notification targets carry `type,id,month?,weekStart?,cycleWeek?,kind?`; UI uses existing monthly/weekly navigation. Never trust a notification ID as permission. Binding and worker tests use injected adapters and in-memory SQLite, not enterprise credentials.
