# Weekly Report Agent Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded tasks and independent review. The user has authorized implementation; execute in this session without an additional execution-choice approval.

**Goal:** Deliver the approved weekly-report stage: import real DOCX templates/examples, confirm mappings and writing rules, generate evidence-backed weekly drafts from system facts, preserve Word layout, edit/finalize/archive, and recover scheduled generation.

**Architecture:** Retain current reports and snapshots; extend new reports with an optional agent payload. Add a strict DOCX inspection/rendering module, a manager-only template/asset service, and leased background jobs. Reports freeze input/template/rules and archive final bytes. Monthly template migration and independent weekly/monthly analytics remain subsequent stages.

**Tech Stack:** Existing React/TypeScript/Express/SQLite, explicit JSZip and maintained xmldom dependencies, browser DOCX preview if verified; Node test runner, real Word samples, browser workflow verification.

**Workspace:** `C:/Users/24830/Documents/ChatGPT/人工智能实验室-部门管理系统/lab-planning/.tools/weekly-report-agent` on `codex/weekly-report-agent`. Base `2b717e6`; all 582 baseline tests pass. No production writes or deployment in this implementation turn.

**Approved spec:** `docs/superpowers/specs/2026-09-21-report-agent-module-design.md`, stages A/B. Real samples supplied by user: `C:/Users/24830/Desktop/周报/人工智能实验室周报（8.17-8.21）.docx` and `人工智能实验室周报（8.24-8.28）.docx`. Read only; do not commit their business content.

## Task 1: Lock contracts and real-template behavior

Files: create `shared/report-agent.ts`; create `shared/report-docx.ts`; modify `shared/types.ts` only to add optional report agent payload.

- [ ] Record DOCX region IDs: direct-body paragraph `p:N`, table `t:N`, cell `t:N:r:R:c:C`, indices zero based. Low-level operations are keep/text/clear and rows replacement; no expressions or model-generated XML.
- [ ] Define plain serializable inspection/binding DTOs and finite field/section/dataset enums. Binding kinds: keep, clear, meta, section, dataset, manual. Each dynamic table column resolves to a known field or an explicit manual value; statistics whose company meaning is unknown remain manual.
- [ ] Define asset/template/job/schedule DTOs, report generation provenance, text/table editable content, fact references, validation issues and manual-confirmation state. No credentials in DTOs.
- [ ] Contract API prefix `/report-agent`: GET bootstrap; POST assets; POST/PATCH templates; POST template learn/preview/activate/archive; POST jobs (generate/rewrite) and cancel/retry; GET job; GET report detail, PATCH content, POST finalize; GET asset and report DOCX; GET/PUT schedule. Existing `/reports` reads can include agent reports but old mutation endpoints must not bypass validation.
- [ ] Freeze templates once active; draft edits invalidate preview confirmation. A new template ID is a new immutable published revision. Store source DOCX and rules with references/hash; final report stores archived DOCX bytes.

## Task 2: Preserve and safely fill DOCX

Files: create `server/report-docx.ts` (split archive/XML/render helpers if needed), `tests/report-docx.test.ts`, generic synthetic fixture helper; modify `package.json` and lockfile through coordinator only.

- [ ] Test safe ZIP parsing before implementation: invalid type, encrypted/duplicate/traversal entries, directory/local mismatch, oversized expanded data, CRC, DTD/entity declarations, external relationships, macros and unsupported dynamic objects are refused without network access.
- [ ] Implement `inspectDocx(bytes)` yielding sha256, regions, tables/cells, fonts and actionable warnings. Preserve bibliography-only custom XML and page-number fields. Reject templates with comments/comment parts, tracked insertions/deletions, hidden text, embedded objects or unreviewable hidden content; return a specific instruction to supply a clean copy while retaining the user's original. The first phase does not silently sanitize these constructs. Neither learning nor activation accepts rejected documents. Test comments/hidden text cannot enter model input or a produced document.
- [ ] Implement `renderDocx(bytes, edits, expectedHash?)`: text replacement retains paragraph/run style; rows replacement retains table/header/prototype properties, clears old examples/data, applies escaped materialized values. Validate overlapping edits, region existence, columns and start/end ranges. All original parts outside edited document XML remain byte identical after decompression.
- [ ] Test Chinese text, XML characters, multi-paragraph cells, long content, zero/many rows, style preservation and page footer equality. Use synthetic fixtures for committed tests; inspect both provided samples only in ignored output.
- [ ] Run `node --import tsx --test tests/report-docx.test.ts`; expect pass. Render real sample-based output with Word to PDF and inspect pages; document exact compatibility scope.

## Task 3: Template learning, assets and evidence-based drafts

Files: create `server/report-agent-service.ts`, `server/report-agent-evidence.ts`, `server/report-agent-schemas.ts`, focused supporting files and tests; update shared contract as agreed.

- [ ] Tests first: manager-only access; validated base64 DOCX upload <=12 MiB; assets in SQLite; duplicate request replay vs changed payload conflict; no private bytes in listing; version checks.
- [ ] Create draft template from inspected asset. Default bindings for recognizable company sample headings/meta/table columns are suggestions. Require explicit handling of every original content region (including old TOP counts, “本周无” and example footer rows), required manual columns and layout verification before activation. Display exact unresolved areas.
- [ ] Queue learning from chosen examples; send necessary parsed text only, not original bytes/hidden content. AI yields candidate rules and bindings, never activates them. Rules are editable and explicitly confirmed; no AI configuration still permits manual rules and deterministic suggestions.
- [ ] Build weekly facts from frozen snapshot and `isEffectiveWeeklyRecord`; include current outcomes/risks and next-week commitments distinctly. Preserve monthly acceptance, phase/whole-task distinction, drafts, late association and submission status. Every generated factual unit references its source entity/version/field.
- [ ] Produce deterministic text/table fallback with complete row coverage. Model writing is per bounded section/row with fact IDs; reject unknown/borrowed numbers, dates and overstated statuses. Retry once then retain original user or rule text with an issue. Missing data remains missing. Company metric labels without a verified definition are manual, not guessed from task counts.
- [ ] Allow editing narrative/table content with source references and explicit manual supplement confirmation; show unresolved validation and missing values. Do not overwrite manual edits during a retry or rewrite.
- [ ] Finalization verifies current actor/report version/template review, renders outside transaction, then checks version again and atomically archives output asset + final status. Failed rendering leaves editable draft. Subsequent download returns archived bytes; source or renderer changes do not alter it.
- [ ] Test attribution mismatch, missing/invalid references, no-AI path, manual omissions, stale writes, immutable finalization and bytes/hash after backup.

## Task 4: Durable jobs and opt-in weekly scheduling

Files: create `server/report-agent-jobs.ts`, `server/report-agent-schedule.ts`, tests; coordinator wires service start/stop in `server/index.ts`.

- [ ] Test job dedupe, queued/running/retry/cancel states, expired lease recovery, manager deactivation and stale target versions using deterministic clock/fake model.
- [ ] Store frozen inputs and step checkpoints. Network/model/DOCX work is outside Store transactions; each commit checks current actor permissions, report version, token and lease expiry. Bounded concurrency and at most one automatic content retry; cancellation prevents late result writes.
- [ ] Worker resumes after restart and doesn't duplicate a report/revision; client polling merely observes. Checkpointed report editing is protected from a stale job. Expose sanitized errors and available retry/continue actions.
- [ ] Schedule opt-in, Shanghai timezone, designated active manager, template, weekday/time and current/previous target week. Default Friday 17:30 current week; Monday previous week explicitly supported. Store enabled/changed-at boundaries and scheduledFor/startedAt/capturedAt.
- [ ] Unique scheduled occurrence per weekly period (not template/settings revision). Catch up only most recent missed eligible occurrence; list older omissions. Never pretend today's source equals an old cutoff. Existing legacy scheduler must not generate a duplicate weekly draft when new agent schedule explicitly takes over; legacy monthly schedule continues.
- [ ] Shutdown stops claiming and safely drains/invalidates leases; stopped jobs recover without accessing a closed Store. Test restart across date, settings edit and Monday target semantics.

## Task 5: HTTP, backup and backward compatibility

Coordinator files: create `server/report-agent-routes.ts`, `server/report-agent-transfer.ts`; modify `server/app.ts`, `server/index.ts`, `server/report-routes.ts`, `server/reports.ts`, `server/scheduler.ts` only where needed; extend `server/data-transfer-schema.ts`, `server/data-transfer.ts`, `server/data-restore.ts`, `server/user-deletion.ts`; tests.

- [ ] Explicit manager auth for all new routes and downloads. Authenticate and check manager before the upload route's 18 MiB JSON parser; all other routes keep narrow limits and same-origin guard.
- [ ] Return async job IDs and expose endpoints according to the frozen contract. Do not auto-enable AI calls, template activation or schedules just by importing a file. Preserve old deterministic report generation/edit/export behavior; agent editing/polish/finalize cannot bypass the agent service.
- [ ] Upgrade existing `polishReport` to the shared evidence validator: build typed source facts, request text units with source IDs rather than blindly trusting naked prose, check object-specific numeric/date/status claims, then apply the existing permission/version check. Invalid output or failed retry leaves the exact previous user narrative unchanged. Add old-report regression tests for borrowed numbers from another task, monthly acceptance overstatement, unknown sources, valid wording and user edits during the model call. This is the explicit stage-A legacy polish fix, separate from the new agent route guard.
- [ ] Extend strict business export to next format version for every new persisted report/template/asset/reference. Asset bytes and frozen dependencies must survive an all-data export; accounts remain remapped through typed fields, not text replacement. Exclude executable leases/schedules or restore them inert to prevent replay side effects. Do not silently drop unknown agent fields in projection.
- [ ] Integrate asset/template/report references into restore closure and user-deletion blockers. Verify hashes/references on restore. SQLite backup automatically includes database assets; meaningful restore tests confirm real file bytes, not just collection count.
- [ ] Test v1–v3 imports, v4 full round trip, corrupt/missing assets, account remap and member export denial; keep current report fixture outputs stable.

## Task 6: Report-center UI

Files: create `src/components/ReportAgent*.tsx`, `src/report-agent.css`, optional helpers; modify `src/pages/Reports.tsx` with a small integration seam.

- [ ] Add manager-only “周报模板与生成” entry alongside existing reports. Provide accessible steps: upload template/examples → inspect/edit bindings and writing rules → trial DOCX/preview and confirm layout → activate → select week/generate.
- [ ] Template view displays original text with mapping suggestions, unknown company metrics and historical text needing replacement. Provide per-table field mappings and clear manual entries; user sees what will be kept/removed. No raw JSON or field IDs in normal flows.
- [ ] Show job progress, errors/retry/cancel and durable results. Dirty edits survive refresh/polling; clear saved-vs-refresh-failed messaging and account-scoped draft handling follow existing helpers.
- [ ] Agent report editor supports text and table cells, source facts, required manual supplements, validation, preview/download, section rewrite, save and finalize. Use confirmed frozen output after finalization; prevent old text editor operations on agent reports.
- [ ] Schedule UI shows target period, active template, recipient/owner, disabled default and missed occurrences. Enabling weekly agent takeover is explicit and explains legacy weekly generation behavior.
- [ ] Use existing styles, responsive form/table layouts and real labels; browser-check desktop and narrow viewport with manager/member fixtures. No production browser mutations.

## Task 7: Review and integration verification

- [ ] Run component tests as implemented; perform independent spec review then quality/security review; fix substantive findings.
- [ ] Run `npm test` and `npm run build` after integration; all baseline and new tests pass. Add tests for real failure boundaries, not implementation mirrors.
- [ ] Browser: local fixture import → correct mappings → preview → activate → generate (rule and mocked AI) → edit → validation → finalize → identical download; restart/cancel/version-conflict paths; mobile and permission checks.
- [ ] Preserve both user DOCX originals, hash before/after, inspect rendered generated pages and compare styles/table geometry/page footer. Synthetic current facts keep old business examples out. Record remaining compatibility limitations honestly.
- [ ] Update README and validation document with actual completed A/B scope and commands/results. Commit focused changes in feature branch; merge only verified feature commits into main without publishing. This turn implements locally; deployment can follow the user's separate release request.

## Execution ownership

- DOCX worker owns `shared/report-docx.ts`, `server/report-docx*`, DOCX tests/helpers.
- Backend worker owns `shared/report-agent.ts`, `server/report-agent-{service,evidence,jobs,schedule,schemas}*`, related domain/job tests, and the optional Report type declaration by agreement.
- Frontend worker owns `src/components/ReportAgent*`, `src/report-agent.css` and the Reports.tsx integration seam.
- Coordinator owns plan, dependency lockfile, app/route/index/legacy seams, data transfer, user deletion, integration/browser verification and docs. Concurrent work uses these disjoint boundaries; shared-contract changes are announced before use.
