import { Fragment } from "react";
import { ChevronRight, Inbox, AlertCircle, CalendarDays } from "lucide-react";
import type { User } from "../../../shared/types";
import { addCalendarDays, shanghaiToday } from "../../overview-data";
import { previewWorkRows, summarizeWorkRows } from "../../overview-workspace-data";
import type { OverviewDrill, OverviewGroup, OverviewMember, OverviewRow as WorkRow } from '../../../shared/overview-workspace';
import { PriorityBadge, WorkTypeBadge } from "../TaskSignals";
import { priorityLabels, workKindLabels } from "../../task-presentation";
import {
  columnLabels,
  type ColumnId,
  type SortId,
} from "./workspace-preferences";

export const statusLabels: Record<WorkRow["status"], string> = {
  planned: "未开始",
  doing: "推进中",
  blocked: "阻塞",
  done: "自报完成",
  not_done: "未完成",
  draft: "周草稿",
  unscheduled: "未排周",
};
export const statusOrder = Object.keys(statusLabels) as WorkRow["status"][];
export const riskRows = (rows: WorkRow[]) =>
  rows.filter(
    (row) =>
      row.overdue || row.status === "blocked" || row.status === "not_done",
  );
const avatarColor = (id: string) =>
  Array.from(id).reduce((sum, character) => sum + character.charCodeAt(0), 0) %
  5;
export function StatusPill({ row }: { row: WorkRow }) {
  return (
    <span className={`ow-pill status-${row.status}`}>
      {statusLabels[row.status]}
    </span>
  );
}
export function NoRows({
  text = "当前条件下没有任务",
  children,
}: {
  text?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="ow-empty">
      <Inbox size={28} aria-hidden="true" />
      <strong>{text}</strong>
      {children}
    </div>
  );
}
type RowAction = (row: WorkRow) => void;
type DrillAction = (title: string, rows: WorkRow[]) => void;
export const workRowClass = (row: WorkRow) =>
  `task-priority-${row.priority || "none"} task-kind-${row.workKind || "routine"}`;
export function WorkRowSignals({ row }: { row: WorkRow }) {
  return (
    <span className="task-signals">
      <PriorityBadge priority={row.priority} />
      <WorkTypeBadge isTemporary={row.workKind === "temporary"} isMonthly={row.workKind === "monthly"} />
    </span>
  );
}
function TaskCount({
  rows,
  label,
  drill,
}: {
  rows: WorkRow[];
  label: string;
  drill: DrillAction;
}) {
  return rows.length ? (
    <button
      className="ow-count"
      onClick={() => drill(label, rows)}
      aria-label={`${label}，${rows.length} 项`}
    >
      {rows.length}
    </button>
  ) : (
    <span className="ow-zero">0</span>
  );
}
function TaskPreview({ rows, onOpen, onExpand }: { rows: WorkRow[]; onOpen: RowAction; onExpand: () => void }) {
  return (
    <div className="ow-task-preview">
      {rows.length ? (
        previewWorkRows(rows).map((row) => (
          <button
            key={row.id}
            className={`ow-title-button ${workRowClass(row)}`}
            title={row.title}
            aria-label={`${row.title}，${priorityLabels[row.priority || "none"]}，${workKindLabels[row.workKind || "routine"]}，${statusLabels[row.status]}${row.overdue ? "，逾期" : ""}`}
            onClick={() => onOpen(row)}
          >
            <span className="ow-preview-title">{row.title}</span>
            <span className="ow-preview-tags">
              <WorkRowSignals row={row} />
              <StatusPill row={row} />
              {row.overdue && (
                <small className="ow-overdue">
                  <AlertCircle size={12} aria-hidden="true" />
                  逾期
                </small>
              )}
            </span>
          </button>
        ))
      ) : (
        <span className="ow-empty-member">本期暂无任务安排</span>
      )}
      {rows.length > 3 && (
        <button className="ow-title-button ow-preview-more" onClick={onExpand}>
          查看全部 {rows.length} 项 <ChevronRight size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
export function MemberTable({
  members,
  rows,
  columns,
  sort,
  onOpen,
  onDrill,
}: {
  members: User[];
  rows: WorkRow[];
  columns: ColumnId[];
  sort: SortId;
  onOpen: RowAction;
  onDrill: DrillAction;
}) {
  const byOwner = new Map<string, WorkRow[]>();
  for (const row of rows)
    byOwner.set(row.ownerId, [...(byOwner.get(row.ownerId) || []), row]);
  const people = members
    .map((user) => {
      const work = byOwner.get(user.id) || [];
      return {
        user,
        work,
        summary: summarizeWorkRows(work),
        risks: riskRows(work),
        due: work.map((row) => row.dueDate || "9999").sort()[0] || "9999",
      };
    })
    .sort(
      (a, b) =>
        (sort === "tasks"
          ? b.work.length - a.work.length
          : sort === "risk"
            ? b.risks.length - a.risks.length
            : sort === "due"
              ? a.due.localeCompare(b.due)
              : 0) || a.user.name.localeCompare(b.user.name, "zh-CN"),
    );
  if (!people.length) return <NoRows text="当前条件下没有成员" />;
  return (
    <>
      <div
        className="ow-table-wrap ow-member-table"
        tabIndex={0}
        role="region"
        aria-label="可横向滚动的全员工作表"
      >
        <table className="ow-table" aria-label="全员任务与进展">
          <thead>
            <tr>
              <th scope="col" className="ow-person-cell">
                成员 <span className="ow-muted">{people.length}</span>
              </th>
              <th scope="col">任务数</th>
              {columns.map((column) => (
                <th scope="col" key={column} className={`ow-col-${column}`}>
                  {columnLabels[column]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.map(({ user, work, summary, risks }) => (
              <tr key={user.id}>
                <th scope="row" className="ow-person-cell">
                  <div className="ow-person">
                    <span
                      className="ow-avatar"
                      data-color={avatarColor(user.id)}
                      aria-hidden="true"
                    >
                      {user.name.slice(-2)}
                    </span>
                    <div>
                      <strong>{user.name}</strong>
                      <span className="ow-person-meta">
                        {!user.active
                          ? "已停用 · 历史任务"
                          : user.position ||
                            (user.role === "manager" ? "管理者" : "团队成员")}
                      </span>
                    </div>
                  </div>
                </th>
                <td>
                  <TaskCount
                    rows={work}
                    label={`${user.name}的全部任务`}
                    drill={onDrill}
                  />
                </td>
                {columns.map((column) => (
                  <td key={column} className={`ow-col-${column}`}>
                    {column === "projects" ? (
                      <span>
                        {work.length ? (
                          [...new Set(work.map((row) => row.projectName))].join(
                            "、",
                          )
                        ) : (
                          <span className="ow-muted">暂无项目任务</span>
                        )}
                      </span>
                    ) : column === "doing" ? (
                      <TaskCount
                        rows={work.filter((row) => row.status === "doing")}
                        label={`${user.name}推进中的任务`}
                        drill={onDrill}
                      />
                    ) : column === "done" ? (
                      <TaskCount
                        rows={work.filter((row) => row.status === "done")}
                        label={`${user.name}自报完成的任务`}
                        drill={onDrill}
                      />
                    ) : column === "risk" ? (
                      <TaskCount
                        rows={risks}
                        label={`${user.name}的风险任务`}
                        drill={onDrill}
                      />
                    ) : column === "drafts" ? (
                      <>
                        <TaskCount
                          rows={work.filter((row) => row.status === "draft")}
                          label={`${user.name}的周草稿任务`}
                          drill={onDrill}
                        />
                        <span className="ow-muted"> / </span>
                        <TaskCount
                          rows={work.filter(
                            (row) => row.status === "unscheduled",
                          )}
                          label={`${user.name}未排周的任务`}
                          drill={onDrill}
                        />
                      </>
                    ) : column === "progress" ? (
                      work.length ? (
                        <div
                          className="ow-progress"
                          aria-label={`自报完成 ${summary.done} / ${work.length}`}
                        >
                          <span>
                            <i
                              style={{
                                width: `${(summary.done / work.length) * 100}%`,
                              }}
                            />
                          </span>
                          <small>
                            {Math.round((summary.done / work.length) * 100)}%
                          </small>
                        </div>
                      ) : (
                        <span className="ow-muted">暂无任务</span>
                      )
                    ) : (
                      <TaskPreview rows={work} onOpen={onOpen} onExpand={() => onDrill(`${user.name}的全部任务`, work)} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ow-member-cards" aria-label="全员任务卡片">
        {people.map(({ user, work, summary, risks }) => (
          <article className="ow-member-card" key={user.id}>
            <header>
              <div className="ow-person">
                <span
                  className="ow-avatar"
                  data-color={avatarColor(user.id)}
                  aria-hidden="true"
                >
                  {user.name.slice(-2)}
                </span>
                <div>
                  <strong>{user.name}</strong>
                  <span className="ow-person-meta">
                    {!user.active
                      ? "已停用 · 历史任务"
                      : user.position || "团队成员"}
                  </span>
                </div>
              </div>
              <button
                className="ow-member-total"
                onClick={() => onDrill(`${user.name}的全部任务`, work)}
                aria-label={`${user.name}的全部任务，${work.length} 项`}
              >
                <strong>{work.length}</strong> 项任务
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </header>
            {work.length > 0 && (
              <div className="ow-member-card-meta">
                <span>推进中 {summary.doing}</span>
                <span>自报完成 {summary.done}</span>
                {risks.length > 0 && (
                  <span className="ow-overdue">
                    <AlertCircle size={13} aria-hidden="true" />
                    {risks.length} 项需关注
                  </span>
                )}
              </div>
            )}
            <TaskPreview rows={work} onOpen={onOpen} onExpand={() => onDrill(`${user.name}的全部任务`, work)} />
          </article>
        ))}
      </div>
    </>
  );
}
export function TaskTable({
  rows,
  onOpen,
}: {
  rows: WorkRow[];
  onOpen: RowAction;
}) {
  if (!rows.length) return <NoRows />;
  return (
    <div className="ow-table-wrap" role="region" aria-label="任务明细，可横向滚动" tabIndex={0}>
      <table className="ow-table" aria-label="任务明细">
        <thead>
          <tr>
            {[
              "任务",
              "负责人",
              "项目 / 月度目标",
              "执行状态",
              "截止日期",
              "生效记录 / 草稿待审",
            ].map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={workRowClass(row)}>
              <td className="ow-title-cell">
                <button className="ow-title-button" onClick={() => onOpen(row)}>
                  {row.title}
                  <ChevronRight size={13} />
                </button>
                <WorkRowSignals row={row} />
              </td>
              <td>{row.ownerName}</td>
              <td className="ow-title-cell">
                {row.projectName}
                <small className="ow-person-meta">
                  {row.planTitle || "未关联月度目标"}
                </small>
              </td>
              <td>
                <StatusPill row={row} />
              </td>
              <td>
                <span className={row.overdue ? "ow-overdue" : ""}>
                  {row.dueDate || "未设置"}
                  {row.overdue ? " · 逾期" : ""}
                </span>
              </td>
              <td>
                {row.officialCount} /{" "}
                <span className="ow-muted">{row.draftCount}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function TaskCard({ row, onOpen }: { row: WorkRow; onOpen: RowAction }) {
  return (
    <button className={`ow-task-card ${workRowClass(row)}`} onClick={() => onOpen(row)}>
      <div className="ow-card-meta">
        <WorkRowSignals row={row} />
      </div>
      <strong>{row.title}</strong>
      <div className="ow-card-meta">
        <small className="ow-card-project">{row.projectName}</small>
        <StatusPill row={row} />
      </div>
      <div className="ow-card-meta">
        <span className="ow-card-owner">
          <span
            className="ow-avatar"
            data-color={avatarColor(row.ownerId)}
            aria-hidden="true"
          >
            {row.ownerName.slice(-1)}
          </span>
          {row.ownerName}
        </span>
        <span className={row.overdue ? "ow-overdue" : ""}>
          <CalendarDays size={13} aria-hidden="true" />
          {row.dueDate?.slice(5) || "未设截止"}
          {row.overdue && " 逾期"}
        </span>
      </div>
    </button>
  );
}
export function Board({
  rows,
  group,
  onOpen,
  totals,
  onFilter,
}: {
  rows: WorkRow[];
  group: "status" | "owner" | "project";
  onOpen: RowAction;
  totals?: OverviewGroup[];
  onFilter?: (filter: OverviewDrill) => void;
}) {
  const groups = new Map<string, { title: string; rows: WorkRow[] }>();
  if (group === "status")
    for (const key of statusOrder)
      groups.set(key, { title: statusLabels[key], rows: [] });
  for (const row of rows) {
    const key =
      group === "status"
        ? row.status
        : group === "owner"
          ? row.ownerId
          : row.projectId || "__none__";
    const item = groups.get(key) || {
      title: group === "owner" ? row.ownerName : row.projectName,
      rows: [],
    };
    item.rows.push(row);
    groups.set(key, item);
  }
  for (const total of totals || []) if (!groups.has(total.id)) groups.set(total.id, { title: group === 'status' ? statusLabels[total.id as WorkRow['status']] : total.name, rows: [] });
  if (!rows.length && !totals?.length) return <NoRows />;
  return (
    <div className="ow-board" role="region" aria-label="任务看板，可横向滚动" tabIndex={0}>
      {[...groups].map(([key, item]) => (
        <section
          className="ow-lane"
          key={key}
          data-status={group === "status" ? key : undefined}
          aria-label={`${item.title}分组`}
        >
          <header className="ow-lane-heading">
            <strong>{item.title}</strong>
            <span>{totals?.find(total => total.id === key)?.summary.total ?? item.rows.length}</span>
          </header>
          {item.rows.length ? (
            item.rows.map((row) => (
              <TaskCard key={row.id} row={row} onOpen={onOpen} />
            ))
          ) : (
            <p className="ow-muted">{totals?.some(total => total.id === key && total.summary.total) ? '本页暂无此组任务' : '暂无任务'}</p>
          )}
          {onFilter && totals?.some(total => total.id === key && total.summary.total > item.rows.length) && <button className="ow-title-button" onClick={() => onFilter(group === 'status' ? { status: key as WorkRow['status'] } : group === 'owner' ? { ownerId: key } : { projectId: key })}>查看分组全部任务</button>}
        </section>
      ))}
    </div>
  );
}
export function ProjectView({
  rows,
  onDrill,
}: {
  rows: WorkRow[];
  onDrill: DrillAction;
}) {
  const projects = new Map<string, { name: string; rows: WorkRow[] }>();
  for (const row of rows) {
    const key = row.projectId || "__none__",
      project = projects.get(key) || { name: row.projectName, rows: [] };
    project.rows.push(row);
    projects.set(key, project);
  }
  if (!rows.length) return <NoRows />;
  return (
    <div className="ow-project-grid">
      {[...projects].map(([key, project]) => {
        const summary = summarizeWorkRows(project.rows);
        return (
          <section className="ow-project-card" key={key}>
            <header>
              <h3>{project.name}</h3>
              <button
                className="ow-title-button"
                onClick={() => onDrill(`${project.name}的任务`, project.rows)}
              >
                查看 {summary.total} 项<ChevronRight size={14} />
              </button>
            </header>
            <p className="ow-muted">
              {new Set(project.rows.map((row) => row.ownerId)).size} 人参与 ·{" "}
              {
                new Set(project.rows.map((row) => row.planId).filter(Boolean))
                  .size
              }{" "}
              个月度目标
            </p>
            <div className="ow-stacked-track" aria-label="任务状态分布">
              {statusOrder.map((status) => (
                <span
                  key={status}
                  className={`status-${status}`}
                  style={{
                    flex: project.rows.filter((row) => row.status === status)
                      .length,
                  }}
                />
              ))}
            </div>
            <div className="ow-project-stats">
              {statusOrder.map((status) => {
                const work = project.rows.filter(
                  (row) => row.status === status,
                );
                return (
                  work.length > 0 && (
                    <button
                      key={status}
                      onClick={() =>
                        onDrill(
                          `${project.name} · ${statusLabels[status]}`,
                          work,
                        )
                      }
                    >
                      <span className={`ow-dot status-${status}`} />
                      {statusLabels[status]}
                      <strong>{work.length}</strong>
                    </button>
                  )
                );
              })}
            </div>
            <p className="ow-muted">
              {[...new Set(project.rows.map((row) => row.ownerName))].join(
                "、",
              )}
            </p>
          </section>
        );
      })}
    </div>
  );
}
export function Timeline({
  rows,
  onOpen,
}: {
  rows: WorkRow[];
  onOpen: RowAction;
}) {
  const dated = rows
      .filter((row) => row.dueDate)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    undated = rows.filter((row) => !row.dueDate);
  const today = shanghaiToday(),
    first = dated[0]?.dueDate || today,
    last = dated.at(-1)?.dueDate || today;
  const start = addCalendarDays(first, -2),
    end = addCalendarDays(last, 3);
  const length = (Date.parse(end) - Date.parse(start)) / 86400000;
  const position = (date: string) =>
    ((Date.parse(date) - Date.parse(start)) / 86400000 / length) * 100;
  if (!rows.length) return <NoRows />;
  return (
    <>
      <p className="ow-filter-note">
        按截止日期排期 · 点击查看任务 · 排期点不代表实际完成
      </p>
      {dated.length > 0 && (
        <div className="ow-timeline" role="region" aria-label="任务时间排期，可横向滚动" tabIndex={0}>
          <div className="ow-timeline-row">
            <div className="ow-timeline-label">任务 / 负责人</div>
            <div className="ow-timeline-ticks">
              {Array.from({ length: 6 }, (_, index) => {
                const date = addCalendarDays(
                  start,
                  Math.floor((length * index) / 6),
                );
                return (
                  <span key={index} style={{ left: `${position(date)}%` }}>
                    {date.slice(5)}
                  </span>
                );
              })}
            </div>
          </div>
          {dated.map((row) => (
            <div className={`ow-timeline-row ${workRowClass(row)}`} key={row.id}>
              <button className="ow-timeline-label" onClick={() => onOpen(row)}>
                <strong>{row.title}</strong>
                <WorkRowSignals row={row} />
                <small>
                  {row.ownerName} · {row.dueDate}
                </small>
              </button>
              <div className="ow-timeline-track">
                {today >= start && today <= end && (
                  <span
                    className="ow-timeline-today"
                    style={{ left: `${position(today)}%` }}
                    title="今天"
                  />
                )}
                <button
                  className={`ow-timeline-bar status-${row.status}`}
                  style={{
                    left: `${position(row.dueDate)}%`,
                    width: "18px",
                    transform: "translateX(-50%)",
                  }}
                  onClick={() => onOpen(row)}
                  aria-label={`${row.title}，${row.ownerName}，${priorityLabels[row.priority || "none"]}，${workKindLabels[row.workKind || "routine"]}，截止 ${row.dueDate}，${statusLabels[row.status]}`}
                  title={`${row.dueDate} · ${statusLabels[row.status]}`}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {undated.length > 0 && (
        <section className="ow-timeline-undated">
          <h3>
            未设置截止日期 <span className="ow-muted">{undated.length}</span>
          </h3>
          <div className="ow-detail-list">
            {undated.map((row) => (
              <Fragment key={row.id}>
                <button className={`ow-title-button ${workRowClass(row)}`} onClick={() => onOpen(row)}>
                  {row.title} · {row.ownerName}
                  <WorkRowSignals row={row} />
                  <StatusPill row={row} />
                </button>
              </Fragment>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** Counts and previews are computed from the complete filtered scope on the server. */
export function OverviewMemberTable({ members, columns, onOpen, onDrill }: {
  members: OverviewMember[]; columns: ColumnId[]; onOpen: RowAction; onDrill: (filter: OverviewDrill) => void;
}) {
  if (!members.length) return <NoRows text="当前条件下没有成员" />;
  const count = (member: OverviewMember, value: number, filter: OverviewDrill = {}) => value ? <button className="ow-count" onClick={() => onDrill({ ownerId: member.id, ...filter })}>{value}</button> : <span className="ow-zero">0</span>;
  const preview = (member: OverviewMember) => <div className="ow-task-preview">
    {member.preview.map(row => <button key={row.id} className={`ow-title-button ${workRowClass(row)}`} onClick={() => onOpen(row)}><span className="ow-preview-title">{row.title}</span><span className="ow-preview-tags"><WorkRowSignals row={row}/><StatusPill row={row}/>{row.overdue && <small className="ow-overdue">逾期</small>}</span></button>)}
    {!member.summary.total && <span className="ow-empty-member">本期暂无任务安排</span>}
    {member.summary.total > member.preview.length && <button className="ow-title-button ow-preview-more" onClick={() => onDrill({ ownerId: member.id })}>查看全部 {member.summary.total} 项<ChevronRight size={13}/></button>}
  </div>;
  return <><div className="ow-table-wrap ow-member-table" tabIndex={0} role="region" aria-label="可横向滚动的全员工作表"><table className="ow-table" aria-label="全员任务与进展"><thead><tr><th scope="col" className="ow-person-cell">成员 <span className="ow-muted">{members.length}</span></th><th scope="col">任务数</th>{columns.map(column => <th key={column} scope="col" className={`ow-col-${column}`}>{columnLabels[column]}</th>)}</tr></thead><tbody>
    {members.map(member => <tr key={member.id}><th scope="row" className="ow-person-cell"><div className="ow-person"><span className="ow-avatar" data-color={avatarColor(member.id)} aria-hidden="true">{member.name.slice(-2)}</span><div><strong>{member.name}</strong><span className="ow-person-meta">{!member.active ? '已停用 · 历史任务' : member.position || (member.role === 'manager' ? '管理者' : '团队成员')}</span></div></div></th><td>{count(member, member.summary.total)}</td>
      {columns.map(column => <td key={column} className={`ow-col-${column}`}>{column === 'projects' ? member.projects.join('、') || <span className="ow-muted">暂无项目任务</span> : column === 'doing' ? count(member, member.summary.doing, { status: 'doing' }) : column === 'done' ? count(member, member.summary.done, { status: 'done' }) : column === 'risk' ? count(member, member.summary.risk, { riskOnly: true }) : column === 'drafts' ? <>{count(member, member.summary.drafts, { status: 'draft' })}<span className="ow-muted"> / </span>{count(member, member.summary.unscheduled, { status: 'unscheduled' })}</> : column === 'progress' ? member.summary.total ? <div className="ow-progress" aria-label={`自报完成 ${member.summary.done} / ${member.summary.total}`}><span><i style={{ width: `${member.summary.done / member.summary.total * 100}%` }}/></span><small>{Math.round(member.summary.done / member.summary.total * 100)}%</small></div> : <span className="ow-muted">暂无任务</span> : preview(member)}</td>)}
    </tr>)}
  </tbody></table></div><div className="ow-member-cards" aria-label="全员任务卡片">{members.map(member => <article className="ow-member-card" key={member.id}><header><div className="ow-person"><span className="ow-avatar" data-color={avatarColor(member.id)}>{member.name.slice(-2)}</span><div><strong>{member.name}</strong><span className="ow-person-meta">{!member.active ? '已停用 · 历史任务' : member.position || '团队成员'}</span></div></div><button className="ow-member-total" onClick={() => onDrill({ ownerId: member.id })}><strong>{member.summary.total}</strong> 项任务<ChevronRight size={14}/></button></header>{member.summary.total > 0 && <div className="ow-member-card-meta"><span>推进中 {member.summary.doing}</span><span>自报完成 {member.summary.done}</span>{member.summary.risk > 0 && <span className="ow-overdue">{member.summary.risk} 项需关注</span>}</div>}{preview(member)}</article>)}</div></>;
}

export function OverviewProjectView({ groups, onDrill }: { groups: OverviewGroup[]; onDrill: (filter: OverviewDrill) => void }) {
  if (!groups.length) return <NoRows />;
  const values = (group: OverviewGroup): Record<WorkRow['status'], number> => ({ planned: group.summary.planned, doing: group.summary.doing, blocked: group.summary.blocked, done: group.summary.done, not_done: group.summary.notDone, draft: group.summary.drafts, unscheduled: group.summary.unscheduled });
  return <div className="ow-project-grid">{groups.map(group => <section className="ow-project-card" key={group.id}><header><h3>{group.name}</h3><button className="ow-title-button" onClick={() => onDrill({ projectId: group.id })}>查看 {group.summary.total} 项<ChevronRight size={14}/></button></header><p className="ow-muted">{group.ownerCount} 人参与 · {group.planCount} 个月度目标</p><div className="ow-stacked-track" aria-label="任务状态分布">{statusOrder.map(status => <span key={status} className={`status-${status}`} style={{ flex: values(group)[status] }}/>)}</div><div className="ow-project-stats">{statusOrder.filter(status => values(group)[status]).map(status => <button key={status} onClick={() => onDrill({ projectId: group.id, status })}><span className={`ow-dot status-${status}`}/>{statusLabels[status]}<strong>{values(group)[status]}</strong></button>)}</div><p className="ow-muted">{group.ownerNames.join('、')}</p></section>)}</div>;
}
