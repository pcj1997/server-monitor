#!/bin/bash
# 服务器监控面板 - 一键部署脚本
# 在 Ubuntu 服务器上运行: bash deploy.sh

set -e

APP_DIR="/opt/server-monitor"
APP_USER="www-monitor"
PYTHON_BIN="python3"

echo "===== 服务器监控面板部署 ====="

# 1. 安装依赖
echo "[1/7] 安装系统依赖..."
sudo apt-get update -qq
sudo apt-get install -y -qq python3 python3-pip python3-venv

# 2. 创建用户
echo "[2/7] 创建服务用户..."
if ! id "$APP_USER" &>/dev/null; then
    sudo useradd -r -s /bin/false "$APP_USER"
    echo "  创建用户: $APP_USER"
else
    echo "  用户已存在: $APP_USER"
fi

# 将监控用户加入 docker 组以获取容器信息
sudo usermod -aG docker "$APP_USER" 2>/dev/null || true

# 3. 配置 sudo 权限
echo "[3/7] 配置 sudo 权限..."
if [ ! -f /etc/sudoers.d/www-monitor ]; then
    echo "$APP_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl start *, /usr/bin/systemctl stop *, /usr/bin/systemctl restart *, /usr/bin/systemctl enable *, /usr/bin/systemctl disable *, /usr/bin/systemctl is-active *, /usr/bin/systemctl is-enabled *, /usr/bin/systemctl show *, /usr/bin/journalctl *, /usr/bin/docker ps *, /usr/bin/docker stats *, /usr/bin/docker start *, /usr/bin/docker stop *, /usr/bin/docker restart *, /usr/bin/docker logs *" | sudo tee /etc/sudoers.d/www-monitor > /dev/null
    sudo chmod 440 /etc/sudoers.d/www-monitor
    echo "  已创建 /etc/sudoers.d/www-monitor"
else
    echo "  sudoers 配置已存在"
fi

# 4. 部署文件
echo "[4/7] 部署应用文件..."
sudo mkdir -p "$APP_DIR"
# 排除 venv 目录，避免残留旧环境
sudo rsync -a --exclude='venv' --exclude='__pycache__' --exclude='.git' --exclude='.gitignore' "$(dirname "$0")/" "$APP_DIR/"
sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# 5. 创建虚拟环境并安装 Python 依赖
echo "[5/7] 安装 Python 依赖..."
if [ ! -d "$APP_DIR/venv" ]; then
    sudo -u "$APP_USER" $PYTHON_BIN -m venv "$APP_DIR/venv"
fi
sudo -u "$APP_USER" "$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

# 6. 生成管理 Token
echo "[6/7] 配置管理 Token..."
if [ -z "$MONITOR_TOKEN" ]; then
    MONITOR_TOKEN=$(openssl rand -hex 16)
    echo "  自动生成 Token: $MONITOR_TOKEN"
else
    echo "  使用环境变量中的 Token"
fi

# 写入 systemd 服务文件中的 Token
sudo sed -i "s/^Environment=MONITOR_TOKEN=.*/Environment=MONITOR_TOKEN=$MONITOR_TOKEN/" \
    "$APP_DIR/server-monitor.service"

# 7. 安装 systemd 服务
echo "[7/7] 安装 systemd 服务..."
sudo cp "$APP_DIR/server-monitor.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable server-monitor
sudo systemctl restart server-monitor

echo ""
echo "=========================================="
echo "  部署完成!"
echo "=========================================="
echo ""
echo "  访问地址:  http://$(hostname -I | awk '{print $1}'):5050"
echo "  管理 Token: $MONITOR_TOKEN"
echo ""
echo "  请在网页右上角输入 Token 以解锁服务操作功能"
echo "  Token 保存在 /etc/systemd/system/server-monitor.service"
echo ""
echo "  自定义监控服务列表: 编辑 $APP_DIR/config.json"
echo "  修改后需重启: sudo systemctl restart server-monitor"
