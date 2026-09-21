# 钉钉后台核对与服务器配置记录

检查日期：2026-09-18。通过 BrowserAct 查看企业后台，应用为“天枢实验室”，企业为“安徽博诺思信息科技有限公司”。**北京时间 16:16:38 已上传并加载四项服务器凭据，取令牌实测成功；应用尚未发布，真实客户端免登与消息送达尚未验收。**

后续状态：17:50 复查时应用已发布，17:56 已开启服务器与管理界面通知开关，试点仅袁中群；本人绑定和真实客户端验收仍待完成。详见[接续操作记录](dingtalk-activation-2026-09-18.md)。下文保留首次核对时事实。

## 后台实测

| 项目 | 当前状态 |
| --- | --- |
| 应用类型 | 企业内部 H5 微应用 |
| AgentId | `5007337208` |
| CorpId | `ding3642d28c19a9b98235c2f4657eb6378f` |
| AppKey / Client ID | `dingcrbp626ho682o6a5` |
| AppSecret | 已从应用信息页取得；本记录不保存密钥正文 |
| 移动首页 | `https://lab.notvitamin.com/work`，正确 |
| PC 首页 | `https://lab.notvitamin.com/work`，正确 |
| 服务器出口 IP 白名单 | 未设置；目标服务器 `/gettoken` 实测成功，当前未阻断此接口；未修改此项 |
| 通讯录授权范围 | 部分员工，授权部门“人工智能实验室” |
| 免登接口权限 | `qyapi_base` 已默认开通，后台列出“通过免登码获取用户userid(v2)”与“获取Access Token” |
| 工作通知接口权限 | `qyapi_base` 已默认开通，后台列出异步发送工作通知及获取发送结果 |
| 应用发布 | 未完成；“版本管理与发布”仍显示“确认发布” |
| 成员可见范围 | 尚未完成发布后核对；通讯录授权范围不能替代应用可使用范围 |
| 登录与分享回调域名 | 空；当前代码走 H5 JSAPI 授权码，不使用 OAuth 重定向登录 |
| 管理后台地址、事件回调 | 当前代码不需要 |

开发管理当前表单没有独立“安全域名”字段，不能据此声称其他页面的安全域名已配置。需在真实钉钉客户端验证当前首页域名与免登能力。

## 服务器上传清单

目标为阿里云 `personal/aliyun-cloud-01`（`120.26.254.159`）。仅更新 `/etc/lab-planning/app.env` 中的下列四项，不重传程序、数据库或前端构建。

| 服务器变量 | 来源 |
| --- | --- |
| `DINGTALK_CORP_ID` | 企业首页 CorpId |
| `DINGTALK_CLIENT_ID` | 应用信息 AppKey |
| `DINGTALK_CLIENT_SECRET` | 应用信息 AppSecret，受控 SSH 标准输入传输 |
| `DINGTALK_AGENT_ID` | 应用信息 AgentId |

保持环境文件权限 `0600`、原 `DINGTALK_DEPLOYMENT_ID` 和其他配置；`DINGTALK_NOTIFICATIONS_ENABLED=false`。应用服务为 `lab-planning.service`。配置重载前设置短暂维护窗口并确认没有运行中的导入解析；完成后恢复入口。

检查前公网 `/api/auth/dingtalk/config` 返回 `configured:false`，CorpId 与 Client ID 均为空。

服务器执行与验证结果：

- 经已固定主机指纹的 SSH 通道，四项凭据已写入 `/etc/lab-planning/app.env`，文件权限维持 `0600`。
- 使用生产 Node.js 24.20.0、服务账号 `lab-planning` 调用钉钉 `/gettoken`，HTTP `200`、`errcode:0`，有效期 `7200` 秒。访问令牌仅在进程内验证，没有保存或输出。
- 短暂维护期间确认旧 Nginx worker 已退出且没有运行中的导入解析，再重启应用；原 Nginx 配置已原样恢复。
- 运行中进程的四项凭据逐项匹配；部署标识及其他环境配置保持不变，通知外发仍为 `false`。
- 公网 `/api/auth/dingtalk/config` 返回 `configured:true`，CorpId、Client ID 与后台一致。
- `/work` 返回 `200`；`/api/auth/status` 返回 `initialized:true`；未登录访问消息和通知设置接口仍为 `401`。
- `lab-planning.service`、Nginx、Cloudflare 隧道及每日备份 timer 均为 `active`；原知识库站点仍返回 `200`。
- 本轮没有重传源码或数据库，没有绑定用户、扩大权限范围、发布应用或发送真实工作通知。

服务器受限备份和记录目录为 `/root/lab-planning-dingtalk-config-20260918T081634Z/`（`0700`）。其中 `app.env.before` 和 `nginx.conf.before` 为变更前备份；`verification.json` 为非密钥验收摘要。完整后台核对记录另存为该目录下 `console-audit.md`。

本地证据：`output/dingtalk-config-20260918/server-configuration-result-attempt2.jsonl`、`public-before.json`、`public-after.json`。首次调用因本地加密文本尾部换行解析失败，被服务端输入校验拒绝，未变更服务器配置；修正本地读取后完成上述操作。

本机临时凭据使用 Windows 当前用户 DPAPI 加密，位于 `%LOCALAPPDATA%\CodexTaskSecrets\dingtalk-5007337208\client-secret.dpapi`，目录访问权限限当前用户与 SYSTEM。完成上传后，自动审批拒绝了该单文件的清理操作，仅返回 `blocked by policy`；文件因此保留，未采取其他方式绕过删除限制。

## 尚需完成的上线步骤

1. 发布企业内部应用，并设置和核对应用可使用范围。
2. 试点本人从钉钉工作台打开应用，登录既有系统账号，显式确认绑定本人身份，再验证重新进入时免登。
3. 分别核对手机与 PC 入口；配置完整不等于真实客户端验收完成。
4. 如需真实通知，约定接收人和试点事项后，再启用服务器外发与管理界面的试点设置；本轮不向成员发送消息。

后台开发配置及发布页面的非密钥证据保存在 `output/dingtalk-config-20260918/`。密钥正文不进入本记录或 Git。
