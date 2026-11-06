# 钉钉文档生产权限只读验证

验证时间：2026-11-06 09:29–09:53（Asia/Taipei）。此记录不是功能上线或真实计划导入验收。

## 结论

**09:53 最新结论：**用户分别明确授权后，现有企业应用 **天枢实验室** 已开通 `qyapi_get_member`、`Wiki.Node.Read`、`Document.Workbook.Read` 三项只读权限，逐项回读均为 `authed=true`。生产凭据与本人操作身份驱动的当前连接器已真实完成 `discover + read`：目录查找完整，找到唯一目标 Sheet，完整读取并复读核对 `A1:I8`，共 8 行、9 列，含表头及 7 条计划。没有部署新功能、修改服务环境文件或导入计划；操作人 unionId 仅在探针进程内存使用。

**09:45 中间结果（历史记录）：**仅开通用户第一轮授权的 `qyapi_get_member` 后，本人身份读取成功；随后目录/节点缺少 `Wiki.Node.Read`，工作表列表缺少 `Document.Workbook.Read`，均返回 HTTP 403。当时尚未申请这两项权限，也未读取单元格。

**首次只读检查（09:30，历史记录）：**应用凭据可取得新版和旧版应用访问令牌，但读取操作人详情被拒绝：`errcode=88`、`subCode=60011`，缺少 `qyapi_get_member`。请求号为 `15qt3aefas24e`，诊断时间为 `2026-11-06T01:30:42.039Z`。当时停止后续文档请求；下面保留该阶段的验证依据。

## 验证范围与证据

- 通过原部署脚本记录的 SSH 连接和独立固定 Host Key 文件访问生产主机，全程保持严格主机校验。
- 只在远端进程读取现有环境文件并发出只读接口请求；没有输出环境内容、令牌、密钥或用户完整身份资料。
- 新版 `/v1.0/oauth2/accessToken` 与旧版 `/gettoken` 均返回 HTTP 200，令牌只保存在探针进程内存。
- 当前本机 DWS 组织与生产 `corpId` 在远端布尔核对一致。本人已有一条生产钉钉绑定，但没有 `nativeIdentities` 中可复用的已核验 unionId。数据库仅以只读连接查询该用户必要身份字段及计数。
- `/topapi/v2/user/get` 返回上述权限错误。官方全局错误码把 88 定义为鉴权异常，须继续查看子错误码；本次不能把它当作限流或临时失败反复重试。
- 本机 DWS 详情读取确认应用名称为“天枢实验室”，状态 `normal`；远端布尔核对其 Client ID 与当前部署一致。没有创建应用、调整权限、修改配置或重启服务。
- 本机 DWS 的通讯录详情未提供可直接复用的 unionId。没有切换账号或组织，也没有复制本机登录凭据到生产。

## 目标元数据（本机 DWS 已核实）

- 文件夹：人工智能实验室管理，`YQBnd5ExVE1BK3vlhadjO74MVyeZqMmz`。
- 文件：[10月月报材料](https://alidocs.dingtalk.com/i/nodes/ZX6GRezwJlyqkwAgcjvLgDKa8dqbropQ)，在线电子表格 `axls`。
- 逻辑文档元数据：父文件夹与上述 ID 一致，workspaceId 为 `r9xmyy5837EpWmEO`。
- 底层存储元数据：spaceId `2912762494`，dentryId `242065936206`，文件名可能显示内部数字名。发现功能应使用文档节点业务名称，不把存储层数字名当作月报标题。
- 目标 Sheet：`st-cbfeedbf-46884`（11月目标）。本机读通不等于生产应用读通。

## 已核实的官方接口契约

2026-11-06 从钉钉官方可读索引进入并读取以下 Markdown 全文：

1. [获取节点列表](https://open.dingtalk.com/document/development/get-node-list.md)：`GET /v2.0/wiki/nodes`，`parentNodeId`、`operatorId` 必填；每页最多 50，`nextToken` 非空需续页；权限 `Wiki.Node.Read`。
2. [获取所有工作表](https://open.dingtalk.com/document/development/obtain-all-worksheets.md)：`GET /v1.0/doc/workbooks/{workbookId}/sheets`，返回 `value:[{id,name}]`；权限 `Document.Workbook.Read`。该文档明确知识库 API 返回的 `nodeId(dentryUuid)` 即 `workbookId`，无需猜测另一套 ID。
3. [获取工作表](https://open.dingtalk.com/document/development/obtain-worksheet-properties.md)：返回 `lastNonEmptyRow`、`lastNonEmptyColumn`，从 0 开始，空表返回 -1。`rowCount/columnCount` 是网格尺寸，不能当作实际数据行数。
4. [获取单元格区域](https://open.dingtalk.com/document/development/get-cell-properties.md)：返回二维 `values`、`displayValues` 等；`values` 是公式计算结果，`displayValues` 是格式化显示值；可用 `select` 缩小字段。
5. [根据链接获取节点](https://open.dingtalk.com/document/development/get-node-by-link.md)和[根据 UUID 获取存储 ID](https://open.dingtalk.com/document/development/api-getdentryidbyuuid.md)属于可用的元数据解析能力，本次尚未使用生产身份验证。

上述读取请求使用应用访问令牌以及操作人 `unionId`。当前“获取工作表 / 单元格区域”契约没有合并区域和原子快照版本字段。连接器应明确标为“合并信息未知”，不依据空值向下填充，不虚构 revision。完整读取需核对非空边界、分段矩阵维度，并在发现变化时拒绝提交。

## 待完成的生产验收

1. 已完成：按用户分轮明确授权开通 `qyapi_get_member`、`Wiki.Node.Read` 和 `Document.Workbook.Read`，并用生产身份取得本人 unionId。本次令牌与 unionId 仅保存在探针内存，没有回显或落盘。
2. 将明确的操作人 unionId 作为服务端文档连接配置。不能填 userid、姓名或 Agent ID。
3. 已完成：使用生产应用及已核验操作人，执行当前连接器对固定文件夹的发现、指定工作表属性及完整 `A1:I8` 读取。资源级访问在实际读取中通过；不是仅凭 token 或权限清单判定。
4. 已完成连接器样本验证：实际范围 8×9、七条目标、九列表头及七个明确年月日期。仍需部署后完成页面预览及人工导入验收；没有实际写入月度目标。

首次检查没有改动任何权限；第二阶段仅申请用户明确授权的 `qyapi_get_member`，第三阶段仅申请用户另行明确授权的 `Wiki.Node.Read` 与 `Document.Workbook.Read`。所有阶段均没有改动生产业务数据、钉钉文档、服务器配置或外发消息。

## 用户授权后的单权限申请与复验

申请目标为“天枢实验室”，统一应用 ID 为 `a12be6e0-c4bd-48ba-836a-05ae6ed30271`。操作前只查询 `qyapi_get_member`：`authed=false`、`allowedActions` 包含 `apply`、`requiredApproval=false`。dry-run 明确仅提交该应用和这一项 scope，随后按已有明确用户授权执行同一命令 `--yes`。

申请回执：`applied=true`、`appliedScopeValues=[qyapi_get_member]`、`directScopeValues=[qyapi_get_member]`、`rejectedScopeValues=[]`、`versionStagedScopeValues=[]`。只回读这一权限，结果 `authed=true`。未创建或发布应用版本。

生产复验时间：`2026-11-06T01:45:11.041Z`（09:45）。同企业、同应用布尔校验通过，结果如下：

| 只读检查 | 结果 |
| --- | --- |
| 新版 / 旧版应用 token | HTTP 200，成功 |
| 本人操作身份详情 | HTTP 200，userid 匹配，取得 unionId |
| 已知文档链接元数据 | HTTP 403；`Forbidden.AccessDenied.AccessTokenPermissionDenied`；响应明确提到 `Wiki.Node.Read` |
| 固定来源文件夹节点列表 | HTTP 403；同上，响应明确提到 `Wiki.Node.Read` |
| 已知工作簿工作表列表 | HTTP 403；同上，响应明确提到 `Document.Workbook.Read` |
| `11月目标!A1:I8` | 未执行，工作表列表前置失败 |

当前不能把生产链路报告为已接通，也不能据以上错误判定操作人是否拥有资源级阅读权限：应用 scope 检查尚未通过。此带有 `AccessToken` 字样的错误是缺接口权限，连接器按“权限不足”处理，不循环刷新 token。

上述“当前”指 09:45 的历史状态；09:53 的最终成功验证如下。

## 两项文档读权限授权与完整连接器验证

仅查询 `Wiki.Node.Read` 与 `Document.Workbook.Read`，二者均为 `authed=false`、允许 `apply`、`requiredApproval=false`。同一现有应用上的合并 dry-run 准确列出这两项后，取得用户明确授权，执行相同参数的正式申请。回执 `directScopeValues` 仅含这两项，`versionStagedScopeValues=[]`、`rejectedScopeValues=[]`；逐项回读均为 `authed=true`。没有创建或发布应用版本，没有申请文档写权限或其他 scope。

真实连接器探针在 `2026-11-06T01:52:50.940Z` 开始。将本地当前 `server/dingtalk-documents-client.ts` 打包为临时代码，通过原严格校验的 SSH 标准输入在生产 Node 进程内执行；未安装或替换生产应用文件。探针读取原环境文件，在内存取得和核验本人 unionId，再只对该进程的客户端配置赋值。

探针实际调用 `createDingTalkDocumentsClient(...).discover('2026-11')`，从完整发现结果精确选择已知文档和 Sheet，再执行该客户端的 `read(...)`。因此覆盖的是当前连接器的目录归属复核、Sheet 列表、边界校验、完整范围读取和第二遍摘要一致性核对，而不是独立请求一次单元格范围。

| 实测项目 | 结果 |
| --- | --- |
| 固定目录发现 | `complete=true`，唯一目标候选；目录分页均已结束 |
| 节点类型 | `type=FILE`、`category=ALIDOC`、`extension=axls` |
| 官方节点标题 | `10月月报材料.axls`；源标题保留，匹配规则已兼容 `.axls` 后缀 |
| 工作表列表 | `10月目标完成情况`、`11月目标`；仅后者进入候选 |
| 非空边界 | `lastNonEmptyRow=7`、`lastNonEmptyColumn=8`，确认为 0 基 |
| 网格尺寸 | `rowCount=200`、`columnCount=40`，没有误读为实际数据范围 |
| 完整范围 | `A1:I8`；两遍 `values`、`displayValues` 均为 8 行×9 列 |
| 一致性 | 三次边界核对一致，两遍完整内容摘要一致，`complete=true` |
| 计划行数 | 7 条（不含表头） |
| 表头 | 序号、部门、指标类型、工作事项、工作内容（做什么）、交付产物（可量化验收标准）、负责人、截至时间、备注 |
| 日期 | 7 个明确日期，最早 `2026-11-06`、最晚 `2026-11-30` |
| 合并元数据 | OpenAPI 未提供，`mergesKnown=false`，不宣称已证明无合并 |

年份未写入文件标题，发现结果不自动预选，保留“结合原表日期确认年份”的提示。真实正文和人员姓名未写入本记录或本地探针产物；只输出上述核验摘要。

生产读取链路已经验证通过，但运行服务的 `DINGTALK_DOCUMENT_OPERATOR_ID` 尚未持久配置，新功能也尚未部署；本记录不能用作功能上线或计划导入成功的证据。
