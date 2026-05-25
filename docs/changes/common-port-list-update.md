# Common Port List Update

Date: 2026-05-15

## Change

通过平台 API 更新运行时配置 `常见端口`，没有直接改 `store.json`，也没有硬编码到代码。

- API: `PUT /api/port-lists/:id`
- List: `常见端口`
- List ID: `463bc2b0-4f16-45db-90f9-4c74c02fae93`
- Old count: 14
- New count: 211

## Why

原 `常见端口` 只有少量 Web/DB 端口，覆盖不足。需要纳入用户给出的常见服务端口，并补充数据库/中间件/管理面的常见变异端口，作为 `port-discovery` 基础巡检端口列表。

## Important Correction

第一次按用户提供端口更新时，由于输入列表里没有 `22`，导致原列表中的 SSH 端口被移除。随后立即通过 API 补回 `22`。

当前列表已确认：

- `21` FTP included
- `22` SSH included
- `23` Telnet included
- `3306/3307/3308/33060` MySQL variants included
- `5432/5433` PostgreSQL variants included
- `6379/6380/16379/26379` Redis/Sentinel variants included
- `27017/27018/27019/28017` MongoDB variants included
- `9200/9201/9300` Elasticsearch variants included
- `9042/9142/9160` Cassandra variants included
- `5984/5986` CouchDB variants included
- `8086` InfluxDB included
- `8123/8443/9000/9009/9010` ClickHouse/HTTP variants included
- `11211/11212` Memcached variants included
- `5671/5672/15672/25672` RabbitMQ variants included
- `2181/2888/3888` ZooKeeper variants included
- `2375/2376/2379/2380/6443/10250/10255/10256` Docker/etcd/Kubernetes variants included
- `8848/9848/9849` Nacos variants included

## Verification

1. Service remained running; no stop required for the actual API update.
2. Authenticated through `/api/auth/login` without printing credentials.
3. Updated by `PUT /api/port-lists/:id`.
4. Verified final list:

```json
{
  "count": 211,
  "has22": true,
  "first": [21,22,23,25,53,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94],
  "last": [18789,19092,20000,20201,20202,25565,25672,26379,27017,27018,27019,28017,32193,33060,50001,50050,50070,50075,50090,60010]
}
```

## Notes

- 这是数据配置变更，不是代码变更。
- 后续如果要形成环境初始化默认值，可以再把这份端口集合做成 seed 脚本；当前先以平台 API 配置为准。
