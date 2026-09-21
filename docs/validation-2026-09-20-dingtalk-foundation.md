# 钉钉 P0 运行基础开发与验收记录

本轮按已批准的 P0 设计实现代码，未改生产配置、未调用真实钉钉发送接口、未上传真实备份。

## 已实现

- 钉钉内启动即使已有会话也先核验当前钉钉身份，成功后才读取业务 bootstrap；冲突提供显式退出切换，未绑定/失败提供明确普通账号入口并保留原事项地址。SDK 能力检查加服务端授权码兑换决定身份，UA 只用于尝试验证。
- `shared/dingtalk-entry.ts` 校验 HTTPS 同源 `/entry` 的唯一事项标识后生成官方 H5 AppLink，保留完整编码路径，禁止任意跳转、令牌和附加参数。`DINGTALK_APPLINK_ENABLED=false` 为默认回退，桌面参数为独立窗口。来源：[H5 AppLink](https://open.dingtalk.com/document/orgapp/open-h5-micro-application)、[免登授权码](https://open.dingtalk.com/tools/explorer/jsapi?id=11723)。本地已验证编码与消息预算，真实客户端效果仍待下述验收。
- 草稿/已有资料导入持久保存 importSource 与服务端 silent 标记，同步事务内统一静默，嵌套/失败自动恢复。正式发布导入草稿仍生成一次真实安排事件；草稿编辑不提前发通知。已有导入激活原记录继续校验未被人工改动。
- SQLite 存储版本 2 只新增派生索引，不重写历史业务记录。worker 有界查询 pending/accepted/sending；诊断按 createdAt+id 稳定分页，支持状态、成员、类型、时间筛选，全量计数不受 200 条限制。
- 管理者诊断包含发送等待原因/下次时间、worker/调度心跳、受理与失败/未知统计、绑定覆盖、回调积压、规则命中、磁盘与备份状态。无原始正文、provider错误、token、绑定ID或环境秘密。未知结果无重发按钮，明确失败沿用服务端重试资格复核。
- 应用 SIGTERM/SIGINT 35 秒预算，先停止调度和领取，再等在途响应和 HTTP 结束，最后关闭数据库；容器与新 systemd 示例为 45 秒。
- 新备份工具先做在线 SQLite 副本，再 AES-256-GCM 加密、SHA-256 校验与隔离解密完整性检查。显式上传使用固定 HTTPS 目录、Bearer 凭据、禁重定向，并回读密文和恢复清单校验后才记异机成功。恢复演练支持从真实配置端点回读，始终使用新临时目录，不接受生产恢复路径。
- 保留预览按 7 日/4 周/6 月代表副本计算；只有已记录异机校验的多余副本可进入删除候选，未知文件/唯一副本保留，执行需要当前预览令牌，逐文件校验受管路径。

## 本地验证

2026-09-20：入口/adapter/身份、导入静默、通知事件、worker快照与发送复核、251 条诊断分页、管理权限、备份加密/异机模拟回读/隔离恢复、保留预览与停机等待，共 74 项定向测试通过。测试使用临时 SQLite 和模拟 provider/备份端点，无真实外发。迁移测试另外核对旧业务 JSON 保持不变、索引存在、新版本禁止旧程序直接打开。

收尾回归：`collaboration-http`、`collaboration-rules`、`user-deletion` 共 30 项通过；全仓 TypeScript 检查通过。个人可选行动摘要偏好默认开启且读取不写库，只允许当前会话用户更新，生成摘要和实际发送前均重新检查偏好。关闭个人摘要不取消当前催办义务。个人偏好按 operational 数据在无业务关联账号删除时一并清理，不新增删除阻断；失败事务回滚、其他账号偏好保留均已验证。

## 运维命令与外部验收

给独立备份进程配置 `DATABASE_PATH`、`VERIFIED_BACKUP_DIR`、`BACKUP_KEY_FILE`，密钥路径必须在数据库和受管备份目录树以外；离线保管恢复密钥。原有每日备份任务保持，按实际环境给新工具另配日调度。示例不包含任何真实秘密。

```text
node --import tsx scripts/verified-backup.ts keygen
node --import tsx scripts/verified-backup.ts create
node --import tsx scripts/verified-backup.ts upload <备份ID>
node --import tsx scripts/verified-backup.ts drill <备份ID>
node --import tsx scripts/verified-backup.ts drill-offsite <备份ID>
node --import tsx scripts/verified-backup.ts retention-preview
node --import tsx scripts/verified-backup.ts retention-apply <已核对的预览令牌>
```

异机端点需配置 `BACKUP_OFFSITE_URL`（以 `/` 结尾的固定 HTTPS 目录）与 `BACKUP_OFFSITE_TOKEN`，支持 PUT、GET 和密文对象 `If-None-Match: *`。端点和密钥未配置时保持待配置；本地模拟通过不代表异机容灾已完成。

待企业环境验收：Android/iOS/Windows/macOS 的工作台与卡片入口、Cookie 账号冲突/未绑定/授权失败回退；发送总开关与 SDK 版本；服务管理器真实 SIGTERM 慢 token/send/result；异机端点和独立密钥、日调度与告警读取权限；从异机密文恢复后的业务核对与耗时。RPO ≤24 小时 / RTO ≤4 小时须按真实日备份间隔与完整恢复演练测量，当前不宣称达标。

回退入口使用 `DINGTALK_APPLINK_ENABLED=false`；关闭外发仍查询 accepted 回执。结构升级后不使用旧数据库覆盖新数据，二进制回退需保持对当前存储版本兼容。生产更新前按 pending/sending/accepted/unknown 诊断核对在途状态。

## 存储 v2 兼容回退产物

本轮基线的原 Store 已配套生成[独立兼容回退说明](../output/collaboration-implementation-20260920/compatibility-rollback/README.md)与[最小补丁](../output/collaboration-implementation-20260920/compatibility-rollback/storage-v2-compatibility.patch)。补丁仅调整旧 `server/storage-migrations.ts` 的版本门：保留创建新库的版本 1 行为，允许名称为 `notification-queue-and-diagnostic-indexes` 的已知 v2 附加索引迁移；未知 v2 和 v3 仍拒绝打开。它不降库、不删除索引，也不修改未知业务集合。

重现命令：`node --import tsx output/collaboration-implementation-20260920/compatibility-rollback/verify.mjs`。9 项隔离验证通过，结果与源码 SHA-256 见[验证记录](../output/collaboration-implementation-20260920/compatibility-rollback/verification-result.json)。验证包含原旧版拒绝 v2、真实 v1→v2 不重写原实体、兼容旧 Store 对原任务/周记录的读写及事务回滚、新进展/回调/未知操作三类实体逐字节保留、4 个索引及 v2 迁移记录不变，以及新版 Store 再打开并读取回退期写入。配套 `apply-to-release.mjs` 的检查模式不写文件，应用模式只替换独立且匹配基线的旧发布副本中迁移文件，并拒绝当前工作树及其子目录、祖先目录。

该产物供独立旧版发布副本使用，未覆盖当前源码或生产。回退前须停止新增通知和 P1/P2 自动任务，核对在途 accepted/unknown 与回调状态，并取得已验证备份；旧业务代码缺少新协作/原生同步 hooks，回退期间不能继续承诺这些新功能，也不得让两个版本并发写库。重新升级前须核对回退期业务变更与新跟踪状态。这里证明的是存储兼容，真实部署的停机切换、完整旧版应用验收与恢复计时仍需在企业环境完成。
