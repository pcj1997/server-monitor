"""
服务器监控面板 - 后端 API
提供系统状态、Docker 容器、Systemctl 服务等信息
支持服务操作（启动/停止/重启）和日志查看
"""

import os
import json
import re
import subprocess
import platform
import time
import secrets
from datetime import timedelta
from functools import wraps
from flask import Flask, jsonify, render_template, request, session

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))

# 认证 Token，通过配置文件或环境变量设置
AUTH_TOKEN = os.environ.get("MONITOR_TOKEN", "")

DEFAULT_SERVICES = [
    "nginx",
    "ssh",
    "cron",
    "docker",
    "ufw",
    "mysql",
    "postgresql",
    "redis-server",
    "mongod",
    "rabbitmq-server",
    "elasticsearch",
    "prometheus",
    "grafana-server",
    "firewalld",
]

# 服务扫描结果缓存
_services_cache = None
_services_cache_time = 0
SERVICES_CACHE_TTL = 60  # 扫描结果缓存 60 秒

CONFIG_PATH = os.environ.get("MONITOR_CONFIG", os.path.join(os.path.dirname(__file__), "config.json"))

# 操作日志记录
ACTION_LOG = []

# psutil CPU 缓存（非阻塞模式需要两次调用间隔）
_cpu_percent = None
_cpu_last_call = 0


def get_cpu_percent():
    """非阻塞获取 CPU 使用率"""
    global _cpu_percent, _cpu_last_call
    try:
        import psutil
    except ImportError:
        return 0

    now = time.time()
    if _cpu_percent is None or (now - _cpu_last_call) > 2:
        _cpu_percent = psutil.cpu_percent(interval=None)
        _cpu_last_call = now
    return _cpu_percent


def load_config():
    """加载配置文件"""
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r") as f:
            return json.load(f)
    return {}


def require_token(f):
    """装饰器：危险操作需要验证 Token"""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not AUTH_TOKEN:
            return jsonify({"error": "未配置 MONITOR_TOKEN，拒绝操作"}), 403

        token = request.headers.get("X-Auth-Token", "") or request.args.get("token", "")
        if token != AUTH_TOKEN:
            return jsonify({"error": "Token 验证失败"}), 401

        return f(*args, **kwargs)
    return decorated


# 安全的名称校验（防止命令注入）
SAFE_NAME_RE = re.compile(r'^[a-zA-Z0-9_.\-:/]+$')


def validate_name(name):
    """校验服务名/容器名是否安全"""
    if not name or len(name) > 128:
        return False
    return bool(SAFE_NAME_RE.match(name))


def log_action(action_type, target, action, result):
    """记录操作日志"""
    ACTION_LOG.insert(0, {
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "type": action_type,
        "target": target,
        "action": action,
        "result": result,
    })
    # 只保留最近 200 条
    if len(ACTION_LOG) > 200:
        ACTION_LOG.pop()


# ============ 数据采集 ============

def get_system_info():
    """获取系统基本信息"""
    try:
        import psutil
    except ImportError:
        return {"error": "psutil 未安装，请运行: pip install psutil"}

    boot_time = psutil.boot_time()
    uptime_seconds = int(time.time() - boot_time)
    uptime_str = str(timedelta(seconds=uptime_seconds))

    cpu_percent = get_cpu_percent()
    cpu_count = psutil.cpu_count()
    cpu_freq = psutil.cpu_freq()

    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()

    disk_info = []
    for partition in psutil.disk_partitions():
        try:
            usage = psutil.disk_usage(partition.mountpoint)
            disk_info.append({
                "device": partition.device,
                "mountpoint": partition.mountpoint,
                "fstype": partition.fstype,
                "total_gb": round(usage.total / (1024**3), 2),
                "used_gb": round(usage.used / (1024**3), 2),
                "free_gb": round(usage.free / (1024**3), 2),
                "percent": usage.percent,
            })
        except PermissionError:
            continue

    net = psutil.net_io_counters()

    load1, load5, load15 = os.getloadavg() if hasattr(os, "getloadavg") else (0, 0, 0)

    return {
        "hostname": platform.node(),
        "os": f"{platform.system()} {platform.release()}",
        "os_version": platform.version(),
        "architecture": platform.machine(),
        "python_version": platform.python_version(),
        "uptime": uptime_str,
        "uptime_seconds": uptime_seconds,
        "cpu": {
            "percent": cpu_percent,
            "count": cpu_count,
            "freq_mhz": round(cpu_freq.current, 0) if cpu_freq else None,
        },
        "memory": {
            "total_gb": round(mem.total / (1024**3), 2),
            "used_gb": round(mem.used / (1024**3), 2),
            "available_gb": round(mem.available / (1024**3), 2),
            "percent": mem.percent,
        },
        "swap": {
            "total_gb": round(swap.total / (1024**3), 2),
            "used_gb": round(swap.used / (1024**3), 2),
            "percent": swap.percent if swap.total > 0 else 0,
        },
        "disks": disk_info,
        "network": {
            "bytes_sent_mb": round(net.bytes_sent / (1024**2), 2),
            "bytes_recv_mb": round(net.bytes_recv / (1024**2), 2),
            "packets_sent": net.packets_sent,
            "packets_recv": net.packets_recv,
        },
        "load_average": {
            "1min": round(load1, 2),
            "5min": round(load5, 2),
            "15min": round(load15, 2),
        },
    }


def get_docker_containers():
    """获取 Docker 容器列表"""
    try:
        result = subprocess.run(
            ["sudo", "docker", "ps", "-a", "--format",
             "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.State}}"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return {"error": "Docker 命令执行失败", "detail": result.stderr}

        containers = []
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split("|")
            if len(parts) >= 6:
                containers.append({
                    "id": parts[0][:12],
                    "name": parts[1],
                    "image": parts[2],
                    "status": parts[3],
                    "ports": parts[4],
                    "state": parts[5],
                })
        return containers
    except FileNotFoundError:
        return {"error": "Docker 未安装或不在 PATH 中"}
    except subprocess.TimeoutExpired:
        return {"error": "Docker 命令超时"}
    except Exception as e:
        return {"error": str(e)}


def get_docker_stats():
    """获取运行中容器的资源使用情况"""
    try:
        result = subprocess.run(
            ["sudo", "docker", "stats", "--no-stream", "--format",
             "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}"],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode != 0:
            return {}

        stats = {}
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split("|")
            if len(parts) >= 6:
                name = parts[0]
                stats[name] = {
                    "cpu_percent": parts[1],
                    "mem_usage": parts[2],
                    "mem_percent": parts[3],
                    "net_io": parts[4],
                    "block_io": parts[5],
                }
        return stats
    except Exception:
        return {}


def scan_services():
    """自动扫描系统已安装的 service 单元"""
    global _services_cache, _services_cache_time

    now = time.time()
    if _services_cache and (now - _services_cache_time) < SERVICES_CACHE_TTL:
        return _services_cache

    services = set()

    # 1. 扫描所有 enabled 的 service（最核心的服务）
    try:
        result = subprocess.run(
            ["sudo", "systemctl", "list-unit-files", "--type=service",
             "--state=enabled", "--no-pager", "--no-legend"],
            capture_output=True, text=True, timeout=10
        )
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            # 格式: service-name.service  enabled
            parts = line.split()
            if parts:
                name = parts[0]
                if name.endswith(".service"):
                    name = name[:-8]
                services.add(name)
    except Exception:
        pass

    # 2. 扫描当前正在运行但不是 enabled 的 service（手动启动的）
    try:
        result = subprocess.run(
            ["sudo", "systemctl", "list-units", "--type=service",
             "--state=running", "--no-pager", "--no-legend"],
            capture_output=True, text=True, timeout=10
        )
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split()
            if parts:
                name = parts[0]
                if name.endswith(".service"):
                    name = name[:-8]
                services.add(name)
    except Exception:
        pass

    # 3. 扫描 failed 的 service（需要关注的故障服务）
    try:
        result = subprocess.run(
            ["sudo", "systemctl", "list-units", "--type=service",
             "--state=failed", "--no-pager", "--no-legend"],
            capture_output=True, text=True, timeout=10
        )
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split()
            if parts:
                name = parts[0]
                if name.endswith(".service"):
                    name = name[:-8]
                services.add(name)
    except Exception:
        pass

    # 过滤掉不感兴趣的系统内部服务
    SKIP_PREFIXES = (
        "system-", "user@", "session-", "dbus-", "getty@",
        "sysinit-", "basic-", "multi-user-", "graphical-",
        "network-", "local-fs-", "swap-", "cryptsetup-",
        "systemd-", "block@", "dev-", "dm-event",
        "lvm2-", "udisks", "udisks2", "accounts-daemon",
        "colord", "rtkit-daemon", "packagekit", "polkit",
        "power", "thermald", "switcheroo-control", "fwupd",
        "bolt", "ModemManager", "NetworkManager-dispatcher",
        "wpa_supplicant", "avahi-", "cups", "snapd.",
        "apparmor", "irqbalance", "kerneloops",
    )
    SKIP_EXACT = {
        "rc", "rc-local", "halt", "reboot", "shutdown",
        "poweroff", "rescue", "emergency", "exit",
        "dbus", "getty", "login", "user-runtime-dir",
    }

    filtered = []
    for svc in sorted(services):
        if svc in SKIP_EXACT:
            continue
        if any(svc.startswith(p) for p in SKIP_PREFIXES):
            continue
        filtered.append(svc)

    _services_cache = filtered
    _services_cache_time = now
    return filtered


def get_service_list():
    """获取监控的服务列表：config 有配置用配置，否则自动扫描"""
    config = load_config()
    custom = config.get("services")
    if custom:
        return custom
    return scan_services()


def get_systemctl_services(service_list=None):
    """获取 systemctl 服务状态（批量优化）"""
    if service_list is None:
        service_list = get_service_list()

    if not service_list:
        return []

    # 批量查询 active 状态
    active_map = {}
    try:
        units = ",".join(service_list)
        result = subprocess.run(
            ["sudo", "systemctl", "is-active", *service_list],
            capture_output=True, text=True, timeout=10
        )
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            # 输出格式: service_name=active\n 或 单独每行
        # is-active 多服务时逐行输出
        lines = result.stdout.strip().split("\n")
        for i, svc in enumerate(service_list):
            active_map[svc] = lines[i].strip() if i < len(lines) else "unknown"
    except Exception:
        active_map = {svc: "unknown" for svc in service_list}

    # 批量查询 enabled 状态
    enabled_map = {}
    try:
        result = subprocess.run(
            ["sudo", "systemctl", "is-enabled", *service_list],
            capture_output=True, text=True, timeout=10
        )
        lines = result.stdout.strip().split("\n")
        for i, svc in enumerate(service_list):
            enabled_map[svc] = lines[i].strip() if i < len(lines) else "unknown"
    except Exception:
        enabled_map = {svc: "unknown" for svc in service_list}

    # 批量查询描述
    desc_map = {}
    try:
        units_arg = ",".join(service_list)
        result = subprocess.run(
            ["sudo", "systemctl", "show", units_arg, "--property=Description"],
            capture_output=True, text=True, timeout=10
        )
        descs = result.stdout.strip().split("\n\n") if result.stdout.strip() else []
        for i, block in enumerate(descs):
            if i < len(service_list):
                desc_map[service_list[i]] = block.replace("Description=", "").strip()
    except Exception:
        pass

    services = []
    for svc in service_list:
        active_state = active_map.get(svc, "unknown")
        enabled_state = enabled_map.get(svc, "unknown")
        desc = desc_map.get(svc, "")

        status = "running" if active_state == "active" else (
            "stopped" if active_state == "inactive" else (
                "failed" if active_state == "failed" else active_state
            )
        )

        services.append({
            "name": svc,
            "description": desc,
            "active": active_state,
            "enabled": enabled_state,
            "status": status,
        })

    return services


def get_process_top(n=10):
    """获取占用资源最高的进程"""
    try:
        import psutil
    except ImportError:
        return []

    processes = []
    for proc in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent", "status"]):
        try:
            info = proc.info
            processes.append(info)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    processes.sort(key=lambda x: x.get("cpu_percent", 0) or 0, reverse=True)
    return processes[:n]


# ============ 操作函数 ============

def docker_action(container_name, action):
    """执行 Docker 容器操作"""
    if not validate_name(container_name):
        return {"success": False, "error": "无效的容器名称"}
    valid_actions = {"start", "stop", "restart"}
    if action not in valid_actions:
        return {"success": False, "error": f"无效操作: {action}"}

    try:
        result = subprocess.run(
            ["sudo", "docker", action, container_name],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            log_action("docker", container_name, action, "success")
            return {"success": True, "message": f"docker {action} {container_name} 成功"}
        else:
            log_action("docker", container_name, action, f"failed: {result.stderr.strip()}")
            return {"success": False, "error": result.stderr.strip()}
    except subprocess.TimeoutExpired:
        log_action("docker", container_name, action, "failed: timeout")
        return {"success": False, "error": "操作超时"}
    except Exception as e:
        log_action("docker", container_name, action, f"failed: {str(e)}")
        return {"success": False, "error": str(e)}


def systemctl_action(service_name, action):
    """执行 systemctl 服务操作"""
    if not validate_name(service_name):
        return {"success": False, "error": "无效的服务名称"}
    valid_actions = {"start", "stop", "restart", "enable", "disable"}
    if action not in valid_actions:
        return {"success": False, "error": f"无效操作: {action}"}

    cmd = ["sudo", "systemctl", action, service_name]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            log_action("systemctl", service_name, action, "success")
            return {"success": True, "message": f"systemctl {action} {service_name} 成功"}
        else:
            log_action("systemctl", service_name, action, f"failed: {result.stderr.strip()}")
            return {"success": False, "error": result.stderr.strip()}
    except subprocess.TimeoutExpired:
        log_action("systemctl", service_name, action, "failed: timeout")
        return {"success": False, "error": "操作超时"}
    except Exception as e:
        log_action("systemctl", service_name, action, f"failed: {str(e)}")
        return {"success": False, "error": str(e)}


def get_docker_logs(container_name, lines=100):
    """获取 Docker 容器日志"""
    if not validate_name(container_name):
        return {"success": False, "error": "无效的容器名称"}
    lines = max(1, min(lines, 2000))
    try:
        result = subprocess.run(
            ["sudo", "docker", "logs", "--tail", str(lines), container_name],
            capture_output=True, text=True, timeout=15
        )
        return {
            "success": True,
            "container": container_name,
            "lines": lines,
            "stdout": result.stdout[-50000:],  # 限制大小
            "stderr": result.stderr[-50000:],
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "获取日志超时"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_systemctl_logs(service_name, lines=100):
    """获取 systemctl 服务日志（journalctl）"""
    if not validate_name(service_name):
        return {"success": False, "error": "无效的服务名称"}
    lines = max(1, min(lines, 2000))
    try:
        result = subprocess.run(
            ["sudo", "journalctl", "-u", service_name, "-n", str(lines), "--no-pager"],
            capture_output=True, text=True, timeout=15
        )
        return {
            "success": True,
            "service": service_name,
            "lines": lines,
            "log": result.stdout[-50000:],
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "获取日志超时"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============ 路由 ============

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/system")
def api_system():
    return jsonify(get_system_info())


@app.route("/api/docker")
def api_docker():
    containers = get_docker_containers()
    if isinstance(containers, dict) and "error" in containers:
        return jsonify(containers)

    stats = get_docker_stats()
    for c in containers:
        c["resource"] = stats.get(c["name"], {})

    return jsonify(containers)


@app.route("/api/services")
def api_services():
    custom = request.args.get("list")
    service_list = custom.split(",") if custom else None
    data = get_systemctl_services(service_list)
    config = load_config()
    return jsonify({
        "auto_scan": not config.get("services"),
        "services": data,
    })


@app.route("/api/processes")
def api_processes():
    n = request.args.get("n", 10, type=int)
    return jsonify(get_process_top(n))


@app.route("/api/all")
def api_all():
    config = load_config()
    return jsonify({
        "system": get_system_info(),
        "docker": get_docker_containers(),
        "services": get_systemctl_services(),
        "services_auto_scan": not config.get("services"),
        "processes": get_process_top(10),
    })


# ---- 操作类 API（需要 Token 鉴权） ----

@app.route("/api/docker/<path:name>/<action>", methods=["POST"])
@require_token
def api_docker_action(name, action):
    """Docker 容器操作: start / stop / restart"""
    return jsonify(docker_action(name, action))


@app.route("/api/docker/<path:name>/logs")
def api_docker_logs(name):
    """获取 Docker 容器日志"""
    lines = request.args.get("lines", 100, type=int)
    return jsonify(get_docker_logs(name, lines))


@app.route("/api/service/<name>/<action>", methods=["POST"])
@require_token
def api_service_action(name, action):
    """Systemctl 服务操作: start / stop / restart / enable / disable"""
    return jsonify(systemctl_action(name, action))


@app.route("/api/service/<name>/logs")
def api_service_logs(name):
    """获取 systemctl 服务日志"""
    lines = request.args.get("lines", 100, type=int)
    return jsonify(get_systemctl_logs(name, lines))


@app.route("/api/action-log")
def api_action_log():
    """获取操作日志"""
    n = request.args.get("n", 50, type=int)
    return jsonify(ACTION_LOG[:n])


@app.route("/api/services/scan")
def api_services_scan():
    """强制重新扫描系统服务"""
    global _services_cache, _services_cache_time
    _services_cache = None
    _services_cache_time = 0
    services = scan_services()
    return jsonify({
        "auto_scan": True,
        "count": len(services),
        "services": services,
    })


@app.route("/api/auth/check")
def api_auth_check():
    """检查 Token 是否有效"""
    if not AUTH_TOKEN:
        return jsonify({"configured": False, "message": "未配置 MONITOR_TOKEN"})
    token = request.headers.get("X-Auth-Token", "") or request.args.get("token", "")
    return jsonify({"configured": True, "valid": token == AUTH_TOKEN})


if __name__ == "__main__":
    config = load_config()
    host = config.get("host", "0.0.0.0")
    port = config.get("port", 5050)
    debug = config.get("debug", False)
    app.run(host=host, port=port, debug=debug)
