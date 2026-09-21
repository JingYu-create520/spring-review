# shop — the demo target

A small, deliberately ordinary Spring Boot + MyBatis project: orders, stock,
price rules. Nothing here is labelled with a rule id, because real code never is.
Five of its files contain the mistakes this tool exists to catch; two files
(`PriceCalculator.java`, `PriceRuleMapper.xml`) are written the right way and must
come back silent.

## Review it

From the repository root:

```bash
npm ci && npm run build
node dist/cli.js --cwd examples/demo-project --experimental \
  --file $(cd examples/demo-project && find src -name '*.java' -o -name '*.xml')
```

Expected shape (exact lines move when the demo changes; `tests/demo-project.test.ts`
pins it):

```
20 findings across 13 files — 13 error, 7 warn
SPR001 1  SPR002 1  SPR003 2  SPR004 1  SPR005 1  SPR006 2
MYB001 2  MYB002 6  MYB003 2  MYB004 1  MYB005 1
```

## What is planted, and why each one is worth a rule

| 位置 | 问题 | 为什么真实项目里常见 |
| --- | --- | --- |
| `OrderService.submit` | 裸调用同类 `createOrder()`，后者 `@Transactional` | "先落库再记审计"的自然写法 |
| `OrderService.submit` / `buyerNames` | 循环里逐条 `selectPrice` / `selectBuyerName` | 一行一条 SQL，测试环境毫无感觉 |
| `OrderService.applyPriceFile` | `throws IOException` 却没有 `rollbackFor` | 默认只回滚 RuntimeException，很少有人记得 |
| `StockService.flushAsync` | 方法内 `Executors.newSingleThreadExecutor()` | "异步一下"最省事的写法 |
| `StockService.pending` | 单例字段 `HashMap` 被并发写 | 本地缓存/计数器，事故高发区 |
| `StockService.stockForCart` | 同类调用 `@Cacheable` 方法 | 缓存看起来配好了，其实每次穿透 |
| `ReconcileJob.nightly` | `@Scheduled` 方法带参数 | 调度框架不会传参，静默不执行 |
| `ReconcileJob.pushDiff` | `@Async` 标在 private 方法上 | 编译通过、启动通过、永远同步跑 |
| `OrderMapper.topSorted` | `order by ${sortField}` | 动态排序，前端可传 |
| `OrderMapper.countByRemark` | `like '%${keyword}%'` | 一次同时踩中注入和左通配 |
| `StockMapper.xml exportAll` | `SELECT * FROM stock` 无条件无上限 | 导出功能的起手式 |
| `StockMapper.xml StockView` | `<association select=…>` 嵌套查询 | N+1 由框架生成，代码里看不见 |

## Two things this demo also proves

`PriceRuleMapper.xml` has a `selectPage` with no `LIMIT` — because MyBatis-Plus
injects pagination from the `IPage` parameter declared in the interface. A tool
that only reads the XML would call that an unbounded full-table scan on every
paged query in your project. It stays quiet, because it followed the namespace to
the interface.

`PriceCalculator.java` loops over amounts and reassigns `sum` — a local, not a
field. The mutable-state rule does not fire. Reading the whole file, rather than
the diff fragment, is what makes that distinction possible.

## Honest note

This project is a review target, not a running application: there is no database,
and CI never compiles it. Its job is to look like the code you already have, so
that the numbers above mean something.
