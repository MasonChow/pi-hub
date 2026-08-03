# pi-hub

给 [Pi coding agent](https://pi.dev) 用的扩展包集合。每个目录都是一个独立发布的 pi package，装上就能用。

## 包一览

| 包 | 做什么 | 入口 |
|---|---|---|
| [`@masonchow/pi-hud`](./pi-hud) | Claude Code statusline 风格的 HUD：模型、上下文水位、额度/花费、缓存命中率、subagent 消耗 | `/hud` |
| [`@masonchow/pi-agent-formula`](./pi-agent-formula) | F1 主题的模型阵容与进站换模顾问：把模型按轮胎强度打标，一句 `/boxbox` 决定换不换 | `/formula-config` `/formula-tires` `/boxbox` |
| [`@masonchow/pi-claude-rules`](./pi-claude-rules) | 按 Claude Code 语义消费 `.claude/rules/`，同一套规则库在 Pi 里表现一致 | `/rules` |

## 快速开始

```bash
pi install npm:@masonchow/pi-hud
```

重启 Pi 即生效。`-l` 只装到当前项目（写 `.pi/settings.json`，不动全局）：

```bash
pi install -l npm:@masonchow/pi-claude-rules
```

`pi list` 看已装的，`pi remove npm:@masonchow/pi-hud` 卸载。

各包的配置、环境变量、故障排查看各自 README。

## 适用范围

✅ Pi coding agent 0.81.1 及以上
✅ Node.js 20+
✅ TypeScript 源码直接发布，装完不需要构建步骤
✅ 三个包互不依赖，按需单独安装

❌ 不是 Claude Code / Cursor / Codex 的扩展（`pi-claude-rules` 只是复用 Claude Code 的规则文件格式）
❌ 不提供 Pi 本体的功能补丁或 fork

## 提问与反馈

用得不顺、想要新能力、发现 bug，都欢迎开
[issue](https://github.com/MasonChow/pi-hub/issues)。开 issue 时带上：

- `pi --version` 与 Node 版本
- 哪个包、哪个命令
- 期望行为 vs 实际行为（有报错请贴完整栈）

## 本地开发

每个包统一 `src/`（`src/index.ts` 为扩展入口）+ `tests/`：

```bash
cd <pkg>
npm install
npm test          # node --test
npm run typecheck
```

装未发布的改动直接用本地路径：

```bash
pi install /absolute/path/to/pi-hub/<pkg>
pi -e /absolute/path/to/pi-hub/<pkg>    # 一次性加载，不写 settings
```

## 许可

[MIT](./LICENSE)
