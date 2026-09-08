import {
  ArrowRight,
  CalendarPlus,
  CircleAlert,
  Flag,
  FileCheck2,
} from 'lucide-react'
import {
  Badge,
  Empty,
  PageHeader,
  currentMonth,
  monday,
  nameOf,
  type PageProps,
} from '../ui'
export default function Overview({
  data,
  navigate,
}: PageProps & { navigate: (page: string) => void }) {
  const manager = data.user.role === 'manager',
    month = currentMonth(),
    week = monday()
  const plans = data.plans.filter((plan) => plan.month === month),
    published = plans.filter((plan) => plan.status === 'published')
  const weeks = data.weeklyRecords.filter(
    (record) => record.weekStart === week && record.submitted,
  )
  const blocked = weeks.filter(
    (record) => record.status === 'blocked' || record.status === 'not_done',
  )
  const unsubmitted = data.users.filter(
    (user) =>
      user.active &&
      user.role === 'member' &&
      !plans.some(
        (plan) =>
          plan.ownerId === user.id &&
          ['submitted', 'approved', 'published', 'merged'].includes(
            plan.status,
          ),
      ),
  )
  const pending = plans.filter((plan) => plan.status === 'submitted'),
    results = plans.filter((plan) => plan.acceptanceStatus === 'submitted')
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE / OVERVIEW"
        title={manager ? '部门概览' : `${data.user.name}，工作有序向前。`}
        description={`${month.replace('-', ' 年 ')} 月 · 从月度承诺到本周实际进展`}
        actions={
          <button
            className="button primary"
            onClick={() => navigate(manager ? 'monthly' : 'weekly')}
          >
            <CalendarPlus size={17} />
            {manager ? '审核月度计划' : '安排本周工作'}
          </button>
        }
      />
      <div className="overview-hero">
        <div>
          <Badge tone="green">{manager ? '部门协作' : '个人工作台'}</Badge>
          <h2>
            明确本月要交付什么，
            <br />
            看清本周推进到哪里。
          </h2>
          <p>
            {published.length
              ? `本月已发布 ${published.length} 项承诺，${published.filter((plan) => plan.acceptanceStatus === 'accepted').length} 项成果已验收。`
              : '本月还没有发布计划，从成员提报开始建立共同的工作节奏。'}
          </p>
        </div>
        <div className="hero-mark">
          <span>{String(new Date().getMonth() + 1).padStart(2, '0')}</span>
          <small>月度工作周期 / {new Date().getFullYear()}</small>
        </div>
      </div>
      <div className="metrics">
        <div>
          <span>本月已发布成果</span>
          <strong>
            {published.length}
            <small>项</small>
          </strong>
          <p>
            其中{' '}
            {
              published.filter((plan) => plan.acceptanceStatus === 'accepted')
                .length
            }{' '}
            项已验收
          </p>
        </div>
        <div>
          <span>本周已提交周记录</span>
          <strong>
            {weeks.length}
            <small>项</small>
          </strong>
          <p>
            其中 {weeks.filter((record) => record.status === 'done').length}{' '}
            项成员自报完成
          </p>
        </div>
        <div>
          <span>{manager ? '待审核提报' : '等待审核的提报'}</span>
          <strong>
            {pending.length}
            <small>项</small>
          </strong>
          <p>草稿和退回项不计入已发布计划</p>
        </div>
        <div>
          <span>本周待处理阻塞</span>
          <strong className={blocked.length ? 'amber-text' : ''}>
            {blocked.length}
            <small>项</small>
          </strong>
          <p>阻塞与未完成记录分别保留原因</p>
        </div>
      </div>
      <div className="overview-grid">
        <section className="panel">
          <div className="section-heading">
            <h2>
              <CircleAlert size={19} />
              需要关注
            </h2>
            <button className="text-button" onClick={() => navigate('weekly')}>
              查看周计划 <ArrowRight size={15} />
            </button>
          </div>
          {blocked.length ? (
            <div className="attention-list">
              {blocked.map((record) => (
                <div key={record.id}>
                  <div>
                    <Badge tone="amber">
                      {record.status === 'blocked' ? '受阻' : '未完成'}
                    </Badge>
                    <strong>{record.commitment}</strong>
                    <p>{record.blocker || '尚未填写原因'}</p>
                  </div>
                  <small>{nameOf(data, record.ownerId)}</small>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="本周没有已提交的阻塞记录"
              description="成员提交阻塞原因后，会显示在这里。"
            />
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>
              <FileCheck2 size={19} />
              {manager ? '本月协作提醒' : '下一步'}
            </h2>
          </div>
          <button className="queue-row" onClick={() => navigate('monthly')}>
            <span>
              待确认月度成果<small>按验收标准确认实际交付</small>
            </span>
            <strong>{results.length}</strong>
            <ArrowRight size={17} />
          </button>
          <button className="queue-row" onClick={() => navigate('monthly')}>
            <span>
              退回待修改<small>补充内容后可以重新提交</small>
            </span>
            <strong>
              {plans.filter((plan) => plan.status === 'returned').length}
            </strong>
            <ArrowRight size={17} />
          </button>
          {manager && (
            <div className="missing-members">
              <h3>
                本月尚未提报 <Badge>{unsubmitted.length} 人</Badge>
              </h3>
              <p>
                {unsubmitted.length
                  ? unsubmitted.map((user) => user.name).join('、')
                  : '当前活跃成员均已提报，或尚未添加成员。'}
              </p>
            </div>
          )}
          <div className="note">
            <Flag size={16} />
            <span>周任务完成反映执行进展；月度成果以管理者验收为准。</span>
          </div>
        </section>
      </div>
    </>
  )
}
