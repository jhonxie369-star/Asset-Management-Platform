import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { AssetList, PortList, Task } from '@sasp/shared';
import { Store } from '../storage/store.js';
import { TaskEngine } from '../engine/task-engine.js';

export function taskRoutes(store: Store, engine: TaskEngine): Router {
  const r = Router();

  r.get('/', (req, res) => {
    let tasks = store.getAll('tasks') as Task[];
    if (req.query.scheduled === 'true') {
      tasks = tasks.filter(t => t.schedule && (t.schedule.cron || t.schedule.intervalMinutes));
    }
    const assetLists = new Map((store.getAll('assetLists') as AssetList[]).map(l => [l.id, l]));
    const portLists = new Map((store.getAll('portLists') as PortList[]).map(l => [l.id, l]));
    const data = tasks.map(task => {
      const assetListId = task.selector?.assetListId;
      const portListId = (task.config as any)?.portListId || (task as any).portListId;
      const assetList = assetListId ? assetLists.get(assetListId) : undefined;
      const portList = portListId ? portLists.get(portListId) : undefined;
      return {
        ...task,
        assetList: assetList ? {
          id: assetList.id,
          name: assetList.name,
          count: assetList.entries?.length || 0,
        } : undefined,
        portList: portList ? {
          id: portList.id,
          name: portList.name,
          count: portList.ports?.length || 0,
        } : undefined,
      };
    });
    res.json({ ok: true, data, total: data.length });
  });

  r.get('/:id', (req, res) => {
    const task = store.getById('tasks', req.params.id);
    if (!task) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, data: task });
  });

  r.post('/', (req, res) => {
    const now = new Date().toISOString();
    const task: Task = {
      id: uuid(),
      name: req.body.name || 'Unnamed Task',
      type: req.body.type || 'discovery',
      selector: req.body.selector || { mode: 'all' },
      modules: req.body.modules || ['port-discovery'],
      config: req.body.config || {},
      schedule: req.body.schedule,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    store.insert('tasks', task);
    res.status(201).json({ ok: true, data: task });
  });

  r.put('/:id', (req, res) => {
    const existing = store.getById('tasks', req.params.id) as Task | undefined;
    if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
    store.update('tasks', req.params.id, {
      name: req.body.name ?? existing.name,
      type: req.body.type ?? existing.type,
      selector: req.body.selector ?? existing.selector,
      modules: req.body.modules ?? existing.modules,
      config: req.body.config ?? existing.config,
      schedule: req.body.schedule ?? existing.schedule,
      updatedAt: new Date().toISOString(),
    });
    res.json({ ok: true, data: store.getById('tasks', req.params.id) });
  });

  r.delete('/:id', (req, res) => {
    store.delete('tasks', req.params.id);
    res.json({ ok: true });
  });

  // 执行任务
  r.post('/:id/run', async (req, res) => {
    const task = store.getById('tasks', req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
    try {
      const runs = await engine.executeTask(task);
      res.json({ ok: true, data: runs });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return r;
}
