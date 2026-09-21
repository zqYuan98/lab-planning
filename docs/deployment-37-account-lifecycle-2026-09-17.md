# 37 服务器成员账号管理更新（2026-09-17）

## 发布结果

- 地址：<http://192.168.0.37:4310/>。
- 切换完成：2026-09-17 16:12:29 +08:00，容器健康状态 `healthy`。
- 应用提交：`bb6469a560ec58c15c554506001f61e3a4eb585d`。
- 当前目录：`/home/yzq/apps/lab-planning/releases/bb6469a`。
- 镜像：`lab-planning:bb6469a`，同时标记 `lab-planning:intranet`。
- 镜像 ID：`sha256:28cba9dce141b1edcfb1ca676121769ef774f15ca09c3298fc1419028e4b9eef`。
- 源码归档 SHA-256：`4997028a5573ab1e6e374d04445653b32c4b7756e8b4a9339c1518da4658512c`。

本次提供无业务关联账号删除、有关联账号的删除原因预览，以及停用成员的日常隐藏和历史查看。未自动停用、删除或修改任何正式账号。规则见[成员账号管理](member-accounts.md)，验收见[验证记录](account-lifecycle-validation-2026-09-17.md)。

## 发布验证

- 本地完整测试 223 项通过，构建通过；服务器候选镜像中再次运行 223 项测试，全部通过。
- 候选容器使用隔离网络和独立匿名卷，完成静态资源、认证 API、SQLite 写入、Word 导出、备份及重启持久化冒烟验证。
- 正式站点首页与 JavaScript、CSS 均返回 HTTP 200，`/api/auth/status` 返回 `initialized: true`。
- 正式资源与本地构建一致：`index-CNjmxkr2.js`、`index-kTO2Hj6p.css`。

## 数据与备份

继续使用原数据卷 `lab-planning-37-data`，保留原环境配置。切换前在线备份，停止旧实例后再次备份。数据库完整性为 `ok`，存储版本仍为 1，无运行中的导入任务。

- 在线备份：`/home/yzq/apps/lab-planning/backups/lab-planning-20260917T081220.477622606Z-3517538.sqlite`。
- 停机备份：`/home/yzq/apps/lab-planning/backups/before-account-lifecycle-bb6469a.sqlite`；原卷中也保留同名备份。
- 切换前后业务实体摘要相同：`b067d8e5ee589935c96501364b0af73048fbfc682cb1f5b2b4b59ee07e361846`。
- 逐记录核对：新增、删除、修改均为 0。保留 6 个账号、14 条月度计划、12 个任务、12 条周记录、18 条导入历史及其他现有资料。

## 回退准备

前一版本为 `71040a3`，旧镜像保留为 `lab-planning:before-account-lifecycle-bb6469a`，镜像 ID 为 `sha256:04ef95595a2cdd9fec0fde6f2c8a518baabce7c92c2958c275b3c0bab9e5eebb`。发布脚本在验证失败时仅恢复旧应用和目录链接，保留当前数据卷；本次未触发回退。

构建、测试、部署脚本和数据审计保存在服务器 `/home/yzq/apps/lab-planning/ops/`，文件名包含 `bb6469a`。不将正式数据库或环境密钥收入源码。
