/**
 * 配置解包、规范化与指纹。
 *
 * 为什么必须解包：
 * Config 的 `enabled` / `pools` 字段带 `.volatile()`，schemastery 在
 * `Schema.resolve` 里把每个 volatile 字段包成 cosmokit 的 volatile 引用
 * （`schemastery/lib/index.mjs:265-276`、`:480`），cordis 传给 `apply` 的
 * 就是 `{ enabled: {get}, pools: {get} }` 这种普通对象。直接读
 * `config.pools` 会拿到一个引用对象，`Array.isArray()` 为 false，插件会
 * 静默不工作。
 *
 * 同时兼容整份 Config 被顶层 `.volatile()` 包裹的形态（此时
 * `config.get()` 才是真实配置）。两种形态都解包，调用方不需要关心。
 *
 * 热更新：volatile 引用的写入无法订阅，所以每次分配前比对配置指纹，
 * 变了就整体换池。
 *
 * @module dsh-main-model-pool/config
 */

import { SessionPool } from "./pool.js";
import { normalizeMaxConcurrent, normalizeStrategy, normalizeWeight } from "./strategy.js";

/**
 * 是否是 cosmokit 的 volatile 引用。
 * @param {unknown} value - 待判定值。
 * @returns {boolean} 是否带 `get()`。
 */
export function isVolatileRef(value) {
  return value !== null && typeof value === "object" && typeof value.get === "function";
}

/**
 * 解包配置：优先 `config.get()`，否则逐字段解包 volatile 引用。
 * @param {unknown} config - `apply` 收到的第二参数。
 * @returns {{enabled?: boolean, strategy?: string, pools?: Array<object>}} 解包后的普通配置。
 */
export function readConfig(config) {
  if (isVolatileRef(config)) {
    const whole = config.get() ?? {};
    return { ...whole, strategy: normalizeStrategy(whole.strategy) };
  }
  if (config === null || config === undefined || typeof config !== "object") return {};

  const enabled = isVolatileRef(config.enabled) ? config.enabled.get() : config.enabled;
  const pools = isVolatileRef(config.pools) ? config.pools.get() : config.pools;
  const strategy = isVolatileRef(config.strategy) ? config.strategy.get() : config.strategy;
  // 缺省/未知策略在解包阶段就归一，下游不必各自再兜一次；返回形状也因此
  // 始终带 strategy，老配置读到的就是默认值。
  return { ...config, enabled, strategy: normalizeStrategy(strategy), pools };
}

/**
 * 规范化池配置：丢掉形状不完整的条目，补默认值，保留配置顺序。
 * @param {unknown} pools - 原始 `pools` 数组。
 * @returns {Array<{provider: string, model: string, maxConcurrent: number, weight: number}>} 规范化结果。
 */
export function normalizePoolEntries(pools) {
  if (!Array.isArray(pools)) return [];
  const entries = [];
  for (const item of pools) {
    if (item === null || typeof item !== "object") continue;
    if (typeof item.provider !== "string" || item.provider.length === 0) continue;
    if (typeof item.model !== "string" || item.model.length === 0) continue;
    entries.push({
      provider: item.provider,
      model: item.model,
      maxConcurrent: normalizeMaxConcurrent(item.maxConcurrent),
      weight: normalizeWeight(item.weight),
    });
  }
  return entries;
}

/**
 * 由配置构建池；未启用或池为空时返回 undefined。
 * @param {unknown} config - 原始或已解包的配置。
 * @returns {SessionPool|undefined} 可用的池。
 */
export function buildPool(config) {
  const unwrapped = readConfig(config);
  if (unwrapped.enabled !== true) return undefined;
  const entries = normalizePoolEntries(unwrapped.pools);
  if (entries.length === 0) return undefined;
  return new SessionPool(entries, normalizeStrategy(unwrapped.strategy));
}

/**
 * 配置指纹：只覆盖影响分配行为的字段。
 *
 * 归一化后再序列化，缺省值与显式默认值得到同一指纹，避免无谓换池。
 * 策略必须进指纹：否则从严格主备切均衡时指纹不变，热更新不会重建池。
 * @param {unknown} config - 原始或已解包的配置。
 * @returns {string} 稳定指纹。
 */
export function signatureOf(config) {
  const unwrapped = readConfig(config);
  const entries = normalizePoolEntries(unwrapped.pools);
  return JSON.stringify([
    unwrapped.enabled === true,
    normalizeStrategy(unwrapped.strategy),
    entries.map((entry) => [entry.provider, entry.model, entry.maxConcurrent, entry.weight]),
  ]);
}
