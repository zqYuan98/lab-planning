# 智能体与数据导入 API（v1）

管理者在“数据导入 → 智能体与 API 接入”创建令牌。令牌只显示一次，服务端仅保存摘要；到期、撤销、账号停用或密码更换后失效。令牌代表创建者，不能绕过该用户的业务权限。持有 `imports:commit` 的管理者令牌可以确认既有计划直接生效及明确指定原成果状态；普通新增计划的审核、发布接口仍通过网页会话使用。

请求基址为当前站点的 `/api/v1`，请求头为 `Authorization: Bearer <令牌>`，写请求使用 `Content-Type: application/json`。网页会话的 `/api` 与令牌接口分别认证。

| 范围 | 能力 |
| --- | --- |
| imports:read | 读取接口字段、批次、结果及原文件 |
| imports:write | 上传、开始解析、校对预览、创建结构化批次和后续批次 |
| imports:commit | 确认批次写入（含既有计划直接生效）、纠正或删除历史资料、删除导入批次 |
| data:read | 查询可见人员／项目／计划／任务上下文，导出业务数据 |

## 接口

| 方法与路径（相对 `/api/v1`） | 说明 |
| --- | --- |
| GET `/schema` | 可接受字段与流程 |
| GET `/context` | 本身份可见的人员、项目、月计划及任务 |
| GET `/imports` | 批次摘要与解析进度 |
| POST `/imports` | `{fileName,mimeType,base64,mode?}` 或 `{fileName,text,mode?}`；保存原资料。省略mode兼容旧客户端默认为history；当前网页显式传existing |
| POST `/imports/structured` | `{sourceKey,mode,rows}`；直接提供已解析的月／周记录，无需再调用系统模型 |
| GET `/imports/:id` | 批次、逐行字段、问题及来源 |
| DELETE `/imports/:id` | `{version}`；删除批次及其归档历史，保留已生成计划和报告；需 imports:commit |
| POST `/imports/:id/analyze` | `{version,sheets?,kind?,period?,instruction?,forceRefresh?}`；202响应后轮询批次的 `analysis` |
| PATCH `/imports/:id` | `{version,mode,rows}`；传完整原行集合，`selected:false` 表示暂不导入 |
| POST `/imports/:id/commit` | `{version}`；事务保存。成功后的重复请求返回原结果，不重复写入 |
| POST `/imports/:id/request-confirmation` | `{version}`；已有计划校对后请求管理员统一确认，保留批次与内容，无需成员重新提报 |
| POST `/imports/:id/fork` | `{}`；复用原资料创建待解析后续批次 |
| GET `/imports/:id/source` | 下载原始文件 |
| GET `/imports/history` | 本身份可见的历史资料 |
| PATCH `/imports/history/:id` | `{version,row,reason}`；只纠正历史记录，保留原文和审计 |
| DELETE `/imports/history/:id` | `{version}`；删除单条历史资料，保留来源与其他记录；需 imports:commit |
| GET `/data/export?format=json&type=all` | 业务导出；format支持json/csv/xlsx，type见界面；可加month/ownerId/projectId |

R3 保留 `/context` 的完整集成协议，内部已使用独立读取，不再调用全量工作空间方法。网页候选改用分页查询；业务导出仍覆盖完整授权集合，不受网页页长限制。网页接口及退役说明见[页面数据路径](workspace-data-paths.md)。

结构化写入示例（所有编号先从 `/context` 获取）：

```json
{
  "sourceKey": "dingtalk-sheet-week-2026-09-07-request-001",
  "mode": "draft",
  "rows": [{
    "kind": "weekly",
    "sourceRow": 2,
    "sourceSheet": "周计划",
    "sourceText": "这里保存原始行文字",
    "title": "完成样机调试",
    "ownerId": "实际人员编号",
    "monthlyPlanId": "实际月计划编号",
    "weekStart": "2026-09-07",
    "dueDate": "2026-09-11",
    "expectedOutcome": "完成串口通信验证",
    "actualOutcome": "",
    "sourceStatus": "计划中"
  }]
}
```

`sourceKey` 由调用方为一次来源请求稳定生成：同编号同内容返回原批次；同编号换内容返回409，需先核对原批次。生成后先检查每条 `issues`，再确认写入。历史模式为 `history`，允许保留缺项，但不会当作已发布计划或已验收成果。

**已有计划模式 `existing`**：月计划至少提供ownerId、month、title；周计划至少ownerId、weekStart、title。没有的预期成果、验收标准、精确截止日期保留为空。管理者确认后月计划直接published、周记录submitted=true，不伪造成员submit/approve事件。周计划可以暂不关联月计划，并注明“导入未关联”，不会虚构临时工作原因。

**临时工作属性**：`kind` 仍选择 `monthly`（纳入月度目标）或 `weekly`（纳入周计划），用独立可选字段 `isTemporary:true` 和 `temporaryReason` 标明领导临时交办等来源；不要把 `kind` 改为 `temporary`。缺省 `isTemporary` 兼容旧数据，不会把所有未关联月目标的导入记录判为临时工作。该字段必须是真正的 JSON 布尔值，不能传 `"true"`、`1` 等替代值。

`history` 可以保留临时原因缺项，供后续核对；纳入 `draft` 或 `existing` 时，临时事项必须填写非空 `temporaryReason`。临时周任务不可同时填写 `monthlyPlanId` 或 `linkedRowId` 关联月目标。成员可以导入本人临时月目标草稿，再按月度审核发布流程提报；普通月目标草稿仍由管理者创建。所有 `existing` 导入（含临时事项）仍需管理者确认，成员可调用 `request-confirmation`。

例如将领导临时交办加入周计划草稿：

```json
{
  "sourceKey": "assigned-work-2026-09-17-001",
  "mode": "draft",
  "rows": [{
    "kind": "weekly",
    "title": "完成临时演示环境检查",
    "ownerId": "实际人员编号",
    "weekStart": "2026-09-14",
    "dueDate": "2026-09-18",
    "expectedOutcome": "提交环境检查记录",
    "isTemporary": true,
    "temporaryReason": "领导临时交办，保障本周演示"
  }]
}
```

可选 `monthlyResult` 为pending/submitted/accepted/not_completed；只有管理者可新指定accepted且必须提供actualOutcome。原表写“完成”不自动等于已验收；缺省有实际成果时为submitted，否则pending（原文明确未完成时为not_completed）。可选 `weeklyStatus` 为planned/doing/blocked/done/not_done；省略时按明确的原始状态保守匹配。来源状态和原文仍保留。模型不能指定这些确认选项。

同一来源行的draft与existing共用业务身份：原草稿未被修改时可原ID生效，已经生效则跳过；已手工修改的草稿不覆盖，返回409。不同文件版本的模糊自动合并仍不支持。

月计划草稿需要 ownerId、month、dueDate、title、expectedOutcome、acceptanceCriteria，以及 projectId 或 category。周记录草稿需要 ownerId、weekStart、dueDate、title、expectedOutcome，以及 taskId、monthlyPlanId、同批月计划行 linkedRowId，或明确临时属性及原因。关联本批月计划时，先取得服务端生成的行id再PATCH周记录的linkedRowId。

后台 `analysis.status` 为 running/completed/failed；`completedChunks` 和 `totalChunks` 表示进度。解析失败仍可读取原文件并重试。`committedCount` 为新增数量，`activatedCount` 为沿用原草稿转为生效的数量，`skippedCount` 为相同来源项跳过数量。`reviewRequestedAt` 表示待管理员确认；继续校对或重新解析后会清空，需再次确认。

错误返回 `{error:string}`；400为输入或业务校验失败，401为凭证无效，403为权限不足，409为版本/来源冲突，429为限流，502/504为模型失败或超时。令牌每分钟最多120次请求；轮询建议间隔2秒以上。

管理员JSON恢复只通过网页认证 `/api/data/restore/preview` 和 `/commit` 开放，令牌不允许恢复整个数据包。模型连接配置与令牌创建同样要求管理员网页会话。

业务 JSON 导出和恢复保留历史行及其审计快照中的 `isTemporary`、`temporaryReason`，旧包不含这些字段仍可恢复。CSV/XLSX 在历史资料的 `row` JSON 单元格、审计快照单元格及月目标／任务对应字段列中保留临时属性。此次仅增加可选 JSON 字段，不改变数据库或迁移包格式版本。

## R4 年度关联与投入字段

校对及结构化导入支持 `annualGoalId?: string|null`、`remainingEffortDays?: number|null`、`plannedEffortDays?: number|null`、`actualEffortDays?: number|null`。月目标年度关联须同年；后面三项用于个人任务剩余工作量及周预计/实际投入。导入允许数字字符串并规范化为非负 0.5 人日步长数值；空白规范化为 null，零保留为零，未提供字段不覆盖旧值。选择现有任务时沿用其任务级字段。

包含 R4 字段、冻结汇总或月报模板的业务包使用格式 8；无新内容的老包保留原版本选择。CSV 属于辅助数据，正式报告通过 Word 模板流程生成。完整口径、权限与回退说明见[业务补齐说明](business-r4.md)。
