/**
 * dsh-main-model-pool：新建主会话的模型池（服务端部分）。
 *
 * 行为（既有语义不得改动；`strategy` 为增量能力）：
 * 1. `pools` 每项 `{provider, model, maxConcurrent=3, weight=1}`；
 * 2. 两种策略可切换（`strategy` 字段，默认 `strict-priority`）：
 *    - 严格主备：weight 降序、同 weight 按配置数组顺序，高优先级候选未占满
 *      自己的 maxConcurrent 时绝不轮到低优先级；
 *    - 均衡分配：在还有余量的候选里挑累计指派次数最少的，同次数按配置顺序；
 * 3. 只在新建主会话的 `agent/created` 里选一次，调用
 *    `agent.model.select({ provider, model })`（不带 reasoningEffort）；
 *    已有会话、resume（带历史）、fork 一律不动；
 * 4. 并发按「轮正在跑」计：分配瞬间乐观占位（pending），`turn/start`
 *    转为 running，`turn/end` 释放；`agent/disposed` / `session/disposed`
 *    兜底清空；
 * 5. 池内全满：不 select、不占位，链路回退 `agentDefaultModel`；
 * 6. 不探测候选，不发任何真实请求；
 * 7. 排除子代理、fork / 带 seed、已经跑过轮次的会话。
 *
 * 源码核实（DSH 0.2.2-rc.1）：
 * - `agent/created` 触发点：`dsh-agent/lib/index.js:703-711`
 *   （`AgentRegistry.announce()` 里 `await this.ctx.serial(...)`，serial 且 await）；
 * - `AgentModel.select()`：`dsh-agent/lib/index.js:181-198`
 *   （只 append `model/selection`，必须早于 step preparation）；
 * - fresh 官方判据：`dsh-tool-subagent/lib/model-selection-settings.js:96`
 *   （`firstLiveSeq === 0` 且首事件不是 `session/end-seed`）；
 * - 轮次事件：`turn/start` / `turn/end` 是 Session 日志事件，经
 *   `session/event(session, event)` 分发（`dsh-session/lib/index.js:1596-1601`），
 *   写入点是 `dsh-agent-loop/lib/index.js:731` / `:819`；根 ctx 无 scope tag
 *   可收到全部会话事件（`dsh-scope/lib/index.js:327-338`，`:334`）。
 *   详细取舍见 `lib/plugin.js` 文件头。
 *
 * 配置读取坑：`enabled` / `pools` 带字段级 `.volatile()`，schemastery 会把
 * 每个字段包成 volatile 引用（`schemastery/lib/index.mjs:265-276`），所以
 * 运行时必须经 `readConfig()` 解包；直接读 `config.pools` 得到的是引用对象，
 * 插件会静默不工作。整份 Config 被顶层 `.volatile()` 包裹时 `config.get()`
 * 也一并兼容。
 *
 * @module dsh-main-model-pool
 */

import z from "@deepseek-ai/schemastery";
import { DEFAULT_MAX_CONCURRENT, DEFAULT_STRATEGY, DEFAULT_WEIGHT } from "./lib/strategy.js";
import { apply as applyMainModelPool } from "./lib/plugin.js";

/** 插件名。 */
export const name = "dsh-main-model-pool";

/**
 * 依赖的 DSH 服务。
 *
 * 只需要 `agents`：监听 `agent/created` 并通过 `agent.model.select()` 落选择。
 * 不探测候选，所以不注入 `llm`。
 */
export const inject = ["agents"];

/** 单条池定义。 */
const PoolEntry = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  maxConcurrent: z.number().min(1).step(1).default(DEFAULT_MAX_CONCURRENT),
  weight: z.number().min(1).step(1).default(DEFAULT_WEIGHT),
});

/**
 * 插件配置。
 *
 * 字段级 `.volatile()` 是设置页可见性与热更新的开关：dsh-settings 的
 * `volatileForm()` 会保留 volatile 字段（`dsh-settings/lib/index.js:122-131`）。
 * `enabled` 默认 false，安装后不会立刻改变现有行为。
 */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  // 策略是标量，与 enabled 一样用字段级 volatile：设置页可见、可热更新，
  // 且必须进配置指纹，否则切换策略不会触发换池。
  strategy: z.string().default(DEFAULT_STRATEGY).volatile(),
  pools: z.array(PoolEntry).default([]).volatile(),
});

/**
 * 插件入口。
 * @param {object} ctx - cordis 插件上下文。
 * @param {unknown} config - 配置（字段级 volatile 引用或普通对象）。
 * @returns {void}
 */
export function apply(ctx, config) {
  return applyMainModelPool(ctx, config);
}

export { readConfig, signatureOf, buildPool, normalizePoolEntries } from "./lib/config.js";
export { freshVerdict, isFreshMainSession } from "./lib/fresh.js";
export { SessionPool, routeKeyOf } from "./lib/pool.js";
export {
  STRATEGIES,
  STRATEGY,
  DEFAULT_STRATEGY,
  normalizeStrategy,
  selectCandidate,
  selectStrictPriority,
  selectBalanced,
  orderCandidates,
  availableOf,
  occupiedOf,
  assignedOf,
  normalizeWeight,
  normalizeMaxConcurrent,
} from "./lib/strategy.js";
