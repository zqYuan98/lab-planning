# 37 服务器：Arco 工作空间与页面样式上线

2026-09-12 21:31（Asia/Shanghai），按用户“上线部署”的授权发布。

- 地址：http://192.168.0.37:4310/
- 应用提交：`e3d89cb`，分支 `codex/arco-workspace-shell`。
- 发布目录：`/home/yzq/apps/lab-planning/releases/e3d89cb`，`current` 已指向此目录。
- 镜像：`lab-planning:e3d89cb`，运行别名 `lab-planning:intranet`。
- 镜像 ID：`sha256:e94513a7e4c4dc13c1b7366d44a8f52d6bacadca4f0b5b97d910340e3ea441b6`。
- 发布包 SHA-256：`24b8a5fed2f78d2f444381a6ff551b351166c3fd0b2f4d7f209a45813234a789`，上传前后相同。

上线内容包括 Arco Design 导航与整体框架、部门概览调整、统一墨色文字，以及标题、表格、筛选栏、表单和移动端布局整理。沿用正式环境配置和 `lab-planning-37-data` 数据卷；本次没有修改服务端代码或数据库结构。

## 备份与数据核验

- 在线备份：`/home/yzq/apps/lab-planning/backups/lab-planning-20260912T133111.146316934Z-1136272.sqlite`。
- 停止旧服务后的最终备份：`/home/yzq/apps/lab-planning/backups/before-ui-e3d89cb.sqlite`，卷内另有副本。
- 两份备份均通过完整性检查；正式库 `PRAGMA integrity_check=ok`。
- 切换前后全部实体（包括账号、会话、配置和周提报规则）的排序哈希一致：`3103884e942c47ba487fec1e6b459e4ba13ff5ec4e2db69305f89e9139ce2d7e`。
- 保留 6 个账号、11 个月度目标、6 个个人任务、6 条周记录及其他全部实体。没有在正式库创建测试账号或业务数据。

## 验证

- 服务器生产镜像构建成功，包含 TypeScript 检查；隔离运行现有测试 **154/154 通过**。
- 新镜像的独立容器完成页面和资源加载、合成账号登录、SQLite 写入、Word 导出、重启后数据保留检查；测试容器及匿名卷已清理。
- 正式容器为 `running / healthy`，启动日志正常；首页返回 200，认证状态为已初始化，匿名访问 `/api/bootstrap` 返回 401。
- 线上 HTML、JavaScript 和 CSS 与新镜像中的构建文件逐字节一致：`index-DoV-W3Rr.js` 和 `index-tfsQR0c7.css`。
- 真实浏览器在 1440px、390px 打开正式登录页，无页面横向溢出，无 JavaScript 运行异常；标题计算颜色为 `#181818`，说明文字为 `#3d3d3d`。未登录的 `/api/auth/me` 返回预期的 401。
- 登录后的完整操作和 8 个页面的多尺寸检查见 [UI 验证记录](ui-refinement-validation.md)，使用隔离数据完成；本次正式环境浏览器检查仅访问登录页。

服务器 `ops/` 保留构建、测试、切换脚本和校验结果，文件名含 `e3d89cb`。本地上线截图位于 `output/playwright/production-ui-e3d89cb-1440.png` 和 `production-ui-e3d89cb-390.png`。

## 回退版本

上一版目录保留为 `/home/yzq/apps/lab-planning/releases/2e3fc12`，上一版镜像保留为 `lab-planning:before-ui-e3d89cb`（ID `sha256:b377e405e5acb3e4804013720bcf8aaab242a8ef7e9b924edb5e3e7fd533b5c9`）。如需回退，恢复此镜像的 `lab-planning:intranet` 标签及 `current` 链接，并沿用原配置、数据卷重新创建应用容器；无需用旧备份覆盖现有数据。
