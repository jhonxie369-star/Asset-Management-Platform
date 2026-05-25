// ─── Asset Data Layer ───────────────────────────────────────────
/** 从一个 entry(可能是字符串或对象)提取 ip */
export function entryIp(e) {
    return typeof e === 'string' ? e : e.ip;
}
/** 把 entry 升格为 AssetListEntry(字符串则落 source=manual) */
export function entryToObject(e) {
    return typeof e === 'string' ? { ip: e, source: 'manual' } : e;
}
