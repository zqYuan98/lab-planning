# 智能体与数据导入 API（v1）

管理者在“数据导入 → 智能体与 API 接入”创建令牌。令牌只显示一次，服务端仅保存摘要；到期、撤销、账号停用或密码更换后失效。令牌代表创建者，不能绕过该用户的业务权限。没有开放管理者审核、发布或成果验收接口给集成令牌。

请求基址为当前站点的 `/api/v1`，请求头为 `Authorization: Bearer <令牌>`，写请求使用 `Content-Type: application/json`。网页会话的 `/api` 与令牌接口分别认证。

| 范围 | 能力 |
| --- | --- |
| imports:read | 读取接口字段、批次、结果及原文件 |
| imports:write | 上传、开始解析、校对预览、创建结构化批次和后续批次 |
| imports:commit | 确认批次写入、纠正已保存历史资料 |
| data:read | 查询可见人员／项目／计划／任务上下文，导出业务数据 |

## 接口

| 方法与路径（相对 `/api/v1`） | 说明 |
| --- | --- |
| GET `/schema` | 可接受字段与流程 |
| GET `/context` | 本身份可见的人员、项目、月计划及任务 |
| GET `/imports` | 批次摘要与解析进度 |
| POST `/imports` | `{fileName,mimeType,base64}` 或 `{fileName,text}`；保存原资料 |
| POST `/imports/structured` | `{sourceKey,mode,rows}`；直接提供已解析的月／周记录，无需再调用系统模型 |
| GET `/imports/:id` | 批次、逐行字段、问题及来源 |
| POST `/imports/:id/analyze` | `{version,sheets?,kind?,period?,instruction?,forceRefresh?}`；202响应后轮询批次的 `analysis` |
| PATCH `/imports/:id` | `{version,mode,rows}`；传完整原行集合，`selected:false` 表示暂不导入 |
| POST `/imports/:id/commit` | `{version}`；事务保存。成功后的重复请求返回原结果，不重复写入 |
| POST `/imports/:id/fork` | `{}`；复用原资料创建待解析后续批次 |
| GET `/imports/:id/source` | 下载原始文件 |
| GET `/imports/history` | 本身份可见的历史资料 |
| PATCH `/imports/history/:id` | `{version,row,reason}`；只纠正历史记录，保留原文和审计 |
| GET `/data/export?format=json&type=all` | 业务导出；format支持json/csv/xlsx，type见界面；可加month/ownerId/projectId |

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

月计划草稿需要 ownerId、month、dueDate、title、expectedOutcome、acceptanceCriteria，以及 projectId 或 category。周记录草稿需要 ownerId、weekStart、dueDate、title、expectedOutcome，以及 taskId、monthlyPlanId 或同批月计划行 linkedRowId。关联本批月计划时，先取得服务端生成的行id再PATCH周记录的linkedRowId。

后台 `analysis.status` 为 running/completed/failed；`completedChunks` 和 `totalChunks` 表示进度。解析失败仍可读取原文件并重试。`committedCount` 为新增数量，`skippedCount` 为相同来源项跳过数量。

错误返回 `{error:string}`；400为输入或业务校验失败，401为凭证无效，403为权限不足，409为版本/来源冲突，429为限流，502/504为模型失败或超时。令牌每分钟最多120次请求；轮询建议间隔2秒以上。

管理员JSON恢复只通过网页认证 `/api/data/restore/preview` 和 `/commit` 开放，令牌不允许恢复整个数据包。模型连接配置与令牌创建同样要求管理员网页会话。
