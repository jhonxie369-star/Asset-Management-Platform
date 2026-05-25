export type AssetStatus = 'discovered' | 'confirmed' | 'monitored' | 'decommissioned';
export type AssetZone = 'public' | 'private';
export type AssetSource = 'manual' | 'imported' | 'discovery' | 'api';
export type AssetKind = 'ip' | 'domain' | 'db_endpoint';
export interface Asset {
    id: string;
    /** 兼容旧字段: IP 资产为 IP；domain/db_endpoint 资产为 endpoint hostname */
    ip: string;
    assetKind?: AssetKind;
    /** 规范地址: IP / 域名 / RDS endpoint。未填时等于 ip */
    address?: string;
    hostname?: string;
    zone: AssetZone;
    status: AssetStatus;
    owner?: string;
    business?: string;
    tags: string[];
    source: AssetSource;
    riskScore: number;
    firstSeenAt: string;
    lastSeenAt: string;
    updatedAt: string;
    /**
     * 机器/LB 实体 key,把同一机器的多个 IP 绑在一起。
     * 格式:'<cloud>:<role>:<id>',例:'alicloud:ecs:i-t4n5...', 'alicloud:slb:lb-xxx','aws:ecs:i-0567...'
     * 填充时机:cloudquery sync 时一次性从云数据源读出
     */
    instanceKey?: string;
    instanceRole?: 'ecs' | 'lb' | 'eip' | 'nat' | 'nic' | 'rds' | 'db';
    instanceName?: string;
    cloud?: 'alicloud' | 'aws' | 'tencentcloud' | 'huaweicloud';
    /** RDS/云数据库等端点资产字段 */
    endpointPort?: number;
    endpointProtocol?: ServiceProtocol;
    cloudProduct?: 'rds' | 'redis' | 'mongodb' | 'postgres' | 'mysql' | 'other';
    resolvedIps?: string[];
    lastResolvedAt?: string;
}
/**
 * LiveEndpoint: "这个 ip:port 开着"
 * 由 port-discovery 产出。只表示端口活着，不代表有可识别的服务。
 */
export interface LiveEndpoint {
    id: string;
    assetId: string;
    /** 兼容旧字段: 可为 IP 或 hostname */
    ip: string;
    host?: string;
    resolvedIp?: string;
    resolvedIps?: string[];
    port: number;
    alive: boolean;
    banner?: string;
    firstSeenAt: string;
    lastSeenAt: string;
    disappearedAt?: string;
}
export type ServiceProtocol = 'http' | 'https' | 'ssh' | 'ftp' | 'tcp' | 'unknown' | 'mysql' | 'redis' | 'postgres' | 'mongodb' | 'cassandra' | 'aerospike' | 'hbase' | 'clickhouse' | 'elasticsearch' | 'mssql' | 'oracle' | 'memcached' | 'zookeeper' | 'neo4j' | 'etcd' | 'rabbitmq' | 'kafka' | 'tidb' | 'oceanbase' | 'opensearch' | 'solr' | 'rocketmq' | 'pulsar' | 'doris' | 'trino' | 'presto' | 'hive' | 'hdfs' | 'consul' | 'nacos';
export interface ServiceFingerprint {
    name: string;
    version?: string;
    confidence: number;
    source: string;
}
/**
 * Service: "这个 ip:port 上有什么服务"
 * 由 fingerprint 模块产出（基于 LiveEndpoint + HTTP 探测/规则匹配）。
 * 是 LiveEndpoint 的丰满版：带 protocol/product/version/title/指纹等。
 */
export interface Service {
    id: string;
    endpointId: string;
    assetId: string;
    /** 兼容旧字段: 可为 IP 或 hostname */
    ip: string;
    host?: string;
    resolvedIp?: string;
    resolvedIps?: string[];
    port: number;
    protocol: ServiceProtocol;
    product?: string;
    version?: string;
    title?: string;
    fingerprints: ServiceFingerprint[];
    riskScore: number;
    firstSeenAt: string;
    lastSeenAt: string;
}
export interface WebPath {
    id: string;
    serviceId: string;
    url: string;
    path: string;
    statusCode: number;
    title?: string;
    contentLength?: number;
    contentType?: string;
    location?: string;
    bodyPreview?: string;
    /** real = 通过真实性验证；suspected = 疑似误报（baseline/关键字/长度命中） */
    verified?: 'real' | 'suspected' | 'unknown';
    verifyReasons?: string[];
    source: string;
    tags: string[];
    usefulForAI: boolean;
    firstSeenAt: string;
    lastSeenAt: string;
    disappearedAt?: string;
}
export interface WebPathRuleMatch {
    pathRegex?: string;
    pathContainsAny?: string[];
    statusCodes?: number[];
    contentTypeIncludes?: string[];
    titleContainsAny?: string[];
    bodyContainsAny?: string[];
    bodyRegex?: string;
}
export interface WebPathRule {
    id: string;
    name: string;
    enabled: boolean;
    builtin?: boolean;
    type: 'sensitive_path' | 'exposure';
    severity: FindingSeverity;
    category?: 'sensitive_leak' | 'admin_entry' | 'api_doc' | 'metrics' | 'debug' | 'other';
    match: WebPathRuleMatch;
    description?: string;
    recommendation?: string;
    createdAt: string;
    updatedAt: string;
}
export type TaskType = 'discovery' | 'fingerprint' | 'dirsearch' | 'weak_password' | 'inspection' | 'ai_test';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface TaskTargetSelector {
    mode: 'all' | 'by_zone' | 'by_ids' | 'by_query' | 'by_list';
    zone?: AssetZone;
    assetIds?: string[];
    assetListId?: string;
    serviceFilter?: {
        protocol?: ServiceProtocol[];
        portRange?: [number, number];
    };
    assetFilter?: {
        assetKinds?: AssetKind[];
        q?: string;
        tags?: string[];
    };
}
export interface Task {
    id: string;
    name: string;
    type: TaskType;
    selector: TaskTargetSelector;
    modules: string[];
    config: Record<string, unknown>;
    schedule?: {
        cron?: string;
        intervalMinutes?: number;
        everyDays?: number;
    };
    status: TaskStatus;
    createdAt: string;
    updatedAt: string;
    lastRunAt?: string;
}
export interface Run {
    id: string;
    /** 同一次任务执行的分组 ID；一个任务可串行产出多个模块 Run */
    taskRunId?: string;
    taskId: string;
    taskName?: string;
    moduleId: string;
    status: RunStatus;
    targetSnapshot: string[];
    configSnapshot: Record<string, unknown>;
    counters: {
        total: number;
        success: number;
        failed: number;
    };
    startedAt: string;
    finishedAt?: string;
    error?: string;
}
/**
 * Result 是统一的历史证据。通过 resultType 区分语义：
 *
 *   endpoint_alive   → 活端点发现        (port-discovery 输出)
 *   service_identified → 服务识别/指纹   (fingerprint 输出)
 *   web_path         → 路径发现          (dirsearch 输出)
 *   finding          → 问题发现
 *   change           → 变化检测
 *   log / error      → 执行日志
 */
export type ResultType = 'endpoint_alive' | 'service_identified' | 'web_path' | 'finding' | 'change' | 'log' | 'error';
export interface Result {
    id: string;
    runId: string;
    moduleId: string;
    assetId?: string;
    endpointId?: string;
    serviceId?: string;
    resultType: ResultType;
    data: Record<string, unknown>;
    evidence?: string;
    createdAt: string;
}
export type FindingType = 'weak_password' | 'unauth' | 'anonymous_login' | 'default_credential' | 'plaintext_protocol' | 'auth_exposure' | 'exposure' | 'dangerous_fingerprint' | 'sensitive_path' | 'new_endpoint' | 'new_service' | 'endpoint_gone' | 'fingerprint_change' | 'config_drift';
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'open' | 'confirmed' | 'resolved' | 'ignored';
export interface Finding {
    id: string;
    assetId: string;
    endpointId?: string;
    serviceId?: string;
    webPathId?: string;
    type: FindingType;
    severity: FindingSeverity;
    status: FindingStatus;
    title: string;
    description?: string;
    evidence?: string;
    recommendation?: string;
    credentials?: {
        username?: string;
        password?: string;
        passwordMasked?: string;
        passwordEmpty?: boolean;
    };
    dedupeKey: string;
    firstSeenAt: string;
    lastSeenAt: string;
    resolvedAt?: string;
}
export type ModuleCategory = 'recon' | 'fingerprint' | 'bruteforce' | 'audit' | 'ai';
export type ModuleTargetType = 'asset' | 'endpoint' | 'service' | 'web_path';
export type ModuleRiskLevel = 'passive' | 'safe_active' | 'intrusive';
export interface ModuleDefinition {
    id: string;
    name: string;
    category: ModuleCategory;
    targetType: ModuleTargetType;
    targetFilter?: Record<string, unknown>;
    riskLevel: ModuleRiskLevel;
    configSchema?: Record<string, unknown>;
    description?: string;
}
export interface FingerprintRule {
    id: string;
    name: string;
    product: string;
    category?: 'database' | 'middleware' | 'webserver' | 'cms' | 'framework' | 'devops' | 'monitoring' | 'other';
    matchers: FingerprintMatcher[];
    /** 匹配策略：any = 任一 matcher 命中即算匹配；all = 全部命中 */
    matchMode?: 'any' | 'all';
    /** 探测层级：越小越早跑，命中就短路。L0=banner, L2=bannerMatch, L3=http/dbHandshake, L4=favicon, L5=cert */
    priority?: number;
    severity?: FindingSeverity;
    tags: string[];
    enabled: boolean;
    source?: 'builtin' | 'user';
}
export interface FingerprintMatcher {
    /** banner=TCP 首包；header=HTTP header；body=HTTP body；title=<title>；favicon=mmh3(32)；cert=TLS subject/issuer */
    type: 'banner' | 'header' | 'body' | 'title' | 'favicon' | 'cert';
    field?: string;
    /** 正则（大多数 type）或 favicon 哈希（type=favicon 时是整数字符串） */
    pattern: string;
    flags?: string;
    /** 版本提取：从 pattern 的捕获组里取第 N 组（1 起）作为 version */
    versionGroup?: number;
}
export interface PortList {
    id: string;
    name: string;
    description?: string;
    ports: number[];
    builtin: boolean;
    createdAt: string;
    updatedAt: string;
}
/**
 * AssetList 条目:可以是纯字符串 IP(手动粘贴),也可以是结构化对象(cloudquery 同步时自动生成)。
 * 扫描引擎只需要 ip 字段;其他字段用于 UI 展示与数据沉淀。
 */
export interface AssetListEntry {
    ip: string;
    assetKind?: AssetKind;
    address?: string;
    endpointPort?: number;
    endpointProtocol?: ServiceProtocol;
    cloudProduct?: 'rds' | 'redis' | 'mongodb' | 'postgres' | 'mysql' | 'other';
    hostname?: string;
    /** 机器/LB 归属 key,同一机器的多 IP 共享,格式 '<cloud>:<role>:<resourceId>' */
    instanceKey?: string;
    instanceRole?: 'ecs' | 'lb' | 'eip' | 'nat' | 'nic' | 'rds' | 'db';
    instanceName?: string;
    cloud?: 'alicloud' | 'aws' | 'tencentcloud' | 'huaweicloud';
    /** 同步时标注的可达性:public 或 private(白名单内) */
    scope?: 'public' | 'private';
    /** 来源:manual=用户手工粘贴,cloudquery=从 cloudquery 同步 */
    source?: 'manual' | 'cloudquery';
}
/** 机器风险演化快照:每日由 scheduler 抓取,用于绘制趋势 */
export interface RiskSnapshot {
    id: string;
    takenAt: string;
    date: string;
    instanceKey: string;
    cloud?: string;
    instanceName?: string;
    score: number;
    bySeverity: Record<string, number>;
    findingCount: number;
}
export interface ApiKeyRecord {
    id: string;
    keyId: string;
    name: string;
    keyHash: string;
    scopes: string[];
    createdBy?: string;
    createdAt: string;
    lastUsedAt?: string;
    revokedAt?: string;
}
export interface AuthAuditLog {
    id: string;
    actorType: 'session' | 'api_key' | 'system';
    actorId?: string;
    action: string;
    target?: string;
    ok: boolean;
    message?: string;
    createdAt: string;
}
export interface AssetList {
    id: string;
    name: string;
    description?: string;
    /** 入库可能是纯字符串或结构化对象;读代码前请用 `entryToIp` / `toEntries` helper 统一 */
    entries: Array<string | AssetListEntry>;
    builtin: boolean;
    createdAt: string;
    updatedAt: string;
    /** 自动同步:每 N 分钟或每日 HH:mm 从 CloudQuery 拉取并覆盖 entries */
    autoSync?: {
        enabled: boolean;
        strategy: 'db-scan' | 'all-ip' | 'public' | 'private' | 'db-endpoints';
        cron?: string;
        intervalMinutes?: number;
        lastSyncedAt?: string;
        lastStatus?: 'ok' | 'failed';
        lastError?: string;
        lastEntriesCount?: number;
    };
}
/** 从一个 entry(可能是字符串或对象)提取 ip */
export declare function entryIp(e: string | AssetListEntry): string;
/** 把 entry 升格为 AssetListEntry(字符串则落 source=manual) */
export declare function entryToObject(e: string | AssetListEntry): AssetListEntry;
export interface ApiResponse<T> {
    ok: boolean;
    data: T;
    error?: string;
}
export interface PaginatedResponse<T> {
    ok: boolean;
    data: T[];
    total: number;
    page: number;
    pageSize: number;
}
export interface DashboardStats {
    assetCount: number;
    endpointCount: number;
    serviceCount: number;
    findingCount: number;
    openFindingCount: number;
    moduleCount: number;
    recentRuns: Run[];
    topRisks: Finding[];
    assetsByZone: {
        public: number;
        private: number;
    };
}
