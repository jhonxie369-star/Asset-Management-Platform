import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Asset, Service, LiveEndpoint, WebPath, WebPathRule, Task, Run, Result, Finding, FingerprintRule, ModuleDefinition, PortList, AssetList, RiskSnapshot, ApiKeyRecord, AuthAuditLog } from '@sasp/shared';

interface StoreData {
  assets: Asset[];
  liveEndpoints: LiveEndpoint[];
  services: Service[];
  webPaths: WebPath[];
  webPathRules: WebPathRule[];
  tasks: Task[];
  runs: Run[];
  results: Result[];
  findings: Finding[];
  fingerprintRules: FingerprintRule[];
  modules: ModuleDefinition[];
  portLists: PortList[];
  assetLists: AssetList[];
  riskSnapshots: RiskSnapshot[];
  apiKeys: ApiKeyRecord[];
  authAuditLogs: AuthAuditLog[];
}

const EMPTY: StoreData = {
  assets: [], liveEndpoints: [], services: [], webPaths: [], webPathRules: [], tasks: [], runs: [],
  results: [], findings: [], fingerprintRules: [], modules: [], portLists: [], assetLists: [],
  riskSnapshots: [], apiKeys: [], authAuditLogs: [],
};

const COLLECTIONS = Object.keys(EMPTY) as Array<keyof StoreData>;

type Row = { json: string };
type PageParamsLike = { page: number; pageSize: number; sortField?: string; sortDir: 'asc' | 'desc' };
type PageResult<T> = { data: T[]; total: number; page: number; pageSize: number; totalPages: number };

function fallbackId(collection: keyof StoreData, index: number): string {
  return `${String(collection)}:${index}`;
}

function timestampOf(item: any): string | undefined {
  return item.updatedAt || item.createdAt || item.lastSeenAt || item.startedAt || item.takenAt || item.firstSeenAt;
}

function likeNeedle(value: string): string {
  return `%${value.toLowerCase()}%`;
}

/**
 * SQLite-backed document store.
 *
 * The rest of the app still uses the small Store API, but persistence is row-level
 * instead of rewriting one huge store.json file on every scan result.
 */
export class Store {
  private dbPath: string;
  private jsonPath: string;
  private db!: Database.Database;
  private batchDepth = 0;

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.dbPath = process.env.SASP_SQLITE_PATH || join(dataDir, 'sasp.sqlite');
    this.jsonPath = join(dataDir, 'store.json');
  }

  async init() {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = OFF');
    this.migrateSchema();
    this.importJsonIfNeeded();
  }

  private migrateSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS store_items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT,
        UNIQUE(collection, id)
      );
      CREATE INDEX IF NOT EXISTS idx_store_items_collection ON store_items(collection, seq);
      CREATE INDEX IF NOT EXISTS idx_store_items_asset_id ON store_items(collection, json_extract(json, '$.assetId'));
      CREATE INDEX IF NOT EXISTS idx_store_items_endpoint_id ON store_items(collection, json_extract(json, '$.endpointId'));
      CREATE INDEX IF NOT EXISTS idx_store_items_service_id ON store_items(collection, json_extract(json, '$.serviceId'));
      CREATE INDEX IF NOT EXISTS idx_store_items_run_id ON store_items(collection, json_extract(json, '$.runId'));
      CREATE INDEX IF NOT EXISTS idx_store_items_dedupe_key ON store_items(collection, json_extract(json, '$.dedupeKey'));
      CREATE INDEX IF NOT EXISTS idx_store_items_ip_port ON store_items(collection, json_extract(json, '$.ip'), json_extract(json, '$.port'));
    `);
    this.db.prepare('INSERT OR IGNORE INTO store_meta(key, value) VALUES (?, ?)').run('schema_version', '1');
  }

  private importJsonIfNeeded() {
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM store_items').get() as { c: number }).c;
    const imported = this.db.prepare('SELECT value FROM store_meta WHERE key = ?').get('json_imported') as { value: string } | undefined;
    if (count > 0 || imported || !existsSync(this.jsonPath)) return;

    const loaded = JSON.parse(readFileSync(this.jsonPath, 'utf-8')) as Partial<StoreData>;
    const data = { ...EMPTY, ...loaded } as StoreData;
    const tx = this.db.transaction(() => {
      for (const collection of COLLECTIONS) {
        data[collection].forEach((item: any, index: number) => {
          const id = item.id || fallbackId(collection, index);
          const now = timestampOf(item) || new Date().toISOString();
          this.insertStmt().run(String(collection), id, JSON.stringify({ ...item, id }), now, now);
        });
      }
      this.db.prepare('INSERT OR REPLACE INTO store_meta(key, value) VALUES (?, ?)')
        .run('json_imported', new Date().toISOString());
      this.db.prepare('INSERT OR REPLACE INTO store_meta(key, value) VALUES (?, ?)')
        .run('json_imported_from', this.jsonPath);
    });
    tx();

    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM store_items').get() as { c: number }).c;
    console.log(`[store] SQLite 初始化完成: ${this.dbPath}，已从 store.json 迁移 ${total} 条记录`);
  }

  private ensureCollection(key: keyof StoreData) {
    if (!COLLECTIONS.includes(key)) throw new Error(`Unknown store collection: ${String(key)}`);
  }

  private insertStmt() {
    return this.db.prepare(`
      INSERT INTO store_items(collection, id, json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  private upsertStmt(matchKey = 'id') {
    if (matchKey !== 'id') return undefined;
    return this.db.prepare(`
      INSERT INTO store_items(collection, id, json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `);
  }

  batch<T>(fn: () => T): T {
    if (this.batchDepth > 0) {
      this.batchDepth++;
      try { return fn(); } finally { this.batchDepth--; }
    }
    const tx = this.db.transaction(() => {
      this.batchDepth++;
      try { return fn(); } finally { this.batchDepth--; }
    });
    return tx();
  }

  getAll<K extends keyof StoreData>(key: K): StoreData[K] {
    this.ensureCollection(key);
    const rows = this.db.prepare('SELECT json FROM store_items WHERE collection = ? ORDER BY seq').all(String(key)) as Row[];
    return rows.map(row => JSON.parse(row.json)) as StoreData[K];
  }

  getById<K extends keyof StoreData>(key: K, id: string): StoreData[K][number] | undefined {
    this.ensureCollection(key);
    const row = this.db.prepare('SELECT json FROM store_items WHERE collection = ? AND id = ?').get(String(key), id) as Row | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  insert<K extends keyof StoreData>(key: K, item: StoreData[K][number]) {
    this.ensureCollection(key);
    const id = (item as any).id;
    if (!id) throw new Error(`Cannot insert ${String(key)} without id`);
    const now = new Date().toISOString();
    this.insertStmt().run(String(key), id, JSON.stringify(item), now, now);
  }

  update<K extends keyof StoreData>(key: K, id: string, patch: Partial<StoreData[K][number]>) {
    this.ensureCollection(key);
    const existing = this.getById(key, id) as any;
    if (!existing) return;
    const next = { ...existing, ...patch };
    this.db.prepare('UPDATE store_items SET json = ?, updated_at = ? WHERE collection = ? AND id = ?')
      .run(JSON.stringify(next), new Date().toISOString(), String(key), id);
  }

  upsert<K extends keyof StoreData>(key: K, item: StoreData[K][number], matchKey = 'id') {
    this.ensureCollection(key);
    if (matchKey === 'id') {
      const id = (item as any).id;
      if (!id) throw new Error(`Cannot upsert ${String(key)} without id`);
      const now = new Date().toISOString();
      this.upsertStmt('id')!.run(String(key), id, JSON.stringify(item), now, now);
      return;
    }

    const existing = this.query(key, (candidate: any) => candidate[matchKey] === (item as any)[matchKey])[0] as any;
    if (existing?.id) this.update(key, existing.id, item as any);
    else this.insert(key, item);
  }

  delete<K extends keyof StoreData>(key: K, id: string) {
    this.ensureCollection(key);
    this.db.prepare('DELETE FROM store_items WHERE collection = ? AND id = ?').run(String(key), id);
  }

  query<K extends keyof StoreData>(key: K, filter: (item: StoreData[K][number]) => boolean): StoreData[K][number][] {
    return (this.getAll(key) as any[]).filter(filter) as StoreData[K][number][];
  }

  private replaceCollection<K extends keyof StoreData>(key: K, items: StoreData[K]) {
    this.ensureCollection(key);
    this.db.prepare('DELETE FROM store_items WHERE collection = ?').run(String(key));
    const stmt = this.insertStmt();
    const now = new Date().toISOString();
    for (const item of items as any[]) {
      if (!item.id) continue;
      stmt.run(String(key), item.id, JSON.stringify(item), now, now);
    }
  }

  private countAll(): Record<string, number> {
    const rows = this.db.prepare('SELECT collection, COUNT(*) AS count FROM store_items GROUP BY collection').all() as Array<{ collection: string; count: number }>;
    const counts: Record<string, number> = {};
    for (const key of COLLECTIONS) counts[String(key)] = 0;
    for (const row of rows) counts[row.collection] = row.count;
    return counts;
  }

  private jsonExpr(alias: string, field: string): string {
    if (!/^[A-Za-z0-9_]+$/.test(field)) throw new Error(`Unsafe JSON field: ${field}`);
    return `json_extract(${alias}.json, '$.${field}')`;
  }

  private pageFromRows<T>(rows: T[], total: number, params: PageParamsLike): PageResult<T> {
    const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
    const page = Math.min(params.page, totalPages);
    return { data: rows, total, page, pageSize: params.pageSize, totalPages };
  }

  pageBySql<K extends keyof StoreData>(
    key: K,
    params: PageParamsLike,
    opts: {
      where?: string[];
      bind?: any[];
      sortMap?: Record<string, string>;
      defaultOrder?: string;
    } = {},
  ): PageResult<StoreData[K][number]> {
    this.ensureCollection(key);
    const where = [`collection = ?`, ...(opts.where || [])];
    const bind = [String(key), ...(opts.bind || [])];
    const sortExpr = params.sortField ? opts.sortMap?.[params.sortField] : undefined;
    const order = sortExpr ? `${sortExpr} ${params.sortDir.toUpperCase()}` : (opts.defaultOrder || 'seq ASC');
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM store_items WHERE ${where.join(' AND ')}`).get(...bind) as { c: number }).c;
    const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
    const page = Math.min(params.page, totalPages);
    const offset = (page - 1) * params.pageSize;
    const rows = this.db.prepare(`
      SELECT json FROM store_items
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `).all(...bind, params.pageSize, offset) as Row[];
    return this.pageFromRows(rows.map(row => JSON.parse(row.json)), total, { ...params, page });
  }

  listBySql<K extends keyof StoreData>(
    key: K,
    where: string[] = [],
    bind: any[] = [],
    order = 'seq ASC',
  ): StoreData[K][number][] {
    this.ensureCollection(key);
    const rows = this.db.prepare(`
      SELECT json FROM store_items
      WHERE collection = ?${where.length ? ` AND ${where.join(' AND ')}` : ''}
      ORDER BY ${order}
    `).all(String(key), ...bind) as Row[];
    return rows.map(row => JSON.parse(row.json)) as StoreData[K][number][];
  }

  assetPage(params: PageParamsLike, filters: { q?: string; zone?: string; status?: string }): PageResult<Asset> {
    const where: string[] = [];
    const bind: any[] = [];
    if (filters.zone) { where.push(`${this.jsonExpr('store_items', 'zone')} = ?`); bind.push(filters.zone); }
    if (filters.status) { where.push(`${this.jsonExpr('store_items', 'status')} = ?`); bind.push(filters.status); }
    if (filters.q) {
      where.push(`lower(
        coalesce(${this.jsonExpr('store_items', 'ip')}, '') || ' ' ||
        coalesce(${this.jsonExpr('store_items', 'address')}, '') || ' ' ||
        coalesce(${this.jsonExpr('store_items', 'hostname')}, '') || ' ' ||
        coalesce(${this.jsonExpr('store_items', 'business')}, '') || ' ' ||
        coalesce(${this.jsonExpr('store_items', 'owner')}, '') || ' ' ||
        coalesce(${this.jsonExpr('store_items', 'instanceName')}, '') || ' ' ||
        coalesce(${this.jsonExpr('store_items', 'tags')}, '')
      ) LIKE ?`);
      bind.push(likeNeedle(filters.q));
    }
    return this.pageBySql('assets', params, {
      where, bind,
      sortMap: {
        ip: this.jsonExpr('store_items', 'ip'),
        address: this.jsonExpr('store_items', 'address'),
        hostname: this.jsonExpr('store_items', 'hostname'),
        zone: this.jsonExpr('store_items', 'zone'),
        status: this.jsonExpr('store_items', 'status'),
        riskScore: `CAST(${this.jsonExpr('store_items', 'riskScore')} AS REAL)`,
        firstSeenAt: this.jsonExpr('store_items', 'firstSeenAt'),
        lastSeenAt: this.jsonExpr('store_items', 'lastSeenAt'),
        updatedAt: this.jsonExpr('store_items', 'updatedAt'),
      },
      defaultOrder: `${this.jsonExpr('store_items', 'lastSeenAt')} DESC`,
    }) as PageResult<Asset>;
  }

  servicePage(params: PageParamsLike, filters: { q?: string; assetId?: string; protocol?: string; product?: string; instance?: string }): PageResult<Service> {
    const where: string[] = [];
    const bind: any[] = [];
    if (filters.assetId) { where.push(`${this.jsonExpr('store_items', 'assetId')} = ?`); bind.push(filters.assetId); }
    if (filters.instance) {
      const assetRows = this.listBySql('assets', [
        `lower(
          coalesce(json_extract(json, '$.instanceKey'), '') || ' ' ||
          coalesce(json_extract(json, '$.instanceName'), '') || ' ' ||
          coalesce(json_extract(json, '$.ip'), '') || ' ' ||
          coalesce(json_extract(json, '$.address'), '')
        ) LIKE ?`,
      ], [likeNeedle(filters.instance)]);
      const assetIds = assetRows.map((a: any) => a.id).filter(Boolean);
      if (assetIds.length === 0) where.push('1 = 0');
      else {
        where.push(`${this.jsonExpr('store_items', 'assetId')} IN (${assetIds.map(() => '?').join(',')})`);
        bind.push(...assetIds);
      }
    }
    if (filters.protocol) { where.push(`${this.jsonExpr('store_items', 'protocol')} = ?`); bind.push(filters.protocol); }
    if (filters.product) { where.push(`${this.jsonExpr('store_items', 'product')} = ?`); bind.push(filters.product); }
    if (filters.q) {
      where.push(`lower(
        coalesce(${this.jsonExpr('store_items', 'ip')}, '') || ' ' ||
        coalesce(${this.jsonExpr('store_items', 'host')}, '') || ' ' ||
        coalesce(${this.jsonExpr('store_items', 'port')}, '') || ' ' ||
        coalesce(${this.jsonExpr('store_items', 'protocol')}, '') || ' ' ||
        coalesce(${this.jsonExpr('store_items', 'product')}, '') || ' ' ||
        coalesce(${this.jsonExpr('store_items', 'title')}, '') || ' ' ||
        coalesce(${this.jsonExpr('store_items', 'fingerprints')}, '')
      ) LIKE ?`);
      bind.push(likeNeedle(filters.q));
    }
    return this.pageBySql('services', params, {
      where, bind,
      sortMap: {
        ip: this.jsonExpr('store_items', 'ip'),
        port: `CAST(${this.jsonExpr('store_items', 'port')} AS INTEGER)`,
        protocol: this.jsonExpr('store_items', 'protocol'),
        product: this.jsonExpr('store_items', 'product'),
        firstSeenAt: this.jsonExpr('store_items', 'firstSeenAt'),
        lastSeenAt: this.jsonExpr('store_items', 'lastSeenAt'),
      },
      defaultOrder: `${this.jsonExpr('store_items', 'lastSeenAt')} DESC`,
    }) as PageResult<Service>;
  }

  endpointPage(params: PageParamsLike, filters: {
    q?: string;
    webPath?: string;
    assetId?: string;
    protocol?: string;
    product?: string;
    scope?: string;
    instance?: string;
    hasService?: boolean;
    hasWebPath?: boolean;
    showGone?: boolean;
    withService?: boolean;
    explicitSort?: boolean;
  }): PageResult<any> {
    const showGone = !!filters.showGone;
    const endpointOnlySorts = new Set(['ip', 'port', 'firstSeenAt', 'lastSeenAt']);
    const canUseFastPath =
      !filters.q && !filters.webPath && !filters.assetId && !filters.protocol && !filters.product && !filters.scope &&
      !filters.instance && !filters.hasService && !filters.hasWebPath &&
      (!params.sortField || endpointOnlySorts.has(params.sortField));
    if (canUseFastPath) return this.endpointPageFast(params, showGone);

    const bind: any[] = [];
    const joinBind: any[] = [];
    const currentServiceCond = showGone
      ? '1 = 1'
      : `json_extract(e.json, '$.alive') = 1
         AND json_type(e.json, '$.disappearedAt') IS NULL
         AND coalesce(json_extract(s.json, '$.lastSeenAt'), '') >= coalesce(json_extract(e.json, '$.lastSeenAt'), '')`;
    const needPathCount = params.sortField === 'webPathCount' || !!filters.webPath || !!filters.hasWebPath;
    const pathSearchSql = filters.webPath
      ? `AND lower(
            coalesce(json_extract(json, '$.path'), '') || ' ' ||
            coalesce(json_extract(json, '$.url'), '') || ' ' ||
            coalesce(json_extract(json, '$.title'), '') || ' ' ||
            coalesce(json_extract(json, '$.statusCode'), '') || ' ' ||
            coalesce(json_extract(json, '$.contentType'), '') || ' ' ||
            coalesce(json_extract(json, '$.bodyPreview'), '') || ' ' ||
            coalesce(json_extract(json, '$.tags'), '')
          ) LIKE ?`
      : '';
    if (filters.webPath) joinBind.push(likeNeedle(filters.webPath));
    const pathCountJoin = needPathCount
      ? `LEFT JOIN (
          SELECT json_extract(json, '$.serviceId') AS serviceId, COUNT(*) AS webPathCount
          FROM store_items INDEXED BY idx_store_items_service_id
          WHERE collection = 'webPaths'
            AND json_type(json, '$.disappearedAt') IS NULL
            ${pathSearchSql}
          GROUP BY json_extract(json, '$.serviceId')
        ) pc ON pc.serviceId = s.id`
      : '';
    const joins = `
      LEFT JOIN store_items s INDEXED BY idx_store_items_endpoint_id
        ON s.collection = 'services'
       AND json_extract(s.json, '$.endpointId') = e.id
       AND ${currentServiceCond}
      ${pathCountJoin}
      LEFT JOIN store_items a
        ON a.collection = 'assets'
       AND a.id = json_extract(e.json, '$.assetId')
    `;
    const where = [`e.collection = 'liveEndpoints'`];
    if (filters.assetId) { where.push(`json_extract(e.json, '$.assetId') = ?`); bind.push(filters.assetId); }
    if (!showGone) where.push(`json_type(e.json, '$.disappearedAt') IS NULL`);
    if (filters.scope === 'public' || filters.scope === 'private') {
      where.push(`json_extract(a.json, '$.zone') = ?`);
      bind.push(filters.scope);
    }
    if (filters.instance) {
      where.push(`lower(
        coalesce(json_extract(a.json, '$.instanceKey'), '') || ' ' ||
        coalesce(json_extract(a.json, '$.instanceName'), '') || ' ' ||
        coalesce(json_extract(a.json, '$.instanceRole'), '') || ' ' ||
        coalesce(json_extract(a.json, '$.cloud'), '') || ' ' ||
        coalesce(json_extract(a.json, '$.ip'), '') || ' ' ||
        coalesce(json_extract(a.json, '$.address'), '') || ' ' ||
        coalesce(json_extract(e.json, '$.ip'), '') || ' ' ||
        coalesce(json_extract(e.json, '$.host'), '')
      ) LIKE ?`);
      bind.push(likeNeedle(filters.instance));
    }
    if (filters.protocol) { where.push(`json_extract(s.json, '$.protocol') = ?`); bind.push(filters.protocol); }
    if (filters.product) { where.push(`json_extract(s.json, '$.product') = ?`); bind.push(filters.product); }
    if (filters.hasService) where.push(`s.id IS NOT NULL`);
    if (filters.webPath || filters.hasWebPath) where.push(`coalesce(pc.webPathCount, 0) > 0`);
    if (filters.q) {
      where.push(`lower(
        coalesce(json_extract(e.json, '$.ip'), '') || ' ' ||
        coalesce(json_extract(e.json, '$.host'), '') || ' ' ||
        coalesce(json_extract(e.json, '$.port'), '') || ' ' ||
        coalesce(json_extract(e.json, '$.banner'), '') || ' ' ||
        coalesce(json_extract(s.json, '$.protocol'), '') || ' ' ||
        coalesce(json_extract(s.json, '$.product'), '') || ' ' ||
        coalesce(json_extract(s.json, '$.title'), '') || ' ' ||
        coalesce(json_extract(s.json, '$.fingerprints'), '')
      ) LIKE ?`);
      bind.push(likeNeedle(filters.q));
    }

    const sortMap: Record<string, string> = {
      ip: `json_extract(e.json, '$.ip')`,
      port: `CAST(json_extract(e.json, '$.port') AS INTEGER)`,
      scope: `json_extract(a.json, '$.zone')`,
      instance: `coalesce(json_extract(a.json, '$.instanceKey'), '')`,
      firstSeenAt: `json_extract(e.json, '$.firstSeenAt')`,
      lastSeenAt: `json_extract(e.json, '$.lastSeenAt')`,
      protocol: `json_extract(s.json, '$.protocol')`,
      product: `json_extract(s.json, '$.product')`,
      version: `json_extract(s.json, '$.version')`,
      title: `json_extract(s.json, '$.title')`,
      status: `CASE WHEN json_type(e.json, '$.disappearedAt') IS NOT NULL THEN 2 WHEN s.id IS NOT NULL THEN 1 ELSE 0 END`,
      webPathCount: `coalesce(pc.webPathCount, 0)`,
    };
    const sortExpr = params.sortField ? sortMap[params.sortField] : undefined;
    const defaultOrder = filters.withService && !filters.explicitSort
      ? `coalesce(json_extract(a.json, '$.instanceKey'), 'zzz-unknown:' || coalesce(json_extract(e.json, '$.ip'), '')) ASC,
         json_extract(e.json, '$.ip') ASC,
         CAST(json_extract(e.json, '$.port') AS INTEGER) ASC`
      : `json_extract(e.json, '$.lastSeenAt') DESC`;
    const order = sortExpr ? `${sortExpr} ${params.sortDir.toUpperCase()}` : defaultOrder;
    const whereSql = where.join(' AND ');
    const finalBind = [...joinBind, ...bind];
    const total = (this.db.prepare(`
      SELECT COUNT(*) AS c
      FROM store_items e
      ${joins}
      WHERE ${whereSql}
    `).get(...finalBind) as { c: number }).c;
    const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
    const page = Math.min(params.page, totalPages);
    const offset = (page - 1) * params.pageSize;
    const rows = this.db.prepare(`
      SELECT e.json AS endpointJson, s.json AS serviceJson, a.json AS assetJson
      FROM store_items e
      ${joins}
      WHERE ${whereSql}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `).all(...finalBind, params.pageSize, offset) as Array<{ endpointJson: string; serviceJson?: string; assetJson?: string }>;
    const data = rows.map(row => {
      const endpoint = JSON.parse(row.endpointJson);
      const service = row.serviceJson ? JSON.parse(row.serviceJson) : undefined;
      const asset = row.assetJson ? JSON.parse(row.assetJson) : undefined;
      return { endpoint, service, asset };
    });
    return this.pageFromRows(data, total, { ...params, page });
  }

  private endpointPageFast(params: PageParamsLike, showGone: boolean): PageResult<any> {
    const where = [`collection = ?`];
    const bind: any[] = ['liveEndpoints'];
    if (!showGone) where.push(`json_type(json, '$.disappearedAt') IS NULL`);

    const sortMap: Record<string, string> = {
      ip: `json_extract(json, '$.ip')`,
      port: `CAST(json_extract(json, '$.port') AS INTEGER)`,
      firstSeenAt: `json_extract(json, '$.firstSeenAt')`,
      lastSeenAt: `json_extract(json, '$.lastSeenAt')`,
    };
    const sortExpr = params.sortField ? sortMap[params.sortField] : undefined;
    const order = sortExpr ? `${sortExpr} ${params.sortDir.toUpperCase()}` : `json_extract(json, '$.lastSeenAt') DESC`;
    const whereSql = where.join(' AND ');
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM store_items WHERE ${whereSql}`).get(...bind) as { c: number }).c;
    const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
    const page = Math.min(params.page, totalPages);
    const offset = (page - 1) * params.pageSize;
    const endpointRows = this.db.prepare(`
      SELECT json FROM store_items
      WHERE ${whereSql}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `).all(...bind, params.pageSize, offset) as Row[];
    const endpoints = endpointRows.map(row => JSON.parse(row.json));
    if (endpoints.length === 0) return this.pageFromRows([], total, { ...params, page });

    const endpointIds = endpoints.map(e => e.id).filter(Boolean);
    const assetIds = [...new Set(endpoints.map(e => e.assetId).filter(Boolean))];
    const services = endpointIds.length > 0
      ? this.listBySql('services', [
        `${this.jsonExpr('store_items', 'endpointId')} IN (${endpointIds.map(() => '?').join(',')})`,
      ], endpointIds) as Service[]
      : [];
    const assets = assetIds.length > 0
      ? (this.db.prepare(`
        SELECT json FROM store_items
        WHERE collection = 'assets' AND id IN (${assetIds.map(() => '?').join(',')})
      `).all(...assetIds) as Row[]).map(row => JSON.parse(row.json)) as Asset[]
      : [];
    const serviceByEndpointId = new Map<string, Service>();
    for (const service of services) serviceByEndpointId.set(service.endpointId, service);
    const assetById = new Map<string, Asset>(assets.map(asset => [asset.id, asset]));
    const data = endpoints.map(endpoint => {
      const service = serviceByEndpointId.get(endpoint.id);
      const isCurrentService = service && (showGone || (
        !endpoint.disappearedAt &&
        endpoint.alive !== false &&
        String(service.lastSeenAt || '') >= String(endpoint.lastSeenAt || '')
      ));
      return {
        endpoint,
        service: isCurrentService ? service : undefined,
        asset: assetById.get(endpoint.assetId),
      };
    });
    return this.pageFromRows(data, total, { ...params, page });
  }

  pruneRetention(days: number): Record<string, number> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const before = this.countAll();
    const older = (value?: string) => !!value && new Date(value).getTime() < cutoff;

    this.batch(() => {
      this.replaceCollection('results', (this.getAll('results') as Result[]).filter(r => !older(r.createdAt)) as any);
      this.replaceCollection('runs', (this.getAll('runs') as Run[]).filter(r => !older(r.finishedAt || r.startedAt)) as any);
      this.replaceCollection('authAuditLogs', (this.getAll('authAuditLogs') as AuthAuditLog[]).filter(r => !older(r.createdAt)) as any);
      this.replaceCollection('riskSnapshots', (this.getAll('riskSnapshots') as RiskSnapshot[]).filter(r => !older(r.takenAt)) as any);
      this.replaceCollection('liveEndpoints', (this.getAll('liveEndpoints') as LiveEndpoint[]).filter(e => !older(e.disappearedAt)) as any);

      const endpoints = this.getAll('liveEndpoints') as LiveEndpoint[];
      const endpointIds = new Set(endpoints.map(e => e.id));
      const services = (this.getAll('services') as Service[]).filter(s => endpointIds.has(s.endpointId) && !older(s.lastSeenAt));
      this.replaceCollection('services', services as any);

      const serviceIds = new Set(services.map(s => s.id));
      this.replaceCollection('webPaths', (this.getAll('webPaths') as WebPath[]).filter((p: any) => serviceIds.has(p.serviceId) && !older(p.disappearedAt)) as any);

      const liveAssetIds = new Set(endpoints.map(e => e.assetId));
      this.replaceCollection('assets', (this.getAll('assets') as Asset[]).filter(a =>
        liveAssetIds.has(a.id) || !older(a.lastSeenAt) || !['decommissioned'].includes(a.status)
      ) as any);
      this.replaceCollection('findings', (this.getAll('findings') as Finding[]).filter(f =>
        f.status === 'open' || f.status === 'confirmed' || !older(f.resolvedAt || f.lastSeenAt)
      ) as any);
    });

    const after = this.countAll();
    return Object.fromEntries(Object.keys(before).map(k => [k, before[k] - (after[k] || 0)]));
  }
}
