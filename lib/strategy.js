/**
 * 候选选择策略。
 *
 * 两种策略并存，由配置里的 `strategy` 切换：
 * 1. `strict-priority`（默认，严格主备）：按 `weight` 从大到小排序，`weight`
 *    相同按配置数组顺序（`index` 升序），取第一个「还有余量」的候选；
 * 2. `balanced`（均衡分配）：先按余量过滤掉已满的候选，再在剩下的里取
 *    `assigned`（累计指派次数）最小的；`assigned` 相同按 `index` 升序。
 *
 * 为什么均衡策略必须用 `assigned` 而不是当前占用：当前占用会随着轮次结束
 * 回落，只看占用会让「刚结束一轮的候选」立刻又被选中，长期并不均衡。
 * 同理，全部候选都没被指派过时（`assigned` 全 0）必须按 `index` 取第一个，
 * 否则同一批并发创建会随机打散，用户看到的首个模型不可预期。
 *
 * 余量 = `maxConcurrent` - `running` - `pending`。
 * `pending` 是「已分配但首轮还没开跑」的乐观占位，正是它挡住了
 * 「三个会话同时创建时池看起来是空的」这种超发。
 *
 * 本文件是纯函数，不依赖 cordis 运行时，便于单测。
 *
 * @module dsh-main-model-pool/strategy
 */

/** 可选策略名；顺序即设置页下拉顺序。 */
export const STRATEGIES = ["strict-priority", "balanced"];

/** 默认策略：保持历史行为，未配置时等同严格主备。 */
export const DEFAULT_STRATEGY = "strict-priority";

/** 历史别名，日志与旧调用方仍可用。 */
export const STRATEGY = DEFAULT_STRATEGY;

/** 默认单候选并发上限。 */
export const DEFAULT_MAX_CONCURRENT = 3;

/** 默认权重。 */
export const DEFAULT_WEIGHT = 1;

/**
 * 策略名归一到已知值；未知/缺省/非字符串一律回落严格主备。
 * @param {unknown} value - 原始策略名。
 * @returns {"strict-priority"|"balanced"} 可用策略。
 */
export function normalizeStrategy(value) {
  return STRATEGIES.includes(value) ? value : DEFAULT_STRATEGY;
}

/**
 * 权重归一到大于 0 的有限数；缺省/非法一律回落 1。
 * @param {unknown} value - 原始权重。
 * @returns {number} 可用权重。
 */
export function normalizeWeight(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_WEIGHT;
}

/**
 * 并发上限归一到大于等于 1 的整数；缺省/非法一律回落 3。
 * @param {unknown} value - 原始上限。
 * @returns {number} 可用上限。
 */
export function normalizeMaxConcurrent(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_CONCURRENT;
  }
  return Math.floor(value);
}

/**
 * 候选当前已占用的名额数。
 * @param {object} candidate - 候选。
 * @returns {number} `running + pending`。
 */
export function occupiedOf(candidate) {
  const running = typeof candidate?.running === "number" ? candidate.running : 0;
  const pending = typeof candidate?.pending === "number" ? candidate.pending : 0;
  return Math.max(0, running) + Math.max(0, pending);
}

/**
 * 候选剩余可分配名额。
 * @param {object} candidate - 候选。
 * @returns {number} 余量，可能为 0。
 */
export function availableOf(candidate) {
  return normalizeMaxConcurrent(candidate?.maxConcurrent) - occupiedOf(candidate);
}

/**
 * 候选是否还有余量。
 * @param {object} candidate - 候选。
 * @returns {boolean} 是否可分配。
 */
export function isAvailable(candidate) {
  return availableOf(candidate) > 0;
}

/**
 * 候选的累计指派次数；缺省/非法按 0 处理。
 * @param {object} candidate - 候选。
 * @returns {number} 非负整数。
 */
export function assignedOf(candidate) {
  const assigned = candidate?.assigned;
  return typeof assigned === "number" && Number.isFinite(assigned) && assigned > 0
    ? Math.floor(assigned)
    : 0;
}

/**
 * 候选的配置数组序号；仅用于稳定 tiebreak。
 * @param {object} candidate - 候选。
 * @returns {number} 序号。
 */
function indexOf(candidate) {
  return Number.isInteger(candidate?.index) ? candidate.index : 0;
}

/**
 * 按「权重降序、同权重按配置顺序」排序，返回新数组，不改原数组。
 * @param {Array<object>} candidates - 候选列表。
 * @returns {Array<object>} 排好序的副本。
 */
export function orderCandidates(candidates) {
  return [...candidates].sort((left, right) => {
    const diff = normalizeWeight(right?.weight) - normalizeWeight(left?.weight);
    if (diff !== 0) return diff;
    return indexOf(left) - indexOf(right);
  });
}

/**
 * 严格主备的实体实现：排序后取第一个有余量的候选；全满返回 undefined。
 * @param {Array<object>} candidates - 候选列表。
 * @returns {object|undefined} 选中的候选；无余量时 undefined。
 */
function selectStrictPriorityCore(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  return orderCandidates(candidates).find(isAvailable);
}

/**
 * 均衡分配：只在有余量的候选里挑 `assigned` 最小的。
 *
 * 同次数按 `index` 升序做稳定 tiebreak；全部为 0 时自然落到第一个候选。
 * 全满返回 undefined，不改任何计数（纯函数）。
 * @param {Array<object>} candidates - 候选列表，每项含
 *   `{index, provider, model, weight, maxConcurrent, running, pending, assigned}`。
 * @returns {object|undefined} 选中的候选；全满时 undefined。
 */
export function selectBalanced(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  let best;
  for (const candidate of candidates) {
    if (!isAvailable(candidate)) continue;
    if (best === undefined) {
      best = candidate;
      continue;
    }
    const diff = assignedOf(candidate) - assignedOf(best);
    if (diff < 0) {
      best = candidate;
      continue;
    }
    if (diff === 0 && indexOf(candidate) < indexOf(best)) best = candidate;
  }
  return best;
}

/**
 * 按策略选择候选。
 *
 * 未知/缺省策略回落 `strict-priority`，保证老配置与旧调用方行为不变。
 * @param {Array<object>} candidates - 候选列表，每项含
 *   `{index, provider, model, weight, maxConcurrent, running, pending, assigned}`。
 * @param {string} [strategy] - 策略名，见 {@link STRATEGIES}。
 * @returns {object|undefined} 选中的候选；无余量时 undefined。
 */
export function selectCandidate(candidates, strategy) {
  if (normalizeStrategy(strategy) === "balanced") return selectBalanced(candidates);
  return selectStrictPriorityCore(candidates);
}

/**
 * 历史别名：与 `selectCandidate` 保持同一函数对象。
 * 不传策略时 `selectCandidate` 的行为就是严格主备，故二者可互换；
 * 显式传策略时仍按策略分派。
 */
export const selectStrictPriority = selectCandidate;
