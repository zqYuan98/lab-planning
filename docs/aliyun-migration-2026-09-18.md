# 阿里云迁移完成记录（2026-09-18）

状态：**已完成 37 服务器账号与整库数据迁移，正式入口为 https://lab.notvitamin.com/。** 原账号和密码保留；更换域名后需要重新登录。

最终源端冻结时间为北京时间 **14:46:39**（UTC **06:46:39**），新服务于北京时间 **14:47:11** 可用。本次发布使用 37 已上线的稳定版本 `bb6469a`，未包含共享工作区正在开发的钉钉接入功能，未启用钉钉通知。

后续更新：同日 **15:16:17** 已在阿里云升级钉钉功能版本 `dingtalk-20260918T070350Z`，保留原数据库，外发仍关闭。当前运行版本及验收见[钉钉功能升级记录](deployment-aliyun-dingtalk-2026-09-18.md)；下文保留首次迁移时的事实。

## 正式部署

目标为 `personal/aliyun-cloud-01`，公网 IP `120.26.254.159`，Ubuntu 26.04 / x86_64。独立安装 Node.js 24.20.0，由 systemd 托管；没有替换主机原有 Node.js 22。

```text
https://lab.notvitamin.com/
  → Cloudflare HTTPS
  → 原 cloudflared-weknora.service 隧道新增 hostname
  → Nginx 127.0.0.1:18431
  → Node.js / Express 127.0.0.1:4310
  → 本机 SQLite
```

用户手动添加 Cloudflare CNAME：`lab` → `b0c8b73b-9197-4ed6-a5bb-ddc0c99d3944.cfargotunnel.com`，开启代理（橙云）。复用隧道 `b0c8b73b-9197-4ed6-a5bb-ddc0c99d3944`；原 `kb.notvitamin.com` 仍返回 200，主域名配置未变。Cloudflare 终止公网 TLS，应用和新增 Nginx 入口均仅监听回环地址。

| 项目 | 正式位置或配置 |
|---|---|
| 程序版本目录 | `/srv/lab-planning/releases/bb6469a-20260918` |
| 当前版本软链接 | `/srv/lab-planning/current` |
| 独立 Node.js | `/opt/lab-planning/node-v24.20.0-linux-x64/bin/node` |
| 应用服务 | `lab-planning.service`，账号 `lab-planning` |
| 环境文件 | `/etc/lab-planning/app.env` |
| 持久数据库 | `/var/lib/lab-planning/lab-planning.sqlite` |
| 正式来源 | `APP_ORIGIN=https://lab.notvitamin.com` |
| Cookie / 代理 | `COOKIE_SECURE=true`、`TRUST_PROXY=loopback` |
| 每日备份 | `/var/backups/lab-planning` |

Nginx 仅信任本机隧道入口传入的 `CF-Connecting-IP`，向应用覆盖转发头；公网 HTTP 请求跳转到规范 HTTPS 地址。普通请求体限制为 `256k`，`/api/imports`、`/api/v1/imports` 及其子路径为 `16m`，`/api/data/restore/` 为 `35m`，与应用限制匹配。

## 来源与最终数据核验

- 来源：`192.168.0.37`，SSH 用户 `yzq`，版本目录 `/home/yzq/apps/lab-planning/releases/bb6469a`。
- 原容器：`lab-planning-intranet-app-1`；原卷：`lab-planning-37-data`。
- 来源镜像：`sha256:28cba9dce141b1edcfb1ca676121769ef774f15ca09c3298fc1419028e4b9eef`，amd64。
- 稳定源码归档：`output/aliyun-deploy-20260918/stable-source-bb6469a.tar.gz`，SHA-256 为 `20767db1e22b0d06fe7d97bb33d49082a80e893a200a3d3de9b32f45ed03e7e6`；已排除环境文件、数据库、依赖、构建产物和 Git 元数据。
- **最终冻结备份**：`/home/yzq/apps/lab-planning/backups/final-aliyun-20260918T064639.922868848Z-2528609.sqlite`，权限 `0600`。
- **最终备份 SHA-256**：`5ba246bd98cb14baa7fa551828c6177e2367739a1033431e608ab5f4b2852c8d`。
- 冻结源、最终备份、新机启动前及启动后的全部实体排序 SHA-256 均为 **`5477c5c12b2727b94ce7a8a84050fb406fc654bda769376334312f474a8282da`**；完整性检查通过。

最终一致快照包含 **356 个实体**：6 个账号、3 个项目、4 个年度目标、14 个月度目标、21 个任务、24 条周记录、1 份周提报，以及导入来源、解析资料、历史、发布记录、会话、审计和其他设置。AI `settings/ai-connection` 存在，运行中的导入任务为 0。账号与密码未重设，数据库内的 AI 配置随整库迁移。

本机 `output/aliyun-deploy-20260918/linux-evidence/` 中的 `source-final-audit.json`、`target-before-start-audit.json`、`target-after-start-audit.json` 三份审计结果一致：完整性为 `ok`，存储版本为 1，全部集合计数及上述实体摘要相同。

14:11 的准备阶段在线备份 `pre-aliyun-20260918T061113.sqlite` 仍保留，但**不是本次最终切换数据**；最终备份包含此后新增的任务与周记录。

冻结过程持有既有部署锁和备份锁。第一轮只读冻结审计失败后自动恢复原容器；修正源容器 UID 1000 / 宿主账号 UID 1001 以及停服后 SQLite WAL 元数据访问问题后，第二轮通过。最终方案从只读源卷向 tmpfs 冷复制数据库及 WAL，再使用 SQLite 在线备份 API 生成并校验最终文件，没有修改源卷权限或重写源业务数据。

## 验收证据

- 稳定源码在本地及目标 Linux 环境均 **223/223 测试通过**；TypeScript 和生产构建通过。
- Linux 隔离实例通过静态资源、认证 API、SQLite 写入、Word 导出、在线备份及重启持久化验收，使用合成资料。
- 本机从工作区根目录执行 `node --use-env-proxy lab-planning/output/aliyun-deploy-20260918/verify-public.mjs`，实际退出码为 **0**：正式公网首页及其引用的 JavaScript 返回 **200**，页面 CSP 符合预期，`/api/auth/status` 返回 **200** 且为 **`initialized:true`**，未登录请求 `/api/bootstrap` 返回 **401**。
- 公网体积路由验收：约 **300kB** 的未认证 JSON POST 请求访问 `/api/imports`、`/api/v1/imports`、`/api/data/restore/preview` 均返回 **401**，说明超过普通 256k 限制的请求可到达这些接口的认证检查；同一请求访问 `/api/projects` 返回 **413**。这覆盖大请求路由差异，完整 `16m` / `35m` 上下界仍属于独立的体积边界测试。
- 公网来源校验：使用不合法 Origin 向 `/api/imports` POST 返回 **403**。上述未认证探针没有创建账号或业务记录。
- 浏览器正常显示正式登录页；原 `kb.notvitamin.com` 返回 **200**。
- 正式账号和数据的保留依据为整库迁移及启动前后全部实体摘要一致；隔离测试没有在正式库创建测试账号或业务资料。
- 新机首次正式备份实测成功，每日备份 timer 已启用。
- AI 配置随整库迁移；目标主机以 `lab-planning` 系统账号、原始 Node.js 24 向原 AI 服务 HTTPS 源地址发起无凭证 HEAD，请求返回 **200**。本项确认 HTTPS 连通性，模型推理未在本轮验收中验证。

公网、浏览器、备份及 AI 连通性的观测摘要保存在 `output/aliyun-deploy-20260918/linux-evidence/acceptance-summary.json`，与本节结果相符。

## 日常运维与备份

`lab-planning-backup.timer` 每日北京时间 **03:10** 触发，附加 **0–2 分钟**随机延迟，并配置错过后补跑。备份保存于 `/var/backups/lab-planning`，使用在线备份与完整性检查，附带 SHA-256；不自动删除旧备份。当前为**同机备份，不等于异机容灾**，仍需安排受控异机副本、容量监控和保留策略。

```sh
sudo systemctl status lab-planning.service lab-planning-backup.timer
sudo journalctl -u lab-planning.service -n 100 --no-pager
sudo systemctl start lab-planning-backup.service
sudo journalctl -u lab-planning-backup.service -n 50 --no-pager
```

更新程序前先生成新备份，保留既有版本目录；数据库独立于版本目录，切换 `current` 不得替换或清空数据库。该系统继续按单实例运行。

## 37 保留状态与回退边界

37 的原应用容器已停止，原版本、镜像和 `lab-planning-37-data` 卷保留。`lab-planning-aliyun-redirect` 容器仅将旧入口 GET 请求以 **302** 跳转到新网址，非 GET 请求拒绝写入，避免两端产生不同数据。

旧每日备份 cron 已单独注释，其余任务保留；原 crontab 备份保存在源部署目录的 `ops/`。暂停的原任务为：

```cron
10 3 * * * /usr/bin/bash /home/yzq/apps/lab-planning/ops/backup-intranet.sh >> /home/yzq/apps/lab-planning/backups/backup-cron.log 2>&1
```

**目标现已开放写入，禁止直接启动旧源库回退。** 如需回迁，先停止目标写入并生成、验证最新整库备份，保全目标及旧源数据，再将最新数据反向迁移到独立卷并验收后切换入口；不得用上线前备份覆盖上线后的新数据。

部署脚本、校验摘要和日志保存在本机 `output/aliyun-deploy-20260918/`。私密备份位于其 `private/` 目录，仅本机用户和 SYSTEM 可访问；数据库包含账号凭证、原始导入资料及模型配置，禁止提交 Git。
