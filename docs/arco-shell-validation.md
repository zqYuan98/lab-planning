# Arco 整体框架验证

日期：2026-09-12。范围：整体框架。分支：`codex/arco-workspace-shell`。

## 实现

- Arco Design React 固定为 2.66.16，配置中文与官方 React 19 适配入口，按组件加载样式。
- 新增 WorkspaceShell 和 WorkspaceBrand。桌面侧栏 232px / 72px，支持记忆折叠状态、角色菜单、键盘导航与折叠提示。
- 顶栏包含面包屑、Arco 搜索输入、管理员审核或成员安排本周工作的主操作、真实账号菜单。
- 900px 以下使用 Arco Drawer。支持键盘关闭、遮罩关闭、焦点锁定、背景 inert、快速开关后的焦点恢复与切回桌面自动关闭。
- App 保留数据、导航、权限及报告编辑状态，报告离开提示使用受控 Arco Modal；业务表单和服务端规则保持既有实现。

## 构建与回归

- Node.js 24.20.0，TypeScript 检查与 Vite 生产构建通过。
- `node --import tsx --test tests/*.test.ts`：154 通过、0 失败。完整日志：`output/arco-regression.log`。
- 安装依赖审计结果：0 漏洞。
- 构建仍提示单个 JS 包大于 500 kB：最终约 646 kB，gzip 约 189 kB。此次没有扩展到业务页的按路由拆包。

## 浏览器验收

使用 Playwright CLI 驱动 Chrome，访问独立实例 `http://127.0.0.1:4326/`。验证数据库为 `output/arco-shell-verification.sqlite`，全部为合成账号与业务记录；没有写入正式数据库或部署 37 服务器。

- 管理员的八个页面均可正常进入；成员仅显示六个可访问导航项。
- 折叠后侧栏宽度为 72px，刷新保留偏好；展开恢复 232px。折叠图标有提示，方向键、Enter 可操作菜单。
- 账号菜单支持 ArrowDown 打开、Esc 关闭和焦点恢复，退出登录成功。
- 搜索支持 `/` 聚焦、输入、清空、Enter 跳转；验证项目编号精确定位，成员无法搜索他人的个人任务。
- 顶部“安排本周工作”打开成员周任务表单；管理员审核入口保持导航意图。
- 已编辑报告通过侧栏、搜索、主操作、退出和手机菜单离开时均弹出确认；取消后标题编辑保留，确认后正常跳转。
- 验证报告确认框关闭后快速打开、关闭手机导航，焦点恢复到“打开导航”按钮。焦点恢复基于 React 状态切换，不依赖可能被快速操作中断的退出动画回调。
- 1440×1000、1024×768、390×844、320×640 下无框架横向溢出；1024×400 下底部菜单可滚动到达。
- 手机抽屉支持 Tab 焦点锁定、具名 dialog、可访问的关闭按钮、Esc 与遮罩关闭、背景 inert，切换到桌面自动关闭。
- 最终版本浏览器冒烟记录 0 个运行时异常。登录前 `/api/auth/me` 的 401 为既有未登录探测响应。

## 预览与复核材料

- 最终桌面：`output/playwright/arco-final-desktop.png`
- 手机：`output/playwright/arco-390.png`、`output/playwright/arco-320.png`
- 折叠、搜索、抽屉、报告离开保护与成员截图：`output/playwright/arco-*.png`
- 交互验收脚本：`output/playwright/check-shell.js`、`check-responsive.js`、`check-guards.js`、`check-member.js`、`final-smoke.js`。
- 预览运行入口：`output/arco-preview.ts`，使用独立数据库，监听本机 4326 端口。

`output/` 和 `.playwright-cli/` 均不提交。正式运行使用仓库既有的构建和启动流程。
