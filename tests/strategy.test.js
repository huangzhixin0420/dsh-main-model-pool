// 严格主备策略的单元测试：纯函数，不启动 DSH。
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_STRATEGY,
  STRATEGIES,
  STRATEGY,
  assignedOf,
  availableOf,
  normalizeStrategy,
  orderCandidates,
  selectBalanced,
  selectCandidate,
  selectStrictPriority,
} from "../lib/strategy.js";

/**
 * 造一个候选。
 * @param {object} over - 覆盖字段。
 * @returns {object} 候选。
 */
function candidate(over = {}) {
  return {
    index: 0,
    provider: "p",
    model: "m",
    weight: 1,
    maxConcurrent: 3,
    running: 0,
    pending: 0,
    ...over,
  };
}

test("STRATEGY 历史别名仍指向严格主备，别名与 selectCandidate 同一函数", () => {
  assert.equal(STRATEGY, "strict-priority");
  assert.equal(selectStrictPriority, selectCandidate);
});

test("weight 降序：高权重候选优先", () => {
  const picked = selectCandidate([
    candidate({ index: 0, provider: "p", model: "low", weight: 1 }),
    candidate({ index: 1, provider: "p", model: "high", weight: 5 }),
  ]);
  assert.equal(picked.model, "high");
});

test("同 weight 按配置数组顺序（index 升序）", () => {
  const picked = selectCandidate([
    candidate({ index: 1, provider: "p", model: "second", weight: 3 }),
    candidate({ index: 0, provider: "p", model: "first", weight: 3 }),
  ]);
  assert.equal(picked.model, "first");
});

test("高权重未占满时绝不轮到低权重（即使低权重更空）", () => {
  const picked = selectCandidate([
    candidate({ index: 0, provider: "p", model: "primary", weight: 8, running: 2, maxConcurrent: 3 }),
    candidate({ index: 1, provider: "p", model: "backup", weight: 1, running: 0, maxConcurrent: 10 }),
  ]);
  assert.equal(picked.model, "primary");
});

test("高权重占满后落到低权重", () => {
  const picked = selectCandidate([
    candidate({ index: 0, provider: "p", model: "primary", weight: 8, running: 3, maxConcurrent: 3 }),
    candidate({ index: 1, provider: "p", model: "backup", weight: 1, running: 0, maxConcurrent: 3 }),
  ]);
  assert.equal(picked.model, "backup");
});

test("乐观占位（pending）也算占用，不能只看 running", () => {
  const picked = selectCandidate([
    candidate({ index: 0, provider: "p", model: "primary", weight: 8, running: 0, pending: 3, maxConcurrent: 3 }),
    candidate({ index: 1, provider: "p", model: "backup", weight: 1, running: 0, pending: 0, maxConcurrent: 3 }),
  ]);
  assert.equal(picked.model, "backup");
});

test("全满返回 undefined", () => {
  const picked = selectCandidate([
    candidate({ index: 0, provider: "p", model: "a", running: 2, pending: 1, maxConcurrent: 3 }),
    candidate({ index: 1, provider: "p", model: "b", running: 1, pending: 1, maxConcurrent: 2 }),
  ]);
  assert.equal(picked, undefined);
});

test("空数组返回 undefined", () => {
  assert.equal(selectCandidate([]), undefined);
  assert.equal(selectCandidate(undefined), undefined);
});

test("orderCandidates 不改原数组", () => {
  const input = [
    candidate({ index: 0, model: "a", weight: 1 }),
    candidate({ index: 1, model: "b", weight: 9 }),
  ];
  const before = input.map((item) => item.model);
  assert.deepEqual(
    orderCandidates(input).map((item) => item.model),
    ["b", "a"],
  );
  assert.deepEqual(input.map((item) => item.model), before);
});

test("余量 = maxConcurrent - running - pending", () => {
  assert.equal(availableOf(candidate({ maxConcurrent: 5, running: 2, pending: 1 })), 2);
  assert.equal(availableOf(candidate({ maxConcurrent: 3, running: 3, pending: 0 })), 0);
});

test("策略枚举与默认值：两种策略，默认严格主备", () => {
  assert.deepEqual([...STRATEGIES], ["strict-priority", "balanced"]);
  assert.equal(DEFAULT_STRATEGY, "strict-priority");
  assert.equal(STRATEGY, "strict-priority");
  assert.equal(normalizeStrategy("balanced"), "balanced");
  assert.equal(normalizeStrategy("unknown"), "strict-priority");
  assert.equal(normalizeStrategy(undefined), "strict-priority");
});

test("balanced：余量不足的候选被跳过，即使它 assigned 最少", () => {
  const picked = selectCandidate(
    [
      candidate({ index: 0, model: "full", assigned: 0, running: 3, maxConcurrent: 3 }),
      candidate({ index: 1, model: "spare", assigned: 5, running: 0, maxConcurrent: 3 }),
    ],
    "balanced",
  );
  assert.equal(picked.model, "spare");
});

test("balanced：首次派发 assigned 全 0 时按 index 选第一个", () => {
  const picked = selectCandidate(
    [
      candidate({ index: 1, model: "second", assigned: 0 }),
      candidate({ index: 0, model: "first", assigned: 0 }),
    ],
    "balanced",
  );
  assert.equal(picked.model, "first");
});

test("balanced：assigned 相同按 index 升序做稳定 tiebreak", () => {
  const picked = selectCandidate(
    [
      candidate({ index: 2, model: "c", assigned: 4 }),
      candidate({ index: 1, model: "b", assigned: 4 }),
      candidate({ index: 0, model: "a", assigned: 4 }),
    ],
    "balanced",
  );
  assert.equal(picked.model, "a");
});

test("balanced：assigned 最少者优先，忽略 weight 高低", () => {
  const picked = selectCandidate(
    [
      candidate({ index: 0, model: "high-weight", weight: 99, assigned: 3 }),
      candidate({ index: 1, model: "low-weight", weight: 1, assigned: 1 }),
    ],
    "balanced",
  );
  assert.equal(picked.model, "low-weight");
});

test("balanced：全满返回 undefined", () => {
  const picked = selectCandidate(
    [
      candidate({ index: 0, model: "a", assigned: 0, running: 3, maxConcurrent: 3 }),
      candidate({ index: 1, model: "b", assigned: 2, running: 1, pending: 1, maxConcurrent: 2 }),
    ],
    "balanced",
  );
  assert.equal(picked, undefined);
});

test("策略切换：同一批候选在两种策略下结果不同且各自符合定义", () => {
  const candidates = [
    candidate({ index: 0, model: "primary", weight: 9, assigned: 5 }),
    candidate({ index: 1, model: "backup", weight: 1, assigned: 0 }),
  ];
  const strict = selectCandidate(candidates, "strict-priority");
  const balanced = selectCandidate(candidates, "balanced");
  assert.equal(strict.model, "primary", "严格主备只看 weight，高权重优先");
  assert.equal(balanced.model, "backup", "均衡分配只看 assigned，少的优先");
  assert.notEqual(strict.model, balanced.model);
});

test("未知/缺省策略回落严格主备", () => {
  const candidates = [
    candidate({ index: 0, model: "primary", weight: 9 }),
    candidate({ index: 1, model: "backup", weight: 1 }),
  ];
  assert.equal(selectCandidate(candidates)?.model, "primary");
  assert.equal(selectCandidate(candidates, "nonsense")?.model, "primary");
  assert.equal(selectCandidate(candidates, "strict-priority")?.model, "primary");
});

test("assignedOf 归一：缺省/非法按 0，负数按 0", () => {
  assert.equal(assignedOf(candidate()), 0);
  assert.equal(assignedOf(candidate({ assigned: 7 })), 7);
  assert.equal(assignedOf(candidate({ assigned: -2 })), 0);
  assert.equal(assignedOf(candidate({ assigned: Number.NaN })), 0);
  assert.equal(selectBalanced(undefined), undefined);
});
