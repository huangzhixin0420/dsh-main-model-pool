/**
 * 主会话模型池的占用状态管理。
 *
 * 语义（设计已定稿）：
 * - 并发单位是「轮正在跑」，不是会话数；
 * - 分配发生在 `agent/created`，那时首轮还没开跑，所以先记一个
 *   `pending`（已分配未开跑）的乐观占位；
 * - `session/event` 里的 `turn/start` 把该会话从 `pending` 转成 `running`；
 * - `turn/end` 把 `running` 转回 `locked`：名额释放，但路由记忆保留，因为
 *   模型已经写进 `model/selection` 不能再换，后续轮次开跑时要重新占用；
 * - `locked` 会话再开一轮时直接回到 `running`，即使该候选此刻已满也照跑
 *   （模型锁定 > 并发上限，没有排队机制可退），只是如实计数、把新会话挤走；
 * - `agent/disposed` / `session/disposed` 才彻底清掉该会话的记录。
 *
 * 「选、占、记」必须同步完成：所有变更方法都是同步的，中途不 await。
 * 否则三个会话同时创建时，池看起来都是空的，必然超发。
 *
 * 可分配余量 = `maxConcurrent` - 该路由 `running` - 该路由 `pending`。
 *
 * @module dsh-main-model-pool/pool
 */

import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_STRATEGY,
  DEFAULT_WEIGHT,
  availableOf,
  normalizeMaxConcurrent,
  normalizeStrategy,
  normalizeWeight,
  occupiedOf,
  selectCandidate,
} from "./strategy.js";

/** 把 provider/model 折成稳定键。 */
export function routeKeyOf(provider, model) {
  return `${provider}\u0000${model}`;
}

/** 只保留路由的 provider/model 两个字段。 */
function asRoute(entry) {
  return { provider: entry.provider, model: entry.model };
}

/** 判断一条池配置是否形状完整。 */
function isEntry(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    typeof value.model === "string" &&
    value.model.length > 0
  );
}

/**
 * 运行期主会话模型池。
 *
 * 状态只有两份：
 * - `#routes`：每个候选的 `running` / `pending` 计数；
 * - `#sessions`：sessionId → `{key, state}`，`state` 为 `pending` / `running` / `locked`。
 *   `locked` 表示「模型已锁定、当前没在跑」，记录保留到 `dispose`。
 *
 * 两份状态在同一个同步方法里一起更新，不存在只改一半的窗口。
 */
export class SessionPool {
  /** 候选数组，顺序即配置数组顺序。 */
  #routes = [];

  /** 选择策略；构造后不变，换策略走整体换池（指纹里含策略）。 */
  #strategy = DEFAULT_STRATEGY;

  /** routeKey → 候选。 */
  #byKey = new Map();

  /** sessionId → `{key, state}`。 */
  #sessions = new Map();

  /**
   * @param {Array<{provider: string, model: string, maxConcurrent?: number, weight?: number}>} entries - 池配置。
   * @param {string} [strategy] - 选择策略；缺省/未知回落严格主备。
   */
  constructor(entries, strategy) {
    this.#strategy = normalizeStrategy(strategy);
    const list = Array.isArray(entries) ? entries : [];
    for (const entry of list) {
      if (!isEntry(entry)) continue;
      // 同一条路由重复配置会让「按 key 找计数」二义化，这里只保留第一条。
      const key = routeKeyOf(entry.provider, entry.model);
      if (this.#byKey.has(key)) continue;
      const route = {
        index: this.#routes.length,
        provider: entry.provider,
        model: entry.model,
        maxConcurrent: normalizeMaxConcurrent(entry.maxConcurrent),
        weight: normalizeWeight(entry.weight),
        running: 0,
        pending: 0,
        // 累计指派次数：只在 allocate() 成功选中时 +1，供均衡策略做长期轮转。
        assigned: 0,
      };
      this.#routes.push(route);
      this.#byKey.set(key, route);
    }
  }

  /** 候选数量。 */
  get size() {
    return this.#routes.length;
  }

  /** 当前选择策略。 */
  get strategy() {
    return this.#strategy;
  }

  /** 当前总占用（running + pending）。 */
  get activeCount() {
    return this.#routes.reduce((sum, entry) => sum + occupiedOf(entry), 0);
  }

  /** 当前已分配但尚未开跑的会话数。 */
  get pendingCount() {
    return this.#routes.reduce((sum, entry) => sum + entry.pending, 0);
  }

  /** 当前轮正在跑的会话数。 */
  get runningCount() {
    return this.#routes.reduce((sum, entry) => sum + entry.running, 0);
  }

  /**
   * 池状态快照，供日志与诊断读取；不暴露内部对象。
   * @returns {Array<object>} 每个候选的只读快照。
   */
  snapshot() {
    return this.#routes.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      weight: entry.weight,
      maxConcurrent: entry.maxConcurrent,
      running: entry.running,
      pending: entry.pending,
      occupied: occupiedOf(entry),
      available: availableOf(entry),
      assigned: entry.assigned,
    }));
  }

  /**
   * 读某个候选的计数。
   * @param {{provider: string, model: string}|string} route - 路由对象或 `provider\0model` 键。
   * @returns {{running: number, pending: number, occupied: number, available: number, maxConcurrent: number}|undefined} 计数。
   */
  countsOf(route) {
    const key = typeof route === "string" ? route : routeKeyOf(route?.provider, route?.model);
    const entry = this.#byKey.get(key);
    if (entry === undefined) return undefined;
    return {
      running: entry.running,
      pending: entry.pending,
      occupied: occupiedOf(entry),
      available: availableOf(entry),
      maxConcurrent: entry.maxConcurrent,
      assigned: entry.assigned,
    };
  }

  /**
   * 读某个会话被分配的路由。
   * @param {string} sessionId - 会话 id。
   * @returns {{provider: string, model: string}|undefined} 路由。
   */
  assignmentOf(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return undefined;
    const entry = this.#byKey.get(session.key);
    return entry === undefined ? undefined : asRoute(entry);
  }

  /**
   * 读某个会话的占用状态。
   * @param {string} sessionId - 会话 id。
   * @returns {"pending"|"running"|undefined} 状态。
   */
  stateOf(sessionId) {
    return this.#sessions.get(sessionId)?.state;
  }

  /**
   * 为一个新建主会话挑路由并占位。
   *
   * 同步完成选择、占位、记录三步；池内全满时返回 undefined，且不改任何计数。
   * 同一 sessionId 重复调用是幂等的：返回既有分配，不重复占位。
   * @param {string} sessionId - 会话 id。
   * @returns {{provider: string, model: string}|undefined} 选中路由；全满时 undefined。
   */
  allocate(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;

    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      const entry = this.#byKey.get(existing.key);
      return entry === undefined ? undefined : asRoute(entry);
    }

    const picked = selectCandidate(
      this.#routes.map((entry) => ({
        index: entry.index,
        provider: entry.provider,
        model: entry.model,
        weight: entry.weight,
        maxConcurrent: entry.maxConcurrent,
        running: entry.running,
        pending: entry.pending,
        assigned: entry.assigned,
      })),
      this.#strategy,
    );
    if (picked === undefined) return undefined;

    const entry = this.#byKey.get(routeKeyOf(picked.provider, picked.model));
    if (entry === undefined) return undefined;

    // 只有这里（真正选中并占位）才计数；turn/start、幂等重复 allocate、
    // 全满返回 undefined 都不增加 assigned，否则均衡策略会被事件频率带偏。
    entry.assigned += 1;
    entry.pending += 1;
    this.#sessions.set(sessionId, { key: routeKeyOf(entry.provider, entry.model), state: "pending" });
    return asRoute(entry);
  }

  /**
   * 一轮开跑：占一个名额。
   *
   * - `pending`（已分配未开跑）→ `running`：把乐观占位换成真实占用，总数不变；
   * - `locked`（模型已锁定、上一轮已结束）→ `running`：重新占一个名额；
   * - 已经在 `running`：重复事件，不重复计数；
   * - 不是本池分配的会话（没有记录）：返回 false，不影响任何计数。
   *
   * `locked` 会话即使该候选此刻已满也照常开跑——模型已经写进会话日志、
   * 换不了，没有排队机制可以退。此时 `running` 会短时超过 `maxConcurrent`，
   * 这是软限制的已知边界，换来的是新会话看见满额后溢出或回退。
   * @param {string} sessionId - 会话 id。
   * @returns {boolean} 是否真的发生了状态转换。
   */
  startTurn(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return false;
    if (session.state === "running") return false;
    const entry = this.#byKey.get(session.key);
    if (entry === undefined) {
      this.#sessions.delete(sessionId);
      return false;
    }
    if (session.state === "pending") entry.pending = Math.max(0, entry.pending - 1);
    entry.running += 1;
    session.state = "running";
    return true;
  }

  /**
   * 一轮结束：释放名额，但保留路由记忆。
   *
   * 转成 `locked` 而不是删除记录：模型已经锁定，同一个会话下一轮还要继续
   * 用这个模型，删了记录就等于放弃了「它在跑时占名额」的事实。
   * @param {string} sessionId - 会话 id。
   * @returns {boolean} 是否真的释放了占用。
   */
  endTurn(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.state !== "running") return false;
    const entry = this.#byKey.get(session.key);
    if (entry !== undefined) entry.running = Math.max(0, entry.running - 1);
    session.state = "locked";
    return true;
  }

  /**
   * 彻底释放某个会话：删除记录并按状态归还计数。
   *
   * 用在 `dispose` 与「select 失败回滚」两处；只有它才会让会话从池里消失。
   * @param {string} sessionId - 会话 id。
   * @returns {boolean} 是否真的释放了占用。
   */
  release(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return false;
    this.#sessions.delete(sessionId);
    const entry = this.#byKey.get(session.key);
    if (entry === undefined) return false;
    if (session.state === "running") entry.running = Math.max(0, entry.running - 1);
    else if (session.state === "pending") entry.pending = Math.max(0, entry.pending - 1);
    return true;
  }

  /**
   * 兜底清理某个会话（`agent/disposed` / `session/disposed`）。
   * 与 {@link SessionPool#release} 等价，单独命名是为了让调用点语义清楚。
   * @param {string} sessionId - 会话 id。
   * @returns {boolean} 是否真的释放了占用。
   */
  dispose(sessionId) {
    return this.release(sessionId);
  }

  /**
   * 清空全部占用与会话记录。配置热更新换池时由旧池自行丢弃。
   * @returns {void}
   */
  clear() {
    this.#sessions.clear();
    for (const entry of this.#routes) {
      entry.running = 0;
      entry.pending = 0;
      entry.assigned = 0;
    }
  }
}

export { DEFAULT_MAX_CONCURRENT, DEFAULT_WEIGHT };
