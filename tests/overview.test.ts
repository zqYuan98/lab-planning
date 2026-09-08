import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOverview,
  monthWeeks,
  shanghaiToday,
} from "../src/overview-data.ts";
import type {
  Bootstrap,
  MonthlyPlan,
  User,
  WeeklyRecord,
} from "../shared/types.ts";

const entity = {
  version: 1,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};
const user: User = {
  ...entity,
  id: "member",
  name: "成员",
  email: "member@example.test",
  position: "算法",
  role: "member",
  active: true,
};
const base = (): Bootstrap => ({
  user,
  users: [user],
  projects: [],
  annualGoals: [],
  plans: [],
  tasks: [],
  weeklyRecords: [],
  publications: [],
  reports: [],
  aiConfigured: false,
});
const record = (
  id: string,
  patch: Partial<WeeklyRecord> = {},
): WeeklyRecord => ({
  ...entity,
  id,
  taskId: id,
  monthlyPlanId: "published",
  ownerId: user.id,
  weekStart: "2026-09-07",
  commitment: "交付验证",
  actualOutcome: "",
  evidenceUrl: "",
  blocker: "",
  nextAction: "",
  status: "planned",
  submitted: false,
  ...patch,
});
const plan = (id: string, patch: Partial<MonthlyPlan> = {}): MonthlyPlan => ({
  ...entity,
  id,
  month: "2026-09",
  title: id,
  projectId: null,
  category: "研发",
  ownerId: user.id,
  collaboratorIds: [],
  expectedOutcome: "验证成果",
  acceptanceCriteria: "评审通过",
  dueDate: "2026-09-30",
  priority: "medium",
  status: "draft",
  reviewComment: "",
  publishedVersion: null,
  sourcePlanId: null,
  actualOutcome: "",
  acceptanceStatus: "pending",
  acceptanceNote: "",
  ...patch,
});

test("month rhythm uses real 4–6 Monday weeks, clips boundaries and identifies September 8 as week two", () => {
  const september = monthWeeks("2026-09", "2026-09-08");
  assert.equal(september.length, 5);
  assert.deepEqual(
    [september[0].weekStart, september[0].startDate, september[0].endDate],
    ["2026-08-31", "2026-09-01", "2026-09-06"],
  );
  assert.equal(september.find((week) => week.isCurrent)?.index, 2);
  assert.equal(september.at(-1)?.endDate, "2026-09-30");
  assert.equal(monthWeeks("2021-02", "2021-02-14").length, 4);
  assert.equal(monthWeeks("2026-08", "2026-08-15").length, 6);
  assert.equal(
    monthWeeks("2024-02", "2024-02-29").at(-1)?.endDate,
    "2024-02-29",
  );
  assert.equal(monthWeeks("2027-01", "2027-01-01")[0].weekStart, "2026-12-28");
  assert.equal(shanghaiToday(new Date("2026-09-07T16:00:00Z")), "2026-09-08");
});

test("elapsed dates never imply execution completion; only submitted done records do", () => {
  const empty = monthWeeks("2026-09", "2026-09-30");
  assert.ok(empty.every((week) => week.state === "empty"));
  const records = [
    record("done", {
      submitted: true,
      status: "done",
      actualOutcome: "完成评审",
    }),
  ];
  assert.equal(monthWeeks("2026-09", "2026-09-30", records)[1].state, "done");
  records.push(record("draft"));
  assert.equal(monthWeeks("2026-09", "2026-09-30", records)[1].state, "active");
  assert.equal(
    monthWeeks("2026-09", "2026-09-30", [
      record("draft", { status: "done", actualOutcome: "尚未提交" }),
    ])[1].state,
    "draft",
  );
});

test("metrics use visible formal records, separate blocked from not done, and never accept monthly results from weekly status", () => {
  const data = base();
  data.plans = [
    plan("published", { status: "published" }),
    plan("review", { status: "submitted" }),
    plan("merged", { status: "merged" }),
    plan("draft"),
  ];
  data.weeklyRecords = [
    record("done", {
      submitted: true,
      status: "done",
      actualOutcome: "自报完成",
    }),
    record("blocked", {
      submitted: true,
      status: "blocked",
      blocker: "需协调",
    }),
    record("not-done", {
      submitted: true,
      status: "not_done",
      blocker: "未完成原因",
    }),
    record("draft-blocked", { status: "blocked" }),
    record("other-week", { weekStart: "2026-09-14", submitted: true }),
  ];
  const result = buildOverview(data, "2026-09-08");
  assert.equal(result.plans.length, 3);
  assert.equal(result.published.length, 1);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.pending.length, 1);
  assert.equal(result.reviewScope.length, 2);
  assert.equal(result.submitted.length, 3);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.notDone.length, 1);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.planExecution(data.plans[0]).done, 1);
  assert.equal(result.monthChange, null);
  assert.equal(result.weekChange, null);
});

test("micro comparisons require observed history; returned submissions are not mislabeled never submitted", () => {
  const data = base();
  data.plans = [
    plan("current", { status: "published" }),
    plan("older", { month: "2026-08", status: "published" }),
    plan("returned", { status: "returned" }),
  ];
  data.weeklyRecords = [
    record("last", { weekStart: "2026-08-31", submitted: true }),
    record("this1", { submitted: true }),
    record("this2", { submitted: true }),
  ];
  const result = buildOverview(data, "2026-09-08");
  assert.equal(result.monthChange, 0);
  assert.equal(result.weekChange, 1);
  assert.deepEqual(
    result.weekTrend.map((point) => point.value),
    [null, null, 1, 2],
  );
  assert.equal(result.missingMembers.length, 0);
  const empty = buildOverview(base(), "2026-09-08");
  assert.equal(empty.monthChange, null);
  assert.equal(empty.weekChange, null);
  assert.equal(empty.reviewScope.length, 0);
});
