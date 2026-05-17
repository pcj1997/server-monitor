# Server Monitor

轻量级服务器监控面板，一个 Python 文件 + 一个 HTML 就能跑起来。实时查看服务器状态、管理 Docker 容器和 Systemctl 服务、查看日志。

![Dashboard Preview](https://img.shields.io/badge/状态-生产可用-green)

## 功能一览

| 模块 | 功能 |
|------|------|
| 系统概览 | 主机名、系统版本、运行时间、负载 |
| 资源监控 | CPU / 内存 / Swap 使用率，进度条可视化 |
| Docker 容器 | 容器列表、运行状态、CPU/内存占用 |
| 容器操作 | 启动 / 停止 / 重启容器（需 Token） |
| Systemctl 服务 | 自定义监控的服务状态与开机启动项 |
| 服务操作 | 启动 / 停止 / 重启 / 启用 / 禁用服务（需 Token） |
| 日志查看 | Docker 日志（docker logs）+ 服务日志（journalctl） |
| 日志下载 | 一键导出日志为文件 |
| 操作日志 | 记录所有通过面板执行的操作及结果 |
| 磁盘使用 | 各挂载点使用率 |
| 进程 TOP 10 | 按 CPU 占用排序 |
| 网络流量 | 收发字节数与包数量 |
| 自动刷新 | 每 5 秒轮询更新 |
| 断线检测 | 连续失败自动提示，一键重连 |
| Token 鉴权 | 写操作需验证 Token，查询无需认证 |

## 快速开始

### 一键部署（Ubuntu）

```bash
git clone https://github.com/panchangjun/server-monitor.git
cd server-monitor
bash deploy.sh
```

部署脚本会自动完成：
1. 安装 Python 依赖
2. 创建专用服务用户 `www-monitor`
3. 配置最小化 sudo 权限
4. 生成随机管理 Token 并输出到终端
5. 注册并启动 systemd 服务

部署完成后访问 `http://<服务器IP>:5050`

### 手动运行（开发/调试）

```bash
pip install -r requirements.txt
MONITOR_TOKEN=mytoken123 python app.py
```

访问 `http://localhost:5050`

## 项目结构

```
server-monitor/
├── app.py                  # 后端 API（Flask）
├── config.json             # 配置文件
├── requirements.txt        # Python 依赖
├── deploy.sh               # 一键部署脚本
├── server-monitor.service  # systemd 服务单元
├── templates/
│   └── index.html          # 前端页面
├── static/
│   └── js/
│       └── app.js          # 前端逻辑
└── README.md
```

## 使用说明

### 管理操作

在页面右上角输入部署时生成的 Token，验证通过后即可执行启动/停止/重启操作。所有操作需二次确认，执行结果通过 Toast 通知反馈。

Token 保存在 `/etc/systemd/system/server-monitor.service` 中。

### 自定义监控服务

编辑 `config.json`，修改 `services` 列表：

```json
{
  "services": ["nginx", "docker", "mysql", "redis-server", "your-service"]
}
```

修改后重启服务：`sudo systemctl restart server-monitor`

### 服务管理

```bash
sudo systemctl start server-monitor
sudo systemctl stop server-monitor
sudo systemctl restart server-monitor
sudo systemctl status server-monitor
```

## API 接口

### 查询类（无需 Token）

| 路径 | 说明 |
|------|------|
| `GET /api/system` | 系统信息 |
| `GET /api/docker` | Docker 容器列表 |
| `GET /api/services` | Systemctl 服务列表 |
| `GET /api/services?list=svc1,svc2` | 指定服务列表 |
| `GET /api/processes?n=10` | TOP 进程 |
| `GET /api/all` | 全部数据 |
| `GET /api/docker/<name>/logs?lines=100` | Docker 日志 |
| `GET /api/service/<name>/logs?lines=100` | 服务日志 |
| `GET /api/action-log` | 操作日志 |
| `GET /api/auth/check` | Token 有效性检查 |

### 操作类（需 Token）

请求头添加 `X-Auth-Token: <your-token>`

| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/docker/<name>/start` | POST | 启动容器 |
| `/api/docker/<name>/stop` | POST | 停止容器 |
| `/api/docker/<name>/restart` | POST | 重启容器 |
| `/api/service/<name>/start` | POST | 启动服务 |
| `/api/service/<name>/stop` | POST | 停止服务 |
| `/api/service/<name>/restart` | POST | 重启服务 |
| `/api/service/<name>/enable` | POST | 启用开机自启 |
| `/api/service/<name>/disable` | POST | 禁用开机自启 |

## 安全设计

| 措施 | 说明 |
|------|------|
| Token 鉴权 | 写操作（启动/停止/重启）需 Token，查询和日志无需认证 |
| 名称校验 | 服务名/容器名只允许 `[a-zA-Z0-9_.\-:/]`，防止命令注入 |
| XSS 防护 | 前端所有动态内容经 HTML 转义后渲染 |
| 最小 sudo | `/etc/sudoers.d/www-monitor` 仅允许特定 systemctl/docker/journalctl 子命令 |
| 专用用户 | 以 `www-monitor` 用户运行，非 root |
| 日志大小限制 | 日志 API 限制最大 2000 行，响应体截断 50KB |

## 技术栈

- **后端**: Python 3 + Flask + psutil + Gunicorn
- **前端**: Tailwind CSS + Vanilla JS（无框架，零构建）
- **部署**: systemd + venv

## 系统要求

- Ubuntu 18.04+（或其他 systemd 发行版）
- Python 3.8+
- Docker（可选，无 Docker 时容器区域显示提示）
- root 权限（部署时使用）

## License

MIT
