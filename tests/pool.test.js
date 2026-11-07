// SessionPool 占用状态测试：不启动 DSH，纯逻辑验证。
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MAX_CONCURRENT, SessionPool } from "../lib/pool.js";

/**
 * 造一个池。
 * @param {Array<object>} entries - 池配置。
 * @returns {SessionPool} 池。
 */
function poolOf(entries) {
  return new SessionPool(entries);
}

test("默认并发上限是 3，默认权重是 1", () => {
  assert.equal(DEFAULT_MAX_CONCURRENT, 3);
  const pool = poolOf([{ provider: "p", model: "a" }]);
  const [entry] = pool.snapshot();
  assert.equal(entry.maxConcurrent, 3);
  assert.equal(entry.weight, 1);
});

test("三个会话同时创建不会超发：乐观占位立刻计入", () => {
  const pool = poolOf([{ provider: "p", model: "a", maxConcurrent: 2 }]);
  const first = pool.allocate("s1");
  const second = pool.allocate("s2");
  const third = pool.allocate("s3");

  assert.deepEqual(first, { provider: "p", model: "a" });
  assert.deepEqual(second, { provider: "p", model: "a" });
  assert.equal(third, undefined, "第三个必须被 pending 占位挡住");
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).pending, 2);
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).running, 0);
  assert.equal(pool.activeCount, 2);
});

test("乐观占位 → turn/start 转 running → turn/end 释放", () => {
  const pool = poolOf([{ provider: "p", model: "a", maxConcurrent: 1 }]);
  assert.deepEqual(pool.allocate("s1"), { provider: "p", model: "a" });
  assert.equal(pool.stateOf("s1"), "pending");
  assert.deepEqual(pool.countsOf({ provider: "p", model: "a" }), {
    running: 0,
    pending: 1,
    occupied: 1,
    available: 0,
    maxConcurrent: 1,
    assigned: 1,
  });

  assert.equal(pool.startTurn("s1"), true);
  assert.equal(pool.stateOf("s1"), "running");
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).pending, 0);
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).running, 1);

  // 正在跑时再来一次 turn/start，不重复计数。
  assert.equal(pool.startTurn("s1"), false);
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).running, 1);

  assert.equal(pool.endTurn("s1"), true);
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).running, 0);
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).pending, 0);
  // 轮次结束后转成 locked：名额已还，但路由记忆保留（模型锁定不能换）。
  assert.equal(pool.stateOf("s1"), "locked");
  assert.deepEqual(pool.assignmentOf("s1"), { provider: "p", model: "a" });

  // 同一会话再开一轮：重新占名额，且不会重复分配。
  assert.equal(pool.startTurn("s1"), true);
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).running, 1);
  assert.equal(pool.endTurn("s1"), true);
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).running, 0);

  // 只有彻底释放才会从池里消失。
  assert.equal(pool.dispose("s1"), true);
  assert.equal(pool.stateOf("s1"), undefined);
  assert.equal(pool.assignmentOf("s1"), undefined);
});

test("locked 会话再开轮次时，即使该候选已满也照跑并如实计数", () => {
  const pool = poolOf([{ provider: "p", model: "a", maxConcurrent: 1 }]);
  pool.allocate("s1");
  pool.startTurn("s1");
  pool.endTurn("s1");                       // s1 → locked，名额已还
  assert.deepEqual(pool.allocate("s2"), { provider: "p", model: "a" });  // s2 拿到名额
  pool.startTurn("s2");
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).occupied, 1);
  // s1 再开一轮：模型锁定不能换，允许占第 2 个名额（软限制的已知边界）。
  assert.equal(pool.startTurn("s1"), true);
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).occupied, 2);
});

test("turn/end 释放后名额可立即复用", () => {
  const pool = poolOf([{ provider: "p", model: "a", maxConcurrent: 1 }]);
  pool.allocate("s1");
  pool.startTurn("s1");
  assert.equal(pool.allocate("s2"), undefined);
  pool.endTurn("s1");
  assert.deepEqual(pool.allocate("s2"), { provider: "p", model: "a" });
});

test("重复释放幂等，不会把计数减成负数", () => {
  const pool = poolOf([{ provider: "p", model: "a", maxConcurrent: 2 }]);
  pool.allocate("s1");
  assert.equal(pool.release("s1"), true);
  assert.equal(pool.release("s1"), false);
  assert.equal(pool.release("s1"), false);
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).occupied, 0);
});

test("未分配的会话释放是 no-op", () => {
  const pool = poolOf([{ provider: "p", model: "a" }]);
  assert.equal(pool.release("ghost"), false);
  assert.equal(pool.endTurn("ghost"), false);
  assert.equal(pool.dispose("ghost"), false);
  assert.equal(pool.activeCount, 0);
});

test("同一会话重复 allocate 幂等，不重复占位", () => {
  const pool = poolOf([{ provider: "p", model: "a", maxConcurrent: 3 }]);
  const first = pool.allocate("s1");
  const again = pool.allocate("s1");
  assert.deepEqual(again, first);
  assert.equal(pool.activeCount, 1);
});

test("池内全满时 allocate 不改任何计数", () => {
  const pool = poolOf([{ provider: "p", model: "a", maxConcurrent: 1 }]);
  pool.allocate("s1");
  const before = pool.snapshot();
  assert.equal(pool.allocate("s2"), undefined);
  assert.deepEqual(pool.snapshot(), before);
  assert.equal(pool.assignmentOf("s2"), undefined);
});

test("dispose 清空该会话的 running 占用", () => {
  const pool = poolOf([{ provider: "p", model: "a", maxConcurrent: 2 }]);
  pool.allocate("s1");
  pool.allocate("s2");
  pool.startTurn("s1");
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).occupied, 2);

  assert.equal(pool.dispose("s1"), true);
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).running, 0);
  assert.equal(pool.countsOf({ provider: "p", model: "a" }).pending, 1);
  assert.equal(pool.assignmentOf("s2")?.model, "a");

  pool.dispose("s2");
  assert.equal(pool.activeCount, 0);
});

test("clear 清空全部占用与会话记录", () => {
  const pool = poolOf([
    { provider: "p", model: "a", maxConcurrent: 2 },
    { provider: "p", model: "b", maxConcurrent: 2 },
  ]);
  pool.allocate("s1");
  pool.allocate("s2");
  pool.startTurn("s1");
  assert.equal(pool.activeCount, 2);

  pool.clear();
  assert.equal(pool.activeCount, 0);
  assert.equal(pool.stateOf("s1"), undefined);
  assert.equal(pool.stateOf("s2"), undefined);
  assert.deepEqual(
    pool.snapshot().map((entry) => [entry.running, entry.pending]),
    [
      [0, 0],
      [0, 0],
    ],
  );
});

test("严格主备：第一个候选占满后才落到第二个", () => {
  const pool = poolOf([
    { provider: "p", model: "primary", weight: 5, maxConcurrent: 2 },
    { provider: "p", model: "backup", weight: 1, maxConcurrent: 2 },
  ]);
  assert.equal(pool.allocate("s1").model, "primary");
  assert.equal(pool.allocate("s2").model, "primary");
  assert.equal(pool.allocate("s3").model, "backup");
  assert.equal(pool.allocate("s4").model, "backup");
  assert.equal(pool.allocate("s5"), undefined);
  assert.deepEqual(
    pool.snapshot().map((entry) => entry.pending),
    [2, 2],
  );
});

test("balanced：三个候选各指派一次后，第 4 次回到第一个（轮转正确）", () => {
  const pool = new SessionPool(
    [
      { provider: "p", model: "a", maxConcurrent: 3 },
      { provider: "p", model: "b", maxConcurrent: 3 },
      { provider: "p", model: "c", maxConcurrent: 3 },
    ],
    "balanced",
  );
  assert.equal(pool.allocate("s1").model, "a");
  assert.equal(pool.allocate("s2").model, "b");
  assert.equal(pool.allocate("s3").model, "c");
  assert.equal(pool.allocate("s4").model, "a", "第 4 次必须回到 assigned 相同里的第一个");
  assert.deepEqual(
    pool.snapshot().map((entry) => entry.assigned),
    [2, 1, 1],
  );
});

test("balanced：候选满载时被跳过，即使它 assigned 最少", () => {
  const pool = new SessionPool(
    [
      { provider: "p", model: "a", maxConcurrent: 1 },
      { provider: "p", model: "b", maxConcurrent: 3 },
    ],
    "balanced",
  );
  // a 先被选中并满载（assigned=1），b 随后拿到两次指派（assigned=2）。
  // 此时 a 的 assigned 更少但已无余量，下一次必须跳过它。
  pool.allocate("s1"); // a
  pool.allocate("s2"); // b
  pool.allocate("s3"); // b
  assert.equal(pool.snapshot()[0].assigned, 1);
  assert.equal(pool.snapshot()[0].available, 0);
  assert.equal(pool.allocate("s4").model, "b", "a 已满，轮到 assigned 更多的 b");
});

test("balanced：全满返回 undefined 且不动任何计数", () => {
  const pool = new SessionPool(
    [
      { provider: "p", model: "a", maxConcurrent: 1 },
      { provider: "p", model: "b", maxConcurrent: 1 },
    ],
    "balanced",
  );
  pool.allocate("s1");
  pool.allocate("s2");
  const before = pool.snapshot();
  assert.equal(pool.allocate("s3"), undefined);
  assert.deepEqual(pool.snapshot(), before);
  assert.deepEqual(
    before.map((entry) => entry.assigned),
    [1, 1],
  );
});

test("assigned 只在 allocate 成功时 +1：重复 allocate / startTurn / 失败都不加", () => {
  const pool = new SessionPool([{ provider: "p", model: "a", maxConcurrent: 1 }], "balanced");
  assert.equal(pool.allocate("s1").model, "a");
  assert.equal(pool.snapshot()[0].assigned, 1);

  pool.allocate("s1"); // 幂等重复，不再占位也不加 assigned
  assert.equal(pool.allocate("s2"), undefined); // 全满失败，不加 assigned
  pool.startTurn("s1");
  pool.endTurn("s1");
  assert.equal(pool.snapshot()[0].assigned, 1);

  pool.clear();
  assert.deepEqual(pool.snapshot().map((entry) => entry.assigned), [0]);
});

test("策略随构造参数生效，未知策略回落严格主备", () => {
  const balanced = new SessionPool([{ provider: "p", model: "a" }], "balanced");
  assert.equal(balanced.strategy, "balanced");
  const fallback = new SessionPool([{ provider: "p", model: "a" }], "nonsense");
  assert.equal(fallback.strategy, "strict-priority");
  assert.equal(new SessionPool([{ provider: "p", model: "a" }]).strategy, "strict-priority");
});
