/**
 * 主会话模型池的运行时接线（不依赖 schemastery，便于单测）。
 *
 * 源码核实（DSH 0.2.2-rc.1，包根
 * `/Users/leo/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`）：
 *
 * 1. `agent/created` 的触发点：`dsh-agent/lib/index.js:703-711`。
 *    `AgentRegistry.announce()` 里是
 *    `await this.ctx.serial(entry.carrier, "agent/created", { agent, source, signal })`，
 *    也就是说本监听器是 serial 且被 await 的：监听器返回前，
 *    `initializeAgent()` 不会返回，首轮也不会开始。因此这里是安全的
 *    「选一次」时机。
 *
 * 2. `AgentModel.select()` 的语义：`dsh-agent/lib/index.js:181-198`。
 *    它只做一件事——`session.append("model/selection", {provider, model})`，
 *    不改内存里的 agent.options。step preparation 会读取这个
 *    `model/selection` 投影，所以 select 必须早于首个 step；`agent/created`
 *    正好满足。本插件只传 `{provider, model}`，不带 `reasoningEffort`
 *    （见 `:198` 的 `toSelection` 对缺省 effort 的处理）。
 *
 * 3. fresh 判定的官方先例：
 *    `dsh-tool-subagent/lib/model-selection-settings.js:96` 的
 *    `target.firstLiveSeq === 0 && target.eventAt(SessionSeq(0))?.type !== "session/end-seed"`。
 *    详见 `lib/fresh.js`。**不按 `source` 判断**：Web 新建空白会话可能走
 *    `agents.resume()`（`dsh-api-session-controller/lib/index.js:312/368`），
 *    此时 `source === "resume"`，但会话仍是全新的。
 *
 * 4. 轮次事件：主会话的 `turn/start` / `turn/end` 不是独立的 cordis 事件，
 *    而是 Session 日志事件：
 *    - 写入点：`dsh-agent-loop/lib/index.js:731`（`turn/start`，data 为
 *      `{turn}`）、`:819`（`turn/end`，data 为 `{turn, reason}`）；
 *    - 事件类型定义：`dsh-session/lib/types/types.d.ts:268-283`；
 *    - 对外分发：`dsh-session/lib/index.js:1596-1601` 以
 *      `session/event` 事件、回调参数 `(session, event)` 发出
 *      （签名见 `dsh-session/lib/types/index.d.ts:63`）；
 *    - 根 ctx 能否收到：`dsh-scope/lib/index.js:327-338` 的 `scopeTarget`
 *      明确「admits untagged listeners globally」（`:334` `if (tag === undefined)
 *      return true;`），所以无 scope tag 的插件 ctx 能收到所有会话的
 *      `session/event`。
 *
 *    因此这里用 `ctx.on("session/event", (session, event) => ...)` 过滤
 *    `event.type`，**不采用 `agent/status`**。理由：`agent/status`
 *    （`dsh-agent-loop/lib/index.js:562`，payload 只有 `{status}`）是
 *    driver 阶段的粗粒度状态；当 inbox 还有排队输入时，一轮结束后 driver
 *    仍保持 `running` 并继续下一轮，`turn/end` 不会产生状态切换，
 *    「每轮释放」就做不到。`session/event` 才是权威的轮次边界。
 *
 * @module dsh-main-model-pool/plugin
 */

import { buildPool, readConfig, signatureOf } from "./config.js";
import { freshVerdict } from "./fresh.js";

/** 日志前缀。 */
const LOG_PREFIX = "dsh-main-model-pool";

/** 路由折成 `provider/model`，用于日志。 */
function routeLabel(route) {
  return `${route.provider}/${route.model}`;
}

/**
 * 装配主会话模型池。
 *
 * 监听器始终注册（即使当前 `enabled=false` 或池为空），这样设置页保存后
 * 无需重启即可生效。
 * @param {object} ctx - cordis 插件上下文。
 * @param {unknown} config - `apply` 的配置（volatile 引用或普通对象）。
 * @returns {void}
 */
export function apply(ctx, config) {
  const initial = readConfig(config);
  const volatile = initial !== config && typeof config?.get === "function";
  ctx.logger?.info?.(
    `${LOG_PREFIX}: apply 收到配置 ${JSON.stringify(initial)}（${volatile ? "volatile 引用" : "普通对象/字段级 volatile"}）`,
  );

  // 池是可变的：配置热更新时整体换掉，监听器只装一次。
  let pool = buildPool(initial);

  if (pool === undefined) {
    ctx.logger?.info?.(`${LOG_PREFIX}: 未启用或模型池为空，不装配分配逻辑（监听器仍保留，支持热更新）`);
  } else {
    ctx.logger?.info?.(
      `${LOG_PREFIX}: 装配 ${pool.size} 个候选，策略 ${pool.strategy}，单候选默认上限 ${pool.snapshot()[0]?.maxConcurrent ?? 0}`,
    );
  }

  // volatile 引用的写入无法订阅，所以在每次新会话分配前比对快照。
  let lastSignature = signatureOf(initial);
  const currentPool = () => {
    const next = readConfig(config);
    const signature = signatureOf(next);
    if (signature === lastSignature) return pool;
    lastSignature = signature;
    pool = buildPool(next);
    if (pool === undefined) {
      ctx.logger?.info?.(`${LOG_PREFIX}: 配置变更后池为空，停止分配`);
    } else {
      ctx.logger?.info?.(
        `${LOG_PREFIX}: 配置热更新，现 ${pool.size} 个候选，策略 ${pool.strategy}（assigned 全部从 0 开始）`,
      );
    }
    // 旧池的占用与 assigned 都不迁移：已分配会话的模型已经写进 model/selection，
    // 不受影响；新池从零开始计数，避免旧计数把新配置的额度吃掉。
    // 已知取舍：切换到 balanced 后，所有候选 assigned 都是 0，最初几轮会严格
    // 按配置顺序各派一次，之后才回到真实的长期均衡。
    return pool;
  };

  /**
   * 新建主会话：判定 fresh → 选/占 → select，全程同步。
   *
   * 顺序敏感：本监听器由 `ctx.serial` await，返回时 `select()` 已 append
   * `model/selection`，早于首个 step preparation。
   */
  ctx.on("agent/created", ({ agent } = {}) => {
    try {
      const pool_ = currentPool();
      if (pool_ === undefined) return;

      const verdict = freshVerdict(agent);
      if (!verdict.ok) {
        if (verdict.reason !== "no-session" && verdict.reason !== "no-header") {
          ctx.logger?.info?.(
            `${LOG_PREFIX}: ${agent?.id ?? "<unknown>"} 不是 fresh 主会话（${verdict.reason}），跳过`,
          );
        }
        return;
      }

      // 用 session id 记账，保证与 session/event 里的 session.id 对得上。
      const sessionId = agent.session?.id ?? agent.id;
      if (typeof sessionId !== "string" || sessionId.length === 0) return;

      // 选、占、记必须在同一个同步块内完成，中间不得 await。
      const route = pool_.allocate(sessionId);
      if (route === undefined) {
        // 池内全满：不 select、不占位，链路自然回退 agentDefaultModel。
        ctx.logger?.info?.(
          `${LOG_PREFIX}: 池内全满，${sessionId} 回退全局默认模型（不占任何名额）`,
        );
        return;
      }

      try {
        // 只带 provider/model，不带 reasoningEffort。
        agent.model.select({ provider: route.provider, model: route.model });
      } catch (error) {
        // select 失败必须回滚占位，否则名额永久泄漏。
        pool_.release(sessionId);
        throw error;
      }

      ctx.logger?.info?.(
        `${LOG_PREFIX}: ${sessionId} → ${routeLabel(route)}（总占用 ${pool_.activeCount}）`,
      );
    } catch (error) {
      // 监听器抛错会让会话创建失败，这里必须完全吞掉。
      ctx.logger?.warn?.(
        `${LOG_PREFIX}: ${agent?.id ?? "<unknown>"} 分配失败，回退全局默认模型：${error?.message ?? String(error)}`,
      );
    }
  });

  // ---- 轮次生命周期：session/event ----
  //
  // 根 ctx 无 scope tag，能收到所有会话的事件（见文件头第 4 点）。
  ctx.on("session/event", (session, event) => {
    try {
      const id = session?.id;
      if (typeof id !== "string" || id.length === 0) return;
      if (event?.type === "turn/start") {
        pool?.startTurn(id);
        return;
      }
      if (event?.type === "turn/end") {
        pool?.endTurn(id);
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `${LOG_PREFIX}: 处理轮次事件失败：${error?.message ?? String(error)}`,
      );
    }
  });

  // ---- 兜底清理 ----

  ctx.on("agent/disposed", ({ agent } = {}) => {
    try {
      const id = agent?.session?.id ?? agent?.id;
      if (typeof id === "string" && id.length > 0) pool?.dispose(id);
    } catch (error) {
      ctx.logger?.warn?.(`${LOG_PREFIX}: 清理 agent 占用失败：${error?.message ?? String(error)}`);
    }
  });

  ctx.on("session/disposed", (session) => {
    try {
      const id = session?.id;
      if (typeof id === "string" && id.length > 0) pool?.dispose(id);
    } catch (error) {
      ctx.logger?.warn?.(`${LOG_PREFIX}: 清理 session 占用失败：${error?.message ?? String(error)}`);
    }
  });

  ctx.effect?.(() => () => {
    pool?.clear();
  }, "dsh-main-model-pool.teardown()");
}
