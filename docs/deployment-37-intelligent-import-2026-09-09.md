# 37服务器智能导入上线记录

部署时间：2026-09-09 10:23（Asia/Shanghai）。

- 服务：`http://192.168.0.37:4310`
- 发布提交：`b7f36d093509`，分支 `codex/intelligent-data-import`
- 当前目录：`/home/yzq/apps/lab-planning/releases/b7f36d093509`
- 当前镜像：`lab-planning:b7f36d093509`，运行别名 `lab-planning:intranet`
- 镜像 SHA256：`38a349ab245b91dd8ba38d7a15a2a6a39eff3bdb9ba4442857dc5c53c7ed1f61`
- 保留配置：`/home/yzq/apps/lab-planning/.env.intranet`
- 保留数据卷：`lab-planning-37-data`，没有初始化或替换正式数据库。

## 备份与数据核验

切换前最近备份：`/home/yzq/apps/lab-planning/backups/lab-planning-20260909T022330.259945325Z-2772517.sqlite`，在线备份与完整性检查通过。

停止旧容器后读取原实体的排序哈希；新版本启动后复核全部原实体，SHA256 均为 `0ceeb99ac20af8eb28d3ee6b499876c7bd9ff7dce337f572032f33e0ee60e01e`。原业务及账号记录没有变化；数据库完整性为 `ok`，仅新增存储迁移版本登记1。

第一次切换前校验的只读卷挂载不能建立 SQLite WAL 共享内存，脚本自动恢复旧容器；随后改为数据库连接自身只读、允许 SQLite 共享内存 bookkeeping 的校验方式，重新备份和切换成功。未恢复旧数据库文件，也未丢弃新写入。

## 验证结果

- 新镜像内隔离运行104项测试，全部通过；没有挂载正式数据卷，没有连接外部模型。
- 新镜像隔离启动验收通过页面资源、合成账号登录、SQLite 写入和 Word 导出。
- 正式服务 `running / healthy`；`/api/auth/status` 为已初始化。
- 正式页面加载新前端资源，包含数据导入入口。
- 未登录请求导入、集成 API、业务导出和模型配置均返回401。
- 浏览器功能验收与真实表格本地结构验证见[验收记录](intelligent-import-validation-2026-09-09.md)。

未配置用户的真实模型密钥，未发送真实表格至模型，也未将真实历史计划自动导入正式数据。管理员下一步在“数据导入 → AI 模型设置”配置服务，再进行真实样本校对。

## 保留的回退位置

旧发布目录：`/home/yzq/apps/lab-planning/releases/7bf2bbe`。

旧镜像标签：`lab-planning:before-import-b7f36d093509`。

升级脚本与实体校验摘要保存在 `/home/yzq/apps/lab-planning/ops/`，以 `b7f36d093509` 标识。程序回退应保留当前数据卷；如后续已产生新业务数据，不应直接用升级前备份覆盖当前库。
