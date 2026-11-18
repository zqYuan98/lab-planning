# 实验室计划与交付 —— 协作规则

给在这个仓库里工作的人和 AI 助手看。这些规则来自 2026-11-18 的复盘（`docs/retrospective-2026-11-18.md`），每一条对应一类已经反复付过成本的问题。

## 项目是什么

单部门、单实例的计划与交付系统：月度目标 → 个人任务 → 周记录 → 周报 / 月报。React 19 + Vite 前端（`src/`），Express 5 + `node:sqlite` 服务端（`server/`），前后端共用的类型和规则在 `shared/`。Node ≥ 24.14。

```sh
npm ci
npm run dev          # 前端 5173，API 4310
npm test             # node:test，全部用例
npm run lint:design  # 设计刻度与文案检查
npm run build        # tsc + vite build
```

## 改之前

1. **先确认要解决的是谁的什么问题。** 用一句话写出“谁，在哪个页面，想完成什么，现在卡在哪”。写不出来就先问，不要动手。
2. **一次改一件事。** 一个提交只做一类改动，能在 400 行内说清楚。超过 30 个文件的提交需要在说明里解释为什么不能拆。历史上三个最大的提交各带 1 万到 2.8 万行，之后的回归修复都无法定位到具体改动。
3. **改动是替换，不是叠加。** 新写法落地的同一个提交里删掉旧写法。不新增“覆盖上一版”的文件、变量族或并行实现。

## 界面

规范在 `design-system/lab-workspace/MASTER.md`，改界面前先读，流程用 `.claude/skills/ui-change`。

- 字号、字重、圆角只用 `src/tokens.css` 里的变量。
- 不加渐变、发光、毛玻璃、装饰图形和口号。
- 页面第一屏是工作内容。规则说明进收起的 `<details>` 或文档。
- 不在列表和卡片上显示内部编号、版本号、统计口径。
- 表单默认可见字段不超过 8 个。加字段用 `.claude/skills/add-field`。
- 界面改动必须附改动前后的截图（1440px 和 375px），并说明用哪个真实任务走了一遍。“测试通过”不能证明界面可用。

## 服务端

- 角色判断只走 `server/authorization.ts`；新增路由后更新 `tests/fixtures/route-permission-matrix.json`。
- 实体的状态枚举和长度限制只在 `shared/entity-rules.ts` 定义，表单、校验、迁移包都从这里读。
- 同一业务事件里的时间只读一次时钟，向下传递。
- 读路径用 `Store.readTransaction`，里面不得写入。

## 文档

- 发布记录写进 `docs/CHANGELOG.md`，一次发布一条，五行以内。不再为每次发布新建 `deployment-*.md` / `validation-*.md`，README 不再追加发布段落。
- 文档只写仍然成立的事实。被取代的方案在同一个提交里删掉或标注“已被 X 取代”。
- 不在仓库里写真实姓名、账号、服务器地址。

## 完成的标准

提交前逐条确认，说明里如实写哪些做了、哪些没做：

- [ ] `npm test` 通过
- [ ] `npm run lint:design` 通过；基线下降时运行 `node scripts/design-lint.mjs --update` 收紧
- [ ] `npm run build` 通过
- [ ] 界面改动有前后截图和一次真实任务走查
- [ ] 被取代的代码、样式、文档已删除
- [ ] 没验证的部分明确写出来

## 复盘

同一类问题出现第二次时，用 `.claude/skills/retro` 做复盘：找出能自动拦截的检查，落成脚本或测试；拦不住的写进本文件。只写结论，不写经过。
