import { join } from 'path';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { appConfig } from '../config/app.js';
import { Store } from '../storage/store.js';
import { TaskEngine } from '../engine/task-engine.js';
import { assetRoutes } from './assets.js';
import { serviceRoutes } from './services.js';
import { taskRoutes } from './tasks.js';
import { findingRoutes, runRoutes, webPathRoutes, dashboardRoutes, fingerprintStatRoutes } from './misc.js';
import { portListRoutes } from './port-lists.js';
import { assetListRoutes } from './asset-lists.js';
import { sourceRoutes } from './sources.js';
import { endpointRoutes } from './endpoints.js';
import { authRoutes, requireAuth } from './auth.js';
import { apiKeyRoutes } from './api-keys.js';
import { aiRoutes } from './ai.js';
import { webPathRuleRoutes } from './web-path-rules.js';

export function createApp(store: Store, engine: TaskEngine): express.Application {
  const app = express();
  app.use(cors({ credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(session({
    name: 'sasp.sid',
    secret: appConfig.auth.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: appConfig.auth.sessionMaxAge,
    },
  }));

  // 认证相关放最前(需要在 requireAuth 之前)
  app.use('/api/auth', authRoutes());

  // 所有 /api/* 走鉴权(auth 路由已自行放行)
  app.use('/api', requireAuth(store));

  app.use('/api/dashboard', dashboardRoutes(store));
  app.use('/api/assets', assetRoutes(store));
  app.use('/api/services', serviceRoutes(store));
  app.use('/api/endpoints', endpointRoutes(store));
  app.use('/api/fingerprint-stats', fingerprintStatRoutes(store));
  app.use('/api/tasks', taskRoutes(store, engine));
  app.use('/api/findings', findingRoutes(store));
  app.use('/api/runs', runRoutes(store));
  app.use('/api/web-paths', webPathRoutes(store));
  app.use('/api/web-path-rules', webPathRuleRoutes(store));
  app.use('/api/port-lists', portListRoutes(store));
  app.use('/api/asset-lists', assetListRoutes(store));
  app.use('/api/sources', sourceRoutes(store));
  app.use('/api/api-keys', apiKeyRoutes(store));
  app.use('/api/ai', aiRoutes(store));
  app.use('/api/modules', (req, res) => {
    res.json({ ok: true, data: engine.getModules().map(m => m.definition) });
  });

  // 静态文件 (前端 build) + SPA fallback
  const staticPath = join(process.cwd(), 'frontend/dist');
  app.use(express.static(staticPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(join(staticPath, 'index.html'));
    }
  });

  return app;
}
