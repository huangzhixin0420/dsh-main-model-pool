// fresh 主会话判定测试。
import test from "node:test";
import assert from "node:assert/strict";

import { freshVerdict, isFreshMainSession } from "../lib/fresh.js";

/**
 * 造一个最小 session 桩。
 * @param {object} over - 覆盖字段。
 * @returns {object} session。
 */
function sessionOf(over = {}) {
  return {
    id: "s1",
    header: {},
    firstLiveSeq: 0,
    eventAt: () => undefined,
    snapshotEvents: () => [],
    ...over,
  };
}

test("普通新会话是 fresh 主会话", () => {
  assert.equal(isFreshMainSession({ session: sessionOf() }), true);
  assert.deepEqual(freshVerdict(sessionOf()), { ok: true });
});

test("已经跑过 turn/start 的会话不是 fresh", () => {
  const session = sessionOf({
    snapshotEvents: () => [{ type: "turn/start", data: { turn: 1 } }],
  });
  assert.equal(isFreshMainSession(session), false);
  assert.equal(freshVerdict(session).reason, "ran-turn");
});

test("首事件是 session/end-seed 的会话不是 fresh", () => {
  const session = sessionOf({
    eventAt: (seq) => (seq === 0 ? { type: "session/end-seed", data: {} } : undefined),
  });
  assert.equal(isFreshMainSession(session), false);
  assert.equal(freshVerdict(session).reason, "seeded");
});

test("子代理（origin=subagent）不是 fresh", () => {
  const session = sessionOf({ header: { origin: "subagent", parentSession: "parent" } });
  assert.equal(isFreshMainSession(session), false);
  assert.equal(freshVerdict(session).reason, "subagent");
});

test("有 parentSession 的子会话不是 fresh", () => {
  const session = sessionOf({ header: { parentSession: "parent" } });
  assert.equal(isFreshMainSession(session), false);
  assert.equal(freshVerdict(session).reason, "child-session");
});

test("fork / 带 seed（header.isSeeded）的会话不是 fresh", () => {
  const session = sessionOf({ header: { isSeeded: true } });
  assert.equal(isFreshMainSession(session), false);
  assert.equal(freshVerdict(session).reason, "seeded");
});

test("firstLiveSeq 不为 0 的恢复会话不是 fresh", () => {
  const session = sessionOf({ firstLiveSeq: 12 });
  assert.equal(isFreshMainSession(session), false);
  assert.equal(freshVerdict(session).reason, "not-fresh");
});

test("默认按官方判据：firstLiveSeq 必须是 0", () => {
  const session = sessionOf({ firstLiveSeq: undefined });
  assert.equal(isFreshMainSession(session), false);
});

test("读事件抛错时按空日志处理，不误伤普通新会话", () => {
  const session = sessionOf({
    eventAt: () => {
      throw new Error("read failed");
    },
    snapshotEvents: () => {
      throw new Error("read failed");
    },
  });
  assert.equal(isFreshMainSession(session), true);
});

test("没有 session / header 时返回 false", () => {
  assert.equal(isFreshMainSession(undefined), false);
  assert.equal(freshVerdict(undefined).reason, "no-session");
  assert.equal(isFreshMainSession({ session: { id: "x" } }), false);
  assert.equal(freshVerdict({ session: { id: "x" } }).reason, "no-header");
});
