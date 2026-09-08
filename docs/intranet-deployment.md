# 37 服务器：内网直接访问

访问地址默认为 **http://192.168.0.37:4310**。浏览器直接连接应用，无需 Nginx、域名或证书。服务器需要 Docker Engine 和 Compose 插件；前端、API、Word 导出与定时草稿由一个 Node 服务提供，SQLite 保存在命名卷中。

2026-09-08 已完成37服务器部署、账号迁移及每日备份配置，实际位置和验证结果见[本次部署记录](deployment-37-2026-09-08.md)。

这套配置只用于可信内网 HTTP。首次启动与管理员初始化应在受控网络内完成；不要把该端口映射到公网。HTTP 不加密浏览器与服务器之间的传输，需要 HTTPS 时使用[原部署手册](deployment.md)。

## 启动

部署根目录为 `/home/yzq/apps/lab-planning`：每次代码包放在 `releases/<版本标识>/`，`current` 链接指向使用中的版本；`.env.intranet` 留在部署根目录，数据库使用独立命名卷。这样更新代码不携带 GitHub 凭据，也不覆盖配置或业务数据。

在部署根目录执行。先确认 `192.168.0.37` 是本机网卡地址且 `4310` 未被占用，再创建环境文件：

```sh
cd /home/yzq/apps/lab-planning
test -f .env.intranet || cp current/deploy/intranet.env.example .env.intranet
docker compose --env-file .env.intranet -f current/compose.intranet.yaml config --quiet
docker compose --env-file .env.intranet -f current/compose.intranet.yaml up -d --build
docker compose --env-file .env.intranet -f current/compose.intranet.yaml ps
docker compose --env-file .env.intranet -f current/compose.intranet.yaml logs --tail=100 app
```

已有 `.env.intranet` 时保留原文件，直接核对配置。防火墙仅放行获准的内网来源访问选定端口。浏览器打开配置地址，使用迁移后的账号登录；全新空库才创建首位管理员。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `INTRANET_IP` | `192.168.0.37` | 只绑定此网卡地址，不用 `0.0.0.0` 发布端口 |
| `INTRANET_PORT` | `4310` | 内网访问端口；被占用时换一个空闲端口 |
| `DATA_VOLUME_NAME` | `lab-planning-37-data` | 持久数据卷，更新时保持不变 |

`APP_ORIGIN` 自动由 IP 与端口生成，两者只需在 `.env.intranet` 配置一次。`COOKIE_SECURE=false`、`TRUST_PROXY=false` 固定用于直接 HTTP 访问；容器内部保持 `4310`，数据库固定为 `/app/data/lab-planning.sqlite`。环境变量的修改通过再次执行 `up -d` 应用。

这是独立 Compose 文件，所有管理命令都要带 `--env-file .env.intranet -f current/compose.intranet.yaml`。不要与 `compose.yaml` 叠加；原 HTTPS 配置和项目名称保持独立，也不要启动两个应用实例共同写同一个 SQLite 卷。Compose 会从当前版本目录构建镜像；若服务器无法拉取基础镜像或 npm 依赖，先用受控构建环境制作并导入 `lab-planning:intranet` 镜像，再使用 `up -d --no-build`。

## 迁移现有数据

1. 在原应用运行环境使用 `npm run backup -- <新的备份路径>` 生成并校验完整备份，保留原始数据。切换前停止原应用写入，再生成最终备份。
2. 通过受控传输把备份复制到服务器，放在代码仓库之外。为迁移创建一个新的数据卷，将备份放为卷根目录的 `lab-planning.sqlite`；整个卷及文件须允许容器 `node` 用户（UID/GID `1000:1000`）读写。导入的是完整备份文件，无需拼接原库的 WAL。
3. 将 `.env.intranet` 的 `DATA_VOLUME_NAME` 指向该新卷，然后启动。确认使用的是迁移后账号，核验项目、计划、报告和 Word 下载，再把访问地址交给部门成员。

首次空库与迁移库不要混用。迁移到新卷后保留旧卷；更改数据卷名称会切换到另一份数据库，不会自动搬迁数据。

## 更新与备份

先把新的代码包放入 `releases/<新版本标识>/`，检查包含独立 Compose 文件。在部署根目录为旧版本备份；备份名每次使用新时间戳，`backups` 目录位于版本代码目录之外：

```sh
cd /home/yzq/apps/lab-planning
backup_name="before-upgrade-$(date +%Y%m%d-%H%M%S).sqlite"
docker compose --env-file .env.intranet -f current/compose.intranet.yaml exec -T app npm run backup -- "/app/data/backups/$backup_name"
mkdir -p backups
docker compose --env-file .env.intranet -f current/compose.intranet.yaml cp "app:/app/data/backups/$backup_name" "backups/$backup_name"
```

确认备份完成后，运维将 `current` 链接切到新版本目录，再执行：

```sh
docker compose --env-file .env.intranet -f current/compose.intranet.yaml config --quiet
docker compose --env-file .env.intranet -f current/compose.intranet.yaml up -d --build
docker compose --env-file .env.intranet -f current/compose.intranet.yaml ps
```

如果使用预先导入的镜像，上一步改用 `up -d --no-build --force-recreate`，确保容器使用刚导入的版本。保留旧代码包以及旧版本镜像的明确标签，便于回退。

更新会重建应用容器，指定的数据卷继续保留。重启后检查登录、计划、报告与导出。恢复时停应用，用已验证备份建立新卷，再修改 `DATA_VOLUME_NAME` 切换；保留故障前的卷，不覆盖唯一副本，不使用 `down -v`。备份还应复制到其他受控存储。

仓库的 `scripts/backup-intranet.sh` 可执行在线备份并复制到部署根 `backups/`，支持指定部署目录、并发锁和不覆盖既有文件。37服务器的安装副本位于 `ops/backup-intranet.sh`，已由 `yzq` 的 crontab 在每天03:10（Asia/Shanghai）运行，保留了原有定时任务。手动运行：

```sh
/usr/bin/bash /home/yzq/apps/lab-planning/ops/backup-intranet.sh
```

备份运行日志为 `backups/backup-cron.log`。当前不自动删除备份，也没有配置持续异机复制；运维需按数据量安排异机存储、容量监控和保留周期。

Docker 需随服务器开机启动。配置包含异常退出重启、持久卷、健康检查和日志轮转；健康检查失败本身不会重启仍存活的进程。定时草稿默认关闭，需管理者在报告中心启用；停机跨过触发日不会补跑，恢复后手动生成。AI 仅在配置后手动点击润色时调用。
