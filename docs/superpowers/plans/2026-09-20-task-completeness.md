# 工作事项完整性修复实施计划

**Goal:** 修复审查确认的事项遗漏与漏显，并将经验证的修复和个人清单正式部署。

**Architecture:** 复用现有 ImportBatch、MonthlyPlan、Task 与权限体系，以可审计的导入核对及跨来源清单投影补齐缺口。兼容旧记录，不批量推断修改历史责任或完成状态。

**Tech Stack:** TypeScript、React、Express、SQLite、tsx tests、现有 systemd 发布流程。

- [x] 保存工作区源码基线与当前正式版本只读预检。
- [x] 导入后端：shared/import-types.ts，server/import-service.ts、existing-plan-writer.ts、import-routes.ts、ai-service.ts，相关数据迁移包字段与有意义的回归测试。落实选择审计、文件核对、补行、协作、来源、完成状态、模型字段边界。
- [x] 导入界面：src/pages/Imports.tsx、src/imports.css 及独立辅助，加入对账与原因、原文预览、人工补项、全表选择、选项恢复、重识别语义，连通后端字段。
- [x] 清单与月度：shared/work-register.ts、src/pages/WorkRegister.tsx、Monthly.tsx、报告/导出与样式、server/domain-work.ts，覆盖未拆目标、交办来源、历史完成核对，保持本人权限和排周约束。
- [x] 各路针对性测试通过后交叉审查；根任务补集成测试与浏览器验收。
- [x] 从当前正式封存版本组装明确文件清单；保留并验证个人清单依赖，不夹带未授权的周审核等功能。
- [x] 封存包运行完整测试、类型检查与生产构建；核对源与产物哈希。
- [x] 复用经核对的固定主机与设备身份，生产备份后原库切换；验证实体、配置、服务与公网资源，失败切代码回退。
- [x] 保存部署证据、验证结果和用户可读说明。
