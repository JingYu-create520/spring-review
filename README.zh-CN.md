# spring-review

对 Spring / MyBatis 的改动做行级审查。给它一个 git diff，它返回带文件、行号和规则号的问题列表。

它处理的是那些得懂 Spring 才看得见的问题：

- 同类里调用的方法带 `@Transactional`。代理拦不到自调用，事务等于没开。编译通过、启动正常、review 也过得去。
- 方法 `throws IOException` 却只写了 `@Transactional`。Spring 默认只回滚 RuntimeException，受检异常抛出后，半截写入会被提交。
- `for` 循环里 `orderLineMapper.selectPrice(id)`。一个元素一次查询。
- Mapper XML 里 `where name = '${keyword}'`。`${}` 是字符串拼接。
- `like concat('%', #{kw}, '%')`。前导 `%` 就是索引失去作用的地方。
- 单例 Bean 的方法里 `Executors.newFixedThreadPool(8)`。

判定由规则做出，离线、不需要 API key，所以同一份 diff 永远得到同一份结果。
`--llm` 只改总结那一段文字。

![spring-review 审查 examples/demo-project 的两个文件：6 个 error、2 个 warn，每条都带规则号、行号、证据代码和改法](./docs/assets/demo.png)

> [English README](./README.md) · [规则](#规则) · [为什么不直接问大模型](#为什么不直接问大模型) · [它做不到什么](#它做不到什么)

退出码：`0` 没有阻塞问题，`1` 存在 error 级发现，`2` 工具自己没跑起来。

## 安装

npm 包还没发，CLI 改为从这个仓库的 Releases 拿，除了 Node 20 或更高之外没有别的要求：

```bash
npm i -g https://github.com/JingYu-create520/spring-review/releases/latest/download/spring-review.tgz
spring-review --diff origin/main..HEAD
```

`releases/latest` 会往前走，`releases/download/v0.1.3/spring-review.tgz` 不会。
要是你想改这个工具本身，就 clone 下来构建：

```bash
git clone https://github.com/JingYu-create520/spring-review.git
cd spring-review
npm ci && npm run build
node dist/cli.js --patch examples/sample.patch
```

下面出现的 `spring-review`，指的就是这两条路里的任意一个可执行文件。

## 用法

```bash
spring-review                              # 工作区未提交变更
spring-review --diff origin/main..HEAD     # 指定提交范围
spring-review --staged
spring-review --file src/main/java/demo/UserService.java
spring-review src/main/java                # 整个目录，递归
spring-review "src/**/*Service.java"       # 或者 glob
spring-review --patch pr.patch --format github
```

路径可以是文件、目录或 glob；`target/`、`build/`、`node_modules/`、`generated/` 不会被遍历。
一个输入如果没匹配到任何可审查文件，会在输出里点名说明，而不是安静地通过——
"扫了 0 个文件然后报告一切正常"的静态检查，比直接报错更糟。
patch 的上下文和它声称修改的文件对不上时，同样会点名：审查退回到 patch 自己的文本，
因为拿新增行的行号去评一段无关代码，产出的正是那种没人该信的结果。

只报新增行上的问题，存量代码不会翻出来骚扰你。
其他参数：`--min-severity error|warn|info`、`--exclude '**/generated/**'`、
`--disable SPR005`、`--experimental`、`--list-rules`。仓库级配置放
`.spring-review.json`（`exclude` / `disable` / `minSeverity`）。

要压掉某一条，就把理由写上：

```java
// spring-review:disable MYB001 "sortField 来自服务端白名单映射"
```

写在问题那一行或它上一行都生效，`disable-file` 管整个文件。

### GitHub Action

```yaml
on: [pull_request]
permissions: { contents: read, checks: write }
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: JingYu-create520/spring-review@v0
        with:
          exclude: "**/generated/**"
```

发现以 check-run annotation 的形式出现，所以不用给 token，也没有需要去重的评论串。
`fail-on-error: false` 会让 job 保持绿色但照样标出问题——做法是把注解降级成
`notice`，因为 `::error` 是 workflow 命令，本身就会让这次运行失败，跟退出码无关。

Action 默认从本仓库的 Release 下载已经构建好的 `spring-review.tgz`，用 node 在临时目录里
跑起来：你的 runner 不需要构建什么，也不需要一个尚未发布的 npm 包。`ref: v0.1.3` 可以把
CLI 钉在某个版本，`install-from: npm` 在包发布后切过去，`install-from: local` 用 job 里
已经构建好的那份。CI 每次 push 会跑 github 和 local 两条。

`@v0` 是个会动的 tag，CI 把它指着那些 job 全绿的 main 提交；想连 Action 本身一起钉住，
就写 `@v0.1.3`。

### Code Scanning

`--format sarif` 输出 SARIF 2.1.0，规则说明一起打包进去，于是发现会长期待在 Security
标签页上，而不是一闪而过：

```yaml
- run: spring-review --diff origin/main..HEAD --format sarif > spring-review.sarif
- uses: github/codeql-action/upload-sarif@v4
  with: { sarif_file: spring-review.sarif, category: spring-review }
```

本仓库每次推 main 就会扫自己的 fixtures，Security 页现在有 21 条未关闭的告警。第 22
条自己变成了 fixed——0.1.2 不再对框架占位 `${ew.customSqlSegment}` 报规则，而一次
上传里不再出现的告警会被自动关闭。

### MCP server

```json
{
  "mcpServers": {
    "spring-review": {
      "command": "node",
      "args": ["/路径/spring-review/dist/cli.js", "mcp"]
    }
  }
}
```

三个工具：`review_diff`（传 patch 文本，或者 range 加 `cwd`）、`review_file`、
`list_rules`。`skills/spring-review/SKILL.md` 是给"读 skill 不走 MCP"的 Agent 的同一套东西。

## 规则

`spring-review --list-rules` 会连理由一起打出来。

| ID | 查什么 | 级别 |
| --- | --- | --- |
| SPR001 | `@Transactional` 自调用，`this.m()` 或裸调用 | error |
| SPR002 | `@Transactional` + 受检异常 + 没写 `rollbackFor` | error |
| SPR003 | 不可能生效的 `@Async`/`@Scheduled`：非 public、static、同类调用、`@Scheduled` 带参数 | error |
| SPR004 | 单例 Bean 里 `new Thread` / `Executors.newXxx` | error |
| SPR005 | 实例字段被非同步方法写（`--experimental`） | warn |
| SPR006 | `@Cacheable` 被自调用绕过，或者所有参数都进 key | warn |
| MYB001 | `${}` 拼接：语句、`<sql>` 片段、`@Select` 都扫 | error |
| MYB002 | N+1：循环或 stream 里调 mapper，`resultMap` 嵌套 select | error |
| MYB003 | 左通配 `LIKE`，字面量 / `concat` / `<bind>` 三种形态 | warn |
| MYB004 | `SELECT *` | warn |
| MYB005 | 没有 `WHERE` 也没有 `LIMIT` 的 `SELECT` | error |

有三条比看起来复杂，也正是规则数停在 11 的原因。

`${}` 不能一律报出来。MyBatis-Plus 和 MyBatis Generator 会把自己的文本塞进
`${ew.customSqlSegment}`、`${criterion.condition}`、`order by ${orderByClause}`，
这些是框架契约，现在完全静默 —— 在生成代码上刷警告，只会让人把整套规则一起忽略掉。
会报的是人写的那部分：`ORDER BY ${sortField}` 降为 warn 而不是 error，因为列名根本
不能绑定，改成 `#{}` 是无效建议，真正能落地的答案是服务端维护列名白名单、命中不了就报错。
写在共享 `<sql id="kwWhere">` 里、被五个语句 `<include>` 进去的占位，报在那块片段本身上，
只报一次：要改的就是那一行，注入也在那里，语句正文里根本没有它。

没有 `LIMIT` 的 `SELECT` 不一定是在读全表。MyBatis-Plus 的分页由拦截器注入，SQL 里
始终是光秃秃的。所以这条规则会顺着 mapper XML 的 `namespace` 找到对应接口，参数里带
`IPage`/`Page` 的语句直接豁免。少了这一步，一个 MyBatis-Plus 项目里的每个分页查询都会
被误报，而那样的项目是绝大多数。

左通配 `LIKE` 在真实 mapper 里几乎不会写成 `'%foo%'`，因为 `#{}` 不能放进引号。实际
形态是 `concat('%', #{kw}, '%')` 和 `<bind value="'%' + kw + '%'/>`。只匹配字面量，
这条规则等于不存在。

## 为什么不直接问大模型

模型看 diff 有三件事做不到。给不出能点开的行号。保证不了两次答案一样，所以不能拿来
卡合并。也不知道 `ORDER BY ${sortField}` 是白名单问题，不是"改成 `#{}`"能解决的。

所以结论由规则给出：每条带规则号、证据、HEAD 里的行号、改法，以及一个单元测试。
`--llm` 接任意 OpenAI 兼容端点（`SR_LLM_BASE_URL`、`SR_LLM_API_KEY`、`SR_LLM_MODEL`），
只写总结那段。`tests/cli.test.ts` 检查开关 `--llm` 之后 JSON 报告逐字节相同，也检查端点
连不通时返回离线模板而不是把构建弄失败。

## 在不是为它写的代码上跑过

demo-project 是自带样本的夹具，它只能证明"规则该触发的时候会触发"。真正的验证来自
几个公开仓库，整目录扫描，里面没有任何为这个工具准备的东西：

| 代码库 | 文件数 | 发现 | 是什么 |
|---|---|---|---|
| 两个 Spring 网关模块（不含 MyBatis） | 195 | 3 | 都在 `*IT.java` 的轮询循环里查库 —— 确实是逐次往返，但在测试里是有意的 |
| [abel533/MyBatis-Spring-Boot](https://github.com/abel533/MyBatis-Spring-Boot) | 24 | 2 | 一个 `SELECT *`，一个无界查询 |
| [macrozheng/mall](https://github.com/macrozheng/mall) | 638 | 29 | 15 个 `SELECT *`、12 个循环里逐条调 mapper、1 个无界查询、1 个失效的 `@Scheduled` |

mall 这一轮扫出了一个真实 bug：`OrderTimeOutCancelTask` 里 `@Scheduled(cron = …)` 标在
**private** 方法上，Spring 不会调用它 —— 那个超时订单取消任务根本没在跑。

这一轮一共带来四个修复，每个都补了测试。MYB001 最初在 mall 上报了 84 条，全部是
MyBatis Generator 自己生成的 `order by ${orderByClause}`，现在框架占位完全静默；
非 mapper 的 XML（`pom.xml`、`logback-spring.xml`）原来每条规则记一次跳过，现在一个
文件一次；传目录时它会报"扫了 0 个文件、一切正常"；
`repository.findByName(name).map(e -> repository.save(e))` 被当成 N+1，而那个
`Optional` 只会执行一次。

还没被验证到的：`${}` 里真的带着用户输入的代码库。上面几个项目里的 `${}` 全部来自框架
生成。

## 它做不到什么

没有编译器，没有 classpath。结构来自"把注释和字符串掩掉之后的括号状态机"，所以跨文件
的 Bean 装配、自定义元注解（`@MyService` 这类）、通过 `@Bean` 注册的类，它都看不见。

结构解析不出来时，规则保持沉默，并在 `skipped` 里说明原因。这发生在它读不懂的 Java
上，也发生在 `--patch` 指向你本地没有的文件时——那种情况下 `${}` 检测仍然工作，因为
一行就够判断了。

它不是 SonarQube，也不是 Checkstyle。格式和代码异味不是它看的东西。

## 开发

```bash
npm ci
npm run typecheck && npm test    # 120 个测试
npm run build                    # dist/cli.js, dist/index.js, dist/mcp/index.js
```

`examples/demo-project` 是一个订单/库存小工程，同样的坑埋在里面且不带标签，另外有两个
文件是照正确写法写的。`tests/demo-project.test.ts` 会在某条规则不再命中、或者干净文件
开始被报的时候让 CI 变红——上面那些数字靠这个才不是空话。

目录：`src/diff`（patch → 行号）、`src/analyze`（Java 与 mapper XML 结构）、
`src/rules`（规则、引擎、抑制）、`src/report`、`src/llm`、`src/mcp`。

## 许可

MIT，见 [LICENSE](./LICENSE)。

## 我做的其他东西

- [sql-index-advisor](https://github.com/JingYu-create520/sql-index-advisor) — 从慢日志和 mapper XML 给 MySQL/MyBatis 索引建议
- [mcp-tool-gateway](https://github.com/JingYu-create520/mcp-tool-gateway) — 给 MCP 工具调用加 RBAC、审计和人工确认
- [agent-regression](https://github.com/JingYu-create520/agent-regression) — Agent 回归测试，跑在 CI 里
- [vredis](https://github.com/JingYu-create520/vredis) — 用 Rust 写的、说 RESP2 的迷你向量库
- [mini-search](https://github.com/JingYu-create520/mini-search) — 中文本地混合搜索，分词器手写
- [jvm-incident-agent](https://github.com/JingYu-create520/jvm-incident-agent) — 从 thread dump、GC 日志和堆直方图分析 JVM 事故
