# Development process — dsh-outsideread-switch

> **这个文档是开发记录，按当时的样子保留。** 插件曾用名 `dsh-plugin-permission-guard`，在 2.0 之
> 后更名为 `dsh-outsideread-switch`（`dsh-plugin-permission-guard` 作为 npm 包名已废弃）。**下面提到
> 旧名的地方多数是历史事实的记载**——当时的四档设计、当时的目录、当时的 diff——改写它们等于伪造记录。
> 需要判断"现在叫什么"时，以 `package.json` 的 `name` 为准。
>
> 变更点：包名与 bundle 名、`plugin.name`、客户端 bundle id、日志前缀、状态接口路径
> （`/permission-guard/state` → `/outsideread-switch/state`）均已更名。**状态文件名 `permissions.json`
> 保持不变**，因为它同时是 self-escalation 围栏的匹配依据，改名会牵动保护逻辑而收益为零。
>
> 另外，注册给模型的工具也从 `permission_mode` 更名为 **`outside_read`**——旧名是四档时代的遗留，而它
> 现在管的是"外部可读"。**下面凡是提到 `permission_mode` 的地方都是那次改名之前的事实记载**，读作
> `outside_read` 即可。

实现 `<workspace>\<spec-file>` 里那四个权限档位，作为**工具层**的文件读写围栏。

How this plugin was built, what was measured, and every bug found along the way — including the
ones in the tests and in the diagnosis. It is kept because the reasoning is the reusable part: most
of these bugs were invisible to inspection and only appeared under a measurement designed to catch
them.

> **About the paths below.** Absolute paths from the development machine have been replaced with
> placeholders, so the text is portable and free of anyone's home directory:
>
> | Placeholder | Was |
> |---|---|
> | `<DSH_HOME>` | the harness home, typically `~/.dsh` (`%USERPROFILE%\.dsh` on Windows) |
> | `<workspace>` | the session workspace this plugin was developed in |
> | `<plugin-dir>` | `profiles/desktop/plugins/dsh-plugin-permission-guard` under the harness home |
> | `<state-file>` | the plugin's mode state file, `permissions.json` |
> | `<spec-file>` | the original four-mode requirements document |
>
> Nothing else was altered; the record is otherwise verbatim.

## 四个档位

| # | 名称 | 工作区读 | 工作区写 | 工作区外读 | 工作区外写 |
|---|---|---|---|---|---|
| 1 | Workspace read 工作区查看 | ✅ | ❌ | ❌ | ❌ |
| 2 | Workspace write 工作区内修改 | ✅ | ✅ | ❌ | ❌ |
| 3 | Outside readable 非工作区可读 | ✅ | ✅ | ✅ | ❌ |
| 4 | Full access 完全权限 | ✅ | ✅ | ✅ | ✅ |

**名字与语言的分工**：文件里的 `name` 字段与宿主侧 `modes.js` 用**英文**（`Workspace read` 等），
因为它们是**被持久化的机器可读值**；界面文案不在这里，由客户端按档位 id 查本地词典，而中文名
（`工作区查看` 等）只作为 `nameZh` 保留在 `modes.js` 一处，避免同一份翻译散落到多个文件。

当前档位存在插件目录内的 `permission-guard\permissions.json`（即 `index.js` 旁边的
`__dirname/permissions.json`），不在工作区根。三种切换方式都立即生效：

- **输入框左侧的「权限」按钮**（本插件自带的客户端 UI，见下节）
- 用编辑器改里面的 `mode` 数字（人类操作，不经过工具围栏）
- 调用 `permission_mode` 工具

**生效是有代价的**：`currentMode()` 每次检查都重读该文件，不做缓存。早期版本用 `modeCache`
记住了第一次读到的档位，导致手改文件不生效、README 的"立即生效"是假的——所以这里宁可每次
多读几百字节，也不留一个过期的权限判定。

## 与旧版（内核沙箱）双向同步

旧版指 DSH 自带的沙箱/审批档位，新版指本插件的四档。两者独立，现在互相跟随。

| 旧版 | → 新版 | 新版 | → 旧版 |
|---|---|---|---|
| 仅可查看 `read-only` | 1 | 1 | `read-only` + 审批 `ask` |
| 工作区内修改 `workspace-write` | **2**（默认） | 2 | `workspace-write` + 审批 `ask` |
| 完全权限 `danger-full-access` | 4 | 3 | **`workspace-write`** + 审批 `ask` |
| | | 4 | `danger-full-access` + 审批 `never` |

### 内核不需要"读围栏"

这是本插件最容易搞错的一点，我第一版就错了：

**`workspace-write` 只限制"修改"，读取在任何内核模式下都不受约束。** `dsh-fs-sandbox` 的源码
原话是 *"Reads pass through untouched: every mode permits reading"*，而且可以直接实测——策略为
`workspace-write` 时读工作区外**成功**。

所以"工作区外可读"**不需要内核做任何事**。我最初把新版 3 映射到 `danger-full-access`
（以为不这样就读不了工作区外），后果是**内核比档位声称的更宽**：工作区外**写**被内核放行，
"工作区外不可写"只剩工具层围栏在守。可观测的症状就是——**选中"非工作区可读"时，内置选择器显示
"完全权限"**，因为内核真的处于 `danger-full-access`。

正确映射让内核**恰好**表达每个档位的写侧：

| 档位 | 写侧语义 | 内核映射 |
|---|---|---|
| 1 | 工作区不可写 | `read-only` |
| 2 | 工作区可写、区外不可写 | `workspace-write` |
| 3 | 工作区可写、区外不可写 | `workspace-write` |
| 4 | 区外可写 | `danger-full-access` |

**不变量：内核写入权限永远是档位权限的子集**（有断言锁定）。只有档位 4 能到
`danger-full-access`。代价是档位 2 和 3 在内核侧同值，选择器对两者都显示"工作区内修改"——
这是**对内核的如实描述**；档位 3 多出来的"读工作区外"内核本来就对每个模式都放行，不是它给的。

旧版的 `workspace-write` 按你的要求映射到新版 **2**。

### 触发方式

- **旧 → 新**：监听 `session/event` 里的 `sandbox/mode` 事件。预设切换就是往会话日志追加这个事件，
  所以能观察到。
- **新 → 旧**：向**每个活动会话**追加 `sandbox/mode`，并对该会话的活动 agent 调
  `approval.setPolicy`。这个动作有**三个**触发点：

  | 触发点 | 来源 |
  |---|---|
  | `permission_mode` 工具 | 模型请求切档（受单调守卫限制，不能借它提权） |
  | **状态文件被编辑**（目录监听 + 150ms 去抖） | 人类用编辑器改档位——**文档写明的人类操作** |
  | 启动时的首次读取 | 让持久化档位与内核在重启后重新对齐 |

  第三个触发点是在 1.0.2 才补上的。在此之前"新 → 旧"只由工具触发，于是**人类编辑文件这条路径上
  没有任何代码**——详见下面「四个 bug，全部来自外部」。

### 防自激

两个方向都会写对方，所以**每次程序化写入都包在 `sync.apply()` 里**（深度计数守卫），两个监听器
忽略在守卫内观察到的事件。没有它，每次写入都会被当成外部变化然后无限回声。

### 会话初始化不是"用户更改"（修过一个真 bug）

旧版会在**每个新会话创建时**重新钉一遍权限：

```js
ctx.on("session/created", (session) => this.pinInitialPermission(session))
pinInitialPermission(session) {
  ...
  setSandboxMode(session, spec.sandbox)          // 追加 sandbox/mode 事件
}
// 无覆盖的会话：
if (sandbox === null) setSandboxMode(session, this.ctx.shell.sandboxMode)
```

`ctx.shell.sandboxMode` 是**部署默认值**（`workspace-write`），不是本插件的档位。于是：

```
新会话创建 → 追加 sandbox/mode=workspace-write → 映射为 2 → 覆盖掉手改的 4
```

**实际症状**：你手改成 4，任何一次新会话（含子会话）都会把它悄悄变回 2。

修法是利用一个源码事实：**一个会话的第一个 `sandbox/mode` 事件必然是这次 pin**，所以跳过它；
之后的事件是用户在预设里真正切换，照常同步。被跳过的次数记在 `status` 的
`sync.sessionPinsIgnored`，日志也会打印——**不静默**。

已知残余：某会话在还没有任何 pin 事件之前就被改，那次改动无法与 pin 区分，会被跳过。
这是信息论上的限制（两者产生完全相同的事件），只能靠日志可见来补偿。

### 实测验证（2026-09-11）

双向同步**实测通过**，证据来自内核自己写入模型的两条运行时上下文——它们由上游
`sandbox-policy` 与 `approval` 服务生成，**不是本插件的输出**，所以能证明"内核采纳了"
而不只是"我的代码执行了"：

| 阶段 | 档位 | `Current DSH file policy` | 审批 |
|---|---|---|---|
| 起始 | 3 | `workspace-write` | `ask` |
| → 4 | 4 | **`danger-full-access`** | **`never`** |
| 等 10 秒 → 2 | 2 | **`workspace-write`** | **`ask`** |

计数同时吻合：`newToOld: 2`、`echoSuppressed: 6`（两次切换 × 3 个活动会话，全部被识别为
自身写入）、`writeFailures: 0`。

另有两条独立验证：

- **档位 2 读工作区外被拒**，切到 4 后同一操作成功 → 围栏按档位严格工作。
- **档位 4 时工作区外实写成功**（`<DSH_HOME>\_kernel_probe.txt`）；而更早一版在
  同样档位下删除 `D:\测试\测试图片.jpg` 被系统报"访问被拒绝"——那时同步还没生效。
  两次对比说明内核对 `danger-full-access` 的采纳是真的。

### 一个必然的观感问题：档位 2 与 3 在内核侧同值

内核**只围栏写、不围栏读**，所以"工作区外可读"这个差异**在内核里没有位置可放**。修正映射后：

```
档位 2 → workspace-write     档位 3 → workspace-write（+ 审批 ask）
```

两者内核状态完全相同，内置选择器对它们显示**同一个名字**。这不是缺陷，是内核事实的推论：
它与档位一一对应的只有**写侧**，"读工作区外"这个能力只存在于本插件的工具层围栏里。

如果你希望选择器与档位**永远一一对应**，唯一办法是**砍掉档位 3、回到三档**——那时档位
与内核三值完全同构，选择器永远准确，代价是失去"档位 2/3 分开"这个区分（该区分在功能上
只体现为本围栏是否放行工作区外读）。

### 已知边界（不粉饰）

- **旧版没有部署级 setter。** `sandboxPolicy.defaultMode` 是只读 getter，来自组合配置、只在启动时
  读取；运行期的写入口只有 per-session 的 `sandbox/mode` 事件。所以"新 → 旧"作用于**当时活着的
  所有会话**；**之后新建的会话**会从组合默认值开始（并且它的 pin 会被上面的规则跳过，所以不会
  反过来覆盖你的档位）。`status` 里的 `sync.note` 会如实报告这一点。
- **旧版是 per-session、新版是全局。** 一个会话改旧版会改全局新版（旧 → 新），这是按你的规格做的，
  但意味着两个会话无法持有不同的新版档位。
- 同步只覆盖 `sandbox/mode` 事件；直接改组合配置重启不属于运行时同步范畴。

## 四个 bug，全部来自外部——以及一个由修复引入的断裂

发布 1.0.0 之后，四个问题被报了出来。**没有一个是这套 900 行测试自己发现的**，这个模式比 bug 本身
更值得记：每一个都发生在测试照不到的维度上——**报告者用自己的方式使用产品**、或者**一个独立实现
静态检查代码**。

| # | 问题 | 谁发现的 | 为什么测试没抓到 |
|---|---|---|---|
| 1 | 守卫缺失时 `permission_mode` 仍能改档位（fail-open） | socket.dev 静态分析 | 测试上下文里永远有 `tools.guard`，那条分支从未被执行 |
| 2 | 状态接口返回文件系统路径 | socket.dev 静态分析 | 断言只检查"字段存在"，从不检查"是否泄露" |
| 3 | 反向同步（新 → 旧）不工作 | **操作者现场报告** | 我测的是**工具**切档位，他用的是**编辑器改文件** |
| 4 | 回退工作区是程序安装目录 | 操作者贴的完整输出 | 本机 `process.cwd()` 恰好合理，另一台机器不合理 |

### 1 和 2：静态分析发现的是"我们的措辞掩盖了事实"

fail-open 那条，我原本的处理是**警告 + 汇报**，并在 README 里写成"降级并如实汇报"——读起来像是
已经处理过了。它不是。**"模型能提权，但我们会记录"不是控制。**

这条的教训不是"要 fail-closed"（那很明显），而是：**当一个取舍被写进文档时，很容易在文档里把它
叙述成一个已解决的问题。** 静态分析不受这种叙述影响，它只看代码做了什么。

修法：守卫缺失时工具变为**只读报告**，切换一律拒绝。代价很小——旧构建上模型失去"用工具切档位"
的能力，而这从来不是受支持的操作路径。

### 3：我用不同的方式使用产品，所以测出了不存在的一致性

操作者报告"旧版能同步到新版，反过来不行"。他给的完整状态里：

```
oldToNew: 2          ← 他通过内置选择器改过两次
newToOld: 0          ← 从未执行
echoSuppressed: 0    ← 证明 applyToOld 一次都没跑过
```

**`newToOld: 0` 不是失败，是"从未尝试"。** 反向推送只由 `permission_mode` 工具触发，而界面指示器
是我**故意做成只读**的（可写的 HTTP 路由会被 agent 的 shell 触达），所以文档写明的人类操作是
"编辑状态文件"——**那条路径上没有任何代码**。

我开发时的"验证"是用工具切的档位，于是 `syncPush` 被调用、测试通过、我确信这个方向好用。
**我和操作者用的是两条不同的路径，而我只测了自己那条。**

### 4：一个只在本机成立的默认值

第二台机器的完整输出暴露：

```
fallbackWorkspaceSource: "process.cwd()"
fallbackWorkspace:       "C:/Program Files/DSH Desktop Beta"
```

我把硬编码路径换成 `process.cwd()` 时，在开发机上它恰好是个合理值。**在 DSH Desktop 上它是应用程序
安装目录**——不是任何人工作的地方，所以任何走到回退分支的调用，都会把真实工作区判定为"工作区外"。

现在回退到**用户主目录**：它必然位于任何工作区之外，因此误判方向是**拒绝**而不是**放行**。

### 而 1 的修复又制造了 3

时间顺序值得写清楚：我先修了 fail-open（问题 1），加了"无守卫则拒绝切换"。**这切断了 `syncPush`
唯一的触发点**，于是反向同步在那台机器上彻底断掉（问题 3）。

也就是说，那个修复**让同步变得更差**，而我的新测试只断言了"拒绝"，没断言"拒绝之后同步怎么办"。

**教训**：给一条路径加限制时，要问"这条路径上还挂着哪些副作用"。`permission_mode` 的 `execute()`
不只改档位，它还调用 `syncPush`——我在第一个 `return` 之前没有检查后面还有什么。

### 测试自身也走了两次弯路

两次都是**对正确的实现报失败**，而假失败比没有测试更糟——它会训练人忽略结果：

1. **用 `Atomics.wait` 死等防抖定时器。** 行为断言被塞进同步的 `test-matrix.js`，而阻塞事件循环
   恰好杀死了它要等的那个定时器。修复：行为测试移到独立的**异步**文件 `test-watch-sync.js`。
2. **贪婪正则越过函数边界。** 断言 `fallbackWorkspace` 的内容时用了 `[\s\S]*?\n}`，扫进了整个文件，
   其中的 `process.cwd()` 让正确实现报错。修复：用 `[^}]*` 并在注释里写明原因。

### 现在补上的断言

| 断言 | 防的是 |
|---|---|
| 无 `tools.guard` 时切换被**拒绝**，且磁盘档位不变 | 问题 1 |
| HTTP payload 字段集合恰为 `id/name/summary` | 问题 2 |
| 人工编辑状态文件 → 推送到**每个**活动会话与审批策略 | 问题 3 |
| 重复通知（无实际变化）**不重复推送** | 编辑器一次保存发多个事件 |
| `fallbackWorkspace` 用 `os.homedir()` 而非 `process.cwd()` | 问题 4 |
| 从**打包产物**安装后再驱动 `node_modules` 里的副本 | "在仓库里能跑" ≠ "用户拿到的那份能跑" |

最后一条尤其重要：这个包的价值全在**行为**上，而"仓库里通过"在本项目里已经错过不止一次。

## 客户端 UI：输入框左侧的只读档位指示器

`client.js` 在 `conversation.input.left` 槽位注册一个控件，显示当前档位；点开是四档说明列表，
**当前档位高亮，但不可点击切换**。

### 两个 `inject` 不是一回事（踩过坑）

客户端插件有**两处** inject 声明，名字一样、含义完全不同，混用会导致"加载成功但拿不到服务"：

| 位置 | 内容 | 作用 |
|---|---|---|
| bundle 的 `exports.inject` | **服务名**，如 `["slots", "remote"]` | **决定哪些服务被挂到插件的 ctx 上** |
| `package.json` 的 `dsh.client.inject` | **包名**，如 `["@deepseek-ai/dsh-client-ui-renderer"]` | 加载顺序 / 依赖解析 |

证据来自随包发布的代码：

```
dsh-client-resources       package.json → ["@deepseek-ai/dsh-client-ui-renderer"]
                           client.js    → ["slots"]
dsh-client-locale          client.js    → ["slots", "remote", "settingsScope"]
```

`dsh-client-resources` 的 manifest 里**没有**任何与 slots 相关的东西，但它的 bundle 声明了
`"slots"` —— 所以 **`slots` 由 bundle 侧那一份决定**。

我一开始把包名写进了 bundle 侧（`"@deepseek-ai/dsh-client-ui-slots"`），结果 `ctx.get("slots")`
在 DSH Desktop 上仍然是 `undefined`。顺带一提，那个包名本身也是错的：该包只有 `lib/index.js`，
**没有 `lib/client.js`，也没声明 `dsh.client`**，根本不是客户端插件包。正确值就是 `"slots"`。

### 为什么是只读的

切换档位需要一条**写入**通道。而唯一对 profile 插件开放的 HTTP 路由**不经过 `tools/pre-execute`**，
所以一个 `POST /permission-guard/mode` 会被 agent 自己的 shell 用 `curl` 调到 —— 那正好重新打开
`fenceSelfWrite` 专门堵上的自我提权洞（CVE-2026-82533 的形态）。

我确实可以自己写 Origin/Host 校验来缓解，但 `/api` 那套校验是经过披露和修复的产品代码，
我不想把安全边界建立在自己的判断上。所以：**UI 只读，写入仍走 `permission_mode` 工具或直接编辑文件。**

路由只支持 `GET`/`HEAD`，其余方法返回 405 —— 这条有断言。

### 数据怎么来的：HTTP 路由，不是 host RPC

`harness.handle` + `host.call` **只存在于动态插件执行器内部**：

```js
handlers: new Map()                              // 每个动态 run 私有
handlers: [...plugin.run.handlers.keys()]        // 状态只暴露本 run 的
"Cordis Host handler ${pluginId}/${run.packageId} ... when the Client called host.call(...)"
```

全树 11342 个代码文件里只有 4 个提到 `host.call`，全在 `dsh-cordis-*-runner`。**这条路对 profile 插件
是设计上封闭的**，不要再试。

可用的接缝是 `webServer.register({ kind, path, handler })` —— 宿主插件能注册原生 Node 路由。
所以：

```
宿主  ctx.inject(['webServer'], ...) → 注册 GET /permission-guard/mode
客户端 fetch('/permission-guard/mode') → { id, name, summary, workspace }
```

客户端在挂载时与窗口重新获得焦点时各读一次（没有推送通道，档位也可能被工具或文件改动）。

### 客户端 bundle 必须自己向模块加载器注册

这不是一个普通模块。外壳把所有 `dsh.client` 包**拼成一个脚本**，每一段必须自己注册：

```js
window.__ModuleLoader__.load({
  id: "dsh-plugin-permission-guard",     // 必须等于包名
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    ...模块代码...
    exports.apply = apply
    return module.exports
  }
})
```

**只写 `exports.apply` 是不够的**：bundle 会被正常伺服、正常加载，然后在最后一步失败：

```
bundle /plugins/... loaded without registering "dsh-plugin-permission-guard" via __ModuleLoader__.load
```

这个错误在 UI 里表现为"插件加载失败"。`test-client-contract.js` 用 stub 的 `__ModuleLoader__`
**真的执行一遍** bundle 并调用 `factory` → `apply`，锁定这个契约。

## 为什么不能复用内置的 `/permission` 选择器

试过，三条独立原因让它不可行：

1. `permissions` 这个 projection key 上游用 `stateVersion: 2` 注册。用别的版本注册同一个 key
   会被注册表拒绝，并让上游入口加载失败、**整棵插件树挂掉**（这条已实测，是启动故障）。
2. 选中会写 `sandbox/mode` 事件，其封闭三值词表由 invariant 插件强制，没有第四个值可写。
3. 最根本：选择器的选中态靠 `(sandbox, approval)` 两个旋钮的值反推，而档位 2 和 3 只差
   "工作区外是否可读"——这个维度旋钮**不存在**，UI 永远分不清。

这三条都写进了 `test-matrix.js` 的回归断言，防止我再犯。

## 与内核沙箱的关系（重要）

上游的旋钮**全是 per-session 的**，且没有部署级 setter：

```
sandboxPolicy.defaultMode     只读 getter
approval.setPolicy(agent, …)  需要 Agent
sandbox/mode 事件              追加到单个会话日志
```

所以本插件**不去改内核**。档位由本文件唯一决定，围栏是权威。两者叠加是安全的：
**内核只可能比本插件更严，不可能更松**，所以取两者中更严的那个。

副作用要知情：档位 3（工作区外可读、不可写）在**内核**看来仍可能是 `workspace-write`，
此时工作区外的**写**会被内核先拦下——结果正确，但拒绝信息来自内核而非本插件。

## 权限状态文件不能被 agent 改写

`permissions.json` 由插件自己持有（`__dirname` 旁边）。**绝对路径的写法本身不是安全边界**：
在源码树里它是 `<workspace>\permission-guard\permissions.json`，仍落在工作区内；只有装到
`<plugin-dir>\` 之后，它才真正位于
工作区**之外**，agent 连读都要看档位 3/4。移进插件目录的价值就在这里，但"移进去"和"装进去"
是两件事，只有后者才换来内核层的隔离。

无论落在哪，把该文件当选写入目标的操作一律拒绝（`write`、`edit`，以及 shell 命令）。人类用
编辑器改不受影响，因为那不走工具层。

**shell 围栏是这个机制里被真实打穿过的一环，值得单独说。** 第一版只认 PowerShell cmdlet 和
POSIX 命令（`Set-Content`、`rm`、`Move-Item`…），结果用 `node -e "fs.renameSync(...)"` 搬走
状态文件时**完全没有触发**：`renameSync` 不在动词表里，于是没有任何路径被抽出来比较。脚本级
文件 API（`node -e`、python heredoc）恰恰是 agent 在 cmdlet 不好用时最自然会走的路。现在：

- `SCRIPT_MUTATION_VERBS` 覆盖 `writeFile(Sync)`、`rename(Sync)`、`unlink(Sync)`、`rmSync`、
  `copyFileSync`、`mkdirSync`、`createWriteStream`、`write_text`、`shutil.move`、
  `os.rename`、`[IO.File]::` 等写法；
- 命中动词后，不看路径抽取结果，而是**直接在命令原文里找状态文件**（归一化 `\`→`/` 后比
  全路径与文件名）。因为抽取是刻意严格的，嵌在脚本字符串里的路径常常根本不会成为独立
  token——引号嵌套会把路径切碎，而 `permissions.json` 这个文件名还可能被 tokenizer 整个丢掉；
- 仍然只管**会写**的命令：`Get-Content ...\permissions.json` 照常放行。只拦写不拦读是有意的，
  而"只拦写"正是让那次移动溜过去的原因，不是因为审查过严。

**围栏按文件名认，不按某一个绝对路径。** 这条也是被打出来的：把 `isStateFile` 收窄成"等于
`STATE_FILE` 那一个路径"之后，**工作区根那份遗留副本就不再受保护**——两次用 `write` 工具写它
都被放行，而同一个会话里插件对别的路径判定正常，说明围栏是活的。旧代码反而认得那份副本，
所以那次"把文件搬进插件目录"一度是**净削弱**。

现在只要目标**文件名**是 `permissions.json`（或它改名前的 `<state-file>`），无论在哪个目录，
`write` / `edit` / shell 一律拒绝。别处的同名文件也会被误拒——这是刻意选的一侧，代价是一次
被拒的调用，收益是堵住一个提权路径。

**改名本身也会开洞，所以两个名字都永久受保护。** 只保护当前名的话，旧名会在
`adoptRenamedStateFile()` 把它当作合法来源读取的**同一时刻**变成可自由写入——围栏必须覆盖
自己那次改名。

## 单一真相源：只有插件目录那份算数

**`<插件目录>/permissions.json` 是唯一的权威。** 别处的同名文件——尤其是工作区根那份——一律
**不被读取**，也不参与任何判定。

这不是一开始的设计。最初的版本在权威文件缺失时会去工作区根读一份作为迁移来源，理由是"文件
被搬走"和"从未配置过"在 `loadMode()` 眼里一样，只能一起降到档位 1。后来按操作者的决定**删掉
了整条回退链**，理由值得留下：

- **回退来源就是攻击面。** 任何"agent 能写、插件以后会信"的文件，都是延迟生效的自升权：现在
  埋一个宽松档位，等权威文件消失的那天被抬成正牌。
- **它只在降级路径上触发**，所以是**最少执行、最少被观察**的一段代码——恰恰是错值危害最大的
  位置。
- **"哪个文件算数"有两个答案，而两者可能不一致。**

代价被明确接受，而且**可见**：权威文件丢了，档位就降到 `DEFAULT_MODE_ID`（1），直到人类恢复。
这是 fail-**safe** 方向——操作者丢失自己声明的档位，好过 agent 继承一个自己写的档位。为了让
"丢失"不是静默的，`apply()` 在文件缺失时会按 fail-safe 档位**重新落盘**。

### 唯一被允许的例外：同目录改名交接

文件从 `<state-file>` 改名为 `permissions.json` 时，光靠上面的规则会让**每一次升级都悄悄降到
档位 1**——一个纯装饰性的改名造成的权限变更。所以 `adoptRenamedStateFile()` 会在这一个条件下
读旧名文件：**权威文件不存在**、**同目录**、且**沿用**操作者已选的档位。

它和被删掉的那条回退链有三点不同，这也是它被允许回来的全部理由：

| | 被删的回退链 | 改名交接 |
|---|---|---|
| 读取位置 | 工作区（agent 可写） | 仅同目录兄弟文件 |
| 触发时的选择 | 去别处**找**一个档位 | **沿用**已选档位 |
| 成功后 | 留下第二份副本 | **删除**旧文件 |

"成功后删除"是关键的第三条：它保证只能发生一次，也让"旧文件被重新种回来"不再是一条活路径。
永久留一份副本正是我们删掉回退链的原因；一次性消耗掉的不是。

回退链与改名交接的区别不在"读了一个文件"，而在**它会不会改变档位**：改档位的回退危险，保档位
的改名不危险。

因此，**重建权威文件是人类的动作**：用编辑器创建/修改插件目录里的 `permissions.json`，或在
选择器里切换。除上述改名交接受理一次外，"帮 agent 把档位找回来"的自动回退都被刻意去掉了。

## 界面语言跟随系统

客户端 UI 从 `locale` 服务读当前语言（`getSnapshot().active`），按**前缀**匹配（`zh-CN`、
`zh-Hant`、裸 `zh` 都命中中文），未知语言落到英文——与 DSH 自己的 fallback 链终点一致。语言
在渲染时读取而非拷进 state，所以切换语言不需要重启。`locale` 服务不可用时退回 `navigator.language`，
再不行用英文：**降级的是文案，不是控件本身**。

**没有用 `ctx.locale.register`。** 那是一套真正的词典注册表，用它意味着把这六个字符串交给内置
语言切换器管理，很有吸引力。放弃它的理由只有一个：本插件的 UI 就是单个只读指示器，向**共享**
命名空间注册要冒重复 `(ns, locale)` 抛错的风险，而带类型的注册形式要求**每一种内置语言**都提供
词典——上游下次新增语言时必然漂移。本地表不会在运行时失败，代价只是放弃这六个字符串的第三方翻译。

"跟随语言"和"自己持有词典"是两件可分开的事，这里只放弃后者。

选择器本身也是：上游的 `permissionPresets` 服务在这里**完全不参与**。档位的真相只在那个文件里。

## 为什么必须建在工具层

上游的沙箱**只围栏写入**，而且它的 `SandboxMode` 是**封闭三值**词表
（`read-only` / `workspace-write` / `danger-full-access`），在三处独立强制：策略配置的
`z.literal`、运行期 `SANDBOX_MODES` 校验、以及一个会拒绝未知 `sandbox/mode` 事件的
invariant 插件。`dsh-fs-sandbox` 的源码注释写得很直白：

> Reads pass through untouched: every mode permits reading.

所以"非工作区不可读"（档位 1、2）**在上游没有任何执行机制**，四个档位里有两个完全
无法用上游预设表达。这不是配置问题，是词表封闭 + 只围栏写入两个事实叠加的结果。

## 这不是内核边界

这话必须说清楚，否则你会高估它。

- **文件工具判得准**：`read` / `read_image` / `write` / `edit` / `glob` / `grep` /
  `str_replace_editor` 的路径参数是结构化的，判定精确。
- **shell 只能启发式**：`pwsh` / `bash` 靠从命令文本里抽路径。它能挡住
  `Get-Content "C:\x"`、`cat ../y` 这类正常写法，但**挡不住刻意混淆**——变量拼接、
  编码字符串、运行时加载的脚本内容都能绕过读取限制。
- 内核级隔离仍然只能靠 `ctx.shell` 的沙箱，而那个沙箱只认那三个模式。

也就是说：档位 1/2 的"不可读"对**文件工具是硬围栏**，对 **shell 是尽力而为**。

## 其他已知边界

- **档位是进程内全局状态，不按会话隔离。** 两个会话共享档位，一个会话切换会影响另一个。
- **`security-guard` 的优先级更高。** 它会拦住对 `.dsh` 控制面的写入，**档位 4 也不例外**。
  这是刻意的纵深：档位 4 表示"允许你改工作区外的文件"，不等于"允许模型改自己的权限配置"。
- **内部错误时 fail-open。** 围栏自身抛异常会放行该次调用并打日志。理由：一个 bug 不该
  把所有工具调用卡死。代价是"静默放行"和"正常通过"看起来一样，所以状态里的计数器要盯着。

## 验证

`node test-matrix.js` —— 把真实插件挂上假的 `tools/pre-execute` 监听器，跑四档 ×
工作区内外 × 文件工具/树工具/shell 的完整矩阵。测试不重写策略，只用矩阵断言实现。

开发过程中这个矩阵抓到了四个真实缺陷：

1. **shell 路径提取把命令名当成路径** —— `Get-Content` 含连字符，被当成相对路径，
   导致工作区内的正常读取被拒。
2. **带引号的路径又被空格拆开** —— `"<workspace>\sub\f.txt"` 拆出的
   `D:\DeepSeek` 被解析成工作区外的 `D:/DeepSeek`，同样误杀正常读取。
3. **`execute` 写成了 `async`** —— 签名与调用方期望不符，调用方拿到 `undefined`。
4. **审计条目漏了 `reason` 字段** —— 拒绝理由本身正常，但环形缓冲里记的是
   `undefined`；持久化 sink 不可用时环形缓冲是唯一的审计面，所以这是真的丢证据。

四个都是"能跑但错"的那一类：不写矩阵根本发现不了。

现在矩阵还额外锁定了三组本轮补上的行为：

- **脚本级文件 API**：`fs.renameSync` / `writeFileSync` / `unlinkSync` / `shutil.move` 搬动或
  改写档位文件 → 拒绝；同一命令作用于无关文件、以及只读脚本提及档位文件 → 放行。反向用例是
  刻意的，防止"加固"变成"禁止一切脚本"。
- **单一真相源**：别处的副本被**忽略**；权威文件缺失时降到 fail-safe 档位 1，**不会**回退到
  别处的副本；`apply()` 会把降级后的档位重新落盘，让丢失可见。
- **改名交接**：旧名被**沿用**而不是降到 1；结果写到新名；旧名被**删除**；且只能发生一次
  （消耗后再跑就落到 fail-safe 1）。
- **围栏覆盖两个名字、任意目录**：当前名与旧名在工作区根或任意子目录下，经 `write` / `edit`
  一律拒绝；无关路径仍放行。

客户端契约测试另外覆盖了**界面语言**：`zh-CN` 渲染中文、`en` 渲染英文、`zh-Hant` 按前缀命中、
未知语言落到英文，以及**展开面板后四种模式名的两种语言**。这些断言需要真的渲染组件并展平
文本树，所以测试替身的 `createElement` 必须像真 React 那样把 children 放进 props——旧替身
直接丢掉 children，会让任何"检查渲染文本"的断言**静默通过**，比测试失败更糟。

另外三个探针（都在 `probes/`，都是只读的，且档位期望值自校准，不写死数字）：

| 探针 | 回答什么问题 |
|---|---|
| `node probes/verify-installed.js` | **已安装**的那份读的是不是 `<插件目录>/permissions.json`？仓库源码的 `__dirname` 不是安装目录，所以这套断言必须单独跑；它同时逐文件比对 SHA-256，回答"运行的是不是刚写的代码" |
| `node probes/check-pollution.js` | 跑完整测试套件后，档位文件是否**原样**恢复？ |
| `node probes/independence.js` | 本插件与 `dsh-plugin-security-guard` 是否互相独立、拆掉任一个另一个是否仍能工作？ |
| `node probes/mode-escalation.js` | **agent 能否自行改档位？** 逐条驱动真实监听器，覆盖直接写名、shell/脚本、硬链接别名、以及 `permission_mode` 工具本身；并断言探针没有改动线上档位 |
| `node probes/workspace-resolution.js [目录]` | **换一个工作区会不会误判？** 用替代工作区驱动围栏，并检查插件**告诉模型**的工作区与**实际执行**的是否一致。可选参数指定驱动哪一份（仓库副本用于部署前验证，默认已安装副本） |
| `node probes/multi-workspace.js [目录]` | **同时开着多个工作区会怎样？** 两个活会话分处两个工作区，正反两种列表顺序各测一遍，并单独验证执行侧不受影响 |

## 多个工作区同时开着

`sessions.list()` 返回**所有活会话**（发货代码用它做跨工作区搜索，还要用 `sameWorkspace` 标注
候选），所以"从列表里挑第一个有 `cwd` 的"**就是在猜**。用两个活会话实测：

```
list [A,B] -> Workspace = <workspace>
list [B,A] -> Workspace = E:/Projects/MyOtherWorkspace
```

**同一个会话、同一份代码，报告的边界随列表顺序变化。** 这是本插件第二个"执行对、报告错"的
bug，比第一个更隐蔽——单工作区下永远看不出来。

**执行侧从来不受影响**（三个断言：B 会话能在 B 内写、不能在 A 内写；A 会话能在 A 内写），因为
它用的是 `exec.agent.session.header.cwd`，是精确值。

修法是让报告也从**调用方自己的会话**取值，而不是从列表里挑。提示词装配上下文本身就带着请求方
的 agent——发货 host 构造的是 `{ agent, scope: agent }`，它自己的 provider 也读
`context.agent.session.header.cwd`。之前的代码**把这个上下文整个丢掉了**，那才是根因。

拿不到 agent 时**如实写"未知"**，不再回退到"挑一个"：

```
Workspace = (not resolvable this turn; the fence uses the session's own cwd).
```

重新引入启发式回退等于把 bug 请回来：**一个自信的错值比一个坦白的未知更糟**，因为模型会照着它
行动。两个探针盯着这件事——单工作区探针断言"报告跟随 context 而非列表形状"，多工作区探针断言
"报告不随列表顺序变化"，以及"无 agent 时不得猜出任何工作区"。

## 工作区按会话区分，不是按本机写死的

`permissions.json` 里的 `workspace` 字段是**记录**，**不参与任何判定**。真正决定"内/外"的是
`resolveWorkspace(exec)`，它读 `exec.agent.session.header.cwd` —— 即**每个会话自己的工作区**。
用替代工作区实测（档位 2，此时唯一能放行写入的理由就是被判定为"工作区内"）：

| 场景 | 判定 |
|---|---|
| `E:\Projects\MyOtherWorkspace\src\main.js`，会话 cwd = 该目录 | **内**（允许） |
| `E:\Projects\MyOtherWorkspace-sibling\x.txt`，同会话 | **外**（拒绝） |
| `<workspace>\scratch.txt`，会话 cwd = 另一个工作区 | **外**（拒绝，且正确——它确实不在该会话工作区里） |
| `exec.agent` 缺失 | **拒绝**（fail-closed，绝不误判成"内"） |
| header 存在但没有 `cwd` | **拒绝**（fail-closed） |

所以换工作区**不会**出现"目标在工作区内却被判在工作区外"：只要会话有 `cwd`，围栏就跟着它走。
`cwd` 读不到时，失败方向是**拒绝**（误拒）而不是**放行**（误放）——对权限系统，这个方向可接受。

**但这暴露了一个真 bug，已修。** 边界文本（模型每轮读到的那段）原先打印一个**编译进代码的
常量**，而不是会话工作区：

```
旧： Workspace = <workspace>.          ← 无论会话在哪个工作区
新： Workspace = E:/Projects/MyOtherWorkspace.  ← 跟随会话
```

于是**执行是对的、报告是错的**：模型会以为工作区内的文件应当被拒、或工作区外的文件应当被
允许。对权限系统而言这是更危险的方向——行为正确但无法据以推理，仍会推出错误决策。

一个细节值得留下：`sessions.list()` 的条目形状是**实测**的，不是猜的。它的 `.id` 在顶层，
header 挂在 **`.session.header`**（发货代码里读作 `agent.session.header.cwd`）。猜错形状
**不会抛错，只会静默回退到常量**——正是本函数要消除的那种失败。所以已知的扁平形状也一并接受，
三种形状各有断言。

## 与 `dsh-plugin-security-guard` 的关系：互相独立

两个插件都装在 `~/.dsh/profiles/desktop/plugins/` 下，共用**同一条** `tools/pre-execute` 事件和
`tools` 服务，但**没有任何互相依赖**：拆掉任一个，另一个照常启动并继续拦截。

| | permission-guard | security-guard |
|---|---|---|
| 监听 | `tools/pre-execute`、`session/event` | `tools/pre-execute` |
| 注入上游服务 | `tools`、`systemPrompt`、`webServer`、`sessions`、`approval` | `tools`、`web`（审计另读 `fs`） |
| 注册工具 | `permission_mode` | `security_guard` |
| 对外提供任何服务 | 否 | 否 |
| 客户端 bundle | 有（`client.js`） | 无 |

**都不 `provide` 任何服务**，所以谁都不可能给谁供货——这是"独立"的机制性理由，不只是观察结果。
两者拦截的对象也不同，重叠为零：permission-guard 管**文件读写范围**（四档 × 工作区内外）；
security-guard 管**控制面写入 / 本地管理 API / 通过本地 API 改写策略**，外加 web 内容注入清洗。

**两处看起来像耦合、实际不是**：

1. permission-guard 的注释与状态报告里多次提到 `security-guard`（"它会拦住对 `.dsh` 控制面的
   写入，档位 4 也不例外"）。那是**行为描述**，不是调用；两边源码都没有 import/require。
2. security-guard 的 `writeAudit` 会 `ctx.get('fs')`——那是**上游**文件服务，不是 permission-guard
   提供的。

**一处必须知情的后果**：`security-guard` 是**纵深防御的一层**，删掉它之后，permission-guard 的四
档照常工作、**但它自己就变成了最外层**。具体代价实测如下（`probes/independence.js`）：

| 写入目标（档位 4） | 两个插件都在 | 只剩 permission-guard |
|---|---|---|
| `permissions.json`（自己的档位文件） | 拦住（security-guard 先拦） | **拦住**（自带 self-escalation 围栏） |
| `index.js`（自己的**执行代码**） | 拦住 | **放行** |
| `modes.js`（自己的**档位表**） | 拦住 | **放行** |
| `cordis.patch.yml`（组合：决定插件是否加载） | 拦住 | **放行** |
| `settings.yaml` | 拦住 | **放行** |

**这个暴露只存在于档位 4**，因为插件源码与组合文件都在 `.dsh` 下、即**工作区之外**：档位 1/2/3
不允许写工作区外，permission-guard 自己就会拦；只有档位 4 才需要 security-guard 兜底。实测
（同目录同目标，仅改档位）：

```
mode 1: index.js -> BLOCKED by permission-guard
mode 2: index.js -> BLOCKED by permission-guard
mode 3: index.js -> BLOCKED by permission-guard
mode 4: index.js -> ALLOWED
```

所以准确的说法是：**删掉 security-guard，四档限制照常工作；但在档位 4 下，permission-guard 的
执行代码与加载它的组合文件变成可写**。这不是"故障"，而是"少了一层"——`permissions.json` 仍受保护，
所以"改档位数字"这条路依然堵死；可被改的是**围栏本身的实现**，而那要等下一次重启才生效。

两者能独立**运行**，却不独立**承担同一份风险**：删除 security-guard 会降低整体防护等级。

`independence.js` 验证的内容：各自在对方缺席时能否 apply、是否各自注册工具、是否有人 `provide`
服务、源码有无交叉 import、组合条目是否自包含，以及**各自单独时是否真的仍在拦截**——只注册而
从不拒绝的监听器会骗过前面所有断言。探针驱动的是**已安装**的那两份，因为它们才是被问到的对象。

## agent 能不能自己改档位？（实测结论）

`probes/mode-escalation.js` 逐条驱动真实监听器。结论分三类：

**一、改写档位文件——两个场景都堵死**，与 security-guard 无关，靠本插件自带的 self-escalation
围栏：

| 路径 | 只剩 permission-guard | 两个都在 |
|---|---|---|
| `write` / `edit` 直接写 `permissions.json` | 拒绝 | 拒绝 |
| 旧名 `<state-file>` | 拒绝 | 拒绝 |
| 大小写变体 `Permissions.JSON` | 拒绝 | 拒绝 |
| `Set-Content` | 拒绝 | 拒绝 |
| `node fs.writeFileSync` / `renameSync` / `unlinkSync` | 拒绝 | 拒绝 |
| `python shutil.move` | 拒绝 | 拒绝 |
| **硬链接别名**（同 inode、不同名） | **放行（已知缺口）** | 拒绝 |

（上表是**文件路径**的分类；`permission_mode` 工具走的是另一条路，见下面的"二"。）

最后一行是**名称围栏的固有边界**：围栏比对的是路径文本里的文件名，硬链接是"同一个文件、
另一个名字"，文本比对看不见。`security-guard` 恰好补上它，因为它判断的是**解析后的路径是否
位于 `.dsh` 下**，与文件名无关——这是纵深防御真实生效的一个例子。

**二、`permission_mode` 工具——已由 `tools.guard` 封堵（此前的自升权路径）。**

工具由 `ctx.inject(['tools'])` 注册，因此**在 agent 的工具列表里**（已通过 Tool Inspect 确认）。
它的 `execute` 直接调用 `persistMode(found)`，**不经过 `tools/pre-execute`**——所以文件围栏从来
没有覆盖它，早期版本里 agent 可以直接调用它把自己切到档位 4。这正是"模型不能自行提权"这句话
当时**对文件路径成立、对这条工具调用不成立**的原因。

现在补上了，并且刻意放在**单调**接缝上：`tools.guard` 的契约是 *"no guard can force-allow a call
another guard denied"*，而 `tools/pre-execute` 是可扩展瀑布。必须不可绕过的控制就该放单调接缝。

判定的是**权限集合是否扩张**，不是"档位是否变了"：

| 调用 | 结果 | 理由 |
|---|---|---|
| 报告（不传 mode） | 放行 | 读取不是能力 |
| 同档（2→2） | 放行 | 无变化 |
| 收窄（4→1、2→1） | 放行 | 放弃已有权限不构成提权，且拒绝会挡住正当的收敛动作 |
| **扩张（2→3、2→4、3→4）** | **拒绝** | 这就是自升权 |

按**字段**比较（`workspaceRead/workspaceWrite/outside-read/outside-write`）而不是按档位 id，
因为"id 越大越宽"只是**当前**的事实；依赖它会让判定在档位集变化时悄悄失效。

守卫内部出错时**fail-closed**（拒绝切换），与文件围栏的 fail-open 相反：这里可接受的失败是
"切换被拒"，不是"沙箱被放宽"。

**三、改本插件的实现代码**——只有 security-guard 在守：

| | 两个都在 | 只剩 permission-guard |
|---|---|---|
| 写 `index.js` / `modes.js`（档位 1/2/3） | 拒绝 | 拒绝（工作区外，自身围栏生效） |
| 写 `index.js` / `modes.js`（**档位 4**） | 拒绝 | **放行** |

档位 4 会同时触发同步：`syncPush` 把新的 (sandbox, approval) 写到所有活动会话。

`check-pollution.js` 存在的理由是一个真实事故：测试套件原先在末尾硬编码
`permission_mode { mode: 2 }`，于是**跑一次测试就会把线上档位改成 2**。测试污染了它本来要
验证的对象。现在恢复靠启动时快照 + `process.on('exit')`，崩溃中断也能还原。

`verify-installed.js` 的版本比对同样来自事故：围栏扩展写在了一次安装**之后**，所有源码级测试
全绿，运行中的守卫却落后一个版本，于是"插件正常运行"和"插件运行的是你刚写的代码"被混为一谈。

## `package.json` 必须有 `exports["./client"]`

宿主会读 `dsh.client` 声明，并**强制**要求两者配对。缺了就在组合阶段失败，而且失败的是整个
`modules` 入口，于是整棵树挂掉：

```
client-modules: 1 client package failed to compose:
  other failures:
    - client-modules: dsh-plugin-permission-guard declares dsh.client but exports no "./client" bundle
```

所以 manifest 里这三项要**同时**存在：

| 字段 | 作用 |
|---|---|
| `dsh.client.platform: "web"` | 让宿主把这个包当成客户端插件包 |
| `exports["./client"] → ./client.js` | 提供浏览器 bundle；**缺了就是上面那条组合失败** |
| `exports["."] → ./index.js` + `main` | 宿主插件入口 |

**一条踩坑记录**：我曾把一次 `ERR_MODULE_NOT_FOUND` 误判为 `exports` 映射造成的，于是把它删掉——
结果下一次启动就报 "declares dsh.client but exports no ./client bundle"。真正的病是**安装目录多了一层
嵌套**。教训：先查文件到底在不在，再怀疑 manifest；删字段之前要能解释"那它本来为什么是对的"。

## 安装

软件包需要落在 profile 目录，而那个目录在会话工作区之外，所以安装由人类执行。

**逐文件复制并当场校验**，不要依赖单条 `Copy-Item` 的路径拼接：

```powershell
$src = "<workspace>\permission-guard"
$dst = "<plugin-dir>"
Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dst | Out-Null
foreach ($f in @('index.js','sync.js','client.js','modes.js','package.json','permissions.json')) {
  Copy-Item (Join-Path $src $f) -Destination (Join-Path $dst $f) -Force
  $p = Join-Path $dst $f
  "{0,-14} {1}" -f $f, $(if (Test-Path -LiteralPath $p) { "OK $((Get-Item -LiteralPath $p).Length) bytes" } else { "MISSING" })
}
Get-ChildItem $dst -Force | Select-Object Length,Name | Format-Table -AutoSize
```

最后一行必须列出 **6 个文件、0 个子目录**。数量随版本变化，关键是**先查文件到底在不在**，
再怀疑别的。这一条不是形式主义：早先一条
`Copy-Item <4 个源文件> -Destination <目录>` 把文件塞进了一层同名子目录，外层因此既没有
`index.js` 也没有 `package.json`，加载器如实报了
`ERR_MODULE_NOT_FOUND: Cannot find module '...\index.js'`——而文件其实在下一层。

**档位文件必须一起复制。** 它叫 `permissions.json`，是**唯一权威**。profile 目录里没有它，插件
不会崩：档位会落到 fail-safe 1，并在下次启动时把 1 落盘。也就是说漏拷它的表现是"插件正常、
档位悄悄变成 1"——一个不报错的权限变更，比崩溃更难发现。

（旧名 `<state-file>` 若还在同目录，会被一次性改名交接接管并把档位接回来，然后删除旧文件。
新装部署没有旧文件，所以直接以 `permissions.json` 为准。）

安装后建议再确认一次解析（用加载器同样的方式，而不是用 `require`），并且**额外验证它读哪个
文件**——`require` 成功只能证明语法和依赖没问题：

```powershell
node -e "import(require('node:url').pathToFileURL('<plugin-dir>/index.js').href).then(m=>console.log('OK apply='+typeof (m.default??m).apply),e=>console.log('FAIL',e.code,e.message))"
node <workspace>\permission-guard\probes\verify-installed.js
```

第二条会打印安装副本实际使用的档位文件路径，断言它在 profile 插件目录里、档位与文件内容一致，
并**逐文件比对安装副本与仓库源码的 SHA-256**。最后这项不是锦上添花：本插件是 profile 插件，
改源码后**不重装就不会生效**，而"插件正在运行"和"插件正在运行你刚写的代码"是两个命题。本
会话就是栽在这里——围栏扩展写在了一次安装**之后**，所有源码级测试全绿，运行中的守卫却落后
一个版本，行为自然对不上。

```powershell
node <workspace>\permission-guard\probes\verify-installed.js
```

**只看"插件起来了"是不够的**：`__dirname` 解析错位置时插件照样正常启动，只是悄悄读写另一个
文件。

`client.js` 是必须的：`package.json` 的 `dsh.client.platform: "web"` 会告诉宿主把它作为
`<package>/client` 提供给浏览器。缺了它，宿主会以"找不到客户端 bundle"失败。

然后往 `<DSH_HOME>\profiles\desktop\cordis.patch.yml` 的插入列表加一项：

```yaml
    - id: permission-guard
      name: ./plugins/dsh-plugin-permission-guard/index.js
```

组合文件只在**启动时**读取（`patchReload: live` 只监听补丁文件本身的变化，不会对新增
插件入口重新求值），所以需要重启 DSH Desktop。

## 卸载

删掉 `cordis.patch.yml` 里那个 `permission-guard` 条目和插件目录，重启即可。

`permissions.json` 就是**唯一权威**，而且住在插件目录里——所以**删插件目录等于删掉档位**。重新
安装时，只要同目录还留着旧名 `<state-file>`，改名交接会把档位接回来；两者都没有，就是 fail-safe
档位 1——哪怕工作区根躺着旧副本也不会被读。想干净地保留档位，卸载前先把它复制出来，装好后放
回去（放旧名或新名都可以，放新名更直接）。

顺手清理时注意：档位文件**不能用工具层删除**——直接写路径会被 self-escalation 围栏拦下，
用 `fs.unlinkSync` 之类也一样（围栏同时看路径和脚本 API 名）。这是设计意图，用编辑器删。

---

# 2.0：从四档收缩成一个布尔

## 决定

操作者的原话是："把原来的 4 档改成 2 档，'工作区外可读'和'工作区外不可读'，只管读，不管写，因为
写已经有 dsh 自带的沙箱管理了。"

于是这个插件只决定一件事：**模型能不能读工作区之外**。

## 为什么这是对的，而不是功能缩水

四档版本之所以复杂，全部来自它在**同时管两个轴**并且**跟内核沙箱双向同步**。而其中"写"那个轴，
内核本来就在管，而且管得更严（内核能看到 syscall，我们只能看工具调用）。

更关键的是：**那个同步层是所有已发布 bug 的来源**。

| 已发生的 bug | 是不是同步层的产物 |
|---|---|
| 档位 3 被映射成 `danger-full-access` | 是（映射表） |
| 新建会话的 pin 静默覆盖手设档位 | 是（会话监听） |
| `newToOld: 0`，反向同步不工作 | 是（触发点缺失） |
| 修 fail-open 时切断了反向同步 | 是（同一条路径上的副作用） |
| 回退工作区是程序安装目录 | 否（这是路径解析，与同步无关） |

**四分之三来自一个本不该存在的层。** 删掉它，那一整类问题就不存在了——不是因为修好了，而是因为
不再有"两处状态需要保持一致"这件事。

## 明确的代价

插件不再跟内核说话，于是**"内核绝不比档位更宽"这条不变量消失**：

- 操作者在内置选择器里选了 `danger-full-access` → 模型能**写**工作区外，插件不阻止
- 反向也成立：内置选择器选 `read-only`，插件的开关改不了工作区内不可写这件事

操作者明确接受了这个代价。这个取舍的实质是：**一个只管一件事、并把边界说清楚的插件，比一个假装
管两件事、还要同步两边状态的插件可靠。**

## 削掉的东西

```
sync.js 整套映射与双向同步              删除
session/event 监听、pin 跳过、回声抑制   删除
NEW_TO_OLD_SANDBOX / NEW_TO_OLD_APPROVAL 删除
状态文件监听 → 推送内核                  删除
审批策略联动 ask/never                   删除
4 档表 → outsideRead 布尔
测试 test-watch-sync.js                  删除（它测的正是被删掉的那条通路）
```

## 状态格式：为什么是**有名字的布尔**，不是 `mode: 1|2`

这是一个真实的陷阱，不是风格问题。

旧的四档里，`mode: 2` 的含义是"**外部不可读**"，而新的两档里 `2` 会是"**外部可读**"。也就是说，
升级后残留的状态文件会被读成**相反的权限**，而且**静默放开**外部读取。

所以状态字段叫 `outsideRead`，名字本身就是含义，缺失也无歧义。旧文件按 `mode >= 3` 迁移：

| 旧档 | 旧含义 | 迁移为 |
|---|---|---|
| 1 工作区查看 | 外部不可读 | `outsideRead: false` |
| 2 工作区内修改 | 外部不可读 | `outsideRead: false` |
| 3 非工作区可读 | 外部可读 | `outsideRead: true` |
| 4 完全权限 | 外部可读 | `outsideRead: true` |

映射表是**写死展开**的，不是推出来的——推错方向就等于升级时发放权限。

## 开关的写入通道：查到的和没查到的

操作者要的是"把原来显示权限几的地方换成开关"。开关必须能写，而写必须**只有人类可达**，
否则模型翻一下开关就给自己开了工作区外读权限。

查证结果：

| 通道 | 结论 |
|---|---|
| 客户端服务目录 | **没有任何**权限/沙箱/审批服务 —— 客户端插件不能直接切 |
| `permissionPresets.set(session, name)` | 宿主侧存在，是内置选择器用的**受制裁写路径**；但只覆盖内核的三值写轴，**表达不了"外部可读"** |
| `commands.execute(...)` `@Remote` | 宿主侧存在，供 UI 调用；客户端能否够到**未验证** |
| `host.call(method, args)` | 客户端 Builtin 里确实有（包内 RPC，模型够不到）；**宿主半边如何注册处理函数未验证** |
| HTTP 写路由 | **必须不存在**：HTTP 不经过 `tools/pre-execute`，模型的 shell 能直接 POST |

而 skill 的 `references/user-actions.md` 里，DSH 自己的规则写得很清楚：

> An action that grants or confirms authority, such as approving a tool call, answering a question
> the agent asked, **or loosening a policy, stays user-only.**

所以 2.0 的 UI 仍然**只读**——但这次不是"没做完"，而是**明确记录了它是未决问题**：读设置、
说明怎么改、并且**不再指向不存在的机制**。这是上一版的错误：它先指向一个模型够不到的工具，
后来又指向内置选择器（在旧设计下有效，新设计下**完全无效**，因为选择器管的是写）。

## 这次重写自己引入的 bug，以及它是怎么被抓到的

写完新 `index.js` 后跑测试，7 个失败。**一个根因解释了其中 5 个**：

`modes.js` 里状态对象的字段叫 **`value`**，而 `index.js` 读的是 **`.outsideRead`**。
后果是连锁的：

- 守卫里 `next.outsideRead === current.outsideRead` 永远是 `undefined === true` → 不相等 → 继续
- 下一句 `if (!next.outsideRead) return undefined` → `!undefined` 为真 → **守卫永远返回"放行"**
- 也就是说：**自升权守卫在这版里从来没拒绝过任何东西**，而所有"守卫已注册"的断言仍然通过
- `persistState(next)` 写入 `outsideRead: undefined` → `JSON.stringify` 丢弃该字段 → 状态文件里
  **字段直接消失**，只剩一句 note

这是"同一个概念在两处用了不同名字"的典型后果，而且**它不会报错**——`undefined` 在比较里合法，
`JSON.stringify` 丢弃 undefined 也合法。修法是统一字段名为 `outsideRead`，而不是在两边对齐。

**为什么测试这次抓到了**：断言写的是**行为**（守卫返回一个字符串拒绝、"窄化"要真的落盘），
不是"函数被调用了"。一个只断言注册成功的测试会让这个 bug 完整地发布出去。

## 另外两个测试自身的问题

1. **两条断言把状态文件当成了"可读"**，但它在伪造工作区之外——所以被读策略正确拦下。修法是
   把会话 cwd 设成插件目录，让状态文件**位于**工作区内，这样测的才是"self-write 围栏不会误伤读取"。
2. **`ALL PASS` 却退出码 1**，查到是 PowerShell 的 `Remove-Item` 贡献了退出码，不是测试的问题。
   单独跑 `node test/test-matrix.js` 退出码是 0。

## 仍然存在的限制（已写进 README）

- shell 路径提取是启发式；`Get-Content C:\secret > out.txt` 这类**混合读写**命令之所以能被挡住，
  是因为规则对"任何提到外部路径的 shell 命令"一律拒绝（**故意过度拦截**）。区分读写位置不可靠，
  而按写动词跳过整条命令会留下一个平凡绕过。
- 档位是**进程级**的，不是按会话。
- 任何目录下**名为 `permissions.json` 的文件**在**被工具写入**时都会被当作状态文件拦下——
  按 basename 匹配，为的是"改名不能打开它本来要关上的洞"。读取不受影响。

---

# 2.0 之后：开关做成、更名，以及一个反复出现的判断模式

## 一、开关最终做成了——通道是**宿主命令**

前面「开关的写入通道」一节记的是当时的未决状态。定下来的方案是：

```
客户端点击
  → sessions.binding(sessionId).session.command('/outside-read on|off')
    → 宿主 commands.register 的处理器
      → persistState()
```

**为什么不是 HTTP 写路由**——这是**构造性**的理由，不是偏好：HTTP 不经过 `tools/pre-execute`，
模型的 shell 能直接 POST，于是它绕过保护状态文件的围栏。开关会把**它本来要扣住的那个能力**亲手
交出去。任何浏览器能拿到的令牌，模型也能通过 HTTP 取到，所以**用令牌救不了这条路**。

**为什么命令可以**：命令注册表是人类命令注册表，模型打不出斜杠命令；而且插件不新增任何路由。

**残留假设，写明而不埋起来**：承载命令的连接 RPC，正是 harness **自己的**权限选择器用的那条
（`permissionPresets.catalog` 是 `@Remote`）。所以能驱动它的人**本来就能改内置沙箱预设**。
**不引入新的暴露类别，但也不是更强的屏障。** 唯一能让屏障严格更强的做法，是不造开关。

实测两个方向都通（真机、浏览器点击驱动，不是测试）：关 → 外部文件被拒；开 → 读到。

## 二、客户端服务必须**惰性解析**（这是我引入的竞态）

第一版在 `apply()` 里读一次 `ctx.get("sessions")` 就闭包捕获。结果：

```
Desktop：能拨
浏览器：切换失败：本插件没有挂上 sessions 客户端服务
```

**根因**：如果服务在插件挂载**之后**才注册，那个 `undefined` 会被**永久记住**——页面开多久都
不会变。这是竞态，所以表现为两个外壳行为不同（它们注册客户端服务的顺序不同）。

两版各错一边，第三版才对：

| 版本 | 错在哪 |
|---|---|
| `sessions` 放进 `inject` | **硬依赖**：服务缺失则 `apply()` 不跑，控件**静默消失** |
| 改成 `ctx.get` 一次捕获 | **竞态**：服务晚到则**永久失效** |
| 按名解析、用的时候才取 | — |

并把它写成回归测试：服务在首次渲染**之后**出现，再点应当有效。旧代码在这条测试前会发出零条命令。

另外，把"拿不到绑定"这一个笼统错误**拆成五路**（无服务 / 无 `binding()` / 无 `sessionId` /
`binding()` 返回空 / 无 `command()`）。理由是它们在实机上要**不同的修法**——而这条诊断正是后来
定位浏览器那个 bug 的入口：错误信息直接指出了断在哪一环。

## 三、更名

包名 → `dsh-outsideread-switch`（旧名描述的是已经不存在的四档设计）；工具名 → `outside_read`。

一致性覆盖：包名、bin、bundle patch 的行 id 与 name、`plugin.name`、日志前缀、边界段名、状态路由、
客户端 bundle id、客户端 cell id、诊断元素 id、原子写临时后缀。

**三处故意不改**：状态文件名 `permissions.json`（它同时是 self-escalation 围栏的匹配依据，改名只为
美观却要牵动保护逻辑）；GitHub URL（仓库未改名时改会让链接 404）；工具名当时留着单独决策。

**更名带来的真实后果**：新旧包名解析到**同一个文件路径**，而模块缓存按路径索引——所以"重装"拿到
的仍是旧模块对象，必须**重启**才换代码。（与首次安装不同，那次路径没被缓存过。）

## 四、一个反复出现的判断模式，代价已累计四次

同一类错误出现了四次，每次都是**手上同时有两条互相矛盾的线索，而只采信了一条就行动**：

| 次 | 表现 | 代价 |
|---|---|---|
| 1 | 断言用 `Atomics.wait` 死等防抖定时器——阻塞了它要等的那个定时器 | 对**正确的代码**报失败 |
| 2 | `modes.js` 用 `value`，`index.js` 读 `outsideRead` | 守卫静默失效 + 状态文件丢字段 |
| 3 | "旧版能同步到新版、反过来不行"：我测的是工具切档，操作者用的是编辑器改文件 | 排查方向错了整整一轮 |
| 4 | 拿 `package.json` 里的 `huang20080115` 当事实拼 URL，而 profile 的依赖 spec 写着 `bluemika111` | 让操作者覆盖了**错误的目录**、配了**错误的 remote**；随后又把远端多出的提交猜成别人的，发出一次错误的警报 |

第 4 次值得留细节，因为**反证就在我自己的输出里**：我在同一条消息里既引用了 `bluemika111` 那条
spec，又按 `huang20080115` 拼出三个 URL，还把它当成"另一个账号"一句话带过。
**两个值指向同一件事而它们不一致时，那不是噪音，是需要停下来查的信号。**

同一轮里我还把"远端有本地没有的提交"直接推断成"可能来自另一台机器，别 force-push 会丢别人的
东西"——而 `git log` 一读就知道那是我自己的提交。**一个可查的事实被我写成了带警告的猜测。**

结论不是"要更小心"（那是空话），而是具体到动作的两条：

1. **同一事实有两个来源而不一致时，先解决矛盾，再使用任何一个值。** 不允许"用其中一个、把另一个
   记为巧合"。
2. **推断与事实要在文字里分开标注。** 上面那两处错误，都起于猜测被写成了陈述句。

## 五、一处纠正

本文前面「开关的写入通道」一节里"2.0 的 UI 仍然只读"是**中间状态**——开关在同一版里随后做成了，
见本节第一、二部分。同理，"这个工具到不了模型的工具列表"后来被实测推翻：在一次干净加载后它出现在
模型的工具列表里（我用它做过一次只读报告）。这意味着 **`tools.guard` 从"守着一条够不到的路径"变成
了真正承重的东西**——README 里那句过时的说法已一并修正。

## 六、发布

新包 `dsh-outsideread-switch@2.0.0` 已发布并端到端验证：从 registry 全新安装、`require` 得到
`apply` 函数、manifest 字段与 CLI shim 齐全、registry shasum 与本地打包**逐字节一致**。

旧包 `dsh-plugin-permission-guard` 的三个版本全部标记废弃并指向新名——**1.0.3 正是守卫缺失时会
fail-open 的那版**，有人搜到旧名就会装上一个有洞的构建。

两个未解的运维事实值得记下：**刚发布完的几分钟内，本机 npm 缓存的陈旧 packument 会让你自己都装
不上它**（表现为 `ETARGET No matching version found`，与发布无关）；以及**发布时 npm 强制要求 2FA**，
没有验证器时唯一可行的凭据是**带 bypass 2FA 的 granular token**——而写在命令行里的 token 会留在
PowerShell 历史文件中。


