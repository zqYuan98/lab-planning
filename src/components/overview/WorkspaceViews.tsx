import { Fragment } from "react";
import { ChevronRight, Inbox, AlertCircle, CalendarDays } from "lucide-react";
import type { User } from "../../../shared/types";
import { addCalendarDays, shanghaiToday } from "../../overview-data";
import { summarizeWorkRows, type WorkRow } from "../../overview-workspace-data";
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
function TaskPreview({ rows, onOpen }: { rows: WorkRow[]; onOpen: RowAction }) {
  return (
    <div className="ow-task-preview">
      {rows.length ? (
        rows.map((row) => (
          <button
            key={row.id}
            className="ow-title-button"
            title={row.title}
            aria-label={`${row.title}，${statusLabels[row.status]}${row.overdue ? "，逾期" : ""}`}
            onClick={() => onOpen(row)}
          >
            <span className="ow-preview-title">{row.title}</span>
            <span className="ow-preview-tags">
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
                      <TaskPreview rows={work} onOpen={onOpen} />
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
            <TaskPreview rows={work} onOpen={onOpen} />
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
    <div className="ow-table-wrap">
      <table className="ow-table" aria-label="任务明细">
        <thead>
          <tr>
            {[
              "任务",
              "负责人",
              "项目 / 月度目标",
              "执行状态",
              "截止日期",
              "周记录（纳入统计 / 草稿）",
            ].map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="ow-title-cell">
                <button className="ow-title-button" onClick={() => onOpen(row)}>
                  {row.title}
                  <ChevronRight size={13} />
                </button>
                {row.isTemporary && (
                  <small className="ow-muted">临时工作</small>
                )}
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
    <button className="ow-task-card" onClick={() => onOpen(row)}>
      <div className="ow-card-meta">
        <StatusPill row={row} />
        {row.isTemporary && <small>临时</small>}
      </div>
      <strong>{row.title}</strong>
      <small className="ow-card-project">{row.projectName}</small>
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
}: {
  rows: WorkRow[];
  group: "status" | "owner" | "project";
  onOpen: RowAction;
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
  if (!rows.length) return <NoRows />;
  return (
    <div className="ow-board">
      {[...groups].map(([key, item]) => (
        <section
          className="ow-lane"
          key={key}
          data-status={group === "status" ? key : undefined}
          aria-label={`${item.title}分组`}
        >
          <header className="ow-lane-heading">
            <strong>{item.title}</strong>
            <span>{item.rows.length}</span>
          </header>
          {item.rows.length ? (
            item.rows.map((row) => (
              <TaskCard key={row.id} row={row} onOpen={onOpen} />
            ))
          ) : (
            <p className="ow-muted">暂无任务</p>
          )}
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
        按任务截止日期定位，点击查看交付内容。排期点不代表实际完成时间。
      </p>
      {dated.length > 0 && (
        <div className="ow-timeline">
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
            <div className="ow-timeline-row" key={row.id}>
              <button className="ow-timeline-label" onClick={() => onOpen(row)}>
                <strong>{row.title}</strong>
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
                  aria-label={`${row.title}，${row.ownerName}，截止 ${row.dueDate}，${statusLabels[row.status]}`}
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
                <button className="ow-title-button" onClick={() => onOpen(row)}>
                  {row.title} · {row.ownerName}
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
