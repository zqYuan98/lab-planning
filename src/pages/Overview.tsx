import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  ClipboardList,
  FileBarChart2,
  FilePenLine,
  FolderPlus,
  Layers3,
  ListChecks,
  Send,
  UsersRound,
} from "lucide-react";
import type { MonthlyPlan, WeeklyRecord } from "../../shared/types";
import type { Navigate } from "../navigation";
import { buildOverview, type TrendPoint } from "../overview-data";
import { nameOf, type PageProps } from "../ui";
import calendarIllustration from "../assets/monthly-calendar.png";
import weeklyIllustration from "../assets/weekly-clipboard.png";
import "../overview.css";

const planLabels: Record<MonthlyPlan["status"], string> = {
  draft: "草稿",
  submitted: "待审核",
  returned: "待修改",
  approved: "待发布",
  published: "已发布",
  merged: "已合并",
};
const weekLabels: Record<WeeklyRecord["status"], string> = {
  planned: "未开始",
  doing: "推进中",
  blocked: "阻塞",
  done: "自报完成",
  not_done: "未完成",
};
const dateLabel = (value: string) =>
  `${Number(value.slice(5, 7))}.${Number(value.slice(8, 10))}`;
function changeLabel(value: number | null, period: string) {
  return value === null
    ? "暂无对比"
    : value === 0
      ? `与${period}持平`
      : `较${period}${value > 0 ? "增加" : "减少"} ${Math.abs(value)}`;
}

function MiniTrend({
  points,
  bars = false,
}: {
  points: TrendPoint[];
  bars?: boolean;
}) {
  if (!points.slice(0, -1).some((point) => point.value !== null))
    return (
      <div className="ov-trend-empty" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    );
  const max = Math.max(1, ...points.map((point) => point.value ?? 0));
  if (bars)
    return (
      <div className="ov-mini-bars" aria-label="近四周已提交记录">
        <div>
          {points.map((point) => (
            <span
              key={point.period}
              className={point.value === null ? "is-missing" : ""}
              style={{
                height:
                  point.value === null
                    ? 2
                    : Math.max(3, (point.value / max) * 38),
              }}
              title={`${point.period}：${point.value === null ? "暂无记录" : `${point.value} 条已提交`}`}
            />
          ))}
        </div>
      </div>
    );
  const coordinates = points.map((point, index) => ({
    x: 5 + index * 29,
    y: 38 - ((point.value ?? 0) / max) * 29,
    value: point.value,
  }));
  return (
    <svg
      className="ov-mini-line"
      viewBox="0 0 98 44"
      role="img"
      aria-label="近四个月有记录的发布项数"
    >
      <title>
        {points
          .map((point) => `${point.period}：${point.value ?? "暂无记录"}`)
          .join("；")}
      </title>
      {coordinates.map((point, index) => (
        <g key={index}>
          {index > 0 &&
            point.value !== null &&
            coordinates[index - 1].value !== null && (
              <line
                x1={coordinates[index - 1].x}
                y1={coordinates[index - 1].y}
                x2={point.x}
                y2={point.y}
              />
            )}{" "}
          {point.value !== null && <circle cx={point.x} cy={point.y} r="2.5" />}
        </g>
      ))}
    </svg>
  );
}
function MetricRing({
  value,
  total,
  color,
}: {
  value: number;
  total: number;
  color: string;
}) {
  const percent = total ? Math.round((value * 100) / total) : null;
  return (
    <div
      className="ov-ring"
      aria-label={percent === null ? "暂无统计分母" : `占 ${percent}%`}
    >
      <svg viewBox="0 0 68 68" aria-hidden="true">
        <circle cx="34" cy="34" r="28" />
        <circle
          cx="34"
          cy="34"
          r="28"
          style={{
            stroke: value && total ? color : "transparent",
            strokeDasharray: `${(percent ?? 0) * 1.7593} 175.93`,
          }}
        />
      </svg>
      <span>
        {percent === null ? (
          "—"
        ) : (
          <>
            {percent}
            <small>%</small>
          </>
        )}
      </span>
    </div>
  );
}

export default function Overview({
  data,
  navigate,
}: PageProps & { navigate: Navigate }) {
  const manager = data.user.role === "manager",
    view = buildOverview(data);
  const currentWeek = view.weeks.find((week) => week.isCurrent)?.index ?? 1;
  const planAction = () =>
    navigate("monthly", {
      month: view.month,
      action: manager ? "publish" : "create",
    });
  const weeklyAction = () =>
    navigate("weekly", { action: "create", weekStart: view.weekStart });
  const reviewAction = () =>
    navigate("monthly", {
      month: view.month,
      ...(manager ? { action: "review" as const } : { status: "submitted" }),
    });
  const rankRecord = (record: WeeklyRecord) =>
    !record.submitted
      ? 2
      : record.status === "blocked"
        ? 0
        : record.status === "not_done"
          ? 1
          : record.status === "doing"
            ? 3
            : 4;
  const focusRecords = [...view.records]
    .sort((a, b) => rankRecord(a) - rankRecord(b))
    .slice(0, 3);
  function openPlan(plan: MonthlyPlan) {
    navigate("monthly", {
      month: view.month,
      id: plan.id,
      ...(manager && plan.status === "submitted"
        ? { action: "review" as const }
        : manager && plan.status === "approved"
          ? { action: "publish" as const }
          : {}),
    });
  }
  return (
    <div className="overview-page">
      <header className="ov-page-heading">
        <h1>{manager ? "部门概览" : "我的工作台"}</h1>
        <p>{data.user.name}，从月度承诺到本周实际进展。</p>
      </header>
      <section className="ov-cycle" aria-label="当前工作周期">
        <div className="ov-cycle-title">
          <CalendarDays size={20} />
          <strong>{Number(view.month.slice(5))} 月工作周期</strong>
          <span>
            {view.month.slice(0, 4)} · 第 {currentWeek} 周
          </span>
        </div>
        <div className="ov-cycle-status">
          <button
            className={`ov-pill ${view.published.length ? "is-blue" : "is-amber"}`}
            onClick={() => navigate("monthly", { month: view.month })}
          >
            <i />
            {view.published.length
              ? `已发布 ${view.published.length} 项承诺`
              : "月计划待发布"}
          </button>
          <span className="ov-pill">本周 {view.submitted.length} 条已提交</span>
        </div>
      </section>

      <section className="ov-metrics" aria-label="当前可见范围的工作指标">
        <article className="ov-stat">
          <div className="ov-stat-top">
            <span className="ov-icon is-blue">
              <Layers3 size={21} />
            </span>
            <div>
              <span>本月已发布成果</span>
              <strong>
                {view.published.length}
                <small>项</small>
              </strong>
            </div>
          </div>
          <div className="ov-stat-bottom">
            <span>
              {changeLabel(view.monthChange, "上月")}
              <small>{view.accepted.length} 项管理者已验收</small>
            </span>
            <MiniTrend points={view.monthTrend} />
          </div>
          <button
            className="ov-card-link"
            aria-label="查看本月已发布计划"
            onClick={() =>
              navigate("monthly", { month: view.month, status: "published" })
            }
          >
            <ChevronRight size={15} />
          </button>
        </article>
        <article className="ov-stat">
          <div className="ov-stat-top">
            <span className="ov-icon is-violet">
              <ClipboardList size={21} />
            </span>
            <div>
              <span>本周已提交记录</span>
              <strong>
                {view.submitted.length}
                <small>条</small>
              </strong>
            </div>
          </div>
          <div className="ov-stat-bottom">
            <span>
              {changeLabel(view.weekChange, "上周")}
              <small>
                {
                  view.submitted.filter((record) => record.status === "done")
                    .length
                }{" "}
                条成员自报完成
              </small>
            </span>
            <MiniTrend points={view.weekTrend} bars />
          </div>
          <button
            className="ov-card-link"
            aria-label="查看本周执行记录"
            onClick={() => navigate("weekly", { weekStart: view.weekStart })}
          >
            <ChevronRight size={15} />
          </button>
        </article>
        <article className="ov-stat ov-stat-ring">
          <div className="ov-stat-top">
            <span className="ov-icon is-amber">
              <ClipboardCheck size={21} />
            </span>
            <div>
              <span>{manager ? "待我审核" : "等待审核"}</span>
              <strong>
                {view.pending.length}
                <small>项</small>
              </strong>
            </div>
          </div>
          <MetricRing
            value={view.pending.length}
            total={view.reviewScope.length}
            color="#F2A33B"
          />
          <p>
            {view.reviewScope.length
              ? `占本月 ${view.reviewScope.length} 项已提交审核计划`
              : "暂无已提交审核的计划"}
          </p>
          <button
            className="ov-card-link"
            aria-label={manager ? "审核待处理月计划" : "查看等待审核的月计划"}
            onClick={reviewAction}
          >
            <ChevronRight size={15} />
          </button>
        </article>
        <article className="ov-stat ov-stat-ring">
          <div className="ov-stat-top">
            <span className="ov-icon is-coral">
              <CircleAlert size={21} />
            </span>
            <div>
              <span>本周未解除阻塞</span>
              <strong>
                {view.blocked.length}
                <small>条</small>
              </strong>
            </div>
          </div>
          <MetricRing
            value={view.blocked.length}
            total={view.submitted.length}
            color="#F27382"
          />
          <p>
            {view.submitted.length
              ? `占本周 ${view.submitted.length} 条已提交记录`
              : "暂无已提交周记录"}
            {view.notDone.length > 0 && ` · 另 ${view.notDone.length} 条未完成`}
          </p>
          <button
            className="ov-card-link"
            aria-label="查看本周阻塞记录"
            onClick={() =>
              navigate("weekly", {
                weekStart: view.weekStart,
                status: "blocked",
              })
            }
          >
            <ChevronRight size={15} />
          </button>
        </article>
      </section>

      <div className="ov-workspace">
        <section className="ov-panel ov-attention">
          <div className="ov-panel-heading">
            <h2>需要关注</h2>
            <button
              className="ov-text-link"
              onClick={() => navigate("monthly", { month: view.month })}
            >
              查看月计划 <ChevronRight size={14} />
            </button>
          </div>
          <div className="ov-chain">
            <div className="ov-chain-column">
              <div className="ov-chain-heading">
                <h3>月度计划</h3>
                <span
                  className={`ov-pill ${view.published.length ? "is-blue" : "is-amber"}`}
                >
                  {view.published.length
                    ? `${view.published.length} 项已发布`
                    : "待发布"}
                </span>
              </div>
              {!view.plans.length ? (
                <div className="ov-chain-empty">
                  <div className="ov-empty-illustration ov-monthly-illustration">
                    <img src={calendarIllustration} alt="" />
                  </div>
                  <h4>先确定本月的交付</h4>
                  <p>
                    {manager
                      ? "发布月计划，明确成果和责任人。"
                      : "提报预期成果，和管理者对齐本月承诺。"}
                  </p>
                </div>
              ) : (
                <div className="ov-plan-list">
                  {view.focusPlans.slice(0, 3).map((plan) => (
                    <button
                      key={plan.id}
                      className="ov-work-item"
                      onClick={() => openPlan(plan)}
                    >
                      <span
                        className={`ov-item-dot ${plan.status === "published" ? "is-blue" : "is-amber"}`}
                      />
                      <span className="ov-item-copy">
                        <strong>{plan.title}</strong>
                        <small>
                          {nameOf(data, plan.ownerId)} ·{" "}
                          {dateLabel(plan.dueDate)} 截止
                        </small>
                        <em
                          className={`ov-state ${plan.status === "published" ? "is-blue" : "is-amber"}`}
                        >
                          {planLabels[plan.status]}
                          {plan.acceptanceStatus === "accepted"
                            ? " · 已验收"
                            : ""}
                        </em>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                  {view.plans.length > 3 && (
                    <button
                      className="ov-more"
                      onClick={() => navigate("monthly", { month: view.month })}
                    >
                      查看全部 {view.plans.length} 项 <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
            <span className="ov-chain-arrow" aria-hidden="true">
              <ArrowRight size={19} />
            </span>
            <div className="ov-chain-column">
              <div className="ov-chain-heading">
                <h3>本周执行</h3>
                <span className="ov-week-caption">第 {currentWeek} 周</span>
              </div>
              {!view.records.length ? (
                <div className="ov-chain-empty">
                  <div className="ov-empty-illustration ov-weekly-illustration">
                    <img src={weeklyIllustration} alt="" />
                  </div>
                  <h4>本周暂无执行记录</h4>
                  <p>
                    {view.published.length
                      ? "把月度成果拆成本周可以交付的任务。"
                      : "月计划发布后，就可以正式推进。"}
                  </p>
                </div>
              ) : (
                <div className="ov-plan-list">
                  {focusRecords.map((record) => (
                    <button
                      key={record.id}
                      className="ov-work-item"
                      onClick={() =>
                        navigate("weekly", {
                          id: record.id,
                          weekStart: view.weekStart,
                        })
                      }
                    >
                      <span
                        className={`ov-item-dot ${record.submitted && ["blocked", "not_done"].includes(record.status) ? "is-coral" : "is-violet"}`}
                      />
                      <span className="ov-item-copy">
                        <strong>
                          {data.tasks.find((task) => task.id === record.taskId)
                            ?.title || record.commitment}
                        </strong>
                        <small>
                          {record.monthlyPlanId
                            ? data.plans.find(
                                (plan) => plan.id === record.monthlyPlanId,
                              )?.title || "关联月计划"
                            : "临时工作"}{" "}
                          · {nameOf(data, record.ownerId)}
                        </small>
                        <em
                          className={`ov-state ${record.submitted && ["blocked", "not_done"].includes(record.status) ? "is-coral" : "is-violet"}`}
                        >
                          {record.submitted
                            ? weekLabels[record.status]
                            : "未提交草稿"}
                        </em>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                  {view.records.length > 3 && (
                    <button
                      className="ov-more"
                      onClick={() =>
                        navigate("weekly", { weekStart: view.weekStart })
                      }
                    >
                      查看全部 {view.records.length} 条 <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="ov-chain-footer">
            <button
              className="button primary"
              onClick={view.published.length ? weeklyAction : planAction}
            >
              {view.published.length
                ? "安排本周工作"
                : manager
                  ? "去发布月度计划"
                  : "提报我的月计划"}
              <ArrowRight size={16} />
            </button>
            {view.published.length > 0 && view.pending.length > 0 && (
              <button className="ov-text-link" onClick={reviewAction}>
                {manager ? "审核" : "查看"} {view.pending.length} 项提报
              </button>
            )}
          </div>
          <p className="ov-fact-note">
            周执行由成员自报，月度成果由管理者独立验收。
          </p>
        </section>

        <aside className="ov-side">
          <section className="ov-panel ov-rhythm">
            <div className="ov-panel-heading">
              <h2>本月节奏</h2>
              <button
                className="ov-text-link"
                aria-label="查看本周计划"
                onClick={() =>
                  navigate("weekly", { weekStart: view.weekStart })
                }
              >
                <ChevronRight size={17} />
              </button>
            </div>
            <div
              className="ov-timeline"
              style={{
                gridTemplateColumns: `repeat(${view.weeks.length}, minmax(0, 1fr))`,
              }}
            >
              {view.weeks.map((week) => (
                <button
                  key={week.weekStart}
                  className={`ov-timeline-week ${week.isCurrent ? "is-current" : ""} ${week.state === "done" ? "is-done" : ""}`}
                  onClick={() =>
                    navigate("weekly", { weekStart: week.weekStart })
                  }
                  aria-label={`第 ${week.index} 周，${week.startDate} 至 ${week.endDate}，${week.state === "empty" ? "暂无记录" : `${week.submitted} 条已提交，${week.done} 条自报完成，${week.drafts} 条草稿`}`}
                >
                  <span className="ov-timeline-node">
                    {week.state === "done" ? <Check size={12} /> : null}
                  </span>
                  <strong>第 {week.index} 周</strong>
                  <span className="ov-week-dates">
                    {dateLabel(week.startDate)}–{dateLabel(week.endDate)}
                  </span>
                  <small>
                    {week.state === "empty"
                      ? "暂无记录"
                      : week.state === "draft"
                        ? `${week.drafts} 条草稿`
                        : week.state === "done"
                          ? "执行完成"
                          : `${week.done}/${week.submitted} 已完成`}
                  </small>
                  {week.isCurrent && <em>本周</em>}
                </button>
              ))}
            </div>
            <p className="ov-rhythm-note">
              <span>
                <i /> 当前周
              </span>
              <span>
                <i className="is-done" /> 已提交记录全部完成
              </span>
            </p>
          </section>
          <section className="ov-panel ov-reminders">
            <div className="ov-panel-heading">
              <h2>协作提醒</h2>
              <span>待办速览</span>
            </div>
            <button
              className="ov-reminder"
              onClick={() =>
                navigate("weekly", {
                  weekStart: view.weekStart,
                  ...(view.drafts.length ? { status: "draft" } : {}),
                })
              }
            >
              <span className="ov-icon is-violet">
                <Send size={18} />
              </span>
              <span>
                <strong>
                  {view.drafts.length
                    ? `${view.drafts.length} 条周草稿待提交`
                    : view.submitted.length
                      ? `本周已收到 ${view.submitted.length} 条进展`
                      : "本周还没有提交记录"}
                </strong>
                <small>
                  {view.drafts.length
                    ? "正式提交后纳入本周执行统计"
                    : "查看本周承诺和实际推进情况"}
                </small>
              </span>
              <ChevronRight size={14} />
            </button>
            <button className="ov-reminder" onClick={reviewAction}>
              <span className="ov-icon is-amber">
                <ClipboardCheck size={18} />
              </span>
              <span>
                <strong>
                  {view.pending.length
                    ? `${view.pending.length} 项月计划等待审核`
                    : "暂无待审核提报"}
                </strong>
                <small>
                  {manager
                    ? "审核通过后，发布共同的月度承诺"
                    : "提报审核状态会在这里更新"}
                </small>
              </span>
              <ChevronRight size={14} />
            </button>
            {view.returned.length > 0 && (
              <button
                className="ov-reminder"
                onClick={() =>
                  navigate("monthly", { month: view.month, status: "returned" })
                }
              >
                <span className="ov-icon is-amber">
                  <FilePenLine size={18} />
                </span>
                <span>
                  <strong>{view.returned.length} 项提报退回待修改</strong>
                  <small>查看退回说明，补充后重新提交</small>
                </span>
                <ChevronRight size={14} />
              </button>
            )}
            <button
              className="ov-reminder"
              onClick={() =>
                navigate("weekly", {
                  weekStart: view.weekStart,
                  status: "blocked",
                })
              }
            >
              <span className="ov-icon is-coral">
                <CircleAlert size={18} />
              </span>
              <span>
                <strong>
                  {view.blocked.length
                    ? `${view.blocked.length} 条阻塞需要协调`
                    : "暂无已提交的阻塞记录"}
                </strong>
                <small>
                  {view.notDone.length
                    ? `另有 ${view.notDone.length} 条未完成记录，请到周执行查看原因`
                    : "依据成员填写的原因处理协调事项"}
                </small>
              </span>
              <ChevronRight size={14} />
            </button>
            {manager && view.awaitingAcceptance.length > 0 && (
              <button
                className="ov-reminder"
                onClick={() =>
                  navigate("monthly", {
                    month: view.month,
                    id: view.awaitingAcceptance[0].id,
                  })
                }
              >
                <span className="ov-icon is-blue">
                  <ListChecks size={18} />
                </span>
                <span>
                  <strong>
                    {view.awaitingAcceptance.length} 项月度成果待验收
                  </strong>
                  <small>按已发布的验收标准确认交付</small>
                </span>
                <ChevronRight size={14} />
              </button>
            )}
            {manager && view.missingMembers.length > 0 && (
              <button
                className="ov-missing"
                onClick={() => navigate("monthly", { month: view.month })}
              >
                <UsersRound size={15} />
                <span>{view.missingMembers.length} 位成员本月待提报</span>
                <ChevronRight size={14} />
              </button>
            )}
          </section>
        </aside>
      </div>

      <section className="ov-panel ov-shortcuts">
        <div className="ov-panel-heading">
          <h2>快捷入口</h2>
          <span>接着推进下一步</span>
        </div>
        <div className="ov-shortcut-grid">
          <button
            className="ov-shortcut is-blue"
            onClick={() =>
              manager
                ? navigate("reports", {
                    action: "write-weekly",
                    weekStart: view.weekStart,
                  })
                : weeklyAction()
            }
          >
            <span className="ov-shortcut-icon">
              <FilePenLine size={22} />
            </span>
            <span>
              <strong>{manager ? "写周报" : "安排本周"}</strong>
              <small>
                {manager ? "从本周实际进展形成草稿" : "拆分承诺，记录真实进展"}
              </small>
            </span>
            <ChevronRight size={17} />
          </button>
          <button
            className="ov-shortcut is-violet"
            onClick={() =>
              manager
                ? navigate("projects", { action: "create" })
                : navigate("monthly", { action: "create", month: view.month })
            }
          >
            <span className="ov-shortcut-icon">
              <FolderPlus size={23} />
            </span>
            <span>
              <strong>{manager ? "建项目" : "提报月计划"}</strong>
              <small>
                {manager
                  ? "建立项目，组织下一项交付"
                  : "写清预期成果与验收标准"}
              </small>
            </span>
            <ChevronRight size={17} />
          </button>
          <button
            className="ov-shortcut is-cyan"
            onClick={() => navigate(manager ? "reports" : "projects")}
          >
            <span className="ov-shortcut-icon">
              <FileBarChart2 size={22} />
            </span>
            <span>
              <strong>{manager ? "看报告" : "查看项目"}</strong>
              <small>
                {manager
                  ? "查看已保存的汇报与源事实"
                  : "了解部门项目及工作归属"}
              </small>
            </span>
            <ChevronRight size={17} />
          </button>
        </div>
      </section>
      <p className="ov-scope-note">
        统计范围：当前账号可访问的本月计划与本周记录。未提交草稿不计入正式执行；历史记录不足时不作趋势对比。
      </p>
    </div>
  );
}
