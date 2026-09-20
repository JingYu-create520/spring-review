# spring-review

**git diff 进,行级问题评论出 —— 专查通用 AI code review 看不见的 Spring / MyBatis 坑。**

`@Transactional` 写了等于没写、`for` 循环里藏着的 N+1、`${}` 让 WHERE 变成可注入、
每次请求 new 一个线程池。这些都不是代码风格问题,是"测试环境好好的、上线就炸"的问题,
而按 Java 语法而不是按 Spring 语义做判断的工具根本看不见它们。

判定全部由确定性规则引擎完成:离线、不需要 API key、同样输入永远同样输出、行号精确、可单测。
LLM 只允许改写总结文案,不参与任何判定。

> [English README](./README.md) · [规则清单](#规则清单11-条) · [为什么不直接问大模型](#为什么不直接问大模型) · [它做不到什么](#它做不到什么写在明面上)

```console
$ npx spring-review --patch examples/sample.patch

src/main/java/demo/BadUserService.java
  src/main/java/demo/BadUserService.java:35  error  SPR001  rename() 通过 this.updateName() 调用同类中带 @Transactional 的方法,代理不拦截自调用,事务通知不会生效。
      this.updateName(id, name);
      → 把 updateName() 挪到另一个 Bean,或注入自身代理后再调用(@Lazy 注入本类 / AopContext.currentProxy())。
  src/main/java/demo/BadUserService.java:48  error  MYB002  importUsers() 在 for 循环中调用 userMapper.insertOne(),循环 N 次就打 N 次库(N+1)。
      userMapper.insertOne(user);
      → 先收集 id 一次性查:selectByIds(ids) 或 IN (…) 批量查,再 Map<id, X> 组装。
  src/main/resources/mapper/BadUserMapper.xml:14  error  MYB001  select#byName 用 ${keyword} 拼接 SQL,该值会原样出现在语句里,存在 SQL 注入风险。
      WHERE user_name = '${keyword}'
      → 改为预编译参数 #{keyword}。

14 error(s)  8 warning(s)  across 2 file(s), rules hit: MYB001, MYB002, MYB003, MYB004, MYB005, SPR001…
```

退出码就是 CI 契约:**0** 无阻塞问题,**1** 存在 error 级发现,**2** 工具自身没跑起来。

## 安装

```bash
npm i -D spring-review         # 项目内
npx spring-review --help       # 或临时跑一次
```

不经过 npm、直接跑仓库:

```bash
npm ci && npm run build && node dist/cli.js --cwd tests/fixtures --file java/BadUserService.java
```

## 四种用法

**1 · CLI:提交前自查**

```bash
spring-review                             # 工作区未提交变更
spring-review --diff origin/main..HEAD    # 指定范围
spring-review --staged
spring-review --file src/main/java/demo/UserService.java
spring-review --patch pr.patch --format github
```

只报**新增行**上的问题——存量代码不会被翻出来骚扰你,这是它能进日常流程的前提。

**2 · GitHub Action:PR 自动行级评论**

```yaml
# .github/workflows/spring-review.yml
on: [pull_request]
permissions: { contents: read, checks: write }
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: JingYu-create520/spring-review@v0
        with:
          exclude: "**/generated/**"
```

发现以 check-run annotations 的形式出现在 Files changed 的行上——不需要仓库 token、
不会刷屏、不用维护评论去重状态。想让 CI 只提示不卡门禁就设 `fail-on-error: false`。

**3 · MCP server:让编码 Agent 自己审自己**

```json
{
  "mcpServers": {
    "spring-review": { "command": "npx", "args": ["-y", "spring-review", "mcp"] }
  }
}
```

工具面:`review_diff`(传 patch 文本或 git range)、`review_file`、`list_rules`。
Agent 写完 Spring 代码自己跑一遍,把坑改掉的闭环就此成立——而且判定里没有模型调用,
所以结果可复现。

**4 · Agent Skill**

`skills/spring-review/SKILL.md` 告诉支持 skill 的 Agent 什么时候该跑、怎么读
`findings[]`,拷进你的 skills 目录即可。

## 规则清单(11 条)

`spring-review --list-rules` 可以直接拿到带说明的机器可读版本。

### Spring

| ID | 查什么 | 级别 |
| --- | --- | --- |
| **SPR001** | 事务自调用:`this.m()` 或裸调用不经过代理,通知静默失效 | error |
| **SPR002** | 方法 `throws` 受检异常却没写 `rollbackFor` —— 默认只回滚 RuntimeException,半截写入会被提交 | error |
| **SPR003** | `@Async` / `@Scheduled` 永远不生效的几种写法:非 public、static、同类调用、`@Scheduled` 带参数 | error |
| **SPR004** | 单例 Bean 方法里 `new Thread` / `Executors.newXxx` —— 线程数失控、无拒绝策略、不会优雅关闭 | error |
| **SPR005** | 单例 Bean 的实例字段被非同步方法写(误报风险高,默认关闭,`--experimental` 打开) | warn |
| **SPR006** | `@Cacheable` 被自调用绕过;或多参数却没显式 `key` | warn |

### MyBatis

| ID | 查什么 | 级别 |
| --- | --- | --- |
| **MYB001** | `${}` 拼接,XML 和 `@Select` 注解 SQL 都扫。MyBatis-Plus 的 `${ew.customSqlSegment}`、动态 `ORDER BY` 降为 warn 并给白名单方案,而不是一刀切误报 | error |
| **MYB002** | N+1:`for` / `while` / `forEach` / `stream().map()` 里调 mapper;`resultMap` 的 `<association select>` 嵌套查询 | error |
| **MYB003** | 左通配 LIKE —— 字面量 `'%x%'`、`concat('%', #{x}, '%')`、`<bind value="'%' + …">` 三种形态都覆盖(只匹配字面量等于这条规则不存在) | warn |
| **MYB004** | `SELECT *`(`count(*)` 不会误报) | warn |
| **MYB005** | 没有 WHERE 也没有 LIMIT 的查询;会从 mapper 接口识别 `IPage` / PageHelper 分页并豁免 | error |

## 为什么不直接问大模型

因为模型看 diff 给不出**能点开的行号**,不保证两次答案一致,也无从判断你的
`ORDER BY ${sortField}` 是"该走白名单"而不是"该改成 #{}"。

所以职责是切开的:

- **规则负责结论。** 每条发现都有规则 ID、证据片段、HEAD 里的行号、修复建议。
  可单测、可复现、断网可用。
- **LLM 负责措辞。** `--llm` 接任意 OpenAI 兼容端点(`SR_LLM_BASE_URL` /
  `SR_LLM_API_KEY` / `SR_LLM_MODEL`),只改总结段落。测试锁死了"开关 --llm 不改变
  findings 的一个字节";端点不通时降级为离线模板,不会把 CI 弄红。

## 它做不到什么(写在明面上)

这类工具的口碑死于误报,所以边界先说清楚:

- **没有编译器、没有 classpath。** 结构来自"注释/字符串掩码 + 括号状态机",
  所以跨文件的 Bean 装配、自定义元注解(`@MyService`)、`@Bean` 注册的类都看不见。
- **拿不准就不报。** 结构解析失败、或者 `--patch` 指向的文件本地不存在,
  依赖上下文的规则会保持沉默并在 `skipped` 里说明原因,而不是猜一个像模像样的结论。
  `${}` 这种行内可判定的规则在片段上依然工作。
- **抑制手段是有的但请节制**:`// spring-review:disable SPR001 "原因"` 写在问题行
  或它上一行都生效;`disable-file` 管整文件;仓库级用 `.spring-review.json`。
- **不替代 SonarQube / Checkstyle。** 它不查异味、不查格式,只查那两个不查的
  Spring / MyBatis 语义坑,并且是在 diff 这一步、几秒之内。

## 开发

```bash
npm ci
npm run typecheck && npm test     # 解析器 / 每条规则正负例 / 误报守卫 / CLI /
                                  # MCP(内存 + 真实 stdio 握手)/ 金样例
npm run build                     # dist/cli.js, dist/index.js, dist/mcp/index.js
```

目录:`src/diff`(patch → 行号)、`src/analyze`(Java 与 mapper XML 结构)、
`src/rules`(11 条规则 + 引擎 + 抑制)、`src/report`、`src/llm`、`src/mcp`。

## 许可

MIT,见 [LICENSE](./LICENSE)。

## 同作者的其他项目

- `sql-index-advisor` —— MySQL / MyBatis 的离线索引顾问,慢日志进、DDL 建议出
- `mcp-tool-gateway` —— 给 MCP 工具调用加 RBAC、审计与人机确认
- `agent-regression` —— Agent 回归测试:trace、评分、卡 PR
