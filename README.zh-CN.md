# dsh-ws-deflate

**简体中文** | [English](./README.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）web 的 WebSocket 传输打开 `permessage-deflate`，**且不修改 DSH 的安装目录**。单机实测：一份会话 transcript 从服务端发出时为 **1,206,822 B，经压缩后实际出网 350,599 B —— 线上字节减少 70.9 %**。

它是**运行时 monkey-patch，不是官方支持的扩展点**。装之前请先读“我该不该装这个”。

## 我该不该装这个？

**适合装：** 如果你不是只在自己这台机器上打开 `dsh web` —— 走 Tailscale/VPN、走公网反向代理、或者任何有真实延迟和丢包的链路。DSH 在每次重连时都会通过 `/api/remote.mux` 重放整份会话 transcript，所以在丢包的链路上，这些字节是要反复支付的。

**不适合装：** 如果你只在 `localhost` 或局域网里用 `dsh web`。省下的字节是真的，但在那个场景下你并不需要；而你要付出的代价，是一个打在别人项目内部实现上的补丁，它可能在每次升级后悄无声息地失效。

代价，在一台 Windows 10 / node v24 机器上的实测：`dsh` 启动耗时 **+10 ms**（交替 4 轮测量），zlib level 6 处理 **1.53 MB** transcript 花 **42.7 ms**。压缩按消息生效，超过 1 KiB 阈值才压，所以小事件完全不受影响。

## 它到底改了什么

磁盘上什么都没改。`ws@8.22.0`、`@deepseek-ai/dsh-api-gateway`、`@deepseek-ai/dsh/lib` 都与 registry 的原始 tarball 做过逐文件（sha256）比对：**63 个文件，0 处不一致、0 个多余、0 个缺失**，当天安装目录里被写入或新建的文件为 **0** 个。

它真正改变的是内存里的一个方法，在 `dsh` 进程内：

```text
BEFORE  WebSocketServer.prototype.handleUpgrade = handleUpgrade(req, socket, head, cb) {   ← ws 自己的实现
AFTER   WebSocketServer.prototype.handleUpgrade = function (req, socket, head, cb) { try {  ← 包装后的
磁盘 sha256 of ws/lib/websocket-server.js: 6d8dd89a841748c8 -> 6d8dd89a841748c8            ← 没变
```

包装器在**握手（handshake）时刻**设置 `this.options.perMessageDeflate`。之所以这样做就够，是因为 ws 8.x 是在 `handleUpgrade` 内部读取这个选项的（`websocket-server.js:299` / `:303`），而不是在构造时读——所以它能作用到 gateway 那个早已构造好的 `new WebSocketServer({ noServer: true })`（`dsh-api-gateway/lib/index.js:179`）。而且只有在没人设置过这个选项时才注入，因此**如果未来 DSH 自己在上游启用了压缩，本插件会自动让位。**

为什么这个选项不能直接配置：DSH 没有暴露对应的配置键。webserver 的那个 `compression` 是 HTTP gzip 中间件，覆盖不到 stream。

## 安装

```bash
dsh plugin --profile web add dsh-ws-deflate
```

然后重启 `dsh web`。bundle 列表是在启动时读取的，不重启就没有效果。

## 验证

```bash
grep 'dsh-ws-deflate' <你的 dsh web 日志所在位置>
```

你要看到三样东西（日志原文是英文，照抄即可）：

```text
[dsh-ws-deflate] permessage-deflate enabled -> …/node_modules/ws [ws 8.22.0] via path (level 6, threshold 1024 B, noContextTakeover on)
[dsh-ws-deflate] self test OK: this process negotiates permessage-deflate
[dsh-ws-deflate] negotiated permessage-deflate with Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) …
```

其中**自测（self test）**是最关键的一行。DSH 的浏览器鉴权会拒绝非浏览器发起的握手，所以你没法用脚本去探测线上服务——插件的做法是在一个临时分配的回环端口上，自己建一个 `new WebSocketServer({ noServer: true })`，然后对它完成一次真实握手。它证明的是“*本进程、这份 ws 副本，能协商成功*”，而这恰恰是任何外部探测都够不到的结论。后面的 `negotiated …` 行则记录前几次真实的浏览器握手（user agent 会被截断，`maxLog` 默认上限 5 条，设为 `0` 关闭）。

浏览器侧如果你想自己确认：DevTools → Network → `remote.mux` 那个请求 → Response Headers 里应当有 `Sec-WebSocket-Extensions: permessage-deflate; …`。

## 卸载

```bash
dsh plugin --profile web remove dsh-ws-deflate
```

重启即可。不需要恢复任何东西，因为磁盘上从来就没有过差异。

## 配置

这个条目**会自己注册**：bundle 清单把 `dsh.bundle.patch` 指向本包自带的 `cordis.patch.yml`，DSH 在合成 profile 树时把它插进去——你自己的 `cordis.patch.yml` 一个字都不用写。下面这条命令是这台机器上 DSH 自己给出的证明：

```bash
dsh --profile web --dump-config | grep -B1 -A9 'id: ws-deflate'
# # == dsh-ws-deflate          ← 独立一层，层名就是这个 bundle
# - id: ws-deflate
#   name: dsh-ws-deflate      ← 没有 config：默认值只存在于 Config schema 里
```

条目里刻意不带 `config` 块，所以 `--dump-config` 只会显示 id 和 name。**真正生效的值看插件激活时打印的那一行**——就是「验证」一节引用的那句：`... (level 6, threshold 1024 B, noContextTakeover on)`。已发布的 `0.1.0` 树里仍有那 7 个键，那是重复，后续版本去掉了。

只有想改配置时才需要动 yml，而且要写**字段替换补丁，不要写 insert**：

```yaml
# 你 profile 的 cordis.patch.yml
- id: ws-deflate
  name: dsh-ws-deflate      # 断言现有 name，不是改名
  config:
    level: 1
    thresholdBytes: 512
    noContextTakeover: true
    concurrencyLimit: 10
    selfTest: true
    maxLog: 5
```

两条规则都是用 `--dump-config` 实测出来的，不是照抄文档：

- **`insert` 是追加，不按 id 去重。** 把包内那份补丁抄进你的 profile，树里会出现**两条** `- id: ws-deflate`——`level: 6` 和 `level: 1` 同时存在——于是你的覆盖要么静默无效，要么跑两遍。实测条目数 1 → 2。
- **`config` 是整体替换，不做深合并。** 你没写的键会回落到本插件 schema 的默认值，而**不是**包内 patch 里那几个值。所以想保留的键必须逐个写上。

| 配置键 | 默认值 | 说明 |
|---|---:|---|
| `enabled` | `true` | 设为 `false` 时包装器仍然装着，但不让任何握手启用压缩 |
| `level` | `6` | 本机实测：同一份 payload 上 level 6 → 压缩比 0.176，level 1 → 0.238，代价是每 1.53 MB 42.7 ms vs 5.9 ms |
| `thresholdBytes` | `1024` | 低于这个字节数的帧原样发出（DSH 事件的中位数约 800 B） |
| `noContextTakeover` | `true` | 每帧独立的 deflate 流：内存占用有上界，而且丢一帧不会污染后续消息。牺牲一点压缩比，换来丢包链路上的健壮性——而这正是用这个插件的全部理由 |
| `concurrencyLimit` | `10` | 并发压缩操作数的上限 |
| `selfTest` | `true` | 激活时在回环地址上跑一次握手自测。**不支持热重载** |
| `maxLog` | `5` | 记录多少次成功协商；`0` 表示静默 |

除 `selfTest` 外所有键都是 `.volatile()`，所以改完 patch 让 profile 热重载就能重新生效，不必重启。

## 它是怎么找到 gateway 那份 `ws` 副本的

插件没法靠 `import 'ws'` 拿到 gateway 用的那一份。profile 是一棵 pnpm 依赖树，里面**根本没有** `ws`；把它声明成 dependency 只会装出**第二份**副本——一个不同的 class 对象，patch 它毫无作用。三条路径按以下顺序尝试，全部实测过：

1. **问进程。** gateway 的 `ws` 就在 CommonJS 的模块缓存里；在那里找到的 class 可以证明就是 gateway 在用的那一个（`cached === path-required: true`）。要按 `ws/lib/websocket-server.js` 匹配，**不要**按 `ws/index.js`——ws 把 `import` 路由到 `wrapper.mjs`，后者直接指向 lib 下那个文件，所以在 ESM 宿主里 `index.js` 根本不会进缓存。另外注意 `lib/websocket-server.js` 结尾是 `module.exports = WebSocketServer`，也就是说**导出本身就是那个 class**。
2. **猜路径。** 尊重 `$DSH_HOME`（优先级：配置的路径 > `$DSH_HOME` > `~/.dsh`），并检查 `<home>/profiles/node_modules/ws`——dsh 自己会把它做成指向安装目录的 junction，因此这是这里最通用、最可移植的入口。另外还覆盖 Windows（`%APPDATA%\npm`）、Linux（`/usr/local`、`/usr/lib`）以及 macOS 两个常见位置（`/usr/local`、`/opt/homebrew`）的 npm 全局前缀。
3. **重试约 2 秒。** 前两条都没找到时，每 250 ms 重试一次（定时器是 unref 的，所以永远不可能把进程吊住不放）。这一条是为了兜住那些前缀不在上面列表里的安装：等到 gateway 加载完，路径 1 就能成功了。验证方式是把所有候选全部废掉（`DSH_HOME` + `APPDATA` + `argv[1]` 都指向空目录）后激活——什么都没 patch 上——然后延迟加载 gateway：`located ws on deferred attempt 2 … via require.cache`，自测 OK。

### 有一件会让你困惑的事，而且是故意留着的

在一个普通 `node` 脚本里 `import 'dsh-ws-deflate'` **会失败**，报 `Cannot find package '@deepseek-ai/schemastery'`，尽管这个插件在 `dsh` 里加载得好好的。这不是待修的 bug：dsh 运行自己的拦截式解析器（`dsh-app-boot/lib/index.js:1459` 的 `scope === "installation"`、`:1479` 的 `readPeerNames(...).has(name)`），由它从安装目录树里提供声明过的 peer。一个全新的 profile 里到处都没有 `schemastery`——在两个平台上都验证过——插件照样能激活。**所以别用“从脚本里 import 一下”来验证这个插件；正确的验证方式是重启 `dsh web`，然后读日志。**

## 测试环境

| 平台 | node | dsh | ws | pnpm | 结果 |
|---|---|---|---|---|---|
| Windows 10 | v24.20.0 | 0.2.0-rc.2 | 8.22.0 | 10.18.2 | 实跑，记录到 3 次浏览器握手，含 macOS Safari |
| Linux | v22.19.0 | 0.2.0-rc.2 | 8.22.0 | 12.11.2 | clean-room：用随包模板建全新 profile，从本地打包的 tarball 安装，在 :3099 启动，自测 OK |

两次都是从本地 tarball 安装，而不是从 registry。每个平台只覆盖了一种组合——其他组合请一律视为未测试。结构性兜底是 `typeof WebSocketServer.prototype.handleUpgrade === 'function'`；如果未来某个 ws 版本改掉了这一点，插件会告警并保持关闭，而不是把握手搞坏。

## 失败模式

- **找不到可 patch 的 `WebSocketServer`** → 输出一行告警，插件仍然正常激活，压缩保持关闭。`dsh` 不受影响。
- **`apply()` 抛异常** → 只是告警。第三方插件 id 不在 `dsh-app-boot` 硬编码的 `requiredStartupEntryIds` 里，所以插件**不可能**阻止 `dsh` 启动。
- **未来某版 DSH 自己设置了 `perMessageDeflate`** → 以它的值为准，本插件退化为 no-op。那就把它删掉。
- **某次 DSH 升级改掉了 gateway 构造 server 的方式** → 插件可能什么都找不到，然后告警。每次升级后都检查一下那三行日志。

## 退出条件

上游本来就想要这个能力：[discussion #6950](https://github.com/deepseek-ai/deepseek-harness/discussions/6950) 提出希望“在 session-stream 的 WebSocket 上启用 permessage-deflate …… 可压缩约 3–5 倍；不需要改协议”（那是他们的测量：22.5 MB / 41,794 个事件；我的压缩比 0.291 即 3.4 倍，两者吻合）。**DSH 一旦原生提供，就删掉这个插件。** 在此之前，它是一个自带退场机制的过渡方案，而不是对 DSH 行为的永久 fork。

## 安全说明

`permessage-deflate` 是压缩特性，而压缩特性是有 BREACH 一类攻击历史的。在这个场景里，被保护的秘密和攻击者可控的输入都在你自己的会话 transcript 内，跑在一条你已经信任到“把 token 放在 URL query string 里传”的链路上。如果你正在公网主机上以明文 HTTP 跑 `dsh web`，**请先解决那件事**——它比这个插件碰到的一切都大得多。

本项目与 DeepSeek 无关联，也未获得其认可。MIT。
