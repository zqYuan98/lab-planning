# 37 服务器：部门概览多维视图与 UI 上线

2026-09-17 12:19（Asia/Shanghai），按用户“部署”授权完成发布。

- 地址：http://192.168.0.37:4310/。
- 应用提交：`60238ec4aa0df995c9356185a719f0eedac9bdb9`，分支 `codex/department-overview-20260917`。
- 当前目录：`/home/yzq/apps/lab-planning/releases/60238ec`。
- 镜像：`lab-planning:60238ec`，运行别名 `lab-planning:intranet`。
- 镜像 ID：`sha256:15388cb3bb615508c2ea0f70ae0bab574fc6ecb88d10939df0fdbe645580c574`。
- 发布包 SHA-256：`dc3d8146e45c2ef366bec4c7a86ec34a03bfe876a64c6f9532b93f500f717080`。

本次在已上线的 `229466b` 应用及其部署文档提交 `13e096d` 上，仅加入本任务的 11 个代码、测试和设计验证文件。保留当天已发布的月度临时目标及导入操作功能。没有修改服务端、依赖、环境配置或数据库结构。

## 上线内容

管理者默认进入全员工作表，支持任务明细、状态看板、项目汇总、时间排期，以及联动筛选、分组、字段、排序和命名视图。UI 增加文字状态、舒适／紧凑密度、手机成员卡片和可移除筛选标签。普通成员保留原个人工作台。

详细交互验收见[部门概览验证记录](department-overview-validation-2026-09-17.md)。

## 备份与数据保留

继续使用原 `.env.intranet` 和 `lab-planning-37-data` 数据卷，没有覆盖数据库、重设账号或创建正式测试数据。

- 在线备份：`/home/yzq/apps/lab-planning/backups/lab-planning-20260917T041938.070043086Z-1813554.sqlite`。
- 停服后最终备份：`/home/yzq/apps/lab-planning/backups/before-overview-60238ec.sqlite`，1,019,904 字节；卷内另存副本。备份完整性检查通过。
- 切换前无运行中的导入解析任务；部署锁和旧目录、镜像、卷名校验通过。
- 切换前后全部实体排序 SHA-256 一致：`53f4f0ce89180fa1370825e32e713c70a8b0b129195cebf0bcc72cdec7121f54`。
- `integrity_check=ok`，存储版本仍为 1。原 6 个账号、11 个月度目标、12 个任务、12 条周记录及其他资料完整保留。

## 验证

- 服务器候选镜像构建成功，隔离运行 **190/190 测试通过**。
- 一次性容器未开放宿主端口、未挂正式卷；通过静态页面、CSP、认证、SQLite 写入、Word 导出、备份和重启持久化验证。测试容器及匿名卷已清理。
- 正式容器为 `running / healthy`，启动日志正常，认证状态仍为 `initialized:true`。
- 正式页面及 `/assets/index-pYHCyOSy.js` 返回 200；资源含五种视图与密度控制，且资源文件名与已通过本地 UI 验收的构建一致。
- 未登录请求 `/api/bootstrap` 返回 401。
- 真实浏览器加载正式登录页成功，运行错误为空。未使用正式账号执行业务写入；完整五视图交互已在隔离资料中完成验收。

## 保留版本

旧目录 `/home/yzq/apps/lab-planning/releases/229466b` 和旧镜像 `lab-planning:before-overview-60238ec` 均保留，镜像 ID 为 `sha256:60f1505242edc3aaf939d98f3f7e28f52aadf2cd3e151a71b75ac8d9a954d122`。本次未触发回退。

回退脚本只回切应用及目录并继续保留当前数据，不用上线前备份覆盖新数据。服务器 `ops/` 保留名称含 `60238ec` 的发布包、构建和测试日志、切换脚本与实体校验结果。
