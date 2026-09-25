import type { Bootstrap, MonthlyPlan, WeeklyRecord } from "./types";
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord } from "./weekly-record-state";

const iso = (value: Date) => value.toISOString().slice(0, 10);
function day(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    iso(parsed) !== value
  )
    throw new Error("Invalid calendar date");
  return parsed;
}
export function addCalendarDays(value: string, amount: number) {
  const parsed = day(value);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return iso(parsed);
}
export function weekMonday(value: string) {
  const parsed = day(value);
  return addCalendarDays(value, -((parsed.getUTCDay() + 6) % 7));
}
export function shiftCalendarMonth(value: string, amount: number) {
  const parsed = day(`${value}-01`);
  parsed.setUTCMonth(parsed.getUTCMonth() + amount);
  return iso(parsed).slice(0, 7);
}
export function shanghaiToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}-${parts.find((p) => p.type === "day")!.value}`;
}

export interface MonthWeek {
  index: number;
  weekStart: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  submitted: number;
  done: number;
  drafts: number;
  state: "empty" | "draft" | "active" | "done";
}
/** Real Monday-based weeks, clipped for display only; navigation keeps the original Monday. */
export function monthWeeks(
  month: string,
  today: string,
  records: WeeklyRecord[] = [],
): MonthWeek[] {
  const first = `${month}-01`,
    last = addCalendarDays(`${shiftCalendarMonth(month, 1)}-01`, -1);
  const weeks: MonthWeek[] = [];
  for (
    let cursor = weekMonday(first);
    cursor <= last;
    cursor = addCalendarDays(cursor, 7)
  ) {
    const week = records.filter((record) => isActiveWeeklyRecord(record) && record.weekStart === cursor);
    const submitted = week.filter(isEffectiveWeeklyRecord),
      drafts = week.length - submitted.length;
    const done = submitted.filter((record) => record.status === "done").length;
    const startDate = cursor < first ? first : cursor,
      end = addCalendarDays(cursor, 6),
      endDate = end > last ? last : end;
    weeks.push({
      index: weeks.length + 1,
      weekStart: cursor,
      startDate,
      endDate,
      isCurrent: today >= startDate && today <= endDate,
      submitted: submitted.length,
      done,
      drafts,
      state: !week.length
        ? "empty"
        : !submitted.length
          ? "draft"
          : done === submitted.length && !drafts
            ? "done"
            : "active",
    });
  }
  return weeks;
}

export interface TrendPoint {
  period: string;
  value: number | null;
}
function monthlyPoints(data: Bootstrap, month: string): TrendPoint[] {
  return [-3, -2, -1, 0].map((offset) => {
    const period = shiftCalendarMonth(month, offset);
    const published = data.plans.filter(
      (plan) => !plan.visibility && plan.month === period && plan.status === "published",
    );
    const snapshots = data.publications
      .filter((item) => item.month === period)
      .sort((a, b) => b.revision - a.revision);
    return {
      period,
      // This month is a live responsibility count; immutable publication snapshots
      // describe earlier periods and must not restore an assignment after transfer.
      value:
        offset === 0
          ? published.length
          : published.length || snapshots.length
          ? published.length || snapshots[0]?.plans.length || 0
          : null,
    };
  });
}
function weeklyPoints(data: Bootstrap, currentWeek: string): TrendPoint[] {
  return [-3, -2, -1, 0].map((offset) => {
    const period = addCalendarDays(currentWeek, offset * 7),
      records = data.weeklyRecords.filter(
        (record) => isActiveWeeklyRecord(record) && record.weekStart === period,
      );
    return {
      period,
      value:
        records.length || offset === 0
          ? records.filter(isEffectiveWeeklyRecord).length
          : null,
    };
  });
}
export function buildOverview(data: Bootstrap, today = shanghaiToday()) {
  const month = today.slice(0, 7),
    weekStart = weekMonday(today);
  const plans = data.plans.filter(
    (plan) => !plan.visibility && plan.month === month && plan.status !== "merged",
  );
  const published = plans.filter((plan) => plan.status === "published");
  const records = data.weeklyRecords.filter(
      (record) => isActiveWeeklyRecord(record) && record.weekStart === weekStart,
    ),
    submitted = records.filter(isEffectiveWeeklyRecord);
  const pending = plans.filter((plan) => plan.status === "submitted"),
    approved = plans.filter((plan) => plan.status === "approved");
  const reviewScope = plans.filter((plan) =>
    ["submitted", "returned", "approved", "published"].includes(plan.status),
  );
  const blocked = submitted.filter((record) => record.status === "blocked"),
    notDone = submitted.filter((record) => record.status === "not_done");
  const accepted = published.filter(
    (plan) => plan.acceptanceStatus === "accepted",
  );
  const awaitingAcceptance = published.filter(
    (plan) => plan.acceptanceStatus === "submitted",
  );
  const returned = plans.filter((plan) => plan.status === "returned");
  const drafts = records.filter((record) => !isEffectiveWeeklyRecord(record));
  const monthTrend = monthlyPoints(data, month),
    weekTrend = weeklyPoints(data, weekStart);
  const previousMonth = monthTrend.at(-2)!.value,
    previousWeek = weekTrend.at(-2)!.value;
  const missingMembers = data.users.filter(
    (user) =>
      user.active &&
      user.role === "member" &&
      !data.plans.some(
        (plan) =>
          plan.month === month &&
          (plan.ownerId === user.id || plan.collaboratorIds.includes(user.id)) &&
          !plan.visibility && plan.status !== "merged",
      ),
  );
  const planExecution = (plan: MonthlyPlan) => {
    const linked = records.filter((record) => record.monthlyPlanId === plan.id),
      official = linked.filter(isEffectiveWeeklyRecord);
    return {
      records: linked.length,
      submitted: official.length,
      done: official.filter((record) => record.status === "done").length,
      blocked: official.filter((record) => record.status === "blocked").length,
      notDone: official.filter((record) => record.status === "not_done").length,
      drafts: linked.length - official.length,
    };
  };
  const rank = (plan: MonthlyPlan) =>
    plan.status === "submitted"
      ? 0
      : plan.status === "approved"
        ? 1
        : planExecution(plan).blocked
          ? 2
          : plan.status === "returned"
            ? 3
            : planExecution(plan).notDone
              ? 4
              : plan.status === "draft"
                ? 5
                : !planExecution(plan).records
                  ? 6
                  : 7;
  const focusPlans = [...plans]
    .sort((a, b) => rank(a) - rank(b) || a.dueDate.localeCompare(b.dueDate))
    .slice(0, 4);
  return {
    today,
    month,
    weekStart,
    plans,
    published,
    pending,
    approved,
    reviewScope,
    records,
    submitted,
    blocked,
    notDone,
    accepted,
    awaitingAcceptance,
    returned,
    drafts,
    missingMembers,
    monthTrend,
    weekTrend,
    monthChange:
      previousMonth === null ? null : published.length - previousMonth,
    weekChange: previousWeek === null ? null : submitted.length - previousWeek,
    weeks: monthWeeks(month, today, data.weeklyRecords),
    focusPlans,
    planExecution,
  };
}
