# spring-review 项目规划书

> 版本 v1.1 · 2026-09-20 · 状态:待开工(第二个发布,sql-index-advisor 先发并复用其基建)
> 本文档是施工依据,内容自洽。**开工前请把本文件复制进项目仓库(如 `docs/PLAN.md`),新对话直接引用该文件即可,无需其他上下文。**
> 说"按 PLAN 执行 M1"我就只做 M1 范围,做完停下等验收。

---

## 1. 一句话定位

**面向 Spring / MyBatis 生态的 AI 代码审查工具:git diff 进,行级问题评论出。专查通用 AI review 看不懂的 Java 生态坑——事务自调用失效、N+1、`${}` 注入、线程池误用。确定性规则引擎离线可跑,LLM 只做 PR 总结润色。**

## 2. 目标用户与使用场景

| 用户 | 场景 | 入口形态 |
|---|---|---|
| Java 后端日常开发(主力) | 提 PR 前自查 | CLI(`--diff HEAD~1`) |
| 团队 TL | PR 自动行级评论 | GitHub Action |
| AI 编码助手用户 | Agent 写完 Spring 代码后自审 | MCP server / Agent Skill |

## 3. 竞品与差异化(2026-09 判断)

| 对手 | 短板 = 我们的机会 |
|---|---|
| CodeRabbit / Copilot code review / Sourcery | 通用模型,对 `@Transactional` 自调用、MyBatis `${}`、N+1 模式识别弱;闭源或付费 |
| SonarQube(Java) | 重、企业部署门槛高;偏静态异味,不覆盖 MyBatis XML 里的 SQL 反模式;无 LLM 解释 |
| 直接问 LLM 看 diff | 无 diff 行号映射,位置报不准;不可复现;每次结果不一样 |

**核心主张(写进 README)**:规则引擎保证"每次都报、位置精确、可单测";LLM 保证"解释像人话"。两层分离,互不污染。

## 4. 成功指标

- 北极星:发布后 30 天 ≥ 100 star
- 过程指标:npm 周安装 ≥ 150;≥3 个真实外部仓库提 issue;MCP/Skill 收录完成

## 5. 范围

### 5.1 MVP 必须有

- 输入:unified diff(patch 文件或 `git diff` 输出)、单文件模式(`.java` / Mapper `.xml`)
- 11 条规则(SPR001~006 + MYB001~005)
- 行内抑制注释:`// spring-review:disable SPR001 "原因"`(对下一行生效)
- 输出:终端彩色 / `--format json` / `--format github`(annotations 数组)
- 四形态:CLI + MCP server + Agent Skill + GitHub Action(PR 行级评论)
- LLM 适配层:默认 Mock 离线;`--llm` 生成 PR 评论风格总结
- 测试:每规则 ≥1 正 1 负 fixture(故意写坏的 `.java`/`.xml` 样例)

### 5.2 明确不做(v2)

- 完整 Java 语义分析(不引 javaparser/Spoon,只用结构化正则 + 括号状态机)
- 编译期检查、类型推断类规则
- Checkstyle/Spotless 的格式化职责(明确让位,README 说明定位差异)
- GitLab / 其他平台集成
- 自定义规则插件系统(MVP 只留好内部接口,不开放外部扩展)

## 6. 规则清单(MVP)

### Spring 类

| ID | 名称 | 触发条件 | 严重度 | 说明要点 |
|---|---|---|---|---|
| SPR001 | 事务自调用失效 | 同类内 `this.method()` 或裸调用,目标方法带 `@Transactional` | error | 代理不拦截自调用;建议注入自身/拆类/AopContext |
| SPR002 | 缺 rollbackFor | `@Transactional` 方法签名 `throws` 受检异常且未指定 rollbackFor | error | 默认只回滚 RuntimeException |
| SPR003 | @Async/@Scheduled 失效 | 注解方法非 public,或被同类调用 | error | 同样代理机制问题 |
| SPR004 | 请求路径新建线程/线程池 | 方法体内 `new Thread(` 或 `Executors.newXxx(` 且类是 Spring Bean | error | 泄漏与不可控;建议 `ThreadPoolTaskExecutor` Bean |
| SPR005 | 单例可变状态 | 单例 Bean 的实例字段在方法内被写,且字段非线程安全类型 | warn | 提示改局部变量/ConcurrentHashMap/@RequestScope |
| SPR006 | @Cacheable 失效或全量缓存 | 自调用;或 key 未指定且方法多参数 | warn | SpEL key 建议 |

### MyBatis 类

| ID | 名称 | 触发条件 | 严重度 | 说明要点 |
|---|---|---|---|---|
| MYB001 | SQL 注入 | XML/注解 SQL 中 `${}` 拼接;`order by` 白名单场景降为 warn | error | 改 `#{}`;动态列名给映射表方案 |
| MYB002 | N+1 查询 | Java 循环体(for/while/stream.forEach)内调用 mapper 方法;或 XML `<collection select="...">` 嵌套查询 | error | 建议批量 `IN` / join + resultMap |
| MYB003 | 左通配 LIKE | `like '%...%'` 或 `'%'#{x}` | warn | 索引失效;建议全文索引/右匹配 |
| MYB004 | SELECT * | `<select>` 或注解 SQL 用 `select *` | warn | 列膨胀 + 无法覆盖索引 |
| MYB005 | 无界全表查询 | 无 `where` 且无 `limit` 的 select | error | 建议分页 + 条件 |

统一结构:

```ts
interface Finding {
  rule: string;        // "SPR001"
  severity: "error" | "warn" | "info";
  file: string;        // 相对路径
  line: number;        // 新增行在 HEAD 中的行号(由 diff 映射得出)
  snippet: string;     // 证据代码
  message: string;     // 中文:问题 + 为什么 + 怎么改
  messageEn: string;
  suggestion?: string; // 建议代码片段
}
```

## 7. 架构与模块

```
spring-review/
├── src/
│   ├── diff/
│   │   ├── parse.ts       # unified diff → {file, addedLines: Map<newLineNo, content>}
│   │   └── git.ts         # 从工作区 git diff <range> 取 patch
│   ├── analyze/
│   │   ├── java.ts        # 轻量 Java 结构提取:类名/注解/方法签名/方法体边界(括号状态机)
│   │   └── xml.ts         # Mapper XML:<select|insert|update|delete> + SQL 文本 + resultMap 嵌套
│   ├── rules/
│   │   ├── engine.ts      # 注册表 + 执行 + 抑制注释处理
│   │   ├── spring/spr001.ts ... spr006.ts
│   │   └── mybatis/myb001.ts ... myb005.ts
│   ├── llm/               # 与 sql-index-advisor 同构:provider/mock/openaiCompat
│   │                      # 环境变量:SR_LLM_BASE_URL / SR_LLM_API_KEY / SR_LLM_MODEL
│   ├── report/            # terminal / json / github
│   ├── cli.ts             # commander,bin: spring-review
│   └── mcp/index.ts
├── skills/spring-review/SKILL.md
├── action.yml + .github/workflows/{ci.yml, pr-review.yml}
├── tests/
│   ├── fixtures/          # 坏代码样例 + 好代码样例
│   └── golden/            # 端到端期望输出
├── README.md / README.zh-CN.md
└── LICENSE(MIT)
```

技术选型:TypeScript strict + tsup + vitest + commander + zod。运行时依赖 ≤ 5。

**与 sql-index-advisor 的复用**:`llm/`、`report/`、MCP 脚手架、Action 骨架四个模块设计成可直接复制(先复制,不抽公共包——两个仓库各自独立可安装比 DRY 更重要,等第三个项目再做 `@jingyu/ai-cli-core`)。

## 8. 接口设计

### CLI

```bash
spring-review                      # 审查工作区未提交变更
spring-review --diff HEAD~1..HEAD  # 审查指定范围
spring-review --patch pr.patch --format github
spring-review --file src/main/java/.../UserService.java   # 整文件模式
# 通用: --llm --min-severity warn --format table|json|github --exclude test/**
```

退出码:0=无 error 级发现,1=有 error,2=运行错误。CI 默认卡 error,warn 仅提示。

### MCP 工具面

| 工具 | 入参 | 用途 |
|---|---|---|
| `review_diff` | diff 文本 或 range | 行级 findings |
| `review_file` | path | 整文件审查 |
| `list_rules` | — | 返回规则清单与说明,供 agent 引用 |

### GitHub Action

`action.yml`(composite)+ `pr-review.yml`:取 PR diff → `--format github` → `actions/github-script` 发行级评论(同一规则重复触发时更新而非刷屏)。

## 9. 里程碑与排期

> 前提:每周 10~15 小时。总计 1.5 周开发 + 1 周发布,且**在 sql-index-advisor 发布之后启动**。

### M1 · 骨架 + diff/结构解析(D1~D3)

- 工程初始化、CI 空跑绿
- diff/parse.ts(unified diff 行号映射是本项目最容易出错的地方,重点测)
- analyze/java.ts 括号状态机、analyze/xml.ts
- **验收**:对 fixture patch 能正确输出"文件+新增行号+内容"三元组;嵌套括号/字符串/注释/匿名类不误伤

### M2 · 11 条规则(D4~D8)

- 顺序:先 MYB001/005 + SPR001/002(误报低、价值高),再 SPR004/003、MYB002,最后 SPR005/006、MYB003/004
- 抑制注释机制
- **验收**:每规则正/负用例通过;对 fixture 仓库整体跑,误报为 0(负例文件不得产生任何 finding)

### M3 · 输出 + LLM + 四形态(D9~D11)

- 三种 report;MCP server(先读 @modelcontextprotocol/sdk 真实类型定义再写)
- SKILL.md、action.yml、npm 发布 0.1.0
- **验收**:Action 在测试仓库发出正确行级评论;Claude/Qoder 配 MCP 实测跑通

### M4 · 文档与发布(D12~D14)

- 双语 README + asciinema GIF + 规则表
- 文章《通用 AI code review 为什么看不懂 Spring 事务失效》
- HN Show HN + 掘金 + V2EX + r/java、awesome-spring 收录提交

## 10. 测试策略

- 单元:每规则正/负 fixture;diff 行号映射的边界用例(新文件、删除文件、rename、无结尾换行)
- 金样例:`tests/golden/` 端到端期望 JSON
- **误报优先**:负例文件(规范写法)必须 0 findings,视为最高优先级测试。这类工具的口碑死于误报
- 保守判定原则:结构提取失败时跳过该规则并记 info,绝不猜测报错

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 正则+状态机对复杂 Java 失效 | 声明支持子集;失效即静默跳过;文档写明"不替代 SonarQube" |
| SPR005(可变状态)误报率高 | MVP 可标 `--experimental` 默认关闭,收集反馈再放开 |
| 与 sql-index-advisor 抢发布窗口 | 强制错开 3~4 周,见总时间线 |
| npm 名占用 | 提前 `npm view spring-review`,备选 `spring-diff-review` |

## 12. 验收清单

- [ ] build/test 全绿,负例 fixture 0 误报
- [ ] 对真实 Spring Boot demo 仓库跑 `--diff` 输出合理
- [ ] Action 行级评论实测通过
- [ ] MCP 在 Claude 或 Qoder 实测跑通
- [ ] 双语 README + GIF + LICENSE + CHANGELOG
- [ ] npm 0.1.0 已发布
- [ ] 分发完成,README 底部 "More from this author" 互链已加

## 13. 双项目总纪律(与 sql-index-advisor 共用)

### 13.1 铁律

1. 两个项目做完后**禁止开第三个新坑**,剩余精力全部投入分发。
2. 本项目**晚 3~4 周发布**,不与 sql-index-advisor 抢同一发布窗口。
3. 本项目开工前提是 sql-index-advisor 已完成 M3(其 `llm/`、`report/`、MCP 脚手架、Action 骨架即为本项目可直接复制的基建)。

### 13.2 六周总时间线(每周 10~15 小时)

| 周次 | 主线 | 副线 |
|---|---|---|
| W0 | 现有三仓库补漏 + 账号资源准备(13.3) | 同左,合计约 1 天 |
| W1~W2 | sql-index-advisor 开发 | — |
| W3 | sql-index-advisor 发布周 | — |
| W4~W5 | **本项目 M1~M4 开发** | 处理第一个项目的 issue/反馈 |
| W6 | **本项目发布周** | — |
| W7+ | 两个项目维护 + 长尾分发 | — |

### 13.3 W0 开工前检查清单

- [ ] **vredis 加 LICENSE 文件**(无 license = 保留所有权利,硬伤)、README 补"为什么造它 + 局限性"
- [ ] mcp-tool-gateway / agent-regression:README 首屏定位 + 示例 + demo 截图;三仓库补 Topics/About
- [ ] GitHub 个人主页仓库(与账号同名)写"Java 系 AI 工具集"导航
- [ ] npm 账号注册 + 2FA;`npm view spring-review` 确认包名(备选 `spring-diff-review`)
- [ ] GitHub 创建两个新仓库(先 private,发布日切 public)
- [ ] 建"靶子 demo 仓库":故意埋事务失效 + N+1 + `${}` 注入的 Spring Boot 小项目(两个工具共用,本项目的主要 demo 素材与端到端测试对象)
- [ ] 掘金/V2EX/Reddit 账号提前活跃

### 13.4 已定技术决策(不再摇摆)

| 决策 | 结论 | 理由 |
|---|---|---|
| 语言 | TypeScript | Skill/Action/MCP 生态在 node 侧最顺;Java 背景体现在规则针对 Java 生态 |
| 仓库结构 | 独立仓库,不做 monorepo;README 底部互链成系列 | 单独可安装、可收录 |
| LLM 定位 | 规则出结论,LLM 只润色 | 可复现、离线可用是卖点 |
| 公共代码 | 从 sql-index-advisor **复制** llm/report/mcp/action 四模块,不抽公共包 | 第三个工具出现时再抽 `@jingyu/ai-cli-core` |
| 版本 | 首发 0.1.0 | 诚实 semver |

### 13.5 发布周标准动作清单(两个项目通用)

- [ ] Show HN 标题:`Show HN: <一句话,离线/无需 API key 是钩子>`
- [ ] 掘金发《通用 AI code review 为什么看不懂 Spring 事务失效》,文末放链接;英文版 dev.to
- [ ] Reddit r/java 以"我遇到 X 所以写了 Y"口吻发帖
- [ ] 提交收录:MCP 官方 registry、skills.sh、awesome-spring / awesome-mcp
- [ ] 发布后 48 小时在线响应每条评论和 issue
- [ ] README 底部 "More from this author" 互链 sql-index-advisor + gateway + regression

---

## 附:实施偏差记录(v0.1.0,2026-09-20)

开工时按代码现实修正了 PLAN 的 6 处设定。以下与正文冲突时**以本节为准**。

| # | PLAN 原文 | 实施决定 | 原因 |
|---|---|---|---|
| 1 | §13.1.3 开工前提是 sql-index-advisor 完成 M3,从它复制 llm/report/mcp/action | **反转复制方向**:本项目先建,四模块按"可整目录拷走"形态写(sql-index-advisor 反过来抄这里) | 前置项目一行代码都没有,阻塞无意义;"先复制不抽包"不变 |
| 2 | §7 数据流暗示对 diff 片段做分析 | 引入 `ReviewUnit{content 全文, addedLines}`,规则一律跑全文,引擎按 addedLines 过滤 | SPR001/002/004/005、MYB002 需要的信息(同类其他方法、类级注解、完整循环体)在 hunk 里不存在 |
| 3 | MYB003 触发条件 `like '%...%'` | 追加 `concat('%', #{x}, '%')` 与 `<bind value="'%' + …">` 两种形态 | XML 里 `#{}` 不能进引号,现实代码几乎都是 concat 形态;只匹配字面量等于规则不存在 |
| 4 | MYB005 无 where 且无 limit 即报 | 从 mapper 接口(namespace→同名 .java)识别 `IPage`/`Page<T>`/PageHelper 并豁免;`${ew.*}` 视为有界 | 否则 MyBatis-Plus 项目的每一个分页查询都会误报 |
| 5 | MYB001 一律 error | `${ew.customSqlSegment}`、`${criterion.criteria}`、`<property>` 绑定名、动态 ORDER BY/列名 → 降 warn 并给白名单方案 | 这些是合法用法,误报会被第一批用户当场指出 |
| 6 | §8 GitHub Action 用 `actions/github-script` 发行级评论、重复触发时更新 | 改走 check-run **annotations**(`::error file=,line=::`),行级 review comment 推到 v0.2 | annotation 天然显示在 PR 的 Files changed 行上,零 API 调用、零去重状态;D9~D11 的排期因此才成立 |

另外三处小调整:抑制注释同时支持"同行"与"上一行"(PLAN 只写了对下一行生效);
成员级发现统一报在**注解行**而非签名行;新增 `.spring-review.json`(exclude /
disable / minSeverity),因为团队级关闭比满仓库散落 disable 注释干净。

实测确认:`spring-review` 与 `spring-diff-review` 在 npm 均为 404 未占用,直接用正名。
