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

退出码：`0` 没有阻塞问题，`1` 存在 error 级发现，`2` 工具自己没跑起来——包括它没法照做的参数和配置文件，所以填错的严重级别会红着退出，不会变成一个干净通过。

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
spring-review                              # 工作区未提交变更，含没 add 过的新文件
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

默认模式会把从没 `git add` 过的新文件一起看，因为对第一次跑的人来说，"看我改的东西"
里那个新类就是主角；`--diff` 和 `--patch` 不看它们，那两者描述的是历史。
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
| MYB001 | `${}` 拼接：语句、`<sql>` 片段、`@Select` 都扫；改法看位置 —— 值用 `#{}`，标识符用白名单，整段片段只能管服务端来源 | error |
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
被误报，而那样的项目是绝大多数。这个文件看不到的文本算未知，不算不存在：
`<include refid="other.Mapper.commonWhere">` 解析不出来的时候，条件很可能就藏在那儿。

左通配 `LIKE` 在真实 mapper 里很少写成 `'%foo%'`，因为 `#{}` 一进引号就不再是参数。
实际形态是 `concat('%', #{kw}, '%')` 和 `<bind value="'%' + kw + '%'/>`，只匹配字面量的
话这条规则等于不存在。带引号的写法确实会出现在真实代码里——newbee-mall 的商品搜索有两处
`CONCAT('%','#{goodsName}','%')`——但那不是查询慢，而是条件根本绑不上，所以 MYB003 对它
报 error，并让你把引号去掉。

## 为什么不直接问大模型

模型看 diff 有三件事做不到。给不出能点开的行号。保证不了两次答案一样，所以不能拿来
卡合并。也不知道 `ORDER BY ${sortField}` 是白名单问题，不是"改成 `#{}`"能解决的——
这一点 v0.1.12 之前的这个工具也不知道，它对一个真实框架里的 6 处 `${}` 全部建议
"改成预编译参数"。规则至少能在一个提交里把自己的错改掉，并且钉在测试上。

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
| [mybatis/mybatis-3](https://github.com/mybatis/mybatis-3) | 1837 | 590 | 全在框架自己的测试 mapper 里：`SELECT *`、无界查询、`${}` 特性测试 |
| [newbee-ltd/newbee-mall](https://github.com/newbee-ltd/newbee-mall) | 98 | 4 | 两处左通配搜索，外加两处商品搜索的 `#{}` 被写在引号里、根本绑定不上 |
| [yangzongzhuan/RuoYi-Vue](https://github.com/yangzongzhuan/RuoYi-Vue) | 295 | 50 | 6 处 `${}` 原样拼接、7 个无界的 `selectXxxAll`、17 个 service 循环里逐条调 mapper、19 处左通配搜索、1 个 `SELECT *` |

"文件数"是这次运行打开的全部 `.java` 与 `.xml`。分析不了的文件不会静默过去，而是在同一
份输出的 `skipped:` 里逐个点名 —— mybatis-3 的 1837 个里有 226 个（站点文档的
`<document>` XML、`pom.xml`、`<configuration>` 文件），RuoYi 的 295 个里有 9 个，所以
`--format json` 报的实际分析数是 1611 和 286。

mall 这一轮扫出了一个真实 bug：`OrderTimeOutCancelTask` 里 `@Scheduled(cron = …)` 标在
**private** 方法上，Spring 不会调用它 —— 那个超时订单取消任务根本没在跑。

这一轮一共带来四个修复，每个都补了测试。MYB001 最初在 mall 上报了 84 条，全部是
MyBatis Generator 自己生成的 `order by ${orderByClause}`，现在框架占位完全静默；
非 mapper 的 XML（`pom.xml`、`logback-spring.xml`）原来每条规则记一次跳过，现在一个
文件一次；传目录时它会报"扫了 0 个文件、一切正常"；
`repository.findByName(name).map(e -> repository.save(e))` 被当成 N+1，而那个
`Optional` 只会执行一次。

mybatis-3 是第一个带真实 MyBatis XML 的代码库，它又带来了四个修复。它的站点文档是
`<document>` XML，`<source>` 块里引着 mapper 例子 —— 于是 64 条发现全落在说明文字上，
其中一条把 `<include refid="${include_target}"/>` 报成注入 error，而那正是文档里写的
选择片段的方式。注解 SQL 之前是从原始文件里扫的，所以 `@Select` 自己的 Javadoc 例子
产出了一条 `SELECT *`。没有 SQL 的文件又变成每条规则记一次跳过。只用来选 include 目标
的 `${}` 现在是 warn，不再是注入 error。

RuoYi 又带来两个修复，两个都不是"报没报"的问题，而是"说的是什么"。它的 6 处 `${}`
有 5 处是数据权限切面拼进来的 WHERE 片段（`${params.dataScope}`，分布在 user/role/dept
三个 mapper），另外 1 处是代码生成器的 DDL（`<update id="createTable">${sql}</update>`）
—— 这些位置在结构上不可能用
`#{}`：预编译参数只能替代表达式里的一个值，替代不了一段 SQL。而旧版本给的建议是
"改为预编译参数 `#{params}`"，也就是把一个 Map 交给驱动。MYB001 现在会看占位符所在的
位置：`= ${kw}` 才建议 `#{}`；`from ${table}`、`select ${id}`、`col_${suffix}`、
`order by ${sort}` 给标识符白名单；`<if test="'${value}' == 'x'">` 说明那拼进的是 OGNL
表达式；整段片段则直说 —— 控制点在服务端来源，不在占位符。同理 `#{ids[${index}]}`，它
选的是"绑哪个参数"，之前被当成注入；这是两个语料合起来去掉的唯一一条发现。

第二个：`SysConfigMapper.selectConfig` 是 `<include refid="selectConfigVo"/>` 加
`<include refid="sqlwhereSearch"/>`，而 WHERE 就在第二个片段里。为了拼出 SQL 文本要把
标签去掉，这一去把"它有边界"的唯一证据删掉了，于是 MYB005 把一个有过滤的查询报成全表
读。现在 `<where>`、`<set>`、`<trim prefix="WHERE">` 会变成 MyBatis 真正生成的关键字，
顺带修好了所有条件写成 `<include refid="Example_Where_Clause"/>` 的 MyBatis Generator
mapper。

仍然没被验证到的是：请求参数直接流进 `${}` 的那种代码。RuoYi 的值来自切面和生成器，
而要把它们和调用方可控的字符串区分开，需要跨文件追一个值的来源 —— 那是
[#2](https://github.com/JingYu-create520/spring-review/issues/2)，不是这条规则。
五个语料里的每一处 `${}` 都被报了出来，但没有一处已知真的带着请求参数。

## 它做不到什么

没有编译器，没有 classpath。结构来自"把注释和字符串掩掉之后的括号状态机"，所以跨文件
的 Bean 装配、自定义元注解（`@MyService` 这类）、通过 `@Bean` 注册的类，它都看不见
（[#2](https://github.com/JingYu-create520/spring-review/issues/2)）；从别的 mapper
文件 `<include>` 进来的 `<sql>` 片段，对使用它的语句也是不可见的
（[#3](https://github.com/JingYu-create520/spring-review/issues/3)）。

结构解析不出来时，规则保持沉默，并在 `skipped` 里说明原因。这发生在它读不懂的 Java
上，也发生在 `--patch` 指向你本地没有的文件、或者 patch 的行号和磁盘上的文件对不上
时——前一种情况下 `${}` 检测仍然工作，因为一行就够判断了。

它不是 SonarQube，也不是 Checkstyle。格式和代码异味不是它看的东西。

## 开发

```bash
npm ci
npm run typecheck && npm test    # 153 个测试
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
