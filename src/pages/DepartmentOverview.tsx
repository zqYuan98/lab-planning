import { useMemo, useState } from "react";
import {
  Users,
  List,
  Columns3,
  FolderKanban,
  CalendarDays,
  Search,
  SlidersHorizontal,
  Bookmark,
  RotateCcw,
  ArrowLeft,
  ArrowRight,
  Plus,
  X,
  Filter,
  CheckCircle2,
  CircleDashed,
  AlertCircle,
  FileClock,
} from "lucide-react";
import {
  addCalendarDays,
  shanghaiToday,
  shiftCalendarMonth,
  weekMonday,
} from "../overview-data";
import {
  buildWorkspace,
  filterWorkRows,
  summarizeWorkRows,
  type WorkFilters,
  type WorkRow,
} from "../overview-workspace-data";
import { Modal, type PageProps } from "../ui";
import type { Navigate } from "../navigation";
import WorkOriginLabel from "../components/WorkOriginLabel";
import { createSubmissionRequestId, weeklyRecordState } from "../weekly-submission-flow";
import { isEffectiveWeeklyRecord } from "../../shared/weekly-record-state";
import {
  Board,
  MemberTable,
  NoRows,
  ProjectView,
  riskRows,
  statusLabels,
  statusOrder,
  StatusPill,
  TaskTable,
  Timeline,
} from "../components/overview/WorkspaceViews";
import {
  columnLabels,
  defaultPreferences,
  loadSavedViews,
  storeSavedViews,
  viewLabels,
  type ColumnId,
  type SavedView,
  type ViewId,
  type WorkspacePreferences,
} from "../components/overview/workspace-preferences";
import "../overview-workspace.css";

const viewIcons = {
  members: Users,
  tasks: List,
  board: Columns3,
  projects: FolderKanban,
  timeline: CalendarDays,
};
const compareName = (a: WorkRow, b: WorkRow) =>
  a.ownerName.localeCompare(b.ownerName, "zh-CN") ||
  a.title.localeCompare(b.title, "zh-CN");

export default function DepartmentOverview({
  data,
  navigate,
  notify,
}: PageProps & { navigate: Navigate }) {
  const [config, setConfig] = useState(defaultPreferences);
  const [settings, setSettings] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [savedViews, setSavedViews] = useState(() =>
    loadSavedViews(data.user.id),
  );
  const [selectedView, setSelectedView] = useState("");
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<WorkRow | null>(null);
  const [drill, setDrill] = useState<{ title: string; rows: WorkRow[] } | null>(
    null,
  );
  const today = shanghaiToday();
  function change(patch: Partial<WorkspacePreferences>) {
    setConfig((previous) => ({
      ...previous,
      ...(patch.view && patch.view !== "members" && previous.sort === "tasks"
        ? { sort: "name" as const }
        : {}),
      ...patch,
    }));
    setSelectedView("");
  }
  const workspace = useMemo(
    () =>
      buildWorkspace(data, { period: config.period, date: config.date, includeInactive: config.includeInactive }, today),
    [data, config.period, config.date, config.includeInactive, today],
  );
  const rows = useMemo(() => {
    const work = filterWorkRows(workspace.rows, {
      ...config,
      status: config.status as WorkFilters["status"],
    });
    return [...work].sort(
      (a, b) =>
        (config.sort === "due"
          ? (a.dueDate || "9999").localeCompare(b.dueDate || "9999")
          : config.sort === "risk"
            ? Number(
                b.overdue || b.status === "blocked" || b.status === "not_done",
              ) -
              Number(
                a.overdue || a.status === "blocked" || a.status === "not_done",
              )
            : 0) || compareName(a, b),
    );
  }, [workspace.rows, config]);
  const summary = summarizeWorkRows(rows);
  const represented = new Set(rows.map((row) => row.ownerId));
  const members = workspace.members.filter((member) => {
    if (config.ownerId && member.id !== config.ownerId) return false;
    if (config.projectId || config.status || config.riskOnly)
      return represented.has(member.id);
    return (
      !config.query.trim() ||
      represented.has(member.id) ||
      member.name
        .toLocaleLowerCase()
        .includes(config.query.trim().toLocaleLowerCase())
    );
  });
  const projectOptions = [
    ...new Map(
      workspace.rows
        .filter((row) => row.projectId)
        .map((row) => [row.projectId!, row.projectName]),
    ).entries(),
  ];
  const hasFilters = Boolean(
    config.query ||
    config.ownerId ||
    config.projectId ||
    config.status ||
    config.riskOnly || config.includeInactive,
  );
  const filterCount = [
    config.ownerId,
    config.projectId,
    config.status,
    config.riskOnly,
    config.includeInactive,
  ].filter(Boolean).length;
  const filterChips = [
    ...(config.includeInactive
      ? [{ key: "inactive", label: "包含停用成员", clear: () => change({ includeInactive: false, ownerId: "" }) }]
      : []),
    ...(config.query
      ? [
          {
            key: "query",
            label: `搜索：${config.query}`,
            clear: () => change({ query: "" }),
          },
        ]
      : []),
    ...(config.ownerId
      ? [
          {
            key: "owner",
            label:
              data.users.find((user) => user.id === config.ownerId)?.name ||
              "历史成员",
            clear: () => change({ ownerId: "" }),
          },
        ]
      : []),
    ...(config.projectId
      ? [
          {
            key: "project",
            label:
              config.projectId === "__none__"
                ? "未关联项目"
                : data.projects.find(
                    (project) => project.id === config.projectId,
                  )?.name || "历史项目",
            clear: () => change({ projectId: "" }),
          },
        ]
      : []),
    ...(config.status
      ? [
          {
            key: "status",
            label:
              config.status === "overdue"
                ? "已逾期"
                : statusLabels[config.status as WorkRow["status"]],
            clear: () => change({ status: "" }),
          },
        ]
      : []),
    ...(config.riskOnly
      ? [
          {
            key: "risk",
            label: "只看风险",
            clear: () => change({ riskOnly: false }),
          },
        ]
      : []),
  ];
  const clearFilters = () =>
    change({
      query: "",
      ownerId: "",
      projectId: "",
      status: "",
      riskOnly: false,
      includeInactive: false,
    });
  const onDrill = (title: string, work: WorkRow[]) =>
    setDrill({ title, rows: work });
  function shiftPeriod(amount: number) {
    change({
      date:
        config.period === "week"
          ? addCalendarDays(config.date, 7 * amount)
          : `${shiftCalendarMonth(config.date.slice(0, 7), amount)}-01`,
    });
  }
  function saveView() {
    const name = saveName.trim();
    if (!name) return;
    if (savedViews.length >= 20) {
      notify("最多保存 20 个视图，请先删除不再使用的视图。");
      return;
    }
    try {
      const item: SavedView = {
        id: createSubmissionRequestId(),
        name,
        config: { ...config, columns: [...config.columns] },
      };
      const next = [...savedViews, item];
      storeSavedViews(data.user.id, next);
      setSavedViews(next);
      setSelectedView(item.id);
      setSaving(false);
      setSaveName("");
      notify("已保存视图，可在“视图设置”中切换。");
    } catch {
      notify("当前浏览器无法保存视图，当前筛选仍可继续使用。");
    }
  }
  function deleteView() {
    const next = savedViews.filter((view) => view.id !== selectedView);
    try {
      storeSavedViews(data.user.id, next);
      setSavedViews(next);
      setSelectedView("");
      notify("已删除保存的视图。");
    } catch {
      notify("当前浏览器无法更新保存的视图。");
    }
  }
  function openRecord(row: WorkRow) {
    navigate("weekly", {
      id: row.record?.id || row.taskId,
      weekStart: row.record?.weekStart || weekMonday(config.date),
      query: row.title,
    });
  }
  const periodLabel =
    config.period === "all"
      ? "全部周期"
      : `${workspace.startDate} — ${workspace.endDate}`;
  const actionDate = config.period === "all" ? today : config.date;
  function taskWeek(row: WorkRow) {
    const plan = row.task?.monthlyPlanId
      ? data.plans.find((plan) => plan.id === row.task!.monthlyPlanId)
      : undefined;
    // New work must intersect the task's current goal month, including after a historical relink.
    const anchor =
      plan && plan.month !== actionDate.slice(0, 7)
        ? `${plan.month}-01`
        : actionDate;
    return weekMonday(anchor);
  }
  const metrics = [
    {
      label: "可见成员",
      icon: Users,
      tone: "neutral",
      value: members.length,
      unit: "人",
      note: "含所选周期暂无任务的成员",
      active: config.view === "members",
      action: () => change({ view: "members" }),
    },
    {
      label: "任务总数",
      icon: List,
      tone: "blue",
      value: summary.total,
      unit: "项",
      note: "跨周记录按任务去重",
      active: config.view === "tasks" && !config.status && !config.riskOnly,
      action: () => onDrill("当前筛选的全部任务", rows),
    },
    {
      label: "推进中",
      icon: CircleDashed,
      tone: "blue",
      value: summary.doing,
      unit: "项",
      note: "按所选周期最新周记录",
      active: false,
      action: () =>
        onDrill(
          "推进中的任务",
          rows.filter((row) => row.status === "doing"),
        ),
    },
    {
      label: "自报完成",
      icon: CheckCircle2,
      tone: "green",
      value: summary.done,
      unit: "项",
      note: "月度成果验收独立进行",
      active: false,
      action: () =>
        onDrill(
          "自报完成的任务",
          rows.filter((row) => row.status === "done"),
        ),
    },
    {
      label: "需要关注",
      icon: AlertCircle,
      tone: "red",
      value: riskRows(rows).length,
      unit: "项",
      note: `${summary.blocked} 阻塞 · ${summary.notDone} 未完成 · ${summary.overdue} 逾期`,
      active: config.riskOnly,
      action: () => onDrill("需要关注的任务（去重）", riskRows(rows)),
    },
    {
      label: "草稿待审 / 未排周",
      icon: FileClock,
      tone: "amber",
      value: `${summary.drafts} / ${summary.unscheduled}`,
      unit: "项",
      note: "查看尚待完善的工作安排",
      active: false,
      action: () =>
        onDrill(
          "草稿、待审核与未排周的任务",
          rows.filter(
            (row) => row.status === "draft" || row.status === "unscheduled",
          ),
        ),
    },
  ];
  return (
    <div className="ow-page" data-density={config.density || "comfortable"}>
      <header className="ow-heading">
        <div className="ow-heading-copy">
          <h1>部门概览</h1>
          <p>全员任务、项目进展与交付安排，一处看清。</p>
        </div>
        <div className="ow-heading-controls">
          <div className="ow-period-bar">
            <div className="ow-segmented" aria-label="统计周期">
              {(
                [
                  ["all", "全部"],
                  ["month", "按月"],
                  ["week", "按周"],
                ] as const
              ).map(([period, label]) => (
                <button
                  key={period}
                  aria-pressed={config.period === period}
                  onClick={() => change({ period })}
                >
                  {label}
                </button>
              ))}
            </div>
            {config.period !== "all" && (
              <>
                <button
                  className="ow-button"
                  aria-label="上一周期"
                  onClick={() => shiftPeriod(-1)}
                >
                  <ArrowLeft size={15} />
                </button>
                <label>
                  <span className="sr-only">选择统计日期</span>
                  <input
                    aria-label="选择统计日期"
                    type={config.period === "month" ? "month" : "date"}
                    value={
                      config.period === "month"
                        ? config.date.slice(0, 7)
                        : config.date
                    }
                    onChange={(event) => {
                      if (event.target.value)
                        change({
                          date:
                            config.period === "month"
                              ? `${event.target.value}-01`
                              : event.target.value,
                        });
                    }}
                  />
                </label>
                <button
                  className="ow-button"
                  aria-label="下一周期"
                  onClick={() => shiftPeriod(1)}
                >
                  <ArrowRight size={15} />
                </button>
                <button
                  className="ow-button"
                  onClick={() => change({ date: today })}
                >
                  回到本期
                </button>
              </>
            )}
            <span className="ow-period-label">
              <CalendarDays size={14} aria-hidden="true" />
              {periodLabel}
            </span>
          </div>
          <div className="ow-actions">
            <button
              className="ow-button"
              onClick={() =>
                navigate("monthly", { month: actionDate.slice(0, 7) })
              }
            >
              月度目标
            </button>
            <button
              className="ow-button is-primary"
              onClick={() =>
                navigate("weekly", {
                  action: "create",
                  weekStart: weekMonday(actionDate),
                })
              }
            >
              <Plus size={16} />
              安排任务
            </button>
          </div>
        </div>
      </header>
      <section className="ow-metrics" aria-label="当前筛选范围统计">
        {metrics.map((metric) => (
          <button
            key={metric.label}
            className={`ow-metric${metric.active ? " is-active" : ""}`}
            data-tone={metric.tone}
            onClick={metric.action}
          >
            <span className="ow-metric-top">
              <span>{metric.label}</span>
              <metric.icon
                className="ow-metric-icon"
                size={17}
                aria-hidden="true"
              />
            </span>
            <strong>
              {metric.value}
              <small>{metric.unit}</small>
            </strong>
            <small>{metric.note}</small>
          </button>
        ))}
      </section>
      <section className="ow-workspace" aria-label="部门多维工作空间">
        <label className="ow-mobile-view">
          <span>展示视图</span>
          <select
            aria-label="切换展示视图"
            value={config.view}
            onChange={(event) => change({ view: event.target.value as ViewId })}
          >
            {(Object.keys(viewLabels) as ViewId[]).map((view) => (
              <option key={view} value={view}>
                {viewLabels[view]}
              </option>
            ))}
          </select>
        </label>
        <div className="ow-viewbar" role="tablist" aria-label="数据展示视图">
          {(Object.keys(viewLabels) as ViewId[]).map((view) => {
            const Icon = viewIcons[view];
            return (
              <button
                className="ow-tab"
                key={view}
                id={`ow-tab-${view}`}
                role="tab"
                aria-selected={config.view === view}
                aria-controls="ow-view-panel"
                tabIndex={config.view === view ? 0 : -1}
                onKeyDown={(event) => {
                  if (
                    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  ) {
                    event.preventDefault();
                    const keys = Object.keys(viewLabels) as ViewId[];
                    const index = keys.indexOf(view);
                    const next =
                      keys[
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? keys.length - 1
                            : (index +
                                (event.key === "ArrowRight"
                                  ? 1
                                  : keys.length - 1)) %
                              keys.length
                      ];
                    change({ view: next });
                    document.getElementById(`ow-tab-${next}`)?.focus();
                  }
                }}
                onClick={() => change({ view })}
              >
                <Icon size={16} aria-hidden="true" />
                {viewLabels[view]}
              </button>
            );
          })}
        </div>
        <div className="ow-toolbar">
          <label className="ow-search">
            <Search size={16} aria-hidden="true" />
            <input
              aria-label="搜索成员、任务或项目"
              placeholder="搜索成员、任务或项目"
              value={config.query}
              onChange={(event) => change({ query: event.target.value })}
            />
          </label>
          <button
            className={`ow-button ow-filter-toggle${filterCount ? " is-active" : ""}`}
            aria-expanded={filtersOpen}
            aria-controls="ow-filter-fields"
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            <Filter size={16} aria-hidden="true" />
            筛选
            {filterCount > 0 && (
              <span className="ow-filter-count">{filterCount}</span>
            )}
          </button>
          <div
            className="ow-filter-fields"
            id="ow-filter-fields"
            data-expanded={filtersOpen}
          >
            <label className="ow-select">
              <span>成员</span>
              <select
                aria-label="负责人筛选"
                value={config.ownerId}
                onChange={(event) => change({ ownerId: event.target.value })}
              >
                <option value="">全部成员</option>
                {config.ownerId &&
                  !workspace.members.some(
                    (member) => member.id === config.ownerId,
                  ) && (
                    <option value={config.ownerId}>
                      {data.users.find((member) => member.id === config.ownerId)
                        ?.name || "历史成员"}
                      （本期无数据）
                    </option>
                  )}
                {workspace.members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                    {!member.active ? "（已停用）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="ow-select">
              <span>项目</span>
              <select
                aria-label="项目筛选"
                value={config.projectId}
                onChange={(event) => change({ projectId: event.target.value })}
              >
                <option value="">全部项目</option>
                {config.projectId &&
                  config.projectId !== "__none__" &&
                  !projectOptions.some(([id]) => id === config.projectId) && (
                    <option value={config.projectId}>
                      {data.projects.find(
                        (project) => project.id === config.projectId,
                      )?.name || "历史项目"}
                      （本期无数据）
                    </option>
                  )}
                {projectOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
                <option value="__none__">未关联项目</option>
              </select>
            </label>
            <label className="ow-select">
              <span>状态</span>
              <select
                aria-label="执行状态筛选"
                value={config.status}
                onChange={(event) => change({ status: event.target.value })}
              >
                <option value="">全部状态</option>
                {statusOrder.map((status) => (
                  <option key={status} value={status}>
                    {statusLabels[status]}
                  </option>
                ))}
                <option value="overdue">已逾期</option>
              </select>
            </label>
            <button
              className={`ow-button${config.riskOnly ? " is-active" : ""}`}
              aria-pressed={config.riskOnly}
              onClick={() => change({ riskOnly: !config.riskOnly })}
            >
              <AlertCircle size={14} aria-hidden="true" />
              只看风险
            </button>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={!!config.includeInactive}
                onChange={(event) => change({ includeInactive: event.target.checked, ownerId: "" })}
              />
              包含停用成员
            </label>
          </div>
          <div className="ow-toolbar-end">
            <button
              className={`ow-button${settings ? " is-active" : ""}`}
              aria-expanded={settings}
              aria-controls="ow-view-settings"
              onClick={() => setSettings(!settings)}
            >
              <SlidersHorizontal size={15} aria-hidden="true" />
              视图设置
            </button>
            <button
              className="ow-button"
              onClick={() => {
                setSaveName(viewLabels[config.view]);
                setSaving(true);
              }}
            >
              <Bookmark size={15} aria-hidden="true" />
              保存视图
            </button>
          </div>
        </div>
        {settings && (
          <div className="ow-config" id="ow-view-settings">
            {savedViews.length > 0 && (
              <div className="ow-saved-bar">
                <label>
                  常用视图{" "}
                  <select
                    aria-label="切换已保存视图"
                    value={selectedView}
                    onChange={(event) => {
                      const view = savedViews.find(
                        (item) => item.id === event.target.value,
                      );
                      if (view) {
                        setConfig({
                          ...view.config,
                          columns: [...view.config.columns],
                        });
                        setSelectedView(view.id);
                      } else setSelectedView("");
                    }}
                  >
                    <option value="">当前自定义视图</option>
                    {savedViews.map((view) => (
                      <option key={view.id} value={view.id}>
                        {view.name}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedView && (
                  <button className="ow-button" onClick={deleteView}>
                    <X size={14} />
                    删除此视图
                  </button>
                )}
                <small className="ow-muted">仅保存本浏览器的视图配置</small>
              </div>
            )}

            <div className="ow-density">
              <span>显示密度</span>
              <div className="ow-segmented" aria-label="显示密度">
                {(["comfortable", "compact"] as const).map((density) => (
                  <button
                    key={density}
                    aria-pressed={(config.density || "comfortable") === density}
                    onClick={() => change({ density })}
                  >
                    {density === "comfortable" ? "舒适" : "紧凑"}
                  </button>
                ))}
              </div>
            </div>
            <label className="ow-select">
              排序{" "}
              <select
                aria-label="排序方式"
                value={config.sort}
                onChange={(event) =>
                  change({
                    sort: event.target.value as WorkspacePreferences["sort"],
                  })
                }
              >
                <option value="name">按成员姓名</option>
                {config.view === "members" && (
                  <option value="tasks">按任务数量（多到少）</option>
                )}
                <option value="risk">按风险优先</option>
                <option value="due">按截止日期</option>
              </select>
            </label>
            {config.view === "board" && (
              <label className="ow-select">
                分组{" "}
                <select
                  aria-label="看板分组"
                  value={config.group}
                  onChange={(event) =>
                    change({
                      group: event.target
                        .value as WorkspacePreferences["group"],
                    })
                  }
                >
                  <option value="status">按状态</option>
                  <option value="owner">按负责人</option>
                  <option value="project">按项目</option>
                </select>
              </label>
            )}
            {config.view === "members" && (
              <fieldset className="ow-columns">
                <legend>表格显示字段</legend>
                {(Object.keys(columnLabels) as ColumnId[]).map((column) => (
                  <label key={column}>
                    <input
                      type="checkbox"
                      checked={config.columns.includes(column)}
                      onChange={(event) =>
                        change({
                          columns: event.target.checked
                            ? (Object.keys(columnLabels) as ColumnId[]).filter(
                                (key) =>
                                  key === column ||
                                  config.columns.includes(key),
                              )
                            : config.columns.filter((key) => key !== column),
                        })
                      }
                    />
                    {columnLabels[column]}
                  </label>
                ))}
              </fieldset>
            )}
            <button
              className="ow-button"
              onClick={() => {
                setConfig(defaultPreferences());
                setSelectedView("");
              }}
            >
              <RotateCcw size={14} />
              恢复默认视图
            </button>
          </div>
        )}
        <div className="ow-filter-note" role="status">
          <span>
            <strong>{members.length}</strong> 位成员
            <span className="ow-meta-divider"> / </span>
            <strong>{rows.length}</strong> 项任务
            {config.includeInactive ? " · 包含停用成员的历史工作" : " · 仅启用成员"}
            {config.view === "members" && !hasFilters
              ? " · 含暂无任务成员"
              : ""}
          </span>
          {hasFilters && (
            <button className="ow-title-button" onClick={clearFilters}>
              清除筛选
            </button>
          )}
          {config.view === "board" && (
            <label className="ow-select">
              分组{" "}
              <select
                aria-label="快速切换看板分组"
                value={config.group}
                onChange={(event) =>
                  change({
                    group: event.target.value as WorkspacePreferences["group"],
                  })
                }
              >
                <option value="status">状态</option>
                <option value="owner">负责人</option>
                <option value="project">项目</option>
              </select>
            </label>
          )}
        </div>
        {hasFilters && (
          <div className="ow-filter-chips" aria-label="当前筛选条件">
            {filterChips.map((chip) => (
              <button
                key={chip.key}
                onClick={chip.clear}
                aria-label={`移除筛选：${chip.label}`}
              >
                {chip.label}
                <X size={12} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        <div
          id="ow-view-panel"
          role="tabpanel"
          aria-labelledby={`ow-tab-${config.view}`}
          tabIndex={0}
        >
          {config.view === "members" ? (
            <MemberTable
              members={members}
              rows={rows}
              columns={config.columns}
              sort={config.sort}
              onOpen={setDetail}
              onDrill={onDrill}
            />
          ) : config.view === "tasks" ? (
            <TaskTable rows={rows} onOpen={setDetail} />
          ) : config.view === "board" ? (
            <Board rows={rows} group={config.group} onOpen={setDetail} />
          ) : config.view === "projects" ? (
            <ProjectView rows={rows} onDrill={onDrill} />
          ) : (
            <Timeline rows={rows} onOpen={setDetail} />
          )}
        </div>
        <footer className="ow-footer">
          <span>
            {viewLabels[config.view]} · {periodLabel}
          </span>
          <span>
            {summary.officialCount} 条周记录已纳入统计 · {summary.draftCount}{" "}
            条草稿或待审计划
          </span>
        </footer>
      </section>
      <details className="ow-fact-note">
        <summary>统计口径与说明</summary>
        <p>
          任务按编号去重，状态取所选周期最新周记录；草稿和待审计划单列，未排周表示该周期没有周记录。月度目标或截止日命中的任务也纳入月视图。逾期按当前截止日期与今天比较，历史周期不还原历史截止日期。单条周记录纳入统计不代表整份周提报已提交。
        </p>
      </details>
      {drill && (
        <Modal wide title={drill.title} onClose={() => setDrill(null)}>
          <div className="ow-page">
            <p className="ow-muted">
              {drill.rows.length} 项任务 · {periodLabel}
            </p>
            {drill.rows.length ? (
              <TaskTable
                rows={drill.rows}
                onOpen={(row) => {
                  setDrill(null);
                  setDetail(row);
                }}
              />
            ) : (
              <NoRows text="当前没有此类任务" />
            )}
          </div>
        </Modal>
      )}
      {detail && (
        <Modal wide title={detail.title} onClose={() => setDetail(null)}>
          <div className="ow-page">
            <div className="ow-detail-meta">
              <span>负责人：{detail.ownerName}</span>
              <StatusPill row={detail} />
              <span className={detail.overdue ? "ow-overdue" : ""}>
                截止：{detail.dueDate || "未设置"}
                {detail.overdue && " · 已逾期"}
              </span>
            </div>
            <p>
              {detail.projectName} / {detail.planTitle}
            </p>
            {(detail.record || detail.task) && (
              <WorkOriginLabel
                row={(detail.record || detail.task)!}
                data={data}
              />
            )}
            <p className="ow-muted">
              {detail.task?.description || "暂无任务说明"}
            </p>
            <div className="ow-detail-list">
              {detail.records.length ? (
                detail.records.map((record) => (
                  <article key={record.id}>
                    <div className="ow-detail-meta">
                      <strong>{record.weekStart} 当周</strong>
                      <span
                        className={`ow-pill status-${isEffectiveWeeklyRecord(record) ? record.status : "draft"}`}
                      >
                        {isEffectiveWeeklyRecord(record)
                          ? statusLabels[record.status]
                          : weeklyRecordState(record).label}
                      </span>
                    </div>
                    <p>
                      <strong>本周承诺：</strong>
                      {record.commitment || "未填写"}
                    </p>
                    {record.actualOutcome && (
                      <p>
                        <strong>实际进展：</strong>
                        {record.actualOutcome}
                      </p>
                    )}
                    {record.blocker && (
                      <p className="ow-overdue">
                        <strong>阻塞 / 原因：</strong>
                        {record.blocker}
                      </p>
                    )}
                    {record.nextAction && (
                      <p>
                        <strong>下一步：</strong>
                        {record.nextAction}
                      </p>
                    )}
                    <button
                      className="ow-title-button"
                      onClick={() => openRecord({ ...detail, record })}
                    >
                      打开这条周记录
                      <ArrowRight size={14} />
                    </button>
                  </article>
                ))
              ) : (
                <NoRows text="该周期尚未安排周记录">
                  <button
                    className="ow-button is-primary"
                    onClick={() =>
                      navigate("weekly", {
                        action: "create",
                        id: detail.taskId,
                        weekStart: taskWeek(detail),
                      })
                    }
                  >
                    为此任务安排周工作
                  </button>
                </NoRows>
              )}
            </div>
            {detail.planId && (
              <button
                className="ow-button"
                onClick={() =>
                  navigate("monthly", {
                    id: detail.planId!,
                    month:
                      data.plans.find((plan) => plan.id === detail.planId)
                        ?.month || config.date.slice(0, 7),
                  })
                }
              >
                查看关联月度目标
              </button>
            )}
          </div>
        </Modal>
      )}
      {saving && (
        <Modal title="保存常用视图" onClose={() => setSaving(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              saveView();
            }}
          >
            <label className="field">
              <span>视图名称</span>
              <input
                aria-label="视图名称"
                required
                maxLength={40}
                value={saveName}
                onChange={(event) => setSaveName(event.target.value)}
              />
            </label>
            <p className="ow-muted">
              保存当前视图、周期日期、筛选、排序、分组与显示字段。下次可从“常用视图”恢复。
            </p>
            <button
              className="button primary"
              disabled={!saveName.trim()}
              type="submit"
            >
              保存
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
