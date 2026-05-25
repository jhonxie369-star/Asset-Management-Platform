import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// 优先加载项目根目录的 .env
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) dotenv.config({ path: envPath });

function parseUsers(): Array<{ username: string; password: string }> {
  const multi = process.env.SASP_USERS;
  if (multi) {
    return multi.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
      const [u, p] = pair.split(':');
      return { username: u, password: p || '' };
    });
  }
  const u = process.env.SASP_USERNAME;
  const p = process.env.SASP_PASSWORD;
  if (u && p) return [{ username: u, password: p }];
  return [];
}

export const appConfig = {
  port: Number(process.env.PORT || 3400),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || './backend/data',
  modulesDir: process.env.MODULES_DIR || './modules',
  retentionDays: Number(process.env.SASP_RETENTION_DAYS || 90),
  auth: {
    users: parseUsers(),
    sessionSecret: process.env.SASP_SESSION_SECRET || 'sasp-default-secret-change-me',
    sessionMaxAge: 1000 * 60 * 60 * 12, // 12h
    disabled: (process.env.SASP_AUTH_DISABLED || '').toLowerCase() === 'true',
  },
  sources: {
    cloudquery: {
      // 推荐整串:CLOUDQUERY_PG_URL=postgresql://user@host:port/db
      // 或拆字段 CLOUDQUERY_PG_HOST/PORT/USER/PASSWORD/DATABASE
      url: process.env.CLOUDQUERY_PG_URL || '',
      host: process.env.CLOUDQUERY_PG_HOST || '',
      port: Number(process.env.CLOUDQUERY_PG_PORT || 5432),
      user: process.env.CLOUDQUERY_PG_USER || '',
      password: process.env.CLOUDQUERY_PG_PASSWORD || '',
      database: process.env.CLOUDQUERY_PG_DATABASE || '',
      // 白名单文件(每行一条 CIDR,# 注释)
      reachableCidrsFile: process.env.CLOUDQUERY_REACHABLE_CIDRS_FILE
        || resolve(process.cwd(), 'backend/data/reachable-cidrs.txt'),
    },
  },
};
