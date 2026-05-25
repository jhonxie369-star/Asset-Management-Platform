import React, { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ModuleConfigPanel } from '../components/ModuleConfigs';
import { Pagination } from '../components/Pagination';
import { formatBeijingTime } from '../utils/time';

export default function Tasks() {
  const [runs, setRuns] = useState<any[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsTotalPages, setRunsTotalPages] = useState(1);
  const [runsPage, setRunsPage] = useState(1);
  const [runsPageSize, setRunsPageSize] = useState(20);
  const [modules, setModules] = useState<any[]>([]);
  const [assetLists, setAssetLists] = useState<any[]>([]);
  const [portLists, setPortLists] = useState<any[]>([]);
  const [scheduledTasks, setScheduledTasks] = useState<any[]>([]);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [schedFlash, setSchedFlash] = useState<string | null>(null);
  const [taskLog, setTaskLog] = useState<{ source: 'task' | 'run'; taskId?: string; runId?: string; loading: boolean; report?: any; error?: string } | null>(null);
  const [editingTask, setEditingTask] = useState<{
    taskId: string;
    name: string;
    modules: string[];
    config: Record<string, any>;
    scheduleType: 'daily' | 'everyDays' | 'interval';
    cron: string;
    everyDays: number;
    intervalMinutes: number;
  } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const schedListRef = useRef<HTMLDivElement>(null);

  const [cfg, setCfg] = useState<{
    assetListId: string;
    portListId: string;
    moduleIds: string[];
    moduleConfigs: Record<string, any>;
  }>({
    assetListId: '',
    portListId: '',
    moduleIds: ['port-discovery'],
    moduleConfigs: {
      'port-discovery': { workers: 500, timeoutMs: 2000 },
      'db-endpoint-probe': { workers: 80, timeoutMs: 3000, includeIpAssets: false },
      'fingerprint': { workers: 60, httpTimeoutMs: 3000, tcpTimeoutMs: 2000, enableFavicon: true, enableTls: true },
      'weak-password': { workers: 20, timeoutMs: 4000, delayBetweenMs: 100, stopOnFirstHit: true },
      'dirsearch': { workers: 30, timeoutMs: 3000 },
    },
  });

  const [schedForm, setSchedForm] = useState({
    name: '',
    scheduleType: 'daily' as 'daily' | 'everyDays' | 'interval',
    cron: '03:00',
    everyDays: 2,
    intervalMinutes: 60,
  });

  const loadRuns = () => {
    api.getTaskRuns({ page: runsPage, pageSize: runsPageSize }).then((r: any) => {
      setRuns(r.data || []);
      setRunsTotal(r.total || 0);
      setRunsTotalPages(r.totalPages || 1);
    });
  };
  const loadScheduled = () => api.getTasks(true).then((r: any) => setScheduledTasks(r.data || []));
  const loadLists = () => {
    api.getAssetLists().then((r: any) => setAssetLists(r.data || []));
    api.getPortLists().then((r: any) => setPortLists(r.data || []));
  };
  const load = () => { loadRuns(); loadScheduled(); };

  useEffect(() => {
    api.getModules().then((r: any) => setModules(r.data || []));
    api.getAssetLists().then((r: any) => {
      const lists = r.data || [];
      setAssetLists(lists);
      if (lists[0]) setCfg(prev => ({ ...prev, assetListId: lists[0].id }));
    });
    api.getPortLists().then((r: any) => {
      const lists = r.data || [];
      setPortLists(lists);
      if (lists[0]) setCfg(prev => ({ ...prev, portListId: lists[0].id }));
    });
  }, []);

  // runs 分页 state 变化或定时刷新
  useEffect(() => {
    loadRuns();
    loadScheduled();
    const timer = setInterval(() => { loadRuns(); loadScheduled(); loadLists(); }, 5000);
    return () => clearInterval(timer);
  }, [runsPage, runsPageSize]);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 50);
  };

  const buildPayload = (name?: string, schedule?: any) => {
    const assetList = assetLists.find(l => l.id === cfg.assetListId);
    const portList = portLists.find(l => l.id === cfg.portListId);

    // 命名空间 config：每个模块走 config[moduleId]
    const nsConfig: Record<string, any> = { ...cfg.moduleConfigs };
    // port-discovery 的 ports 从左侧端口列表注入
    if (cfg.moduleIds.includes('port-discovery')) {
      nsConfig['port-discovery'] = {
        ...(nsConfig['port-discovery'] || {}),
        ports: portList?.ports || [],
      };
    }
    // 扁平 ports 保留给其他地方用
    const flat = { ports: portList?.ports || [] };

    const primaryType = cfg.moduleIds.includes('weak-password') ? 'weak_password'
      : cfg.moduleIds.includes('dirsearch') ? 'dirsearch'
      : cfg.moduleIds.includes('fingerprint') ? 'fingerprint' : 'discovery';
    const portName = portList?.name || 'endpoint端口';

    return {
      name: name || `${cfg.moduleIds.join('+')} · ${assetList?.name} × ${portName}`,
      type: primaryType,
      modules: cfg.moduleIds,
      selector: { mode: 'by_list', assetListId: cfg.assetListId },
      config: { ...flat, ...nsConfig, portListId: cfg.portListId },
      schedule,
    };
  };

  const runNow = async () => {
    setLogs([]);
    const assetList = assetLists.find(l => l.id === cfg.assetListId);
    const portList = portLists.find(l => l.id === cfg.portListId);
    const needsPortList = cfg.moduleIds.includes('port-discovery');
    if (!assetList) { addLog('❌ 请先选择资产列表'); return; }
    if (needsPortList && !portList) { addLog('❌ port-discovery 需要先选择端口列表'); return; }

    const taskCount = cfg.moduleIds.includes('port-discovery')
      ? (assetList.entries?.length || 0) * (portList?.ports?.length || 0)
      : (assetList.entries?.length || 0);
    const pdWorkers = cfg.moduleConfigs['port-discovery']?.workers ?? 500;
    addLog(`目标: ${assetList.name} (${assetList.entries?.length})${portList ? ` × ${portList.name} (${portList.ports?.length})` : ''}`);
    addLog(cfg.moduleIds.includes('port-discovery')
      ? `总连接: ${taskCount.toLocaleString()}，port-discovery 并发 ${pdWorkers}`
      : `endpoint 目标: ${taskCount.toLocaleString()}，端口来自资产条目`);
    if (!confirm(`确认立即执行一次临时扫描任务？\n\n资产列表：${assetList.name} (${assetList.entries?.length || 0})${portList ? `\n端口列表：${portList.name} (${portList.ports?.length || 0})` : ''}\n模块：${cfg.moduleIds.join(' → ')}\n预计连接/目标：${taskCount.toLocaleString()}`)) return;
    if (taskCount > 500000 && !confirm(`任务数 ${taskCount.toLocaleString()}，确认继续？`)) return;

    const res: any = await api.createTask(buildPayload());
    if (!res.ok) { addLog(`❌ 创建失败: ${res.error}`); return; }
    addLog(`✓ 任务已创建`);

    setRunning(true);
    const t0 = Date.now();
    const runRes: any = await api.runTask(res.data.id);
    setRunning(false);

    if (runRes.ok && runRes.data) {
      for (const run of runRes.data) {
        const icon = run.status === 'completed' ? '✓' : '✗';
        addLog(`${icon} ${run.moduleId}: ${run.counters?.total || 0} 个结果`);
        if (run.error) addLog(`  错误: ${run.error}`);
      }
      addLog(`── 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）──`);
    } else {
      addLog(`❌ 执行失败: ${runRes.error || 'unknown'}`);
    }
    load();
  };

  const saveSchedule = async () => {
    if (!schedForm.name.trim()) { alert('请填写任务名称'); return; }
    const assetList = assetLists.find(l => l.id === cfg.assetListId);
    const portList = portLists.find(l => l.id === cfg.portListId);
    const needsPortList = cfg.moduleIds.includes('port-discovery');
    if (!assetList || (needsPortList && !portList)) { alert(needsPortList ? '请先配置资产/端口列表' : '请先配置资产列表'); return; }
    const schedule = schedForm.scheduleType === 'interval'
      ? { intervalMinutes: schedForm.intervalMinutes }
      : schedForm.scheduleType === 'everyDays'
        ? (schedForm.everyDays > 1 ? { cron: schedForm.cron, everyDays: schedForm.everyDays } : { cron: schedForm.cron })
        : { cron: schedForm.cron };
    const res: any = await api.createTask(buildPayload(schedForm.name, schedule));
    if (res.ok) {
      const savedName = schedForm.name;
      setSchedForm({ ...schedForm, name: '' });
      load();
      setSchedFlash(`✓ 已保存 "${savedName}"`);
      setTimeout(() => setSchedFlash(null), 3000);
      setTimeout(() => schedListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    } else {
      alert(`失败: ${res.error}`);
    }
  };

  const deleteSchedule = async (task: any) => {
    if (!confirm(`确认删除定时任务？\n\n名称：${task.name}\nID：${String(task.id).slice(0, 8)}\n\n删除后不会影响历史报告，但不会再按计划执行。`)) return;
    const id = task.id;
    await api.deleteTask(id);
    load();
  };

  const runScheduleNow = async (task: any) => {
    if (!confirm(`确认立即执行此定时任务？\n\n名称：${task.name}\nID：${String(task.id).slice(0, 8)}\n模块：${(task.modules || []).join(' → ')}\n\n大型任务会占用较长时间。`)) return;
    const id = task.id;
    setLogs([]);
    addLog(`▶ 立即执行定时任务 ${id.slice(0, 8)}...`);
    setRunning(true);
    const t0 = Date.now();
    const runRes: any = await api.runTask(id);
    setRunning(false);
    if (runRes.ok && runRes.data) {
      for (const run of runRes.data) {
        const icon = run.status === 'completed' ? '✓' : '✗';
        addLog(`${icon} ${run.moduleId}: ${run.counters?.total || 0} 结果`);
      }
      addLog(`── 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）──`);
    }
    load();
  };

  const openTaskLog = async (task: any) => {
    const taskId = task.id;
    if (taskLog?.source === 'task' && taskLog?.taskId === taskId && !taskLog.loading) {
      setTaskLog(null);
      return;
    }
    setTaskLog({ source: 'task', taskId, loading: true });
    const runList: any = await api.getTaskRuns({ taskId, pageSize: 1 });
    const latest = runList.data?.[0];
    if (!latest) {
      setTaskLog({ source: 'task', taskId, loading: false, error: '暂无执行记录' });
      return;
    }
    const report: any = await api.getTaskRunReport(latest.id);
    if (!report.ok) {
      setTaskLog({ source: 'task', taskId, runId: latest.id, loading: false, error: report.error || '日志加载失败' });
      return;
    }
    setTaskLog({ source: 'task', taskId, runId: latest.id, loading: false, report: report.data });
  };

  const openRunLog = async (run: any) => {
    const runId = run.id;
    if (taskLog?.source === 'run' && taskLog?.runId === runId && !taskLog.loading) {
      setTaskLog(null);
      return;
    }
    setTaskLog({ source: 'run', taskId: run.taskId, runId, loading: true });
    const report: any = await api.getTaskRunReport(runId);
    if (!report.ok) {
      setTaskLog({ source: 'run', taskId: run.taskId, runId, loading: false, error: report.error || '日志加载失败' });
      return;
    }
    setTaskLog({ source: 'run', taskId: run.taskId, runId, loading: false, report: report.data });
  };

  const refreshTaskLog = async () => {
    if (!taskLog) return;
    if (taskLog.source === 'run' && taskLog.runId) {
      const report: any = await api.getTaskRunReport(taskLog.runId);
      setTaskLog(report.ok
        ? { source: 'run', taskId: taskLog.taskId, runId: taskLog.runId, loading: false, report: report.data }
        : { source: 'run', taskId: taskLog.taskId, runId: taskLog.runId, loading: false, error: report.error || '日志加载失败' });
      return;
    }
    if (!taskLog.taskId) return;
    const runList: any = await api.getTaskRuns({ taskId: taskLog.taskId, pageSize: 1 });
    const latest = runList.data?.[0];
    if (!latest) {
      setTaskLog({ source: 'task', taskId: taskLog.taskId, loading: false, error: '暂无执行记录' });
      return;
    }
    const report: any = await api.getTaskRunReport(latest.id);
    setTaskLog(report.ok
      ? { source: 'task', taskId: taskLog.taskId, runId: latest.id, loading: false, report: report.data }
      : { source: 'task', taskId: taskLog.taskId, runId: latest.id, loading: false, error: report.error || '日志加载失败' });
  };

  useEffect(() => {
    if (!taskLog?.taskId && !taskLog?.runId) return;
    const timer = setInterval(() => { refreshTaskLog(); }, 5000);
    return () => clearInterval(timer);
  }, [taskLog?.source, taskLog?.taskId, taskLog?.runId]);

  const renderLogPanel = (colSpan: number) => (
    <tr>
      <td colSpan={colSpan} style={{ background: 'var(--bg)', padding: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <div>
            <b>{taskLog?.source === 'run' ? '本次执行日志' : '最近执行日志'}</b>
            {taskLog?.report?.taskRun && (
              <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>
                {taskLog.report.taskRun.status} · {formatBeijingTime(taskLog.report.taskRun.startedAt)}
              </span>
            )}
          </div>
          <button className="btn" onClick={refreshTaskLog} disabled={taskLog?.loading}>↻ 刷新</button>
        </div>
        {taskLog?.loading && <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>加载中…</div>}
        {taskLog?.error && <div style={{ color: 'var(--danger)', fontSize: '0.8rem' }}>{taskLog.error}</div>}
        {taskLog?.report && (
          <>
            <table style={{ margin: 0 }}>
              <thead><tr><th>模块</th><th>状态</th><th>结果数</th><th>有效结果/命中</th><th>耗时</th><th>开始</th><th>错误</th></tr></thead>
              <tbody>
                {(taskLog.report.runs || []).map((r: any) => {
                  const types = r.resultTypes || {};
                  const effective =
                    r.moduleId === 'db-endpoint-probe'
                      ? `${types.endpoint_alive || 0} 活端点 / ${types.log || 0} 未连通`
                      : r.moduleId === 'port-discovery'
                        ? `${types.endpoint_alive || 0} 活端点`
                        : r.moduleId === 'fingerprint'
                          ? `${types.service_identified || 0} 服务`
                          : r.moduleId === 'dirsearch'
                            ? `${types.web_path || 0} Web路径`
                            : r.moduleId === 'weak-password'
                              ? `${r.weakPasswordFindings || 0} 问题 / ${types.log || 0} 目标`
                              : Object.entries(types).map(([k, v]) => `${k}:${v as any}`).join(', ') || '-';
                  return (
                    <tr key={r.id}>
                      <td>{r.moduleId}</td>
                      <td style={{ color: r.status === 'completed' ? 'var(--success)' : r.status === 'running' ? 'var(--warning)' : 'var(--danger)' }}>{r.status}</td>
                      <td>{r.total || 0}</td>
                      <td style={{ fontSize: '0.75rem' }}>{effective}</td>
                      <td>{typeof r.durationMs === 'number' ? `${(r.durationMs / 1000).toFixed(1)}s` : '-'}</td>
                      <td style={{ fontSize: '0.75rem' }}>{formatBeijingTime(r.startedAt)}</td>
                      <td style={{ color: 'var(--danger)', fontSize: '0.75rem' }}>{r.error || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{
              marginTop: '0.5rem', maxHeight: '260px', overflow: 'auto',
              background: 'rgba(0,0,0,0.12)', border: '1px solid var(--border)',
              borderRadius: '4px', padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.72rem',
            }}>
              {(taskLog.report.logs || []).length === 0 ? (
                <div style={{ color: 'var(--text-dim)' }}>
                  暂无模块 log 记录。端口发现/指纹主要看上方模块结果；弱口令、endpoint 探测会输出详细 log。
                </div>
              ) : (taskLog.report.logs || []).map((r: any) => {
                const d = r.data || {};
                const text = d.target
                  ? `${d.target} ${d.tester || ''} tried=${d.tried ?? '-'} hit=${d.hit ? 'yes' : 'no'} failures=${JSON.stringify(d.failures || {})}`
                  : `${d.host || d.ip || ''}${d.port ? ':' + d.port : ''} ${JSON.stringify(d).slice(0, 260)}`;
                return (
                  <div key={r.id} style={{ color: d.hit ? 'var(--danger)' : 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>
                    [{formatBeijingTime(r.createdAt)}] {r.moduleId} {text}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </td>
    </tr>
  );

  const startEditSchedule = (task: any) => {
    setEditingTask({
      taskId: task.id,
      name: task.name,
      modules: task.modules || [],
      config: task.config || {},
      scheduleType: task.schedule?.intervalMinutes ? 'interval' : task.schedule?.everyDays ? 'everyDays' : 'daily',
      cron: task.schedule?.cron || '03:00',
      everyDays: task.schedule?.everyDays || 2,
      intervalMinutes: task.schedule?.intervalMinutes || 60,
    });
  };

  const saveEditSchedule = async () => {
    if (!editingTask) return;
    const schedule = editingTask.scheduleType === 'interval'
      ? { intervalMinutes: editingTask.intervalMinutes }
      : editingTask.scheduleType === 'everyDays'
        ? (editingTask.everyDays > 1 ? { cron: editingTask.cron, everyDays: editingTask.everyDays } : { cron: editingTask.cron })
        : { cron: editingTask.cron };
    const res: any = await api.updateTask(editingTask.taskId, {
      name: editingTask.name,
      modules: editingTask.modules,
      config: editingTask.config,
      schedule,
    });
    if (res.ok) {
      setSchedFlash('✓ 定时任务配置已更新');
      setEditingTask(null);
      loadScheduled();
      setTimeout(() => setSchedFlash(null), 3000);
    } else {
      alert(`更新失败: ${res.error || 'unknown'}`);
    }
  };

  const assetList = assetLists.find(l => l.id === cfg.assetListId);
  const portList = portLists.find(l => l.id === cfg.portListId);
  const needsPortList = cfg.moduleIds.includes('port-discovery');
  const taskCount = needsPortList
    ? (assetList?.entries?.length || 0) * (portList?.ports?.length || 0)
    : (assetList?.entries?.length || 0);
  const pdCfg = cfg.moduleConfigs['port-discovery'] || {};
  const pdWorkers = pdCfg.workers ?? 500;
  const pdTimeout = pdCfg.timeoutMs ?? 2000;
  const estimateSec = taskCount > 0 && pdWorkers > 0
    ? Math.ceil(taskCount / pdWorkers * pdTimeout / 1000 * 0.3) : 0;

  const configReady = !!assetList && (!needsPortList || !!portList) && cfg.moduleIds.length > 0;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
        <h2>任务中心</h2>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
          资产列表 × 端口列表 × 模块 = 扫描任务
        </span>
      </div>

      {/* ═══ 两栏布局：左配置 / 右执行 ═══ */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>

        {/* ─── 左栏：扫描配置 ─── */}
        <div className="card" style={{ margin: 0 }}>
          <h3 style={{ marginBottom: '1rem' }}>扫描配置</h3>

          {/* 资产列表 */}
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>
              <span>资产列表</span>
              <Link to="/asset-lists" style={{ color: 'var(--accent)' }}>管理 →</Link>
            </div>
            {assetLists.length === 0 ? (
              <Link to="/asset-lists" className="btn" style={{ display: 'inline-block', textDecoration: 'none', color: 'var(--warning)' }}>+ 请先创建资产列表</Link>
            ) : (
              <select value={cfg.assetListId} onChange={e => setCfg({ ...cfg, assetListId: e.target.value })} style={{ width: '100%' }}>
                {assetLists.map(l => (
                  <option key={l.id} value={l.id}>{l.name} ({l.entries?.length || 0})</option>
                ))}
              </select>
            )}
          </div>

          {/* 端口列表 */}
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>
              <span>端口列表</span>
              <Link to="/port-lists" style={{ color: 'var(--accent)' }}>管理 →</Link>
            </div>
            {!needsPortList && (
              <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem', marginBottom: '0.3rem' }}>
                当前模块不强制依赖端口列表；db-endpoint-probe 使用资产条目中的 host:port。
              </div>
            )}
            {portLists.length === 0 ? (
              <Link to="/port-lists" className="btn" style={{ display: 'inline-block', textDecoration: 'none', color: 'var(--warning)' }}>+ 请先创建端口列表</Link>
            ) : (
              <select value={cfg.portListId} onChange={e => setCfg({ ...cfg, portListId: e.target.value })} style={{ width: '100%' }}>
                {portLists.map(l => (
                  <option key={l.id} value={l.id}>{l.name} ({l.ports?.length || 0})</option>
                ))}
              </select>
            )}
          </div>

          {/* 模块 */}
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>
              执行模块 <span style={{ fontSize: '0.7rem' }}>（按勾选顺序串行执行，上游产出作为下游输入）</span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {modules.map(m => {
                const checked = cfg.moduleIds.includes(m.id);
                const order = checked ? cfg.moduleIds.indexOf(m.id) + 1 : null;
                const riskColor = m.riskLevel === 'intrusive' ? 'var(--danger)'
                  : m.riskLevel === 'safe_active' ? 'var(--warning)' : 'var(--text-dim)';
                return (
                  <label key={m.id} style={{
                    display: 'flex', alignItems: 'center', gap: '0.3rem',
                    padding: '0.3rem 0.6rem', borderRadius: '4px',
                    border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                    background: checked ? 'rgba(79,195,247,0.1)' : 'transparent',
                    cursor: 'pointer', fontSize: '0.8rem',
                  }}>
                    <input type="checkbox" checked={checked}
                      onChange={e => {
                        const ids = e.target.checked ? [...cfg.moduleIds, m.id] : cfg.moduleIds.filter(x => x !== m.id);
                        setCfg({ ...cfg, moduleIds: ids });
                      }} />
                    {order && <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{order}.</span>}
                    {m.name}
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
                      ({m.targetType === 'asset' ? '资产' : m.targetType === 'endpoint' ? '端点' : '服务'})
                    </span>
                    <span style={{ fontSize: '0.6rem', color: riskColor }}>{m.riskLevel}</span>
                  </label>
                );
              })}
            </div>
            {cfg.moduleIds.length > 1 && (
              <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>
                💡 执行顺序：{cfg.moduleIds.join(' → ')}
              </div>
            )}
          </div>

          {/* 每模块配置面板 */}
          <ModuleConfigPanel
            moduleIds={cfg.moduleIds}
            configs={cfg.moduleConfigs}
            onChange={(id, c) => setCfg({ ...cfg, moduleConfigs: { ...cfg.moduleConfigs, [id]: c } })}
          />

          {/* 预览 + 执行 */}
          <div style={{
            padding: '0.75rem', background: 'var(--bg)', borderRadius: '4px',
            fontSize: '0.8rem', borderLeft: `3px solid ${taskCount > 0 ? 'var(--accent)' : 'var(--border)'}`,
          }}>
            <div>预计 <b style={{ color: 'var(--accent)' }}>{taskCount.toLocaleString()}</b> 次连接
              {estimateSec > 0 && <span style={{ color: 'var(--text-dim)' }}> · 约 {estimateSec}s</span>}
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: '0.7rem', marginTop: '0.2rem' }}>
              {needsPortList
                ? `${assetList?.entries?.length || 0} 资产 × ${portList?.ports?.length || 0} 端口`
                : `${assetList?.entries?.length || 0} endpoint/资产，端口来自条目`}
            </div>
          </div>

          <button className="btn btn-primary" disabled={running || !configReady}
            style={{ width: '100%', marginTop: '0.75rem', padding: '0.6rem' }}
            onClick={runNow}>
            {running ? '⏳ 执行中...' : '▶ 立即执行'}
          </button>
        </div>

        {/* ─── 右栏：执行日志 / 定时任务 ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

          {/* 执行日志（仅在有日志时显示）*/}
          {logs.length > 0 && (
            <div className="card" style={{ margin: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <h3 style={{ margin: 0 }}>执行日志</h3>
                <button className="btn" onClick={() => setLogs([])}>清空</button>
              </div>
              <div ref={logRef} style={{
                maxHeight: '280px', overflow: 'auto', background: 'var(--bg)',
                borderRadius: '4px', padding: '0.6rem', fontFamily: 'monospace',
                fontSize: '0.75rem', lineHeight: '1.5',
              }}>
                {logs.map((l, i) => (
                  <div key={i} style={{
                    color: l.includes('❌') || l.includes('✗') ? 'var(--danger)'
                      : l.includes('✓') ? 'var(--success)' : 'var(--text-dim)',
                  }}>{l}</div>
                ))}
              </div>
            </div>
          )}

          {/* 保存为定时任务 */}
          <div className="card" style={{ margin: 0 }}>
            <h3 style={{ marginBottom: '0.5rem' }}>📅 保存为定时任务</h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '0.75rem' }}>
              基于左侧的扫描配置创建定时任务
            </p>
            <input placeholder="任务名称" style={{ width: '100%', marginBottom: '0.5rem' }}
              value={schedForm.name} onChange={e => setSchedForm({ ...schedForm, name: e.target.value })} />
            <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.5rem' }}>
              <select value={schedForm.scheduleType}
                onChange={e => setSchedForm({ ...schedForm, scheduleType: e.target.value as any })}
                style={{ flex: 1 }}>
                <option value="daily">每日定时(北京时间)</option>
                <option value="everyDays">每 N 天定时</option>
                <option value="interval">间隔运行</option>
              </select>
              {schedForm.scheduleType === 'daily' ? (
                <input type="time" style={{ width: '120px' }}
                  value={schedForm.cron} onChange={e => setSchedForm({ ...schedForm, cron: e.target.value })} />
              ) : schedForm.scheduleType === 'everyDays' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>每</span>
                  <input type="number" min={1} style={{ width: '64px' }}
                    value={schedForm.everyDays}
                    onChange={e => setSchedForm({ ...schedForm, everyDays: +e.target.value })} />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>天</span>
                  <input type="time" style={{ width: '112px' }}
                    value={schedForm.cron} onChange={e => setSchedForm({ ...schedForm, cron: e.target.value })} />
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <input type="number" min={1} style={{ width: '80px' }}
                    value={schedForm.intervalMinutes}
                    onChange={e => setSchedForm({ ...schedForm, intervalMinutes: +e.target.value })} />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>分钟</span>
                </div>
              )}
            </div>
            <button className="btn btn-primary" onClick={saveSchedule}
              disabled={!configReady || !schedForm.name.trim()}
              title={
                !configReady ? '请先在左侧选择资产列表、端口列表、至少一个模块'
                  : !schedForm.name.trim() ? '请填写任务名称'
                  : '保存为定时任务'
              }
              style={{ width: '100%' }}>
              + 保存为定时任务
            </button>
            {schedFlash && (
              <div style={{
                marginTop: '0.5rem', padding: '0.4rem 0.6rem',
                background: 'rgba(46,204,113,0.15)', color: 'var(--success)',
                borderRadius: '4px', fontSize: '0.8rem',
              }}>{schedFlash}</div>
            )}
            {(!configReady || !schedForm.name.trim()) && (
              <div style={{ marginTop: '0.4rem', fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                {!configReady && '⚠ 先在左侧选资产/端口/模块'}
                {configReady && !schedForm.name.trim() && '⚠ 请填写任务名称'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ═══ 定时任务列表 ═══ */}
      <div ref={schedListRef} className="card" style={{ marginTop: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0 }}>定时任务</h3>
          <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>{scheduledTasks.length} 个</span>
        </div>
        {scheduledTasks.length === 0 ? (
          <p style={{ padding: '1rem', color: 'var(--text-dim)', textAlign: 'center' }}>
            还没有定时任务，在右上方的"保存为定时任务"区创建一个吧
          </p>
        ) : (
          <table>
            <thead><tr><th>名称</th><th>资产列表 × 端口列表</th><th>调度</th><th>模块</th><th>最后执行</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {scheduledTasks.map(t => {
                const schDisplay = t.schedule?.cron
                  ? (t.schedule?.everyDays && t.schedule.everyDays > 1
                    ? `每 ${t.schedule.everyDays} 天 ${t.schedule.cron}（北京时间）`
                    : `每日 ${t.schedule.cron}（北京时间）`)
                  : t.schedule?.intervalMinutes ? `每 ${t.schedule.intervalMinutes} 分钟` : '-';
                const isEditing = editingTask?.taskId === t.id;
                const alId = t.selector?.assetListId;
                const plId = (t.config as any)?.portListId;
                const al = assetLists.find(l => l.id === alId);
                const pl = portLists.find(l => l.id === plId);
                const taskAssetList = (t as any).assetList;
                const taskPortList = (t as any).portList;
                const alName = al ? `${al.name} (${al.entries?.length || 0})`
                  : taskAssetList ? `${taskAssetList.name} (${taskAssetList.count || 0})`
                    : (alId ? '(未加载/已删除)' : '-');
                const plName = pl ? `${pl.name} (${pl.ports?.length || 0})`
                  : taskPortList ? `${taskPortList.name} (${taskPortList.count || 0})`
                    : (plId ? '(未加载/已删除)' : '-');
                return (
                  <React.Fragment key={t.id}>
                  <tr>
                    <td>
                      {isEditing && editingTask ? (
                        <input value={editingTask.name}
                          onChange={e => setEditingTask({ ...editingTask, name: e.target.value })}
                          style={{ minWidth: '180px' }} />
                      ) : t.name}
                    </td>
                    <td style={{ fontSize: '0.8rem' }}>
                      <div>{alName}</div>
                      <div style={{ color: 'var(--text-dim)' }}>× {plName}</div>
                    </td>
                    <td style={{ fontSize: '0.8rem' }}>
                      {isEditing && editingTask ? (
                        <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', flexWrap: 'wrap' }}>
                          <select value={editingTask.scheduleType}
                            onChange={e => setEditingTask({
                              ...editingTask,
                              scheduleType: e.target.value as 'daily' | 'everyDays' | 'interval',
                            })}>
                            <option value="daily">每日(北京时间)</option>
                            <option value="everyDays">每 N 天</option>
                            <option value="interval">间隔</option>
                          </select>
                          {editingTask.scheduleType === 'daily' ? (
                            <input type="time" value={editingTask.cron}
                              onChange={e => setEditingTask({ ...editingTask, cron: e.target.value })}
                              style={{ width: '110px' }} />
                          ) : editingTask.scheduleType === 'everyDays' ? (
                            <>
                              <span style={{ color: 'var(--text-dim)' }}>每</span>
                              <input type="number" min={1} value={editingTask.everyDays}
                                onChange={e => setEditingTask({ ...editingTask, everyDays: +e.target.value })}
                                style={{ width: '64px' }} />
                              <span style={{ color: 'var(--text-dim)' }}>天</span>
                              <input type="time" value={editingTask.cron}
                                onChange={e => setEditingTask({ ...editingTask, cron: e.target.value })}
                                style={{ width: '110px' }} />
                            </>
                          ) : (
                            <>
                              <input type="number" min={1} value={editingTask.intervalMinutes}
                                onChange={e => setEditingTask({ ...editingTask, intervalMinutes: +e.target.value })}
                                style={{ width: '72px' }} />
                              <span style={{ color: 'var(--text-dim)' }}>分钟</span>
                            </>
                          )}
                          <button className="btn btn-primary" onClick={saveEditSchedule}>保存</button>
                          <button className="btn" onClick={() => setEditingTask(null)}>取消</button>
                        </div>
                      ) : (
                        <span style={{ fontFamily: 'monospace' }}>{schDisplay}</span>
                      )}
                    </td>
                    <td style={{ fontSize: '0.8rem' }}>{t.modules?.join(', ')}</td>
                    <td style={{ fontSize: '0.8rem' }}>{formatBeijingTime(t.lastRunAt)}</td>
                    <td>
                      <span style={{ color: t.status === 'running' ? 'var(--warning)' : t.status === 'completed' ? 'var(--success)' : 'var(--text-dim)' }}>
                        {t.status}
                      </span>
                    </td>
                    <td>
                      <button className="btn" onClick={() => runScheduleNow(t)} disabled={running}>▶ 执行</button>
                      <button className="btn" style={{ marginLeft: '0.3rem' }} onClick={() => openTaskLog(t)}>
                        日志
                      </button>
                      <button className="btn" style={{ marginLeft: '0.3rem' }} onClick={() => startEditSchedule(t)}>编辑</button>
                      <button className="btn btn-danger" style={{ marginLeft: '0.3rem' }} onClick={() => deleteSchedule(t)}>删除</button>
                    </td>
                  </tr>
                  {taskLog?.source === 'task' && taskLog?.taskId === t.id && renderLogPanel(7)}
                  {isEditing && editingTask && (
                    <tr>
                      <td colSpan={7} style={{ background: 'var(--bg)', padding: '0.75rem' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '0.5rem' }}>
                          编辑模块参数会直接更新该定时任务；无需重建任务，也不会重启平台。
                        </div>
                        <ModuleConfigPanel
                          moduleIds={editingTask.modules}
                          configs={editingTask.config}
                          onChange={(id, c) => setEditingTask({
                            ...editingTask,
                            config: { ...editingTask.config, [id]: c },
                          })}
                        />
                        <div className="row" style={{ marginTop: '0.5rem' }}>
                          <button className="btn btn-primary" onClick={saveEditSchedule}>保存任务配置</button>
                          <button className="btn" onClick={() => setEditingTask(null)}>取消</button>
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ═══ 执行历史 ═══ */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0 }}>执行历史</h3>
          <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>
            按任务执行维度汇总；点"日志"直接查看模块明细和最近 300 条模块 log
          </span>
        </div>
        <table>
          <thead><tr><th>任务</th><th>模块链路</th><th>状态</th><th>记录</th><th>耗时</th><th>时间</th><th>操作</th></tr></thead>
          <tbody>
            {runs.map((r: any) => {
              const duration = typeof r.durationMs === 'number'
                ? `${(r.durationMs / 1000).toFixed(1)}s`
                : '-';
              return (
                <React.Fragment key={r.id}>
                  <tr>
                    <td>
                      <div>{r.taskName}</div>
                      <div style={{ color: 'var(--text-dim)', fontSize: '0.7rem', fontFamily: 'monospace' }}>{r.taskId?.slice(0, 8)}</div>
                    </td>
                    <td style={{ fontSize: '0.8rem' }}>{(r.modules || []).join(' → ')}</td>
                    <td><span style={{ color: r.status === 'completed' ? 'var(--success)' : r.status === 'failed' || r.status === 'cancelled' ? 'var(--danger)' : 'var(--warning)' }}>{r.status}</span></td>
                    <td>{r.totalResults || 0}</td>
                    <td>{duration}</td>
                    <td style={{ fontSize: '0.8rem' }}>{formatBeijingTime(r.startedAt)}</td>
                    <td>
                      <button className="btn" onClick={() => openRunLog(r)}>
                        {taskLog?.source === 'run' && taskLog?.runId === r.id ? '收起日志' : '日志'}
                      </button>
                    </td>
                  </tr>
                  {taskLog?.source === 'run' && taskLog?.runId === r.id && renderLogPanel(7)}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        {runsTotal === 0 && <p style={{ padding: '1rem', color: 'var(--text-dim)', textAlign: 'center' }}>暂无执行记录</p>}
        <Pagination page={runsPage} pageSize={runsPageSize} total={runsTotal} totalPages={runsTotalPages}
          onPageChange={setRunsPage} onPageSizeChange={s => { setRunsPageSize(s); setRunsPage(1); }} />
      </div>
    </div>
  );
}
