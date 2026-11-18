# 192.168.0.37 临时事项导入部署记录

- 时间：2026-09-17 15:10（北京时间）。入口：http://192.168.0.37:4310/。
- 应用提交：`71040a36ede85d912c60a9120c6fcf7c2704f10f`；上一版本：`22747bb248b48246ed49661cc55092e204068cdd`。
- 当前目录：`/home/yzq/apps/lab-planning/releases/71040a3`；镜像：`lab-planning:71040a3`，同时标记为 `lab-planning:intranet`。
- 镜像 ID：`sha256:04ef95595a2cdd9fec0fde6f2c8a518baabce7c92c2958c275b3c0bab9e5eebb`。

## 用户可用功能

导入校对顶部可选择纳入月度或每周计划、标为临时交办并填写说明，支持批量设置。独立临时周任务可不挂月度目标；成员可创建本人临时月度草稿，已有计划仍由管理员确认生效。临时标记与说明保留到计划、周记录、历史、迁移和报告，周卡片同时显示原任务名与周承诺。

## 验证

- 本地构建、207 项测试及差异检查通过；隔离 Docker 构建内再次通过 207 项测试。
- 独立合成数据库浏览器验收完成：单条校对、缺原因阻止生效、混合月周批量导入、计划页面落点、成员草稿、375px 手机布局。
- 隔离容器验证静态文件、登录 API、数据库写入、Word 导出、SQLite 备份及重启持久化通过，没有挂载正式卷。
- 正式容器 `healthy`，认证状态接口正常；线上 JS/CSS SHA256 与本地验收构建完全一致。
- JS：`/assets/index-DuTBOrSF.js`，SHA256 `49c2474a9a740ff57895f31c6a6b3053d7a11b4e351a42a6b002f647da764f56`。
- CSS：`/assets/index-CKGlJi4R.css`，SHA256 `5e772a50326310dd4ba95207569c41b7a3ff8d32a1b8f2ca7cf01dadd51e1e82`。

## 数据与备份

继续使用 `lab-planning-37-data` 原数据卷及原 `.env.intranet`；没有迁移、清空或覆盖数据。SQLite 完整性检查为 `ok`，存储版本仍为 1。切换前后实体摘要一致：`3e44257d5553d3e99a77290aae0f66eb96c79e7582cc98b2072b7b0ebb245297`。差异审计 added、removed、changed 均为空。

- 在线备份：`/home/yzq/apps/lab-planning/backups/lab-planning-20260917T071024.757185033Z-3264738.sqlite`。
- 切换前停服备份：`/home/yzq/apps/lab-planning/backups/before-temporary-import-71040a3.sqlite`，卷内 `/app/data/backups/` 保留同名文件。
- 旧镜像保留为 `lab-planning:before-temporary-import-71040a3`。

部署使用互斥锁、旧版本/镜像/数据卷校验、停服前正在解析任务检查、备份和启动健康检查。服务恢复后允许正常并发导入，实体差异只做审计，避免将用户正常新写入误判为损坏。自动回退只恢复应用及 current 链接，保留当前卷，绝不自动恢复旧数据库。新版本写入临时导入属性后，任何后续人工回退须考虑旧导入逻辑可能不保留新属性，优先兼容修复。

发布归档 SHA256：`a12360b294dfc42fe6ddf9c58f536b924f785dfec46a3c4eda9b238489bd9efb`。部署脚本、检查器、构建日志及差异审计保存在服务器 `/home/yzq/apps/lab-planning/ops/`，本地副本在主工作目录 `output/`。
