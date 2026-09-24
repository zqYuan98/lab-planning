# 第四批：向上协同、项目里程碑与成员交付档案设计

日期：2026-09-22；状态：待评审提案。范围：LP-14、16、17及配套 LP-19。
依赖对象授权、个人交付验收和历史复盘，见[总体设计](2026-09-22-lab-planning-optimization-design.md)。

## 1. LP-14 领导交办关系与订阅

### 1.1 关系模型

新增 `AssignmentRelation`：`taskId、assignerUserId|null、accountableUserId、originalAssignedByText、scopeGrantIds、effectiveFrom、endedAt、version`。任务 ownerId 仍是执行人；accountableUserId 是对上汇报负责人；assignerUserId 是明确选择的交办账号。三者可以不同。

保留 workSource、assignedBy、assignedOn 原文；有文字但无账号时显示“交办账号未关联”。不得根据姓名、岗位或钉钉昵称自动绑定。录入关系时单独预览并确认查看范围，将授权写成 ObjectGrant；“交办人”关系本身不授予查看权。跨月沿用同一任务则关系继续有效；新目标/新任务需要重新确认授权，不沿 sourcePlanId 自动扩散。

订阅独立记录为 `WorkSubscription`：`relationId、recipientId、topics、frequency、channel、enabled、version`。topics 为成果、风险、待决策，frequency 复用现有日/周摘要时段。只有当前有效授权范围内的主题能订阅，观察者默认只读；需要其正式处理决策必须另行评审角色设计，不能通过订阅赋予写权限。

### 1.2 摘要与正式汇报

继续复用现有业务事件、摘要、通知和投递队列。新增“授权观察者接收人”计算路径，不把 observer 放入仅允许 manager 的 `effectiveManagerIds`。生成前投影、发送前再次核对账号/绑定/授权/开关。

两种发送模式分别显示：

- **日常订阅摘要**：用户已启用订阅后，按频率自动发送授权范围的简要变化；重复调度依靠接收人、来源事件和摘要时段去重。
- **正式向上汇报**：由对上负责人或管理者生成 ScopedReport 草稿，核对接收人、范围、正文与证据，明确确认后才入队。订阅不等于正式汇报的发送授权。

正式汇报增加 `OutboundReportApproval`：`reportId、reportRevision、recipientIds、contentHash、sourceManifest、grantManifest、confirmedBy、confirmedAt、status、version`，流程为 draft → confirmed → queued → delivered/failed/unknown/cancelled。只允许当前 accountableUserId 或有权管理者确认；确认人本人不能读取的来源不得进入汇报。

确认后编辑正文、接收人、来源清单或授权范围使确认失效，返回草稿重新确认。实际发送前检查当前来源版本与确认 manifest；来源有变化则取消该队列项并提示重新核对，不自行润色后发送。队列已明确受理则不能假装撤回成功；未知结果进入待核查，复用既有防重发规则，不盲目换渠道。

普通自动摘要在发送时裁掉失权事项；正式确认稿发生范围变化则整份停止并重新确认，不能静默改变已确认正文。送达、查看、接收确认、业务决策和成果验收是不同状态。

接口建议：`POST /api/tasks/:id/assignment-relations`、`PUT /api/work-subscriptions/:id`、`POST /api/scoped-reports`、`POST /api/scoped-reports/:id/confirm-send`。命令均带 requestId 与版本；确认发送响应仅表示已确认/入队，只有真实渠道回执才能显示送达。

### 1.3 验收

姓名相同不自动关联；未授权关系不泄露事项；领导只收到授权来源；重复调度不重发；撤权或停用阻止旧队列；正式稿变化需重确认；未知发送结果不可盲重试；已读/送达不自动验收。

## 2. LP-16 项目里程碑与轻量依赖

在 Projects 的项目详情和现有时间轴中增加里程碑列表，不新增独立排程系统。

新增 `Milestone`：`projectId、title、ownerId、dueDate、acceptanceCriteria、status、deliveryRefs、confirmedAt、confirmedBy、version`。状态 planned/in_progress/accepted/cancelled，成果引用精确到 deliverableKey 和被确认的提交版本。里程碑完成由管理者明确确认，要求对应验收证据；不因所有任务 self-reported done 自动完成。

新增 `WorkDependency`：`projectId、predecessor:{type,id}、successor:{type,id}、kind=finish_to_start、reason、createdBy、version`。第一版只允许同项目内的 task/milestone，避免跨部门排程和权限传播。项目、月目标可选 annualGoalId，不强制临时工作挂年度方向。

写入时验证两端存在、活跃、同项目、当前操作者可管理；禁止自依赖与循环。读出依赖子图并在同一 SQLite 写事务内再次做环检查，避免并发 A→B 与 B→A 同时成功。带活跃依赖的任务切换项目时返回影响列表，先明确调整/解除依赖再改归属；不静默搬迁图边。

前置是否达成按明确定义判断：里程碑须 accepted；任务须已声明的交付项均有有效 accepted 版本。没有交付证据时显示待确认，Task.status=done 不充当验收凭证。新增交付项或替代版本可能使当前依赖重新待确认，已冻结里程碑确认仍保留当时证据，并显示后续变化提示。

前置未达成展示等待、责任人和影响节点，但不阻止成员如实填写实际进展。选择“带风险推进”必须记录原因；不自动平移截止、不自动重新分配任务。前置作废显示“前置已作废，需调整依赖”，不能视为已经完成；管理者解除依赖须留原因。历史引用不删除。

维护接口为项目下 milestones/dependencies 的 GET/POST、对象级 PATCH 和明确 confirm/cancel/remove 动作，均使用版本和 requestId。年度方向选择复用已有目标维护。授权观察者只看到获准的项目摘要，未授权前置只显示不可见提示。

验收：可定位项目阶段、等待对象和影响节点；单次与并发成环均拒绝；里程碑不能靠自报完成自动通过；作废前置不冒充达成；年度方向可空；项目摘要不泄露未授权依赖名称。

## 3. LP-17 先交付档案，再正式评价

### 3.1 阶段一：交付档案

成员详情增加“周期交付档案”，接口 `GET /api/members/:id/delivery-record?period=`。member 仅本人，manager 保持部门管理范围，observer 的任务或项目授权不包含该档案。

档案按稳定交付项汇总：当期责任、初始承诺和批准变更、各版本提交/验收、阻塞区间、协作贡献、主管说明、成员补充和待核实项。每条都有 sourceType/sourceId/version 和证据质量，可回到授权业务对象。

同一任务跨周、跨月、返工版本只归入同一成果项，不按周记录数量重复计功。按期末事实展示已验收、待验收、未完成、已作废，不能把缺少证据视为零贡献。责任中途变更保留每段责任，不把全部成果自动归给最后 owner。

协作贡献新增 `ContributionRecord`：`deliverableKey、contributorId、description、evidenceRefs、proposedBy、confirmedBy、confirmedAt、status、version`。成员可申报本人贡献，管理者核实；未确认标待核实，不由消息次数、工时文字或提交次数推算比例。成果总数按交付项计一次，各人的责任/贡献说明可分别展示但不得相加冒充部门成果数量。

### 3.2 阶段二：人工评价与反馈

在证据覆盖可解释、前三批稳定后，再引入 `PerformanceCycle、Evaluation、EvaluationFeedback`。周期保存范围、时间截点、规则版本和证据清单；评价保存主管的事实说明、可选维度分数、理由和来源。规则先由管理者配置并确认，本设计不代替部门制定分值、权重或绩效制度。

状态为 draft → manager_reviewed → member_feedback → finalized。主管先确认评价，成员可反馈或补证据；成员“已查看”不等于认可。反馈期截止后，管理者必须记录未解决异议的处理意见才能定稿；超期无反馈可定稿，但标注“未反馈”，不能标成成员同意。更正新建修订，不覆盖原分数或证据。

评分初期只支持人工确认，不自动从延期、阻塞、任务数量生成分数。外部阻塞显示原因、期间和处理履责证据，不直接认定个人失职；未知事实保持待核实。评分规则的版本、各维度允许范围和总分算法需在该阶段独立规格中确认后再启用，交付档案不以评分模块为上线前提。

接口建议：`POST /api/performance-cycles`、`POST /api/evaluations`、`POST /api/evaluations/:id/review`、`POST /api/evaluations/:id/feedback`、`POST /api/evaluations/:id/finalize`。规则、反馈、定稿采用独立记录与版本保护，不复用任务 status。

### 3.3 验收与启用条件

档案每个结果可追溯；跨周与返工不重复；责任变更可解释；主管观点和原始证据有明确标签；成员只见本人；领导只读任务授权不延伸到绩效；没有资料不自动评分；已定稿评价不随任务变化。

正式评分启用前必须具备：LP-11 可解释历史口径、LP-12 权限矩阵、LP-13 交付版本与验收事实、已确认的评分规则及反馈处理流程。暂未满足时仍可使用无分数的交付档案。

## 4. 迁移与工程验收

旧 assignedBy 文本原样保留；历史无账号关联、无里程碑、无评价数据均按缺省空集合解释，不自动猜测或生成。业务包包含关系事实、里程碑/依赖、贡献和评价证据；授权、订阅及发送确认作为环境相关配置不自动恢复，目标环境需重新确认。关系中的账号引用映射后不自动启用接收人。

所有新增引用进入账号删除阻断、严格 schema、用户映射与导出完整性测试。评价包含敏感内容，个人业务包只导出本人可导出事实，观察者仅使用授权摘要导出。完整部门迁移仍由管理者执行，恢复不发送外部消息。

LP-19 增加授权范围变化下的摘要与发送回归、渠道未知结果处理、依赖并发成环、里程碑证据冻结、成果/贡献计数去重和评价反馈修订测试。各功能单独记录 LP-20 的实现、部署、启用与真实验收状态。
