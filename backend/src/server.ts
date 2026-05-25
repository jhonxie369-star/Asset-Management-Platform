import { appConfig } from './config/app.js';
import { Store } from './storage/store.js';
import { EnrichmentPipeline } from './pipeline/enrichment.js';
import { TaskEngine } from './engine/task-engine.js';
import {
  PortDiscoveryModule, FingerprintModule, WeakPasswordModule, DirsearchModule, DbEndpointProbeModule,
} from './modules/index.js';
import { getBuiltinFingerprintRules } from './modules/fingerprints/index.js';
import { createApp } from './http/app.js';
import { Scheduler } from './engine/scheduler.js';
import type { FingerprintRule, Run, Task } from '@sasp/shared';

async function main() {
  const store = new Store(appConfig.dataDir);
  await store.init();
  markInterruptedExecutions(store);

  // 种子内置指纹规则（幂等 upsert by id）
  const existing = store.getAll('fingerprintRules') as FingerprintRule[];
  const existingIds = new Set(existing.filter(r => r.source === 'builtin').map(r => r.id));
  const builtin = getBuiltinFingerprintRules();
  let added = 0, updated = 0;
  for (const rule of builtin) {
    if (existingIds.has(rule.id)) {
      store.upsert('fingerprintRules', rule);
      updated++;
    } else {
      store.insert('fingerprintRules', rule);
      added++;
    }
  }
  console.log(`[SASP] 指纹规则：内置 ${builtin.length} 条（新增 ${added}，更新 ${updated}），用户自定义 ${existing.filter(r => r.source !== 'builtin').length} 条`);

  const pipeline = new EnrichmentPipeline(store);
  const engine = new TaskEngine(store, pipeline);

  engine.registerModule(new PortDiscoveryModule());
  engine.registerModule(new DbEndpointProbeModule());
  engine.registerModule(new FingerprintModule(store));
  engine.registerModule(new WeakPasswordModule(store));
  engine.registerModule(new DirsearchModule(store));

  const scheduler = new Scheduler(store, engine);
  scheduler.start();

  const app = createApp(store, engine);
  app.listen(appConfig.port, appConfig.host, () => {
    console.log(`[SASP] 安全资产扫描平台启动: http://${appConfig.host}:${appConfig.port}`);
    console.log(`[SASP] 已注册模块: ${engine.getModules().map(m => m.definition.id).join(', ')}`);
    if (appConfig.auth.disabled) {
      console.log('[SASP] ⚠ 登录认证已禁用(SASP_AUTH_DISABLED=true)');
    } else if (appConfig.auth.users.length === 0) {
      console.log('[SASP] ⚠ 未配置登录账户,API 将全部返回 401。请在 .env 设置 SASP_USERNAME / SASP_PASSWORD');
    } else {
      console.log(`[SASP] 登录账户数: ${appConfig.auth.users.length}`);
    }
  });
}

main().catch(err => { console.error(err); process.exit(1); });

function markInterruptedExecutions(store: Store) {
  const now = new Date().toISOString();
  let runs = 0;
  for (const run of store.getAll('runs') as Run[]) {
    if (run.status !== 'running' && run.status !== 'queued') continue;
    store.update('runs', run.id, {
      status: 'cancelled',
      finishedAt: now,
      error: '服务重启，中断未完成的执行',
    });
    runs++;
  }

  let tasks = 0;
  for (const task of store.getAll('tasks') as Task[]) {
    if (task.status !== 'running') continue;
    store.update('tasks', task.id, { status: 'cancelled', updatedAt: now });
    tasks++;
  }

  if (runs > 0 || tasks > 0) {
    console.log(`[SASP] 已标记中断执行: runs=${runs}, tasks=${tasks}`);
  }
}
