// 桩式端到端：用最小 ctx / agent 桩驱动真实的 apply()，不启动 DSH。
import test from "node:test";
import assert from "node:assert/strict";

import { apply } from "../lib/plugin.js";

/**
 * 造一个最小 cordis ctx 桩。
 * @returns {{ctx: object, handlers: Map<string, Function>, logs: Array}} 桩。
 */
function stubCtx() {
  const handlers = new Map();
  const logs = [];
  const ctx = {
    logger: {
      info: (message) => logs.push(["info", message]),
      warn: (message) => logs.push(["warn", message]),
    },
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    effect: () => {},
  };
  return { ctx, handlers, logs };
}

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

/**
 * 造一个新建主会话 agent 桩。
 * @param {string} id - 会话 id。
 * @param {object} options - 覆盖项。
 * @returns {object} agent 与读取器。
 */
function freshAgent(id, options = {}) {
  let selected;
  let selectCalls = 0;
  const session = {
    id,
    header: options.header ?? {},
    firstLiveSeq: options.firstLiveSeq ?? 0,
    eventAt: options.eventAt ?? (() => undefined),
    snapshotEvents: options.snapshotEvents ?? (() => []),
  };
  const agent = {
    id,
    session,
    model: {
      current: () => selected,
      select: (route) => {
        selectCalls += 1;
        if (options.selectThrows === true) throw new Error("select 桩：模拟写事件失败");
        selected = { provider: route.provider, model: route.model };
      },
    },
  };
  return {
    agent,
    selected: () => selected,
    selectCalls: () => selectCalls,
  };
}

/**
 * 触发一次 agent/created。
 * @param {Map<string, Function>} handlers - 监听器表。
 * @param {object} agent - agent 桩。
 * @param {string} source - 创建来源。
 * @returns {void}
 */
function created(handlers, agent, source = "startup") {
  handlers.get("agent/created")({ agent, source });
}

/**
 * 发一条会话事件。
 * @param {Map<string, Function>} handlers - 监听器表。
 * @param {object} session - session 桩。
 * @param {object} event - 事件。
 * @returns {void}
 */
function sessionEvent(handlers, session, event) {
  handlers.get("session/event")(session, event);
}

test("4 个并发创建：2 个候选各 maxConcurrent=2，分配结果 2+2", () => {
  const { ctx, handlers } = stubCtx();
  apply(ctx, {
    enabled: fieldRef(true),
    pools: fieldRef([
      { provider: "p", model: "primary", maxConcurrent: 2 },
      { provider: "p", model: "backup", maxConcurrent: 2 },
    ]),
  });

  const agents = ["s1", "s2", "s3", "s4"].map((id) => freshAgent(id));
  for (const { agent } of agents) created(handlers, agent);

  const models = agents.map(({ selected }) => selected()?.model);
  assert.deepEqual(models, ["primary", "primary", "backup", "backup"]);
  assert.equal(agents.filter(({ selected }) => selected()?.model === "primary").length, 2);
  assert.equal(agents.filter(({ selected }) => selected()?.model === "backup").length, 2);
});

test("第 5 个：池内全满，不 select、不占位", () => {
  const { ctx, handlers } = stubCtx();
  apply(ctx, {
    enabled: fieldRef(true),
    pools: fieldRef([
      { provider: "p", model: "primary", maxConcurrent: 2 },
      { provider: "p", model: "backup", maxConcurrent: 2 },
    ]),
  });

  const agents = ["s1", "s2", "s3", "s4"].map((id) => freshAgent(id));
  for (const { agent } of agents) created(handlers, agent);

  const fifth = freshAgent("s5");
  created(handlers, fifth.agent);
  assert.equal(fifth.selected(), undefined, "全满时不能调用 select");
  assert.equal(fifth.selectCalls(), 0);

  // 释放 s1 后只空出一个名额；若 s5 偷偷占了位，s6 就拿不到。
  // 真实时序里 turn/end 前一定先有 turn/start。
  sessionEvent(handlers, agents[0].agent.session, { type: "turn/start", data: { turn: 1 } });
  sessionEvent(handlers, agents[0].agent.session, { type: "turn/end", data: { turn: 1 } });
  const sixth = freshAgent("s6");
  created(handlers, sixth.agent);
  assert.notEqual(sixth.selected(), undefined, "s5 未占位，释放后 s6 应能分配");
  assert.equal(fifth.selected(), undefined);
});

test("乐观占位 → turn/start → turn/end 的完整生命周期", () => {
  const { ctx, handlers } = stubCtx();
  apply(ctx, {
    enabled: fieldRef(true),
    pools: fieldRef([{ provider: "p", model: "only", maxConcurrent: 1 }]),
  });

  const first = freshAgent("s1");
  const second = freshAgent("s2");
  created(handlers, first.agent);
  assert.equal(first.selected()?.model, "only");

  // 首轮还没开跑，但 pending 已占位，第二个必须挡住。
  created(handlers, second.agent);
  assert.equal(second.selected(), undefined, "turn/start 之前就要挡超发");

  sessionEvent(handlers, first.agent.session, { type: "turn/start", data: { turn: 1 } });
  created(handlers, second.agent);
  assert.equal(second.selected(), undefined, "running 期间仍然挡住");

  sessionEvent(handlers, first.agent.session, { type: "turn/end", data: { turn: 1 } });
  created(handlers, second.agent);
  assert.equal(second.selected()?.model, "only", "turn/end 释放后名额可复用");

  // 重复 turn/end 幂等，不影响第二个会话的占位。
  sessionEvent(handlers, first.agent.session, { type: "turn/end", data: { turn: 1 } });
  const third = freshAgent("s3");
  created(handlers, third.agent);
  assert.equal(third.selected(), undefined, "第二个会话的 pending 不能被误删");
});

test("不按 source 判断：source=resume 的空白新会话仍然分配", () => {
  const { ctx, handlers } = stubCtx();
  apply(ctx, {
    enabled: fieldRef(true),
    pools: fieldRef([{ provider: "p", model: "only", maxConcurrent: 5 }]),
  });

  const resumedFresh = freshAgent("r1");
  created(handlers, resumedFresh.agent, "resume");
  assert.equal(resumedFresh.selected()?.model, "only");

  const subagent = freshAgent("sub1", { header: { origin: "subagent", parentSession: "parent" } });
  created(handlers, subagent.agent, "startup");
  assert.equal(subagent.selectCalls(), 0);

  const seeded = freshAgent("fork1", { header: { isSeeded: true } });
  created(handlers, seeded.agent, "startup");
  assert.equal(seeded.selectCalls(), 0);

  const ran = freshAgent("ran1", {
    snapshotEvents: () => [{ type: "turn/start", data: { turn: 1 } }],
  });
  created(handlers, ran.agent, "startup");
  assert.equal(ran.selectCalls(), 0);
});

test("agent.disposed / session.disposed 清空占用", () => {
  const { ctx, handlers } = stubCtx();
  apply(ctx, {
    enabled: fieldRef(true),
    pools: fieldRef([{ provider: "p", model: "only", maxConcurrent: 1 }]),
  });

  const first = freshAgent("s1");
  created(handlers, first.agent);
  const second = freshAgent("s2");
  created(handlers, second.agent);
  assert.equal(second.selected(), undefined);

  handlers.get("agent/disposed")({ agent: first.agent });
  created(handlers, second.agent);
  assert.equal(second.selected()?.model, "only");

  const third = freshAgent("s3");
  created(handlers, third.agent);
  assert.equal(third.selected(), undefined, "second 仍占着唯一名额");

  handlers.get("session/disposed")(second.agent.session);
  created(handlers, third.agent);
  assert.equal(third.selected()?.model, "only");
});

test("select 抛错时回滚占位，不泄漏名额", () => {
  const { ctx, handlers } = stubCtx();
  apply(ctx, {
    enabled: fieldRef(true),
    pools: fieldRef([{ provider: "p", model: "only", maxConcurrent: 1 }]),
  });

  const broken = freshAgent("s1", { selectThrows: true });
  created(handlers, broken.agent);
  assert.equal(broken.selectCalls(), 1);

  const next = freshAgent("s2");
  created(handlers, next.agent);
  assert.equal(next.selected()?.model, "only", "失败会话的占位必须已回滚");
});

test("配置热更新：改 pools 后新会话用新池，无需重启", () => {
  const { ctx, handlers, logs } = stubCtx();
  const enabled = fieldRef(true);
  const pools = fieldRef([{ provider: "p", model: "old", maxConcurrent: 1 }]);
  apply(ctx, { enabled, pools });

  const first = freshAgent("s1");
  created(handlers, first.agent);
  assert.equal(first.selected()?.model, "old");

  const second = freshAgent("s2");
  created(handlers, second.agent);
  assert.equal(second.selected(), undefined, "旧池已满");

  pools.set([{ provider: "p", model: "new", maxConcurrent: 2 }]);
  const third = freshAgent("s3");
  created(handlers, third.agent);
  assert.equal(third.selected()?.model, "new");
  const fourth = freshAgent("s4");
  created(handlers, fourth.agent);
  assert.equal(fourth.selected()?.model, "new");
  const fifth = freshAgent("s5");
  created(handlers, fifth.agent);
  assert.equal(fifth.selected(), undefined, "新池也按新上限封顶");
  assert.ok(logs.some(([, message]) => /配置热更新/.test(message)));
});

test("enabled 默认 false：不分配；热启用后生效", () => {
  const { ctx, handlers } = stubCtx();
  const enabled = fieldRef(false);
  apply(ctx, {
    enabled,
    pools: fieldRef([{ provider: "p", model: "only", maxConcurrent: 1 }]),
  });

  const before = freshAgent("s1");
  created(handlers, before.agent);
  assert.equal(before.selectCalls(), 0);

  enabled.set(true);
  const after = freshAgent("s2");
  created(handlers, after.agent);
  assert.equal(after.selected()?.model, "only");
});

test("兼容整份配置被顶层 volatile 包裹的形态（config.get()）", () => {
  const { ctx, handlers } = stubCtx();
  const config = {
    get: () => ({ enabled: true, pools: [{ provider: "p", model: "only", maxConcurrent: 1 }] }),
  };
  apply(ctx, config);

  const agent = freshAgent("s1");
  created(handlers, agent.agent);
  assert.equal(agent.selected()?.model, "only");
});

test("strategy=balanced：新建会话按 assigned 轮转，而不是压满高权重", () => {
  const { ctx, handlers } = stubCtx();
  apply(ctx, {
    enabled: fieldRef(true),
    strategy: fieldRef("balanced"),
    pools: fieldRef([
      { provider: "p", model: "primary", maxConcurrent: 3, weight: 9 },
      { provider: "p", model: "backup", maxConcurrent: 3, weight: 1 },
    ]),
  });

  const agents = ["s1", "s2", "s3", "s4"].map((id) => freshAgent(id));
  for (const { agent } of agents) created(handlers, agent);
  assert.deepEqual(
    agents.map(({ selected }) => selected()?.model),
    ["primary", "backup", "primary", "backup"],
  );
});

test("配置热更新：只改 strategy 也会换池，下一次分配即按新策略", () => {
  const { ctx, handlers, logs } = stubCtx();
  const strategy = fieldRef("strict-priority");
  apply(ctx, {
    enabled: fieldRef(true),
    strategy,
    pools: fieldRef([
      { provider: "p", model: "primary", maxConcurrent: 3, weight: 9 },
      { provider: "p", model: "backup", maxConcurrent: 3, weight: 1 },
    ]),
  });

  const first = freshAgent("s1");
  created(handlers, first.agent);
  const second = freshAgent("s2");
  created(handlers, second.agent);
  assert.deepEqual(
    [first.selected()?.model, second.selected()?.model],
    ["primary", "primary"],
    "严格主备会一直压 primary，直到它占满",
  );

  strategy.set("balanced");
  const third = freshAgent("s3");
  created(handlers, third.agent);
  const fourth = freshAgent("s4");
  created(handlers, fourth.agent);
  assert.equal(third.selected()?.model, "primary", "新池 assigned 全 0，先按顺序取第一个");
  assert.equal(fourth.selected()?.model, "backup", "第二次按 assigned 轮到 backup");
  assert.ok(logs.some(([, message]) => /策略 balanced/.test(message)));
});
