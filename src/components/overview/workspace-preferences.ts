import { shanghaiToday } from "../../overview-data";
import type { WorkPeriod } from "../../overview-workspace-data";

export const viewLabels = {
  members: "全员工作表",
  tasks: "任务明细",
  board: "状态看板",
  projects: "项目汇总",
  timeline: "时间排期",
} as const;
export type ViewId = keyof typeof viewLabels;
export const columnLabels = {
  tasks: "任务内容",
  doing: "推进中",
  done: "自报完成",
  risk: "风险任务",
  drafts: "草稿 / 未排周",
  progress: "完成占比",
  projects: "参与项目",
} as const;
export type ColumnId = keyof typeof columnLabels;
export type SortId = "name" | "tasks" | "risk" | "due";
export interface WorkspacePreferences {
  view: ViewId;
  period: WorkPeriod;
  date: string;
  query: string;
  ownerId: string;
  projectId: string;
  status: string;
  riskOnly: boolean;
  includeInactive?: boolean;
  sort: SortId;
  columns: ColumnId[];
  group: "status" | "owner" | "project";
  density?: "comfortable" | "compact";
}
export interface SavedView {
  id: string;
  name: string;
  config: WorkspacePreferences;
}
export const defaultPreferences = (): WorkspacePreferences => ({
  view: "members",
  period: "all",
  date: shanghaiToday(),
  query: "",
  ownerId: "",
  projectId: "",
  status: "",
  riskOnly: false,
  includeInactive: false,
  sort: "name",
  columns: Object.keys(columnLabels) as ColumnId[],
  group: "status",
  density: "comfortable",
});
function validConfig(value: unknown): value is WorkspacePreferences {
  if (!value || typeof value !== "object") return false;
  const row = value as WorkspacePreferences;
  return (
    Object.hasOwn(viewLabels, row.view) &&
    ["all", "month", "week"].includes(row.period) &&
    typeof row.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
    Number.isFinite(Date.parse(row.date)) &&
    new Date(row.date).toISOString().slice(0, 10) === row.date &&
    ["query", "ownerId", "projectId", "status"].every(
      (key) => typeof row[key as keyof WorkspacePreferences] === "string",
    ) &&
    [
      "",
      "planned",
      "doing",
      "blocked",
      "done",
      "not_done",
      "draft",
      "unscheduled",
      "overdue",
    ].includes(row.status) &&
    typeof row.riskOnly === "boolean" &&
    (row.includeInactive === undefined || typeof row.includeInactive === "boolean") &&
    ["name", "tasks", "risk", "due"].includes(row.sort) &&
    ["status", "owner", "project"].includes(row.group) &&
    (row.density === undefined ||
      ["comfortable", "compact"].includes(row.density)) &&
    Array.isArray(row.columns) &&
    row.columns.every((key) => Object.hasOwn(columnLabels, key))
  );
}
export function loadSavedViews(userId: string): SavedView[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`department-views:v1:${userId}`) || "[]",
    );
    return Array.isArray(value)
      ? value
          .filter(
            (item): item is SavedView =>
              item &&
              typeof item.id === "string" &&
              typeof item.name === "string" &&
              validConfig(item.config),
          )
          .slice(0, 20)
      : [];
  } catch {
    return [];
  }
}
export function storeSavedViews(userId: string, views: SavedView[]) {
  localStorage.setItem(`department-views:v1:${userId}`, JSON.stringify(views));
}
