# 37服务器：团队自主注册上线记录

2026-09-0909:30（Asia/Shanghai）更新。地址：http://192.168.0.37:4310/ 。

- 应用提交：7bf2bbe50a616b57b226f11e381b8eee6d4787f2；镜像lab-planning:7bf2bbe，ID sha256:68208f9f46d4466d708f43f3a39108e700d1f1c46fc33b489df749a01711fbe8。
- current指向/home/yzq/apps/lab-planning/releases/7bf2bbe；原镜像lab-planning:8c7876a与旧目录保留。
- 容器lab-planning-intranet-app-1健康检查通过；继续使用lab-planning-37-data，端口及每日备份计划保持原配置。
- 上线前备份：/home/yzq/apps/lab-planning/backups/lab-planning-20260909T013017.864677021Z-2564212.sqlite。切换后逐条比对备份记录全部保留，PRAGMA integrity_check=ok。
- 本地54项测试、TypeScript检查、前端构建通过；GitHub CI通过：https://github.com/zqYuan98/lab-planning/actions/runs/34299295391 。
- 37隔离容器通过注册权限测试、静态资源/API/Word导出、在线备份及重启持久性验证；验收容器和临时卷已清理。
- 浏览器使用隔离内存数据库验证密码确认、8位数字注册、审批前禁止登录、管理员驳回/重新审核、通过后成员登录；正式站仅只读确认注册入口与表单，没有写入测试账号。
- 本地4310及临时44321端口均无监听，生产仅37运行。

使用：员工在登录页点“申请加入团队”；管理员在“成员管理 → 注册申请”审核；通过后员工用自己设置的密码登录。旧账号与原密码继续有效。密码8至256字符，不强制数字或复杂度。驳回需原因，管理员可重新审核。

回退：旧版本不识别注册状态。产生新申请后禁止直接旧代码复用当前库，应使用兼容修复，或保全新数据后受控恢复上线前备份。
