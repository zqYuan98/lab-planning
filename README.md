# 实验室计划与交付

部门管理者和成员在同一个工作区维护月度目标、安排每周工作、提交进展，并生成周报和月报。

## 本地启动

使用 Node.js 24.20.0（最低 24.14）。在仓库根目录运行：

```sh
npm ci
npm run dev
```

打开 http://127.0.0.1:5173 。首次启动时创建管理者账号，成员可在登录页申请加入团队。开发 API 监听本机 4310 端口，数据库默认保存在 `data/lab-planning.sqlite`。

## 文档

- [日常使用、账号和备份](docs/usage.md)
- [生产部署](docs/deployment.md)
- [功能状态](docs/feature-status.md)与[变更记录](docs/CHANGELOG.md)
- [接口约定](docs/api-contract.md)与[协作规则](CLAUDE.md)
