# Weekly assignment implementation plan

> Execute locally with superpowers:executing-plans, after the approved design. Review spec and plan independently.

**Goal:** Make manager-issued weekly work visible to its responsible member with accurate authorship and independent whole-sheet submission.

**Architecture:** Optional immutable workOrigin on Task/WeeklyRecord; server-side creation and read-only legacy audit projection; existing ownership and receipt services remain authoritative.

**Tech Stack:** TypeScript, React, Express, SQLite JSON entities, node:test.

- [x] Add shared source type/labels and server creation/legacy projection helper. Extend WorkService and bootstrap. Cover manager assignment, proxy reason, member spoofing, immutable origin, legacy and import exclusions in tests/weekly-assignment.test.ts.
- [x] Extend server/data-transfer-schema.ts for task/weekly origins, strict nested projection, references/remap. Test schema round trip including receipt snapshots.
- [x] Update src/pages/Weekly.tsx: explicit manager owner placeholder, issue/proxy creation mode, required reason for proxy, source badges/actor in cards, source filter. Show source in WeeklySubmissionPanel live preview using bootstrap records; new receipts preserve stored origins.
- [x] Run focused tests, npm test and npm run build. Exercise isolated HTTP browser manager → member → whole-sheet flow and other-member isolation. Review edited TSX with React skill.
- [ ] Commit application, build exact Linux image, run tests, backup then deploy to 192.168.0.37:4310. Verify health, data checksum preservation and source UI assets. Record actual evidence in validation docs.

Review: independent spec/code reviewer approved; export disables legacy projection. Overview also shows source and clarifies record-statistics labels. Local 161 tests and build pass; isolated LAN HTTP browser verified owner selection, assignment, member update, whole-sheet receipt, proxy reason and peer isolation.
