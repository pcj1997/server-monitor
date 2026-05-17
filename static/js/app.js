/**
 * 服务器监控面板 - 前端逻辑
 * 支持服务操作（启动/停止/重启）和日志查看
 */

const REFRESH_INTERVAL = 5000;

// ============ HTML 转义（防 XSS） ============

function esc(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

// ============ Token 管理 ============

function getToken() {
    return localStorage.getItem('monitor_token') || '';
}

function saveToken() {
    const input = document.getElementById('token-input');
    const token = input.value.trim();
    localStorage.setItem('monitor_token', token);
    checkToken();
}

async function checkToken() {
    const token = getToken();
    const input = document.getElementById('token-input');
    const status = document.getElementById('token-status');

    input.value = token;

    if (!token) {
        status.innerHTML = '<span class="text-slate-500">未设置</span>';
        return;
    }

    try {
        const resp = await fetch('/api/auth/check', {
            headers: { 'X-Auth-Token': token }
        });
        const data = await resp.json();
        if (data.configured && data.valid) {
            status.innerHTML = '<i class="fas fa-check-circle text-green-400"></i>';
        } else if (data.configured && !data.valid) {
            status.innerHTML = '<i class="fas fa-times-circle text-red-400"></i>';
        } else {
            status.innerHTML = '<span class="text-yellow-400 text-xs">未配置Token</span>';
        }
    } catch {
        status.innerHTML = '<i class="fas fa-exclamation-circle text-red-400"></i>';
    }
}

// ============ 工具函数 ============

function formatBytes(mb) {
    if (mb < 1) return mb.toFixed(2) + ' MB';
    if (mb < 1024) return mb.toFixed(1) + ' MB';
    return (mb / 1024).toFixed(2) + ' GB';
}

function progressBar(percent) {
    let barColor = 'bg-blue-500';
    if (percent > 90) barColor = 'bg-red-500';
    else if (percent > 75) barColor = 'bg-yellow-500';
    else if (percent > 50) barColor = 'bg-green-500';
    return `<div class="w-full bg-slate-700 rounded-full h-2.5">
        <div class="progress-bar ${barColor} h-2.5 rounded-full" style="width: ${Math.min(percent, 100)}%"></div>
    </div>`;
}

function statusDot(status) {
    const map = {
        running: { color: 'bg-green-400 glow-green', text: '运行中' },
        active: { color: 'bg-green-400 glow-green', text: '运行中' },
        exited: { color: 'bg-red-400 glow-red', text: '已停止' },
        stopped: { color: 'bg-red-400 glow-red', text: '已停止' },
        inactive: { color: 'bg-slate-500', text: '未运行' },
        failed: { color: 'bg-red-500 glow-red', text: '失败' },
        paused: { color: 'bg-yellow-400 glow-yellow', text: '已暂停' },
        restarting: { color: 'bg-yellow-400 glow-yellow', text: '重启中' },
        enabled: { color: 'bg-green-400', text: '已启用' },
        disabled: { color: 'bg-slate-500', text: '已禁用' },
    };
    const info = map[status] || { color: 'bg-slate-500', text: status };
    return `<span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full ${info.color}"></span><span class="text-slate-300">${info.text}</span></span>`;
}

function overviewCard(icon, label, value, color = 'text-white') {
    return `<div class="card p-3">
        <div class="flex items-center gap-2 mb-1"><i class="${icon} text-xs text-slate-400"></i><span class="text-xs text-slate-400">${label}</span></div>
        <div class="${color} font-semibold text-sm truncate" title="${esc(value)}">${esc(value)}</div>
    </div>`;
}

function networkCard(icon, label, value) {
    return `<div class="card p-3 text-center">
        <i class="${icon} text-blue-400 text-lg mb-1"></i>
        <div class="text-xs text-slate-400">${label}</div>
        <div class="text-white font-semibold text-sm mt-1">${value}</div>
    </div>`;
}

// ============ 操作相关 ============

let pendingAction = null; // 待确认的操作

function hasToken() {
    return !!getToken();
}

function confirmAction(type, target, action) {
    const actionNames = { start: '启动', stop: '停止', restart: '重启', enable: '启用', disable: '禁用' };
    const typeName = type === 'docker' ? 'Docker 容器' : 'Systemctl 服务';

    pendingAction = { type, target, action };

    document.getElementById('confirm-message').innerHTML =
        `确定要 <span class="text-blue-400 font-semibold">${actionNames[action] || action}</span> ${typeName} <span class="text-yellow-300 font-semibold">${target}</span> 吗？`;

    const okBtn = document.getElementById('confirm-ok-btn');
    if (action === 'stop') {
        okBtn.className = 'action-btn stop';
        okBtn.style.cssText = 'padding:6px 16px;background:rgba(239,68,68,0.2);color:#f87171;border:1px solid rgba(239,68,68,0.3);';
    } else if (action === 'start') {
        okBtn.className = 'action-btn start';
        okBtn.style.cssText = 'padding:6px 16px;background:rgba(34,197,94,0.2);color:#4ade80;border:1px solid rgba(34,197,94,0.3);';
    } else {
        okBtn.className = 'action-btn restart';
        okBtn.style.cssText = 'padding:6px 16px;background:rgba(59,130,246,0.2);color:#60a5fa;border:1px solid rgba(59,130,246,0.3);';
    }

    document.getElementById('confirm-modal').classList.add('active');
}

function closeConfirmModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('confirm-modal').classList.remove('active');
    pendingAction = null;
}

async function executeConfirmed() {
    if (!pendingAction) return;

    const { type, target, action } = pendingAction;
    document.getElementById('confirm-modal').classList.remove('active');
    pendingAction = null;

    const url = type === 'docker'
        ? `/api/docker/${encodeURIComponent(target)}/${action}`
        : `/api/service/${encodeURIComponent(target)}/${action}`;

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'X-Auth-Token': getToken() }
        });
        const data = await resp.json();

        if (resp.status === 401 || resp.status === 403) {
            showToast(data.error || '操作未授权，请检查 Token', 'error');
            return;
        }

        if (data.success) {
            showToast(data.message, 'success');
            setTimeout(fetchData, 1000);
        } else {
            showToast(data.error || '操作失败', 'error');
        }
    } catch (err) {
        showToast('请求失败: ' + err.message, 'error');
    }
}

// Toast 通知
function showToast(message, type = 'info') {
    const existing = document.getElementById('toast-container');
    if (existing) existing.remove();

    const colors = {
        success: 'bg-green-600/90 border-green-500',
        error: 'bg-red-600/90 border-red-500',
        info: 'bg-blue-600/90 border-blue-500',
    };

    const icons = {
        success: 'fas fa-check-circle',
        error: 'fas fa-exclamation-circle',
        info: 'fas fa-info-circle',
    };

    const container = document.createElement('div');
    container.id = 'toast-container';
    container.className = `fixed top-16 right-4 z-[200] ${colors[type]} border rounded-lg px-4 py-3 flex items-center gap-2 text-white text-sm shadow-lg`;
    container.style.animation = 'fadeIn 0.2s ease';
    container.innerHTML = `<i class="${icons[type]}"></i><span>${message}</span>`;
    document.body.appendChild(container);

    setTimeout(() => {
        container.style.opacity = '0';
        container.style.transition = 'opacity 0.3s';
        setTimeout(() => container.remove(), 300);
    }, 3000);
}

// ============ 日志查看 ============

let currentLogTarget = null;
let currentLogType = null;

function openLogModal(type, name) {
    currentLogType = type;
    currentLogTarget = name;

    const icon = document.getElementById('log-modal-icon');
    const title = document.getElementById('log-modal-title');
    const subtitle = document.getElementById('log-modal-subtitle');

    if (type === 'docker') {
        icon.className = 'fab fa-docker text-blue-400';
        title.textContent = 'Docker 日志';
    } else {
        icon.className = 'fas fa-cogs text-blue-400';
        title.textContent = '服务日志 (journalctl)';
    }
    subtitle.textContent = name;

    document.getElementById('log-modal-content').textContent = '加载中...';
    document.getElementById('log-modal').classList.add('active');

    loadLog();
}

function closeLogModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('log-modal').classList.remove('active');
}

async function loadLog() {
    if (!currentLogTarget) return;

    const lines = document.getElementById('log-lines-select').value;
    const url = currentLogType === 'docker'
        ? `/api/docker/${encodeURIComponent(currentLogTarget)}/logs?lines=${lines}`
        : `/api/service/${encodeURIComponent(currentLogTarget)}/logs?lines=${lines}`;

    try {
        const resp = await fetch(url, { headers: { 'X-Auth-Token': getToken() } });
        const data = await resp.json();

        if (!data.success) {
            document.getElementById('log-modal-content').textContent = data.error || '获取日志失败';
            return;
        }

        const el = document.getElementById('log-modal-content');

        if (currentLogType === 'docker') {
            let text = '';
            if (data.stdout) text += data.stdout;
            if (data.stderr) {
                if (text) text += '\n\n--- STDERR ---\n\n';
                text += data.stderr;
            }
            el.innerHTML = highlightLog(text || '（无日志）');
        } else {
            el.innerHTML = highlightLog(data.log || '（无日志）');
        }
    } catch (err) {
        document.getElementById('log-modal-content').textContent = '加载失败: ' + err.message;
    }
}

function reloadLog() {
    loadLog();
}

function highlightLog(text) {
    if (!text) return '';
    let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // 高亮常见关键词
    html = html.replace(/(\bERROR\b|\bFATAL\b|\bCRITICAL\b|\bFAILED\b)/g, '<span class="log-err">$1</span>');
    html = html.replace(/(\bWARN\b|\bWARNING\b)/g, '<span class="log-warn">$1</span>');
    html = html.replace(/(\bINFO\b|\bNOTICE\b|\bDEBUG\b)/g, '<span class="log-info">$1</span>');

    return html;
}

// ============ 渲染函数 ============

function renderSystemOverview(sys) {
    const el = document.getElementById('sys-overview');
    if (!sys || sys.error) {
        el.innerHTML = overviewCard('fas fa-exclamation-triangle', '系统信息', sys?.error || '获取失败', 'text-red-400');
        return;
    }
    document.getElementById('hostname').textContent = sys.hostname;
    el.innerHTML = [
        overviewCard('fas fa-desktop', '主机名', sys.hostname),
        overviewCard('fab fa-linux', '系统', sys.os),
        overviewCard('fas fa-microchip', '架构', sys.architecture),
        overviewCard('fas fa-clock', '运行时间', sys.uptime),
        overviewCard('fas fa-tachometer-alt', '负载(1m)', sys.load_average['1min'].toString()),
        overviewCard('fas fa-memory', '内存', `${sys.memory.percent}%`),
    ].join('');
}

function renderResources(sys) {
    const el = document.getElementById('resource-cards');
    if (!sys || sys.error) return;

    const cards = [];

    const cpuColor = sys.cpu.percent > 80 ? 'text-red-400' : sys.cpu.percent > 60 ? 'text-yellow-400' : 'text-green-400';
    cards.push(`<div class="card p-4">
        <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2"><i class="fas fa-microchip text-blue-400"></i><span class="text-sm font-medium text-white">CPU</span></div>
            <span class="text-2xl font-bold ${cpuColor}">${sys.cpu.percent}%</span>
        </div>
        ${progressBar(sys.cpu.percent)}
        <div class="mt-2 text-xs text-slate-400">${sys.cpu.count} 核心 ${sys.cpu.freq_mhz ? '| ' + sys.cpu.freq_mhz + ' MHz' : ''}</div>
    </div>`);

    const memColor = sys.memory.percent > 85 ? 'text-red-400' : sys.memory.percent > 70 ? 'text-yellow-400' : 'text-green-400';
    cards.push(`<div class="card p-4">
        <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2"><i class="fas fa-memory text-blue-400"></i><span class="text-sm font-medium text-white">内存</span></div>
            <span class="text-2xl font-bold ${memColor}">${sys.memory.percent}%</span>
        </div>
        ${progressBar(sys.memory.percent)}
        <div class="mt-2 text-xs text-slate-400">${sys.memory.used_gb} GB / ${sys.memory.total_gb} GB</div>
    </div>`);

    const swapColor = sys.swap.percent > 50 ? 'text-yellow-400' : 'text-green-400';
    cards.push(`<div class="card p-4">
        <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2"><i class="fas fa-exchange-alt text-blue-400"></i><span class="text-sm font-medium text-white">Swap</span></div>
            <span class="text-2xl font-bold ${swapColor}">${sys.swap.percent}%</span>
        </div>
        ${progressBar(sys.swap.percent)}
        <div class="mt-2 text-xs text-slate-400">${sys.swap.used_gb} GB / ${sys.swap.total_gb} GB</div>
    </div>`);

    el.innerHTML = cards.join('');
}

function renderDocker(containers) {
    const tbody = document.getElementById('docker-tbody');
    const errorDiv = document.getElementById('docker-error');
    const countSpan = document.getElementById('docker-count');

    if (!Array.isArray(containers)) {
        tbody.innerHTML = '';
        errorDiv.classList.remove('hidden');
        errorDiv.querySelector('p').textContent = containers.error || '无法获取 Docker 信息';
        countSpan.textContent = '0';
        return;
    }

    errorDiv.classList.add('hidden');
    const running = containers.filter(c => c.state === 'running').length;
    countSpan.textContent = `${running}/${containers.length}`;

    if (containers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-6 text-center text-slate-500">暂无容器</td></tr>';
        return;
    }

    tbody.innerHTML = containers.map(c => {
        const res = c.resource || {};
        const isRunning = c.state === 'running';
        const isStopped = c.state === 'exited' || c.state === 'stopped';

        return `<tr class="border-b border-slate-700/50 hover:bg-slate-700/30">
            <td class="px-4 py-2.5">${statusDot(c.state)}</td>
            <td class="px-4 py-2.5 font-medium text-white">${esc(c.name)}</td>
            <td class="px-4 py-2.5 text-slate-400 text-xs">${esc(c.image)}</td>
            <td class="px-4 py-2.5 text-slate-300">${esc(res.cpu_percent) || '-'}</td>
            <td class="px-4 py-2.5 text-slate-300">${esc(res.mem_percent) || '-'}</td>
            <td class="px-4 py-2.5 text-slate-400 text-xs">${esc(c.ports) || '-'}</td>
            <td class="px-3 py-2">
                <div class="flex items-center justify-center gap-1 flex-wrap">
                    ${isStopped ? `<button class="action-btn start" onclick="confirmAction('docker','${esc(c.name)}','start')"><i class="fas fa-play"></i> 启动</button>` : ''}
                    ${isRunning ? `<button class="action-btn stop" onclick="confirmAction('docker','${esc(c.name)}','stop')"><i class="fas fa-stop"></i> 停止</button>` : ''}
                    ${isRunning ? `<button class="action-btn restart" onclick="confirmAction('docker','${esc(c.name)}','restart')"><i class="fas fa-redo"></i> 重启</button>` : ''}
                    <button class="action-btn log" onclick="openLogModal('docker','${esc(c.name)}')"><i class="fas fa-file-alt"></i> 日志</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function renderServices(services, autoScan) {
    const tbody = document.getElementById('svc-tbody');
    const countSpan = document.getElementById('svc-count');
    const scanBadge = document.getElementById('svc-scan-badge');

    if (!Array.isArray(services)) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-6 text-center text-slate-500">无法获取服务信息</td></tr>';
        return;
    }

    const active = services.filter(s => s.active === 'active').length;
    countSpan.textContent = `${active}/${services.length}`;

    if (scanBadge) {
        scanBadge.textContent = autoScan ? '自动扫描' : '自定义';
        scanBadge.className = autoScan
            ? 'status-badge bg-blue-600/30 text-blue-300 ml-2'
            : 'status-badge bg-slate-600 text-slate-300 ml-2';
    }

    tbody.innerHTML = services.map(s => {
        const isActive = s.active === 'active';
        const isInactive = s.active === 'inactive';

        return `<tr class="border-b border-slate-700/50 hover:bg-slate-700/30">
            <td class="px-4 py-2.5">${statusDot(s.status)}</td>
            <td class="px-4 py-2.5 font-medium text-white">${esc(s.name)}</td>
            <td class="px-4 py-2.5 text-slate-400 text-xs">${esc(s.description) || '-'}</td>
            <td class="px-4 py-2.5">${s.enabled === 'enabled' ? statusDot('enabled') : s.enabled === 'disabled' ? statusDot('disabled') : `<span class="text-slate-500">${esc(s.enabled)}</span>`}</td>
            <td class="px-3 py-2">
                <div class="flex items-center justify-center gap-1 flex-wrap">
                    ${isInactive ? `<button class="action-btn start" onclick="confirmAction('systemctl','${esc(s.name)}','start')"><i class="fas fa-play"></i> 启动</button>` : ''}
                    ${isActive ? `<button class="action-btn stop" onclick="confirmAction('systemctl','${esc(s.name)}','stop')"><i class="fas fa-stop"></i> 停止</button>` : ''}
                    ${isActive ? `<button class="action-btn restart" onclick="confirmAction('systemctl','${esc(s.name)}','restart')"><i class="fas fa-redo"></i> 重启</button>` : ''}
                    <button class="action-btn log" onclick="openLogModal('systemctl','${esc(s.name)}')"><i class="fas fa-file-alt"></i> 日志</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function renderDisks(disks) {
    const el = document.getElementById('disk-section');
    if (!disks || disks.length === 0) {
        el.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">暂无磁盘信息</p>';
        return;
    }
    el.innerHTML = disks.map(d => {
        const color = d.percent > 90 ? 'text-red-400' : d.percent > 75 ? 'text-yellow-400' : 'text-green-400';
        return `<div>
            <div class="flex items-center justify-between mb-1">
                <span class="text-sm text-white font-medium">${d.mountpoint}</span>
                <span class="text-xs text-slate-400">${d.device} (${d.fstype})</span>
            </div>
            ${progressBar(d.percent)}
            <div class="flex justify-between mt-1 text-xs text-slate-400">
                <span>已用 ${d.used_gb} GB / ${d.total_gb} GB</span>
                <span class="${color} font-semibold">${d.percent}%</span>
            </div>
        </div>`;
    }).join('');
}

function renderProcesses(processes) {
    const tbody = document.getElementById('proc-tbody');
    if (!processes || processes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="px-4 py-6 text-center text-slate-500">无法获取进程信息</td></tr>';
        return;
    }
    tbody.innerHTML = processes.map(p => {
        const cpu = (p.cpu_percent || 0).toFixed(1);
        const mem = (p.memory_percent || 0).toFixed(1);
        const cpuColor = cpu > 50 ? 'text-red-400' : cpu > 20 ? 'text-yellow-400' : 'text-slate-300';
        const memColor = mem > 20 ? 'text-red-400' : mem > 10 ? 'text-yellow-400' : 'text-slate-300';
        return `<tr class="border-b border-slate-700/50 hover:bg-slate-700/30">
            <td class="px-4 py-2 text-slate-400">${p.pid}</td>
            <td class="px-4 py-2 text-white font-medium">${esc(p.name)}</td>
            <td class="px-4 py-2 text-right ${cpuColor}">${cpu}</td>
            <td class="px-4 py-2 text-right ${memColor}">${mem}</td>
        </tr>`;
    }).join('');
}

function renderNetwork(net) {
    const el = document.getElementById('network-section');
    if (!net) {
        el.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">无法获取网络信息</p>';
        return;
    }
    el.innerHTML = [
        networkCard('fas fa-arrow-up', '发送', formatBytes(net.bytes_sent_mb)),
        networkCard('fas fa-arrow-down', '接收', formatBytes(net.bytes_recv_mb)),
        networkCard('fas fa-paper-plane', '发送包', net.packets_sent.toLocaleString()),
        networkCard('fas fa-inbox', '接收包', net.packets_recv.toLocaleString()),
    ].join('');
}

async function renderActionLog() {
    const tbody = document.getElementById('action-log-tbody');
    try {
        const resp = await fetch('/api/action-log');
        const logs = await resp.json();

        if (!logs || logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-4 text-center text-slate-500 text-xs">暂无操作记录</td></tr>';
            return;
        }

        tbody.innerHTML = logs.map(l => {
            const resultBadge = l.result === 'success'
                ? '<span class="text-green-400 text-xs">成功</span>'
                : `<span class="text-red-400 text-xs" title="${l.result}">失败</span>`;
            const typeBadge = l.type === 'docker'
                ? '<span class="text-blue-400">Docker</span>'
                : '<span class="text-purple-400">Systemctl</span>';

            return `<tr class="border-b border-slate-700/50">
                <td class="px-4 py-1.5 text-xs text-slate-500">${esc(l.time)}</td>
                <td class="px-4 py-1.5 text-xs">${typeBadge}</td>
                <td class="px-4 py-1.5 text-xs text-white">${esc(l.target)}</td>
                <td class="px-4 py-1.5 text-xs text-slate-300">${esc(l.action)}</td>
                <td class="px-4 py-1.5">${resultBadge}</td>
            </tr>`;
        }).join('');
    } catch {
        tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-4 text-center text-slate-500 text-xs">获取失败</td></tr>';
    }
}

// ============ 数据获取 ============

let fetchFailCount = 0;

async function fetchData() {
    try {
        const resp = await fetch('/api/all');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        renderSystemOverview(data.system);
        renderResources(data.system);
        renderDocker(data.docker);
        renderServices(data.services, data.services_auto_scan);
        renderDisks(data.system?.disks || []);
        renderProcesses(data.processes);
        renderNetwork(data.system?.network || {});

        document.getElementById('last-update').textContent =
            '更新于 ' + new Date().toLocaleTimeString('zh-CN');
    } catch (err) {
        console.error('获取数据失败:', err);
        fetchFailCount++;
        const statusEl = document.getElementById('last-update');
        if (fetchFailCount >= 3) {
            statusEl.innerHTML = '<span class="text-red-400">连接断开</span>';
            // 显示重连按钮
            let retryBtn = document.getElementById('retry-btn');
            if (!retryBtn) {
                retryBtn = document.createElement('button');
                retryBtn.id = 'retry-btn';
                retryBtn.className = 'action-btn restart text-xs ml-2';
                retryBtn.innerHTML = '<i class="fas fa-sync-alt mr-1"></i>重连';
                retryBtn.onclick = () => { fetchFailCount = 0; fetchData(); retryBtn.remove(); };
                statusEl.parentNode.insertBefore(retryBtn, statusEl.nextSibling);
            }
        } else {
            statusEl.textContent = '连接失败';
        }
        return;
    }
    fetchFailCount = 0;
    const retryBtn = document.getElementById('retry-btn');
    if (retryBtn) retryBtn.remove();
}

// ============ 服务重新扫描 ============

async function rescanServices() {
    try {
        const resp = await fetch('/api/services/scan');
        const data = await resp.json();
        showToast(`扫描完成，发现 ${data.count} 个服务`, 'success');
        fetchData();
    } catch (err) {
        showToast('扫描失败: ' + err.message, 'error');
    }
}

// ============ 日志下载 ============

function downloadLog() {
    const content = document.getElementById('log-modal-content').textContent;
    if (!content || content === '加载中...') return;

    const name = currentLogTarget || 'log';
    const type = currentLogType || 'unknown';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${type}-${name}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ============ 键盘快捷键 ============

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const logModal = document.getElementById('log-modal');
        const confirmModal = document.getElementById('confirm-modal');
        if (logModal.classList.contains('active')) {
            closeLogModal();
        } else if (confirmModal.classList.contains('active')) {
            closeConfirmModal();
        }
    }
});

// ============ 启动 ============

document.addEventListener('DOMContentLoaded', () => {
    checkToken();
    fetchData();
    renderActionLog();
    setInterval(fetchData, REFRESH_INTERVAL);
    setInterval(renderActionLog, 10000);
});
