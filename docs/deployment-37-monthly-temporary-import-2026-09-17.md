# 37 服务器：月度临时目标与导入操作上线

2026-09-17 10:45（Asia/Shanghai），按用户“部署”授权发布。

- 地址：http://192.168.0.37:4310/。
- 应用提交：`229466b299717619d2260307ee49269b6bd739a4`，分支 `codex/monthly-temporary-import-20260917`。
- 当前目录：`/home/yzq/apps/lab-planning/releases/229466b`。
- 镜像：`lab-planning:229466b`，运行别名 `lab-planning:intranet`。
- 镜像 ID：`sha256:60f1505242edc3aaf939d98f3f7e28f52aadf2cd3e151a71b75ac8d9a954d122`。
- 发布包 SHA-256：`405b61e56dde30face177c850bc6303611c22563a12a13368070ac2725ed95a7`。

本次从独立验证分支发布月度临时目标、文件/图片拖入、截图粘贴和导入历史删除。未包含同时开发的多视图总览及相关每周页面改动。继续使用原 `.env.intranet` 和 `lab-planning-37-data`，未替换数据库或创建正式测试账号。

## 备份和切换

- 在线备份：`/home/yzq/apps/lab-planning/backups/lab-planning-20260917T024550.934964095Z-1413405.sqlite`。
- 停止旧服务后的最终备份：`/home/yzq/apps/lab-planning/backups/before-monthly-import-229466b.sqlite`，1,019,904 字节；卷内另存副本。两次备份完整性检查通过。
- 切换前确认运行中的导入解析任务为 0；部署锁避免同脚本并发切换。
- 切换前后全部实体排序 SHA-256 相同：`53f4f0ce89180fa1370825e32e713c70a8b0b129195cebf0bcc72cdec7121f54`。
- `integrity_check=ok`，存储版本仍为 1。原 6 个账号、11 个月度目标、12 个任务、12 条周记录、16 条归档历史及其他数据完整保留。

## 验证

- 服务器镜像构建成功；构建阶段隔离运行 180 项测试全部通过。
- 一次性容器通过静态页面、身份认证、SQLite 写入、Word 导出和重启持久化验证，测试容器及匿名卷已清理。挂载验收脚本初次因宿主权限不可读失败，调整隔离测试客户端权限后通过，正式应用仍以镜像原 `node` 用户运行。
- 正式容器 `running / healthy`，认证状态 `initialized:true`，启动日志正常。
- 正式页面和 `/assets/index-Bkj2JWTc.js` 返回 200，脚本包含临时目标、拖放上传和删除批次功能。
- 未登录访问 bootstrap、周提报、业务导出及 DELETE 导入接口均返回 401。
- 真实浏览器能打开正式登录页；未使用真实账号执行生产业务写入。完整成员及管理员功能流程已在隔离浏览器中验证，见[功能验证记录](validation-2026-09-17-monthly-temporary-import.md)。

## 保留版本

旧目录 `/home/yzq/apps/lab-planning/releases/b168c8e` 和镜像 `lab-planning:before-monthly-import-229466b` 已保留，镜像 ID 为 `sha256:30c59986707f329f590dd457c13844f9095c519b1343d11596d758ee6c35fda1`。本次没有触发回退。

旧版不提供临时目标与历史删除功能；新数据产生后优先兼容修复，不能用上线前备份覆盖新数据。服务器 `ops/` 保留名称含 `229466b` 的发布包、构建/测试/切换日志、脚本及数据校验结果。
