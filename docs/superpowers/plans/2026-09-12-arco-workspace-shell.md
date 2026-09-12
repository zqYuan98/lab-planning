# Arco 整体框架实施计划

**目标：** 使用 Arco 统一整体框架，保留现有业务流程。

**架构：** App 管理数据、角色和导航意图；WorkspaceShell 管理响应式导航、折叠与账号入口；WorkspaceSearch 保持权限过滤和结果跳转。控件使用 Arco，原业务页面继续使用现有主题。

**技术栈：** React 19、TypeScript、Vite、Arco Design React 2.66.16。

## 步骤与文件

- [x] `package.json`、`package-lock.json`：安装并锁定 Arco React；读取组件声明，检查 React 19 适配入口。
- [x] `src/arco-styles.ts`、`src/main.tsx`：按使用组件导入样式，启用 React 19 适配与中文 ConfigProvider。
- [x] `src/components/WorkspaceBrand.tsx`：抽取已有品牌资源，保持登录页品牌。
- [x] `src/components/WorkspaceShell.tsx`：使用 Layout、Menu、Breadcrumb、Avatar、Dropdown、Drawer；菜单按角色过滤，侧栏保存命名空间偏好；900px 以下抽屉导航；键盘可访问。所有导航与主操作使用传入的 navigate，退出使用 onLogout。
- [x] `src/components/WorkspaceSearch.tsx`：使用 Arco Input 及对应 ref；保留现有索引、历史周定位、键盘选择和清空。
- [x] `src/App.tsx`：移除旧外框，将 route 置于 WorkspaceShell；数据、业务页、页面 key 及未保存拦截继续由 App 管理，确认框改为受控 Arco Modal。
- [x] `src/workspace-shell.css`：外框独立类名和局部样式，控制宽度、响应式、抽屉、焦点与减少动画偏好。
- [x] 执行 `npm run build`，预期 TypeScript 与 Vite 成功；运行现有 `tests/*.test.ts`，预期 154 项通过。
- [x] `output/arco-preview.ts` 与 `output/arco-shell-verification.sqlite`：独立服务和合成数据验收。浏览器检查管理员/成员导航、当前页面、主操作、搜索结果跳转、侧栏刷新偏好、账号菜单键盘与退出。
- [x] 浏览器验证报告编辑后经侧栏、搜索、主操作和退出进入未保存确认，取消保持编辑；手机抽屉无焦点冲突。
- [x] 浏览器检查 1440、1024、390、320px 宽及低高度，无框架横向溢出。截图保存 `output/playwright/`，验证结果记录 `docs/arco-shell-validation.md`，向用户展示本地预览。
