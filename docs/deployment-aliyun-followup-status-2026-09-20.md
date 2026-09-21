# 进展与催办状态修正上线记录

2026-09-20 **18:01:55（北京时间）上线完成**；18:02:29 公网验收 19/19 通过。正式入口：https://lab.notvitamin.com/work?view=collaboration。

- 新版本：`followup-status-20260920T095638Z`。
- 前一版本及代码回退目标：`collaboration-20260920T050721Z`。
- 运行目录：`/srv/lab-planning/releases/followup-status-20260920T095638Z`；`/srv/lab-planning/current` 已指向该目录。
- 服务仍为 `lab-planning.service`，数据库仍为 `/var/lib/lab-planning/lab-planning.sqlite`，存储版本仍为 2。

## 本次内容

从已上线封存版本复制，仅覆盖本次 10 个运行文件及相关测试、说明。页面明确全员/本人、全周期且含已完成的范围；任务卡片与详情分别显示整体状态、周状态和成果；周进展提供默认不勾选的“同时完成整个任务”。整体完成操作在同一事务更新任务、周记录及相关督办处理。历史周完成不会自动批量关闭整个任务。

依赖锁文件、存储层和迁移代码与前一版本完全一致。复用现有 Linux 依赖，构建及完整测试均在本机完成，未在生产运行安装依赖、全量测试或构建。

## 备份与数据保护

- 备份：`/var/backups/lab-planning/pre-followup-status-20260920T095638Z.sqlite`。
- SHA-256：`4de9ebf0b6f0bab5d87e3b7d4d8c64adcb5d9663581e2b8c8b1dbeec8dae0172`。
- 持有部署锁、备份锁，入口短暂维护，按现有 45 秒宽限停止旧进程，再通过 SQLite backup API 备份。
- 758 条业务、配置、身份及其他受保护实体的 collection/id/version/data 核对完全一致。唯一排除项为 `nativeRuntime/stream` 的预期运行状态及版本、更新时间；保留其存在性及其他字段。
- 原环境文件和 Nginx 配置字节保持一致，现有通知及协作设置、部署标识、账号、密码与 5 个钉钉绑定保留；未恢复数据库或写入生产测试任务、会话。
- 回退只切回前一版本代码并使用当前数据库，不能用本次备份覆盖上线后的业务数据。

## 验收

- 封存源码 304 个文件，源码与 6 个静态产物的 SHA-256 均核验。
- 本地 Windows 类型检查和 Vite 构建通过；本地 WSL Ubuntu、Node 24.20.0 全部 **474/474 测试通过**。
- 发布包 SHA-256：`63d0c0fcc574562e854d3f3e12af3cffef752bd015c288aa1d3d90a52a04f801`。
- 公网 19/19 只读检查通过：首页、工作入口、静态资源 SHA-256、初始化状态、受保护接口鉴权及本次新增功能标识。
- 实际浏览器打开正式入口正常展示登录页，无页面运行错误；未用正式账号执行业务测试。
- 生产库只读快照及新摘要函数核验通过：当时 23 项任务、11 项整体完成、15 项有可展示的周记录、3 项为周记录完成但整体未完成；输出仅汇总数字，未输出业务正文。以上为验收时点快照。
- 应用、Nginx、Cloudflare 隧道及备份 timer 均 active；服务自动重启次数 0，错误级别日志 0，数据库完整性 ok。验收时主机可用内存约 1008 MiB、swap 0。

本地证据目录：`output/aliyun-followup-status-20260920/`。服务器发布记录：`/root/lab-planning-upgrade-followup-status-20260920T095638Z/`，其中配置备份仅 root 可读，不得整体上传。
