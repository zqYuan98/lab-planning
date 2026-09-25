import { openTask } from '../navigation';
import { useState } from "react";
import type { DepartmentOverviewResponse, OverviewDrill, OverviewRow } from "../../shared/overview-workspace";
import { useWorkspaceQuery } from "../workspace-query";
import { useDebouncedSearch } from "../use-debounced-search";
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
  LayoutGrid,
} from "lucide-react";
import {
  addCalendarDays,
  shanghaiToday,
  shiftCalendarMonth,
  weekMonday,
} from "../overview-data";
import {
  summarizeWorkRows,
} from "../overview-workspace-data";
import { Modal, type PageProps } from "../ui";
import type { Navigate } from "../navigation";
import { TaskLegend } from "../components/TaskSignals";
import { createSubmissionRequestId } from "../weekly-submission-flow";
import {
  Board,
  OverviewMemberTable,
  OverviewProjectView,
  statusLabels,
  statusOrder,
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
  const [cursors, setCursors] = useState<string[]>([""]);
  const today = shanghaiToday();
  function change(patch: Partial<WorkspacePreferences>) {
    setCursors([""]);
    setConfig((previous) => ({
      ...previous,
      ...(patch.view && patch.view !== "members" && previous.sort === "tasks"
        ? { sort: "name" as const }
        : {}),
      ...patch,
    }));
    setSelectedView("");
  }
  const querySearch = useDebouncedSearch(config.query);
  const parameters = new URLSearchParams({ period: config.period, date: config.date, includeInactive: String(!!config.includeInactive), ownerId: config.ownerId, projectId: config.projectId, status: config.status, q: querySearch, riskOnly: String(config.riskOnly), sort: config.sort, limit: '50' });
  if (cursors.at(-1)) parameters.set('cursor', cursors.at(-1)!);
  const query = useWorkspaceQuery<DepartmentOverviewResponse>(`/workspace/overview/department?${parameters}`, `${data.user.id}:${data.operationEpoch}:${data.accessScopeVersion}`, undefined, { onCursorStale: () => { const first = new URLSearchParams(parameters); first.delete('cursor'); setCursors(['']); return `/workspace/overview/department?${first}` } });
  const reloadFirst = () => { const first = new URLSearchParams(parameters); first.delete('cursor'); setCursors(['']); return query.reload(`/workspace/overview/department?${first}`) };
  const empty = { ...summarizeWorkRows([]), risk: 0 };
  const workspace = query.value;
  const rows = workspace?.items || [], members = workspace?.members || [], summary = workspace?.summary || empty;
  const memberOptions = workspace?.memberOptions || [], projectOptions = (workspace?.projectOptions || []).map(project => [project.id, project.name]);
  const setDetail = (row: OverviewRow) => openTask({ taskId: row.taskId, section: 'overview' });
  const onDrill = (patch: OverviewDrill) => change({ ...patch, ...(patch.status === 'all' ? { status: '' } : {}), view: 'tasks' });
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
              memberOptions.find((user) => user.id === config.ownerId)?.name ||
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
                : workspace?.projectOptions.find((project) => project.id === config.projectId)?.name || "历史项目",
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
                : config.status === "unplanned" ? "草稿 / 未排周" : statusLabels[config.status as OverviewRow["status"]],
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
  const periodLabel = config.period === "all" ? "全部周期" : workspace ? `${workspace.startDate} — ${workspace.endDate}` : config.date;
  const actionDate = config.period === "all" ? today : config.date;
  const metrics = [
    {
      label: "团队成员",
      icon: Users,
      tone: "neutral",
      value: members.length,
      unit: "人",
      note: "含本期暂无任务成员",
      active: config.view === "members",
      action: () => change({ view: "members" }),
    },
    {
      label: "任务总数",
      icon: List,
      tone: "blue",
      value: summary.total,
      unit: "项",
      note: "跨周任务已去重",
      active: config.view === "tasks" && !config.status && !config.riskOnly,
      action: () => change({ view: "tasks" }),
    },
    {
      label: "推进中",
      icon: CircleDashed,
      tone: "blue",
      value: summary.doing,
      unit: "项",
      note: "本期最新执行状态",
      active: false,
      action: () => onDrill({ status: "doing" }),
    },
    {
      label: "自报完成",
      icon: CheckCircle2,
      tone: "green",
      value: summary.done,
      unit: "项",
      note: "月度成果验收独立进行",
      active: false,
      action: () => onDrill({ status: "done" }),
    },
    {
      label: "需要关注",
      icon: AlertCircle,
      tone: "red",
      value: summary.risk,
      unit: "项",
      note: `${summary.blocked} 阻塞 · ${summary.notDone} 未完成 · ${summary.overdue} 逾期`,
      active: config.riskOnly,
      action: () => onDrill({ riskOnly: true }),
    },
    {
      label: "草稿·待审 / 未排周",
      icon: FileClock,
      tone: "amber",
      value: `${summary.drafts} / ${summary.unscheduled}`,
      unit: "项",
      note: "待完善工作安排",
      active: false,
      action: () => change({ view: "tasks", status: "unplanned" }),
    },
  ];
  return (
    <div className="ow-page" data-density={config.density || "comfortable"}>
      {query.loading && <p role="status">正在读取概览…</p>}
      {query.error && <p role="alert">{query.error}<button onClick={() => { void reloadFirst().catch(() => {}) }}>重新加载</button></p>}
      <header className="ow-heading">
        <div className="ow-heading-title">
          <span className="ow-heading-icon" aria-hidden="true">
            <LayoutGrid size={26} strokeWidth={2.15} />
          </span>
          <div className="ow-heading-copy">
            <h1>部门概览</h1>
            <p>团队进展与交付安排</p>
          </div>
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
              <span className="ow-metric-label">
                <span className="ow-metric-icon-shell" aria-hidden="true">
                  <metric.icon className="ow-metric-icon" size={18} />
                </span>
                <span>{metric.label}</span>
              </span>
              <ArrowRight className="ow-metric-arrow" size={16} aria-hidden="true" />
            </span>
            <strong>
              {metric.value}
              <small>{metric.unit}</small>
            </strong>
            <small>{metric.note}</small>
          </button>
        ))}
      </section>
      <TaskLegend />
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
                  !memberOptions.some(
                    (member) => member.id === config.ownerId,
                  ) && (
                    <option value={config.ownerId}>
                      {memberOptions.find((member) => member.id === config.ownerId)
                        ?.name || "历史成员"}
                      （本期无数据）
                    </option>
                  )}
                {memberOptions.map((member) => (
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
                      {workspace?.projectOptions.find((project) => project.id === config.projectId)?.name || "历史项目"}
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
                        setCursors(['']);
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
                setCursors(['']);
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
            <strong>{summary.total}</strong> 项任务
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
            <OverviewMemberTable members={members} columns={config.columns} onOpen={setDetail} onDrill={onDrill} />
          ) : config.view === "tasks" ? (
            <TaskTable rows={rows} onOpen={setDetail} />
          ) : config.view === "board" ? (
            <Board rows={rows} group={config.group} onOpen={setDetail} totals={workspace?.groups[config.group]} onFilter={onDrill} />
          ) : config.view === "projects" ? (
            <OverviewProjectView groups={workspace?.groups.project || []} onDrill={onDrill} />
          ) : (
            <Timeline rows={rows} onOpen={setDetail} />
          )}
        </div>
        {['tasks', 'board', 'timeline'].includes(config.view) && <div className="ow-filter-note" aria-label="任务分页">
          <span>第 {cursors.length} 页 · 本页 {rows.length} 项 / 共 {summary.total} 项</span>
          <button disabled={cursors.length === 1 || query.loading} onClick={() => setCursors(previous => previous.slice(0, -1))}>上一页</button>
          <button disabled={!workspace?.nextCursor || query.loading} onClick={() => setCursors(previous => [...previous, workspace!.nextCursor!])}>下一页</button>
        </div>}
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
