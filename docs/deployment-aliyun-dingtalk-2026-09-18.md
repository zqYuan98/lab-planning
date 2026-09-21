# 阿里云钉钉功能升级记录（2026-09-18）

状态：**北京时间 2026-09-18 15:16:17 完成升级，正式入口为 https://lab.notvitamin.com/，工作入口为 https://lab.notvitamin.com/work。** 原账号、密码及业务数据保留。消息中心、消息确认、提醒、钉钉绑定和通知管理代码已上线。**同日 16:16:38 已配置企业应用凭据并通过钉钉取令牌验证，外发保持关闭；应用发布、真实免登和消息送达尚未验收。** 详见[后台核对与配置记录](dingtalk-console-audit-2026-09-18.md)。下文保留 15:16 升级时的验收事实。

本次在已完成迁移的阿里云服务上升级程序，没有重新初始化或覆盖数据库，没有在正式库创建测试账号。此前的首次迁移见[阿里云迁移记录](aliyun-migration-2026-09-18.md)，钉钉管理员操作见[接入手册](dingtalk-public-server.md)。

## 发布版本与运行位置

| 项目 | 实际值 |
| --- | --- |
| 阿里云服务器 | `120.26.254.159`，`personal/aliyun-cloud-01` |
| 当前版本 | `/srv/lab-planning/releases/dingtalk-20260918T070350Z` |
| 当前软链接 | `/srv/lab-planning/current` |
| 保留的旧版本 | `/srv/lab-planning/releases/bb6469a-20260918` |
| 服务 | `lab-planning.service`，运行账号 `lab-planning` |
| Node.js | `/opt/lab-planning/node-v24.20.0-linux-x64/bin/node` |
| 服务端配置 | `/etc/lab-planning/app.env`，权限 `0600` |
| 持久数据库 | `/var/lib/lab-planning/lab-planning.sqlite` |
| 每日备份 | `lab-planning-backup.timer`，每日北京时间 03:10 加 0–2 分钟随机延迟 |
| 正式来源 | `APP_ORIGIN=https://lab.notvitamin.com` |
| Cookie 与代理 | `COOKIE_SECURE=true`，`TRUST_PROXY=loopback` |
| 钉钉外发 | `DINGTALK_NOTIFICATIONS_ENABLED=false` |

沿用 Cloudflare HTTPS → 原隧道 → Nginx `127.0.0.1:18431` → Express `127.0.0.1:4310` 的入口。未更改 DNS、隧道或其他站点配置；知识库 `https://kb.notvitamin.com/` 验收仍为 200。本次未连接或变更 37 服务器。

发布包来自工作区实际源码及锁文件，包含 209 个文件；没有使用落后于线上稳定版本的本地 Git HEAD 打包。已排除环境文件、数据库、私钥、依赖、输出目录和 Git 元数据。

- 文件：`output/aliyun-dingtalk-20260918/dingtalk-20260918T070350Z.tar.gz`
- SHA-256：`2264cc9a700ce255eeb38320a1ac88a799ecf6c9772c2aecefb9e3bd705f2e08`
- 解包后逐文件核对 `release-files.sha256`，安装和构建后再次核对。
- 运行单实例，存储版本仍为 1；消息和绑定使用既有 SQLite 实体存储新增集合。

## 备份与数据保留

切换前持有部署锁、备份锁，临时将本应用入口置为维护状态，并在停服前后确认没有运行中的导入解析任务。生成独立备份后才切换代码软链接。

最终切换前备份：

```text
/var/backups/lab-planning/pre-dingtalk-20260918T070350Z-attempt2.sqlite
SHA-256: 4ebaa2b6324bbca34f72d1354669c3099af10dc815bbc169b9f24604d5c4b92b
权限: 0600
```

备份完整性检查与 SHA-256 复核通过；上线后主库 `PRAGMA integrity_check` 为 `ok`。正式备份保留在服务器，未下载至本次发布目录。

新程序启动后、恢复公网写入前，对账号、项目、目标、任务、周记录、提报、发布、事件、设置、导入、历史、会话和身份集合逐条比较 `id/version/data`，结果完全一致。其中包含 6 个账号、3 个项目、4 个年度目标、14 个月度目标、21 个任务、24 条周记录、2 份周提报、14 条发布记录和 26 个会话。账号密码和已有配置没有重设。

周五当前有效时段的站内提醒会按新程序逻辑生成，因此通知集合可以新增；这些站内记录不表示已经向钉钉发送。外发开关与企业应用凭据状态均已核验为未启用。

第一次切换因 Nginx 重载后立即检查仍命中维护响应而自动回退旧代码；数据库原地保留。第二次重新取得最新备份，等待 Nginx 新工作进程接管，并确认代理返回的页面与新版构建文件一致后完成切换。没有使用第一次备份覆盖期间的数据。

## 验收结果

- 阿里云目标机运行全部 **288/288 测试通过**；TypeScript 检查与 Vite 生产构建通过。构建保留较大资源包提示，不影响通过。
- 新版本先在独立端口、独立 SQLite 数据库及无钉钉凭据的隔离实例验收：静态资源、登录认证、业务写入、Word 导出、在线备份及服务重启后的数据持久化均通过。
- 正式首页、`/work`、`/entry` 返回 200；引用新版 JS/CSS，资源返回 200，三个资源 SHA-256 与服务器构建结果相同。
- `/api/auth/status` 返回 `initialized:true`；`/api/auth/dingtalk/config` 返回 200 且 `configured:false`。
- 未登录请求 `/api/notifications`、`/api/notification-settings` 均返回 401。
- 原有公网路由与来源检查仍通过：约 300kB 未认证请求访问导入和恢复路由返回 401、普通项目路由返回 413；不合法 Origin 返回 403。探针没有写入业务资料。
- 匿名真实浏览器检查桌面及 390px 手机登录页均正常，新版脚本加载成功，无页面运行错误；手机无横向溢出。没有在正式环境输入凭据或提交表单。
- 应用、Nginx、原 cloudflared 服务和每日备份 timer 均为 `active`。
- 公网检查未使用正式账号执行业务操作；真实钉钉免登、绑定和送达留待企业应用配置后的试点验收。

本地非敏感证据位于 `output/aliyun-dingtalk-20260918/verification.json`、`reviewer-public-check.json`、`reviewer-browser-check.json` 及桌面/手机截图。服务器准备与切换记录位于 `/root/lab-planning-upgrade-dingtalk-20260918T070350Z/`，第二次切换记录位于其 `activation-2/`。服务器记录含配置备份，应保持仅 root 可访问，不得整体上传或提交 Git。

## 钉钉管理员下一步

创建并发布企业内部 H5 应用，移动端与 PC 首页填写 **`https://lab.notvitamin.com/work`**，按控制台要求配置域名 **`lab.notvitamin.com`**、成员可见范围和对应接口权限。准备 CorpId、Client ID / AppKey、Client Secret / AppSecret、AgentId，由部署人员直接保存到服务器环境文件，不写入前端或代码库。

当前阿里云使用 systemd，不执行 Compose 命令。修改 `/etc/lab-planning/app.env` 后，通过 `sudo systemctl restart lab-planning.service` 加载配置；正常升级和重启保持现有 `DINGTALK_DEPLOYMENT_ID`。先在外发关闭状态联调本人身份绑定和免登，再按[小范围通知试点](dingtalk-public-server.md#6-小范围启用个人通知)显式启用。

## 运维与回退

```sh
sudo systemctl status lab-planning.service lab-planning-backup.timer
sudo systemctl start lab-planning-backup.service
sudo journalctl -u lab-planning-backup.service -n 50 --no-pager
```

后续升级继续使用新的独立版本目录、切换前最新备份和原地数据库。代码回退只切换到已验证旧版本并保持外发关闭；**不能用上线前备份覆盖当前数据库**。数据库恢复属于另一项停写、备份和校验操作，应按接入手册生成新的部署标识，并重新验收后开放。

目前为同机备份；异机副本与钉钉真实客户端试点仍需后续落实。
