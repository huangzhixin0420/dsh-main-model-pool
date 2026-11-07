/**
 * 判定一个 agent 是否属于「需要选模型的新建主会话」。
 *
 * 官方先例（照抄判据）：
 * `dsh-tool-subagent/lib/model-selection-settings.js:96`
 *
 * ```js
 * target.firstLiveSeq === 0 && target.eventAt(SessionSeq(0))?.type !== "session/end-seed"
 * ```
 *
 * 含义：
 * - `firstLiveSeq === 0`：这条 Session 的事件日志里没有任何来自持久化/seed
 *   的历史事件，是刚创建的空日志；
 * - 首事件不是 `session/end-seed`：排除带 seed / fork / 恢复时补的结束标记。
 *
 * **绝不能按 `agent/created` 的 `source` 判断。** Web 里「新建会话」在空白
 * 会话场景会走 `agents.resume()`，`source` 是 `"resume"`，但会话本身仍是
 * 全新的；反过来，带历史事件的 resume 即使 `source` 是 `"startup"` 也不能
 * 重新分配。
 *
 * 额外排除三类（设计稿第 7 条）：
 * 1. 子代理：`header.origin === "subagent"` 或存在 `header.parentSession`；
 * 2. fork / 带 seed：`header.isSeeded === true`，或首事件是 `session/end-seed`；
 * 3. 已经跑过轮次：日志里出现过 `turn/start`（防御性检查；正常
 *    `agent/created` 时还不可能有）。
 *
 * @module dsh-main-model-pool/fresh
 */

/**
 * 兼容传入 agent 或 session。
 * @param {object|undefined} input - agent 或 session。
 * @returns {object|undefined} session。
 */
function sessionOf(input) {
  if (input === null || typeof input !== "object") return undefined;
  // agent 的 session 一定有 header；session 自己也一定有 header。
  if (input.session !== undefined && input.session !== null) return input.session;
  return input;
}

/**
 * 读第一条事件；读不到就当作 undefined。
 * @param {object} session - Session。
 * @returns {object|undefined} 首事件。
 */
function firstEventOf(session) {
  try {
    return typeof session.eventAt === "function" ? session.eventAt(0) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读自有事件；读不到就当作空数组。
 * @param {object} session - Session。
 * @returns {Array<object>} 事件数组。
 */
function liveEventsOf(session) {
  try {
    if (typeof session.snapshotEvents !== "function") return [];
    return session.snapshotEvents(0) ?? [];
  } catch {
    return [];
  }
}

/**
 * 给出 fresh 判定与原因，供调用方写诊断日志。
 * @param {object|undefined} input - agent 或 session。
 * @returns {{ok: boolean, reason?: string}} 判定结果。
 */
export function freshVerdict(input) {
  const session = sessionOf(input);
  if (session === undefined) return { ok: false, reason: "no-session" };

  const header = session.header;
  if (header === null || typeof header !== "object") return { ok: false, reason: "no-header" };

  // 子代理：origin 是官方分类；parentSession 是 fork/子会话的血缘字段。
  if (header.origin === "subagent") return { ok: false, reason: "subagent" };
  if (header.parentSession !== undefined) return { ok: false, reason: "child-session" };

  // fork / 带 seed：header 明确标记，或首事件是 seed 结束标记。
  if (header.isSeeded === true) return { ok: false, reason: "seeded" };
  if (firstEventOf(session)?.type === "session/end-seed") {
    return { ok: false, reason: "seeded" };
  }

  // 官方判据：没有继承/持久化事件。
  if (session.firstLiveSeq !== 0) return { ok: false, reason: "not-fresh" };

  // 已经跑过轮次：正常 created 时为空，这里是防御性检查。
  if (liveEventsOf(session).some((event) => event?.type === "turn/start")) {
    return { ok: false, reason: "ran-turn" };
  }

  return { ok: true };
}

/**
 * 布尔便捷入口。
 * @param {object|undefined} input - agent 或 session。
 * @returns {boolean} 是否是需要分配模型的新建主会话。
 */
export function isFreshMainSession(input) {
  return freshVerdict(input).ok;
}
