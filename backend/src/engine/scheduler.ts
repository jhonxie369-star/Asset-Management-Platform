import type { Task, AssetList } from '@sasp/shared';
import { Store } from '../storage/store.js';
import { TaskEngine } from './task-engine.js';
import { syncCloudquery, cloudqueryConfigured } from '../sources/cloudquery.js';
import { takeRiskSnapshot } from '../http/misc.js';
import { appConfig } from '../config/app.js';

const SCHEDULE_TIME_ZONE = 'Asia/Shanghai';

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
}

/**
 * 简易定时调度器：
 * - 每 30 秒检查一次所有启用了 schedule 的 Task 与 autoSync 的 AssetList
 * - cron 格式支持 HH:mm（每日或每 N 天,按 Asia/Shanghai 解释）和 intervalMinutes（每 N 分钟）
 * - 到点执行对应 Task / 从 CloudQuery 同步 AssetList
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  private lastRunMinute = new Map<string, string>();
  private deferredTaskIds = new Set<string>();
  private lastDeferLogMinute: string | null = null;
  private syncing = new Set<string>();
  private lastSyncMinute = new Map<string, string>();

  constructor(private store: Store, private engine: TaskEngine) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(err => console.error('[scheduler]', err)), 30_000);
    console.log('[scheduler] started');
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async tick() {
    const now = new Date();
    const zoned = getZonedParts(now);
    const minuteKey = `${zoned.year}-${zoned.month}-${zoned.day}T${String(zoned.hour).padStart(2, '0')}:${String(zoned.minute).padStart(2, '0')}`;

    await this.tickTasks(now, zoned, minuteKey);
    await this.tickAssetListSync(now, zoned, minuteKey);
    this.tickRiskSnapshot(zoned, minuteKey);
    this.tickRetention(zoned, minuteKey);
  }

  private lastSnapshotMinute: string | null = null;
  private tickRiskSnapshot(now: ZonedParts, minuteKey: string) {
    // 每日 00:05 抓一次(避开 cron 整点拥挤);进程内幂等
    if (now.hour !== 0 || now.minute !== 5) return;
    if (this.lastSnapshotMinute === minuteKey) return;
    this.lastSnapshotMinute = minuteKey;
    try {
      const r = takeRiskSnapshot(this.store);
      console.log(`[scheduler] risk snapshot taken: ${r.taken} 台机器 @ ${r.date}`);
    } catch (err) {
      console.error('[scheduler] risk snapshot failed:', err);
    }
  }

  private lastRetentionMinute: string | null = null;
  private tickRetention(now: ZonedParts, minuteKey: string) {
    // 每日 00:15 清理超过保留期的历史/消失态数据;在线 current-state 不清。
    if (now.hour !== 0 || now.minute !== 15) return;
    if (this.lastRetentionMinute === minuteKey) return;
    this.lastRetentionMinute = minuteKey;
    try {
      const removed = this.store.pruneRetention(appConfig.retentionDays);
      console.log(`[scheduler] retention ${appConfig.retentionDays}d pruned: ${JSON.stringify(removed)}`);
    } catch (err) {
      console.error('[scheduler] retention failed:', err);
    }
  }

  private async tickTasks(now: Date, zoned: ZonedParts, minuteKey: string) {
    const tasks = this.store.getAll('tasks') as Task[];
    const due: Task[] = [];

    for (const task of tasks) {
      const sch = task.schedule;
      if (!sch) continue;
      if (task.status === 'running') continue;
      if (this.running.has(task.id)) continue;
      if (this.lastRunMinute.get(task.id) === minuteKey && !this.deferredTaskIds.has(task.id)) continue;

      let shouldRun = this.deferredTaskIds.has(task.id);

      if (!shouldRun && sch.cron && /^\d{1,2}:\d{2}$/.test(sch.cron)) {
        shouldRun = isCronTaskDue(task, now, zoned);
      } else if (!shouldRun && sch.intervalMinutes && sch.intervalMinutes > 0) {
        const last = task.lastRunAt ? new Date(task.lastRunAt).getTime() : 0;
        if (now.getTime() - last >= sch.intervalMinutes * 60_000) shouldRun = true;
      }

      if (shouldRun) {
        this.deferredTaskIds.add(task.id);
        this.lastRunMinute.set(task.id, minuteKey);
        due.push(task);
      }
    }

    if (due.length === 0) return;

    const anyTaskRunning = this.running.size > 0 || tasks.some(t => t.status === 'running');
    if (anyTaskRunning) {
      if (this.lastDeferLogMinute !== minuteKey) {
        this.lastDeferLogMinute = minuteKey;
        console.log(`[scheduler] ${due.length} 个定时任务等待中,已有任务运行,稍后顺延`);
      }
      return;
    }

    // 全局串行:一次只启动一个定时任务,其他 due 任务留在 deferredTaskIds,下个 tick 顺延。
    due.sort((a, b) => scheduleOrder(a).localeCompare(scheduleOrder(b)));
    const task = due[0];
    this.deferredTaskIds.delete(task.id);
    this.running.add(task.id);
    console.log(`[scheduler] executing task ${task.name} (${task.id.slice(0, 8)})`);
    this.engine.executeTask(task)
      .then(runs => console.log(`[scheduler] task ${task.name} done, ${runs.length} runs`))
      .catch(err => console.error(`[scheduler] task ${task.name} failed:`, err))
      .finally(() => this.running.delete(task.id));
  }

  private async tickAssetListSync(now: Date, zoned: ZonedParts, minuteKey: string) {
    const anyTaskRunning = this.running.size > 0 || (this.store.getAll('tasks') as Task[]).some(t => t.status === 'running');
    if (anyTaskRunning) return;

    const lists = this.store.getAll('assetLists') as AssetList[];
    for (const list of lists) {
      const s = list.autoSync;
      if (!s || !s.enabled) continue;
      if (this.syncing.has(list.id)) continue;
      if (this.syncing.size > 0) continue;
      if (this.lastSyncMinute.get(list.id) === minuteKey) continue;

      let shouldRun = false;
      if (s.cron && /^\d{1,2}:\d{2}$/.test(s.cron)) {
        const [h, m] = s.cron.split(':').map(Number);
        if (zoned.hour === h && zoned.minute === m) shouldRun = true;
        else {
          const scheduledAt = zonedDailyUtcMs(zoned, h, m);
          const last = s.lastSyncedAt ? new Date(s.lastSyncedAt).getTime() : 0;
          // 如果服务在当天 cron 时间之后才启动，补跑一次当天同步，避免错过台账刷新。
          if (now.getTime() > scheduledAt && last < scheduledAt) shouldRun = true;
        }
      } else if (s.intervalMinutes && s.intervalMinutes > 0) {
        const last = s.lastSyncedAt ? new Date(s.lastSyncedAt).getTime() : 0;
        if (now.getTime() - last >= s.intervalMinutes * 60_000) shouldRun = true;
      }
      if (!shouldRun) continue;

      if (!cloudqueryConfigured()) {
        console.warn(`[scheduler] assetList ${list.name}: cloudquery PG 未配置,跳过`);
        continue;
      }

      this.syncing.add(list.id);
      this.lastSyncMinute.set(list.id, minuteKey);
      console.log(`[scheduler] syncing assetList ${list.name} (strategy=${s.strategy})`);
      syncCloudquery(s.strategy)
        .then(result => {
          if (result.entries.length === 0) {
            // 保留旧 entries,只更新状态
            this.store.update('assetLists', list.id, {
              autoSync: {
                ...s,
                lastSyncedAt: new Date().toISOString(),
                lastStatus: 'failed',
                lastError: '同步结果为空,保留旧 entries',
              },
              updatedAt: new Date().toISOString(),
            });
            console.warn(`[scheduler] assetList ${list.name}: 同步结果为空`);
            return;
          }
          this.store.update('assetLists', list.id, {
            entries: result.entries,
            autoSync: {
              ...s,
              lastSyncedAt: new Date().toISOString(),
              lastStatus: 'ok',
              lastError: undefined,
              lastEntriesCount: result.entries.length,
            },
            updatedAt: new Date().toISOString(),
          });
          console.log(`[scheduler] assetList ${list.name} synced: ${result.entries.length} assets`);
        })
        .catch(err => {
          // 失败保留旧 entries
          this.store.update('assetLists', list.id, {
            autoSync: {
              ...s,
              lastSyncedAt: new Date().toISOString(),
              lastStatus: 'failed',
              lastError: String(err?.message || err).slice(0, 200),
            },
            updatedAt: new Date().toISOString(),
          });
          console.error(`[scheduler] assetList ${list.name} sync failed:`, err);
        })
        .finally(() => this.syncing.delete(list.id));
    }
  }

  triggerNow() { return this.tick(); }
}

function scheduleOrder(task: Task): string {
  const sch = task.schedule;
  if (sch?.cron) return `0:${sch.cron}:${String(sch.everyDays || 1).padStart(4, '0')}:${task.name}`;
  if (sch?.intervalMinutes) return `1:${String(sch.intervalMinutes).padStart(8, '0')}:${task.name}`;
  return `2:${task.name}`;
}

function isCronTaskDue(task: Task, now: Date, zoned: ZonedParts): boolean {
  const sch = task.schedule;
  if (!sch?.cron) return false;
  const [h, m] = sch.cron.split(':').map(Number);
  const everyDays = Math.max(1, Math.floor(Number(sch.everyDays || 1)));
  const scheduledAt = zonedDailyUtcMs(zoned, h, m);
  const isAtScheduledMinute = zoned.hour === h && zoned.minute === m;

  if (everyDays <= 1) return isAtScheduledMinute;

  const lastMs = task.lastRunAt ? new Date(task.lastRunAt).getTime() : 0;
  if (!lastMs) return isAtScheduledMinute;

  const lastZoned = getZonedParts(new Date(lastMs));
  const daysSinceLastRun = daysBetweenLocalDates(lastZoned, zoned);
  if (daysSinceLastRun < everyDays) return false;

  // 到点运行；如果上一个长任务跨过了到点时间，完成后在当天补跑一次，形成顺延而不是重叠。
  if (isAtScheduledMinute) return true;
  return now.getTime() > scheduledAt && lastMs < scheduledAt;
}

function daysBetweenLocalDates(a: ZonedParts, b: ZonedParts): number {
  const left = Date.UTC(Number(a.year), Number(a.month) - 1, Number(a.day));
  const right = Date.UTC(Number(b.year), Number(b.month) - 1, Number(b.day));
  return Math.floor((right - left) / 86_400_000);
}

function getZonedParts(date: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHEDULE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string) => parts.find(p => p.type === type)?.value || '00';
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
  };
}

function zonedDailyUtcMs(zoned: ZonedParts, hour: number, minute: number): number {
  // Asia/Shanghai 固定 UTC+8，无夏令时。
  return Date.UTC(Number(zoned.year), Number(zoned.month) - 1, Number(zoned.day), hour - 8, minute, 0, 0);
}
