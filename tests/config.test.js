// 配置解包 / 规范化 / 指纹测试：不依赖 schemastery，验证运行时契约。
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPool,
  normalizePoolEntries,
  readConfig,
  signatureOf,
} from "../lib/config.js";

/**
 * 造一个字段级 volatile 引用。
 * @param {unknown} value - 初始值。
 * @returns {{get: Function, set: Function}} 引用。
 */
function fieldRef(value) {
  let current = value;
  return {
    get: () => current,
    set: (next) => {
      current = next;
    },
  };
}

test("readConfig 解包字段级 volatile（cordis 实际传入的形态）", () => {
  const config = {
    enabled: fieldRef(true),
    pools: fieldRef([{ provider: "p", model: "m" }]),
  };
  const unwrapped = readConfig(config);
  assert.equal(unwrapped.enabled, true);
  assert.deepEqual(unwrapped.pools, [{ provider: "p", model: "m" }]);
});

test("readConfig 解包整份顶层 volatile（config.get()）", () => {
  const config = {
    get: () => ({ enabled: true, pools: [{ provider: "p", model: "m" }] }),
  };
  assert.deepEqual(readConfig(config), {
    enabled: true,
    strategy: "strict-priority",
    pools: [{ provider: "p", model: "m" }],
  });
});

test("readConfig 对普通对象原样解包", () => {
  assert.deepEqual(readConfig({ enabled: true, pools: [] }), {
    enabled: true,
    strategy: "strict-priority",
    pools: [],
  });
  assert.deepEqual(readConfig(null), {});
  assert.deepEqual(readConfig(undefined), {});
});

test("normalizePoolEntries 补默认值并丢掉不完整条目", () => {
  const entries = normalizePoolEntries([
    { provider: "p", model: "a" },
    { provider: "p", model: "b", maxConcurrent: 7, weight: 4 },
    { provider: "", model: "bad" },
    { provider: "p" },
    null,
  ]);
  assert.deepEqual(entries, [
    { provider: "p", model: "a", maxConcurrent: 3, weight: 1 },
    { provider: "p", model: "b", maxConcurrent: 7, weight: 4 },
  ]);
});

test("buildPool：enabled=false 或池为空返回 undefined", () => {
  assert.equal(buildPool({ enabled: false, pools: [{ provider: "p", model: "m" }] }), undefined);
  assert.equal(buildPool({ enabled: true, pools: [] }), undefined);
  assert.equal(buildPool({ pools: [{ provider: "p", model: "m" }] }), undefined);
});

test("buildPool：字段级 volatile 配置能建成池", () => {
  const pool = buildPool({
    enabled: fieldRef(true),
    pools: fieldRef([
      { provider: "p", model: "a", maxConcurrent: 2, weight: 5 },
      { provider: "p", model: "b" },
    ]),
  });
  assert.notEqual(pool, undefined);
  assert.equal(pool.size, 2);
  assert.deepEqual(
    pool.snapshot().map((entry) => [entry.model, entry.maxConcurrent, entry.weight]),
    [
      ["a", 2, 5],
      ["b", 3, 1],
    ],
  );
});

test("signatureOf：默认值与显式默认值同指纹，池变化则指纹变化", () => {
  const a = { enabled: true, pools: [{ provider: "p", model: "m" }] };
  const b = {
    enabled: true,
    pools: [{ provider: "p", model: "m", maxConcurrent: 3, weight: 1 }],
  };
  assert.equal(signatureOf(a), signatureOf(b));

  const changed = { enabled: true, pools: [{ provider: "p", model: "m", maxConcurrent: 4 }] };
  assert.notEqual(signatureOf(a), signatureOf(changed));
  assert.notEqual(signatureOf(a), signatureOf({ ...a, enabled: false }));
});

test("signatureOf 支持字段级 volatile", () => {
  const config = {
    enabled: fieldRef(true),
    pools: fieldRef([{ provider: "p", model: "m" }]),
  };
  assert.equal(
    signatureOf(config),
    signatureOf({ enabled: true, pools: [{ provider: "p", model: "m" }] }),
  );
});

test("readConfig 解包字段级 volatile 的 strategy", () => {
  const config = {
    enabled: fieldRef(true),
    strategy: fieldRef("balanced"),
    pools: fieldRef([{ provider: "p", model: "m" }]),
  };
  const unwrapped = readConfig(config);
  assert.equal(unwrapped.strategy, "balanced");
  assert.equal(unwrapped.enabled, true);
});

test("buildPool 把 strategy 传给池；缺省/未知回落严格主备", () => {
  const entries = [{ provider: "p", model: "m" }];
  assert.equal(buildPool({ enabled: true, strategy: "balanced", pools: entries }).strategy, "balanced");
  assert.equal(buildPool({ enabled: true, pools: entries }).strategy, "strict-priority");
  assert.equal(buildPool({ enabled: true, strategy: "nonsense", pools: entries }).strategy, "strict-priority");
});

test("signatureOf 包含 strategy：只改策略也会产生不同指纹", () => {
  const base = { enabled: true, pools: [{ provider: "p", model: "m" }] };
  const balanced = { ...base, strategy: "balanced" };
  const explicitStrict = { ...base, strategy: "strict-priority" };
  assert.equal(signatureOf(base), signatureOf(explicitStrict), "缺省与显式默认同指纹");
  assert.notEqual(signatureOf(base), signatureOf(balanced), "策略必须参与指纹");
});
