// 主会话模型池 —— Web GUI 设置页（客户端半身）。
//
// 手写 ModuleLoader 客户端，与同作者的 dsh-subagent-model-pool 同一套契约：
// dsh.client.platform = "web" + exports.apply / exports.inject。
//
// 配置落在 cordis.patch.yml 的 main-model-pool.config：
//   enabled: boolean                                            —— 标量，走 SettingsFormModel 的 staged/save
//   strategy: "strict-priority" | "balanced"                    —— 标量，同一表单通道提交
//   pools: Array<{ provider, model, maxConcurrent, weight }>    —— 数组，走控制器自己的 scope.mutate
//
// 界面上的「优先级」在存储层就是 weight（严格主备按 weight 降序选），
// 字段名与 schema 保持一致，不另造 priority，避免与服务端脱节。
// 均衡分配不使用 weight，但切换策略时它的值必须原样保留，不能清空。
//
// 两段提交的顺序不能反：先 form.save() 提交标量，再 scope.mutate 提交数组。
// form 在创建时捕获了 baseline.revision；若先 mutate，namespace revision 已递增，
// form.save() 必撞 settings/conflict 乐观锁（同参考实现 client.js:385-389 的注释）。
(function () {
  var SETTINGS_NS = "main-model-pool";
  var DEFAULT_MAX_CONCURRENT = 3;
  var DEFAULT_WEIGHT = 1;

  // 策略枚举与标签的唯一真源：下拉选项、格式化、校验全部从这里派生。
  // 上次加策略漏项，就是因为「值」和「标签」各写了一份、只改了一处。
  var STRATEGY_OPTIONS = [
    { value: "strict-priority", label: "严格主备" },
    { value: "balanced", label: "均衡分配" }
  ];
  var DEFAULT_STRATEGY = "strict-priority";
  var STRATEGY_VALUES = STRATEGY_OPTIONS.map(function (option) { return option.value; });

  /** 策略名归一：未知/缺省回落严格主备，与服务端 normalizeStrategy 同规则。 */
  function normalizeStrategy(value) {
    return STRATEGY_VALUES.indexOf(value) >= 0 ? value : DEFAULT_STRATEGY;
  }

  /**
   * 解析「≥1 的整数」。
   *
   * 只认纯十进制数字：空串、负数、小数、科学计数法、带空格之外的脏字符一律
   * 返回 undefined。返回 undefined 即视为该字段无效（红边 + 禁用保存）。
   */
  function parsePositiveInt(text) {
    if (typeof text !== "string") return undefined;
    var trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    var value = Number(trimmed);
    if (!Number.isSafeInteger(value) || value < 1) return undefined;
    return value;
  }

  /**
   * 候选路由的身份键；只用于查找。
   *
   * 用 JSON 编码而不是分隔符拼接：provider/model 自带分隔符时后者会碰撞
   * （a + "b\0c" 与 "a\0b" + c 同键）。
   */
  function poolKey(provider, model) {
    return JSON.stringify([provider, model]);
  }

  /** 从 poolKey 还原出 { provider, model }。 */
  function parsePoolKey(key) {
    var parts = JSON.parse(String(key));
    return { provider: parts[0], model: parts[1] };
  }

  /** 把已存配置归一成 { provider, model, maxConcurrent, weight } 数组。 */
  function normalizePools(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var entry = raw[i];
      if (typeof entry !== "object" || entry === null) continue;
      if (typeof entry.provider !== "string" || entry.provider.length === 0) continue;
      if (typeof entry.model !== "string" || entry.model.length === 0) continue;
      var maxConcurrent = entry.maxConcurrent;
      if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
        maxConcurrent = DEFAULT_MAX_CONCURRENT;
      }
      var weight = entry.weight;
      if (!Number.isInteger(weight) || weight < 1) weight = DEFAULT_WEIGHT;
      out.push({
        provider: entry.provider,
        model: entry.model,
        maxConcurrent: maxConcurrent,
        weight: weight
      });
    }
    return out;
  }

  window.__ModuleLoader__.load({
    id: "dsh-main-model-pool",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      var jsxRuntime = require("react/jsx-runtime");
      var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
      var jsx = jsxRuntime.jsx;
      var jsxs = jsxRuntime.jsxs;

      // 视觉规格照 prototype/settings.html + states.html 的实测值。
      // 面板不跟随 DSH 主题变量：原型给的是固定深色值（#1B1B1C / #F9FAFB），
      // 混用别名变量会得到两套不同的观感。
      var CSS = [
        ".mmp-panel{box-sizing:border-box;width:100%;max-width:640px;padding:22px 24px 18px;border:1px solid rgba(255,255,255,.08);border-radius:20px;background:#1B1B1C;color:#F9FAFB;font-family:inherit;font-size:13px}",
        ".mmp-panel *{box-sizing:border-box}",

        // 标题区
        ".mmp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}",
        ".mmp-headText{min-width:0;max-width:470px}",
        ".mmp-title{font-size:15px;font-weight:600;line-height:20px;letter-spacing:.2px;color:#F9FAFB}",
        ".mmp-sub{margin-top:5px;font-size:12px;line-height:18px;color:#ADB2B8}",
        ".mmp-subMuted{margin-top:2px;color:#81858C}",

        // 开关 36×20
        ".mmp-switch{position:relative;flex:none;width:36px;height:20px;margin-top:2px;padding:0;border:0;border-radius:999px;background:#7AAAFF;cursor:pointer;transition:background .15s ease}",
        ".mmp-switch::after{content:\"\";position:absolute;top:2px;left:18px;width:16px;height:16px;border-radius:50%;background:#151517;transition:left .15s ease,background .15s ease}",
        ".mmp-switch.off{background:rgba(255,255,255,.16)}",
        ".mmp-switch.off::after{left:2px;background:#8E9298}",
        ".mmp-switch:disabled{cursor:not-allowed;opacity:.55}",
        ".mmp-switch:focus-visible{outline:2px solid rgba(122,170,255,.5);outline-offset:2px}",

        ".mmp-divider{height:1px;margin:16px 0 14px;background:rgba(255,255,255,.08)}",

        // 分配策略：行高 32、下拉 24 高、圆角 8，色值复用候选行输入框
        ".mmp-strategy{margin:0 0 10px}",
        ".mmp-strategyRow{display:flex;align-items:center;height:32px;padding:0 8px;border-radius:8px}",
        ".mmp-strategyLabel{flex:1 1 auto;min-width:0;font-size:13px;letter-spacing:.1px;color:#F9FAFB}",
        ".mmp-select{flex:none;width:120px;height:24px;padding:0 6px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(255,255,255,.06);color:#F9FAFB;font-family:inherit;font-size:12px;outline:none;cursor:pointer}",
        ".mmp-select:focus{border-color:rgba(122,170,255,.8);box-shadow:0 0 0 2px rgba(122,170,255,.16)}",
        ".mmp-select:disabled{color:#81858C;border-color:rgba(255,255,255,.08);background:transparent;cursor:not-allowed}",
        ".mmp-select option{background:#1B1B1C;color:#F9FAFB}",
        ".mmp-hint{margin:0 8px 2px;font-size:11px;line-height:16px;letter-spacing:.2px;color:#81858C}",

        // 区块标题行
        ".mmp-sec{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:2px}",
        ".mmp-secTitle{font-size:13px;font-weight:500;line-height:20px;color:#F9FAFB}",
        ".mmp-secTitle span{margin-left:6px;font-size:12px;font-weight:400;color:#81858C}",
        ".mmp-link{padding:0;border:0;background:none;color:#7AAAFF;font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}",
        ".mmp-link:disabled{opacity:.4;cursor:not-allowed}",

        // 列表：停用态整体降透明
        ".mmp-groups{transition:opacity .15s ease}",
        ".mmp-groups.off{opacity:.5}",
        ".mmp-group{margin-top:12px}",
        ".mmp-groupName{margin-bottom:4px;font-size:11px;font-weight:500;letter-spacing:.2px;color:#81858C}",

        // 行 32 高、左右 8、间距 2
        ".mmp-row{position:relative;display:flex;align-items:center;height:32px;margin-bottom:2px;padding:0 8px;border-radius:8px}",
        ".mmp-row.on{background:rgba(255,255,255,.035)}",
        ".mmp-row.bad{margin-bottom:22px}",
        ".mmp-cb{flex:none;width:14px;height:14px;margin:0 10px 0 0;accent-color:#7AAAFF;cursor:pointer}",
        ".mmp-cb:disabled{cursor:not-allowed}",
        ".mmp-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;letter-spacing:.1px;color:#ADB2B8}",
        ".mmp-row.on .mmp-name{color:#F9FAFB}",
        ".mmp-field{display:flex;flex:none;align-items:center;gap:6px;margin-left:14px}",
        ".mmp-field label{font-size:11px;letter-spacing:.2px;color:#81858C;white-space:nowrap}",
        ".mmp-num{width:56px;height:24px;padding:0;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(255,255,255,.06);color:#F9FAFB;font-family:inherit;font-size:12px;text-align:center;outline:none}",
        ".mmp-num::placeholder{color:#81858C;opacity:.8}",
        ".mmp-num.on{border-color:rgba(122,170,255,.5)}",
        ".mmp-num:focus{border-color:rgba(122,170,255,.8);box-shadow:0 0 0 2px rgba(122,170,255,.16)}",
        ".mmp-num:disabled{color:#81858C;border-color:rgba(255,255,255,.08);background:transparent;cursor:not-allowed}",
        ".mmp-num.bad{border-color:#FF6E6E;color:#FF9C9C;background:rgba(255,110,110,.06)}",
        ".mmp-err{position:absolute;right:8px;top:34px;font-size:11px;letter-spacing:.2px;color:#FF8A8A}",

        // 空目录 / 失败提示
        ".mmp-empty{margin:12px 0 0;padding:10px 6px;font-size:12px;line-height:18px;color:#81858C;text-align:center}",
        ".mmp-note{margin:0 0 12px;font-size:12px;line-height:18px;color:#ADB2B8}",
        ".mmp-failed{margin:12px 0 0;font-size:12px;line-height:18px;color:#FF8A8A}",
        ".mmp-catalogError{margin:6px 0 0;font-size:11px;line-height:16px;color:#FF8A8A}",
        ".mmp-retry{margin-left:6px;padding:0;border:0;background:none;color:#7AAAFF;font-family:inherit;font-size:11px;cursor:pointer}",

        // 底部一行：左汇总、右按钮
        ".mmp-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:16px}",
        ".mmp-summary{font-size:11px;letter-spacing:.2px;color:#81858C}",
        ".mmp-actions{display:flex;flex:none;align-items:center;gap:8px}",
        ".mmp-ghost{display:inline-flex;align-items:center;height:28px;padding:0 10px;border:0;border-radius:8px;background:none;color:#CFD3D6;font-family:inherit;font-size:12px;cursor:pointer}",
        ".mmp-ghost:disabled{opacity:.4;cursor:not-allowed}",
        ".mmp-primary{display:inline-flex;align-items:center;height:28px;padding:0 14px;border:0;border-radius:8px;background:#F9FAFB;color:#151717;font-family:inherit;font-size:12px;font-weight:500;cursor:pointer}",
        ".mmp-primary:disabled{background:rgba(249,250,251,.28);color:rgba(21,21,23,.55);cursor:not-allowed}"
      ].join("");
      if (typeof document !== "undefined" && typeof document.querySelector === "function"
        && document.querySelector("style[data-main-model-pool-css]") === null) {
        var style = document.createElement("style");
        style.setAttribute("data-main-model-pool-css", "true");
        style.textContent = CSS;
        document.head.appendChild(style);
      }

      // 布尔标量的 field 描述：SettingsFormModel 只有 text/number 两个现成工厂，
      // 但 spec 本身是开放的（{field, format, parse}），这里把 true/false
      // 编码成 "true"/"false" 文本，仍然走 staged → plan → mutate 这条正路。
      var ENABLED_SPEC = {
        field: "enabled",
        format: function (value) { return value === false ? "false" : "true"; },
        parse: function (text) {
          if (text === "true") return { kind: "set", value: true };
          if (text === "false") return { kind: "set", value: false };
          return undefined;
        }
      };

      // 策略是标量，和 enabled 一样走 SettingsFormModel 的 staged/save，
      // 不另走 scope.mutate：一条通道提交，少一次乐观锁风险。
      var STRATEGY_SPEC = {
        field: "strategy",
        format: function (value) { return normalizeStrategy(value); },
        parse: function (text) {
          return STRATEGY_VALUES.indexOf(text) >= 0 ? { kind: "set", value: text } : undefined;
        }
      };

      // pools 必须作为正式字段注册：SettingsFormModel 的 specs 里没有它时，
      // 任何 field("pools")/队列路径都会当作「没有这个字段」，改动无法进入
      // 待提交队列，保存时被静默丢弃且没有任何报错。
      //
      // 注意：注册 ≠ 用 form 提交。pools 的实际写入由控制器 scope.mutate 完成
      // （见 save()），这里只提供字段身份与合法序列化，避免误走标量通道。
      var POOLS_SPEC = {
        field: "pools",
        format: function (value) {
          try { return JSON.stringify(Array.isArray(value) ? value : []); } catch (error) { return "[]"; }
        },
        parse: function (text) {
          try {
            var value = JSON.parse(text);
            return Array.isArray(value) ? { kind: "set", value: value } : undefined;
          } catch (error) {
            return undefined;
          }
        }
      };

      /**
       * 控制器：标量（enabled）交给 SettingsFormModel，数组（pools）走本地草稿 +
       * scope.mutate 直接写。
       *
       * actions() 只暴露 edit/resetField/discard/save，没有读取待提交队列的入口，
       * 所以「标量 + 数组」只能分两段提交，不能把数组塞进表单再统一 save。
       */
      function ModelPoolController(scope, ctx) {
        var self = this;
        this.scope = scope;
        this.ctx = ctx;
        this.catalogGroups = [];
        this.catalogStatus = "idle";
        this.catalogFailure = undefined;
        this.draft = undefined;   // 草稿池；undefined 表示未改动（直接读已存配置）
        this.saving = false;
        this.failed = false;
        this.form = new primitives.SettingsFormModel(scope, [ENABLED_SPEC, STRATEGY_SPEC, POOLS_SPEC]);
        this.actions = this.form.actions();
        this.store = this.form.bind(function () { return self.projection(); });
        this.unsubscribe = scope.subscribe(function () {
          if (self.catalogStatus === "idle") self.loadCatalog();
          self.publish();
        });
        if (this.catalogStatus === "idle") this.loadCatalog();
      }

      ModelPoolController.prototype.publish = function () {
        this.store.set(this.projection());
      };

      ModelPoolController.prototype.isWritable = function () {
        var snapshot = this.scope.getSnapshot();
        return !snapshot || snapshot.writable !== false;
      };

      /** 当前编辑态的启用值（含未保存的 staged 值）。 */
      ModelPoolController.prototype.enabled = function () {
        return this.form.field("enabled").text === "true";
      };

      /** 当前编辑态的策略（含未保存的 staged 值）。 */
      ModelPoolController.prototype.strategy = function () {
        return normalizeStrategy(this.form.field("strategy").text);
      };

      /** 已存配置里的池（Host 侧真值）。 */
      ModelPoolController.prototype.currentPools = function () {
        var snapshot = this.scope.getSnapshot();
        return normalizePools(snapshot && snapshot.value ? snapshot.value.pools : undefined);
      };

      /**
       * 当前展示用的行映射（key → 草稿/已存值）。
       *
       * 草稿存在时以草稿为准；否则每次从已存配置重建（放弃更改后即「重读」）。
       * 值统一存字符串，才能保留 "0"、""、"abc" 这些中间态并标红。
       */
      ModelPoolController.prototype.rowsMap = function () {
        if (this.draft !== undefined) return this.draft;
        var map = {};
        var pools = this.currentPools();
        for (var i = 0; i < pools.length; i++) {
          var pool = pools[i];
          map[poolKey(pool.provider, pool.model)] = {
            provider: pool.provider,
            model: pool.model,
            limit: String(pool.maxConcurrent),
            weight: String(pool.weight)
          };
        }
        return map;
      };

      /** 确保草稿存在（基于当前已存值深拷贝）。 */
      ModelPoolController.prototype.beginDraft = function () {
        if (this.draft === undefined) {
          var source = this.rowsMap();
          var draft = {};
          var keys = Object.keys(source);
          for (var i = 0; i < keys.length; i++) {
            var entry = source[keys[i]];
            draft[keys[i]] = {
              provider: entry.provider,
              model: entry.model,
              limit: entry.limit,
              weight: entry.weight
            };
          }
          this.draft = draft;
        }
        return this.draft;
      };

      /** 单行装饰：勾选态、编辑文本、校验结果。 */
      ModelPoolController.prototype.decorateRow = function (key, provider, model, name, entry, stale) {
        var selected = entry !== undefined;
        var limitText = selected ? entry.limit : "";
        var weightText = selected ? entry.weight : "";
        var limitValue = selected ? parsePositiveInt(limitText) : undefined;
        var weightValue = selected ? parsePositiveInt(weightText) : undefined;
        return {
          key: key,
          provider: provider,
          model: model,
          name: name || model,
          stale: stale === true,
          selected: selected,
          limitText: limitText,
          weightText: weightText,
          limitValue: limitValue,
          weightValue: weightValue,
          limitInvalid: selected && limitValue === undefined,
          weightInvalid: selected && weightValue === undefined,
          invalid: selected && (limitValue === undefined || weightValue === undefined)
        };
      };

      /**
       * 生成渲染视图：按 provider 分组的实时目录 + 目录里已消失但仍被配置的候选。
       *
       * 孤儿候选必须显示，否则用户既看不到它、也没法把它从池里删掉。
       */
      ModelPoolController.prototype.view = function () {
        var self = this;
        var map = this.rowsMap();
        var groups = [];
        var seen = {};
        var catalogCount = 0;
        var selectedCount = 0;
        var totalConcurrency = 0;
        var invalidCount = 0;
        var catalog = Array.isArray(this.catalogGroups) ? this.catalogGroups : [];

        function tally(row) {
          if (!row.selected) return;
          selectedCount++;
          if (row.limitInvalid) invalidCount++;
          else totalConcurrency += row.limitValue;
          if (row.weightInvalid) invalidCount++;
        }

        for (var g = 0; g < catalog.length; g++) {
          var group = catalog[g];
          if (!group || typeof group !== "object") continue;
          var provider = typeof group.id === "string" ? group.id : String(group.id);
          var models = Array.isArray(group.models) ? group.models : [];
          var rows = [];
          for (var m = 0; m < models.length; m++) {
            var model = models[m];
            var modelId = typeof model === "string" ? model : (model && model.id);
            if (typeof modelId !== "string" || modelId.length === 0) continue;
            var key = poolKey(provider, modelId);
            if (seen[key] === true) continue;   // 同一路由在目录里重复出现时只留一行
            seen[key] = true;
            catalogCount++;
            var name = typeof model === "string" ? model : (model.name || modelId);
            var row = self.decorateRow(key, provider, modelId, name, map[key], false);
            tally(row);
            rows.push(row);
          }
          if (rows.length > 0) {
            groups.push({ id: provider, name: group.name || provider, rows: rows });
          }
        }

        var keys = Object.keys(map);
        var orphans = [];
        for (var k = 0; k < keys.length; k++) {
          if (seen[keys[k]] === true) continue;
          var entry = map[keys[k]];
          var orphan = self.decorateRow(keys[k], entry.provider, entry.model, entry.model, entry, true);
          tally(orphan);
          orphans.push(orphan);
        }
        if (orphans.length > 0) {
          groups.push({ id: "\u0000stale", name: "已不在模型目录中", rows: orphans });
        }

        return {
          groups: groups,
          selectedCount: selectedCount,
          totalCount: catalogCount + orphans.length,
          totalConcurrency: totalConcurrency,
          invalidCount: invalidCount,
          catalogEmpty: catalogCount === 0
        };
      };

      /** 待提交的池（按草稿插入顺序，数字已归一）。 */
      ModelPoolController.prototype.desiredPools = function () {
        var map = this.rowsMap();
        var keys = Object.keys(map);
        var out = [];
        for (var i = 0; i < keys.length; i++) {
          var entry = map[keys[i]];
          var limit = parsePositiveInt(entry.limit);
          var weight = parsePositiveInt(entry.weight);
          out.push({
            provider: entry.provider,
            model: entry.model,
            maxConcurrent: limit === undefined ? DEFAULT_MAX_CONCURRENT : limit,
            weight: weight === undefined ? DEFAULT_WEIGHT : weight
          });
        }
        return out;
      };

      ModelPoolController.prototype.isDirty = function () {
        if (this.draft === undefined) return false;
        var current = this.currentPools();
        var desired = this.desiredPools();
        if (current.length !== desired.length) return true;
        for (var i = 0; i < current.length; i++) {
          if (current[i].provider !== desired[i].provider) return true;
          if (current[i].model !== desired[i].model) return true;
          if (current[i].maxConcurrent !== desired[i].maxConcurrent) return true;
          if (current[i].weight !== desired[i].weight) return true;
        }
        return false;
      };

      ModelPoolController.prototype.projection = function () {
        var snapshot = this.scope.getSnapshot();
        var available = snapshot === undefined || snapshot === null ? true : snapshot.status === "ready";
        var writable = snapshot === undefined || snapshot === null ? true : snapshot.writable !== false;
        var view = this.view();
        var shell = this.form.shell();
        var enabled = this.enabled();
        var strategy = this.strategy();
        var dirty = this.isDirty() || shell.dirty === true;

        var summary;
        if (!enabled) {
          summary = "已停用，配置保留";
        } else {
          summary = "已选 " + view.selectedCount + " 个候选，并发上限合计 " + view.totalConcurrency;
          if (view.invalidCount > 0) summary += " · 有 " + view.invalidCount + " 项无效";
        }

        return {
          available: available,
          writable: writable,
          enabled: enabled,
          strategy: strategy,
          strategyOptions: STRATEGY_OPTIONS,
          balanced: strategy === "balanced",
          dirty: dirty,
          // 停用态静态（无未保存改动）时 dirty=false，保存自然禁用。
          canSave: writable && !this.saving && view.invalidCount === 0 && dirty,
          failed: this.failed,
          saving: this.saving,
          groups: view.groups,
          selectedCount: view.selectedCount,
          totalCount: view.totalCount,
          totalConcurrency: view.totalConcurrency,
          invalidCount: view.invalidCount,
          catalogEmpty: view.catalogEmpty,
          catalogStatus: this.catalogStatus,
          catalogFailure: this.catalogFailure,
          summary: summary
        };
      };

      /** 载入实时模型目录（provider 分组 + 模型列表）。 */
      ModelPoolController.prototype.loadCatalog = function () {
        var self = this;
        if (this.catalogStatus === "loading") return;
        // ctx.remote 是 cordis 服务代理，未 inject 时读属性会直接抛，必须先兜住。
        var remote;
        try {
          remote = this.ctx && this.ctx.remote;
        } catch (error) {
          remote = undefined;
        }
        if (!remote || !remote.session || typeof remote.session.modelCatalog !== "function") {
          this.catalogStatus = "error";
          this.catalogFailure = "当前会话不支持模型目录，无法列出候选。";
          this.publish();
          return;
        }
        this.catalogStatus = "loading";
        this.publish();
        Promise.resolve(remote.session.modelCatalog()).then(function (response) {
          if (response && response.ok && response.value) {
            self.catalogGroups = Array.isArray(response.value.groups) ? response.value.groups : [];
            self.catalogStatus = "ready";
            self.catalogFailure = (response.value.failures || []).length > 0
              ? "部分 provider 读取失败：" + response.value.failures.map(function (failure) {
                return failure.name || failure.id || "未知";
              }).join("、")
              : undefined;
          } else {
            self.catalogStatus = "error";
            self.catalogFailure = "读取模型目录失败。";
          }
          self.publish();
        }, function () {
          self.catalogStatus = "error";
          self.catalogFailure = "读取模型目录失败。";
          self.publish();
        });
      };

      /** 勾选 / 取消一个候选。 */
      ModelPoolController.prototype.toggleRow = function (key) {
        if (this.saving || !this.isWritable() || !this.enabled()) return;
        var draft = this.beginDraft();
        if (Object.prototype.hasOwnProperty.call(draft, key)) {
          delete draft[key];
        } else {
          var route = parsePoolKey(key);
          draft[key] = {
            provider: route.provider,
            model: route.model,
            limit: String(DEFAULT_MAX_CONCURRENT),
            weight: String(DEFAULT_WEIGHT)
          };
        }
        this.failed = false;
        this.publish();
      };

      /** 改某行的并发上限或优先级（字段名：limit / weight）。 */
      ModelPoolController.prototype.setField = function (key, field, text) {
        if (this.saving || !this.isWritable() || !this.enabled()) return;
        var draft = this.beginDraft();
        if (Object.prototype.hasOwnProperty.call(draft, key) !== true) return;
        draft[key][field] = text;
        this.failed = false;
        this.publish();
      };

      /** 切换策略：标量，走表单暂存；非法值直接忽略。 */
      ModelPoolController.prototype.setStrategy = function (value) {
        if (this.saving || !this.isWritable() || !this.enabled()) return;
        if (STRATEGY_VALUES.indexOf(value) < 0) return;
        this.actions.edit("strategy", value);
        this.failed = false;
        this.publish();
      };

      /** 清空已选（只清勾选，不动标量 staged）。 */
      ModelPoolController.prototype.clearSelected = function () {
        if (this.saving || !this.isWritable() || !this.enabled()) return;
        this.draft = {};
        this.failed = false;
        this.publish();
      };

      /** 放弃更改：丢掉暂存的标量与草稿，重新读已存配置。 */
      ModelPoolController.prototype.discard = function () {
        if (this.saving) return;
        this.draft = undefined;
        this.failed = false;
        this.actions.discard();
        this.publish();
      };

      /**
       * 提交：先 form.save()（enabled / strategy），再 scope.mutate（pools）。
       *
       * 顺序关键：SettingsFormModel.save 显式携带创建时捕获的 baseline.revision；
       * 若先 mutate 数组，namespace revision 已递增，form.save 必撞
       * settings/conflict 乐观锁。两段都必须成功才算保存成功。
       */
      ModelPoolController.prototype.save = function () {
        var self = this;
        var snapshot = this.scope.getSnapshot();
        if (this.saving || !snapshot || snapshot.writable === false) return;
        if (this.view().invalidCount > 0) return;

        var poolsDirty = this.isDirty();
        var shell = this.form.shell();
        if (!poolsDirty && shell.dirty !== true) return;

        this.saving = true;
        this.failed = false;
        this.publish();

        var formWriting = shell.dirty === true
          ? Promise.resolve(this.form.save()).then(function () {
            return self.form.shell().failed !== true;
          }, function () {
            return false;
          })
          : Promise.resolve(true);

        var writing = formWriting.then(function (formOk) {
          if (!formOk) return false;
          if (!poolsDirty) return true;
          return Promise.resolve(self.scope.mutate([{
            op: "set",
            path: ["pools"],
            value: self.desiredPools().map(function (item) {
              return {
                provider: item.provider,
                model: item.model,
                maxConcurrent: item.maxConcurrent,
                weight: item.weight
              };
            })
          }])).then(function (result) {
            // scope.mutate 可能用 resolve(false) 表达失败（不是 reject），两种都要接住。
            return result !== false;
          }, function () { return false; });
        });

        writing.then(function (ok) {
          if (!ok) {
            self.saving = false;
            self.failed = true;
            self.publish();
            return undefined;
          }
          if (poolsDirty) self.draft = undefined;
          self.saving = false;
          self.failed = false;
          self.publish();
          return true;
        }, function () {
          self.saving = false;
          self.failed = true;
          self.publish();
        });
      };

      ModelPoolController.prototype.inject = function () {
        var self = this;
        // actions 提供 edit/resetField/discard；save 由本控制器接管（要连带写数组）。
        return Object.assign({}, this.actions, {
          hooks: { modelPool: this.store },
          setEnabled: function (enabled) {
            self.actions.edit("enabled", enabled ? "true" : "false");
          },
          setStrategy: function (value) { self.setStrategy(value); },
          toggleRow: function (key) { self.toggleRow(key); },
          setLimit: function (key, value) { self.setField(key, "limit", value); },
          setWeight: function (key, value) { self.setField(key, "weight", value); },
          clearSelected: function () { self.clearSelected(); },
          retryCatalog: function () {
            self.catalogStatus = "idle";
            self.loadCatalog();
          },
          save: function () { self.save(); },
          discard: function () { self.discard(); }
        });
      };

      ModelPoolController.prototype.dispose = function () {
        if (this.unsubscribe) this.unsubscribe();
        this.form.dispose();
      };

      /**
       * 单行渲染。disabled 同时覆盖「保存中/不可写」「已停用」与「均衡分配」。
       * 均衡策略只按 assigned 轮转，weight 不参与选择；这里置灰但保留值，
       * 切回严格主备时原样恢复可编辑，不清空用户已填的优先级。
       */
      function renderRow(row, listDisabled, handlers, balanced) {
        var selected = row.selected;
        var weightDisabled = listDisabled || !selected || balanced;
        var limitClass = "mmp-num" + (row.limitInvalid ? " bad" : (selected && !listDisabled ? " on" : ""));
        var weightClass = "mmp-num" + (row.weightInvalid ? " bad" : (selected && !weightDisabled ? " on" : ""));
        return jsxs("div", {
          className: "mmp-row" + (selected ? " on" : "") + (row.invalid ? " bad" : ""),
          "data-mmp-row": row.key,
          "data-mmp-selected": selected ? "true" : "false",
          children: [
            jsx("input", {
              type: "checkbox",
              className: "mmp-cb",
              checked: selected,
              disabled: listDisabled,
              "aria-label": row.name,
              "data-mmp-checkbox": row.key,
              onChange: function () { handlers.toggleRow(row.key); }
            }),
            jsx("span", { className: "mmp-name", children: row.name }),
            jsxs("div", {
              className: "mmp-field",
              children: [
                jsx("label", { children: "并发" }),
                jsx("input", {
                  type: "text",
                  inputMode: "numeric",
                  autoComplete: "off",
                  className: limitClass,
                  value: selected ? row.limitText : "",
                  placeholder: selected ? "" : "—",
                  disabled: listDisabled || !selected,
                  "aria-label": row.name + " 并发上限",
                  "aria-invalid": row.limitInvalid ? "true" : undefined,
                  "data-mmp-limit": row.key,
                  onChange: function (event) { handlers.setLimit(row.key, event.currentTarget.value); }
                })
              ]
            }),
            jsxs("div", {
              className: "mmp-field",
              children: [
                jsx("label", { children: "优先级" }),
                jsx("input", {
                  type: "text",
                  inputMode: "numeric",
                  autoComplete: "off",
                  className: weightClass,
                  value: selected ? row.weightText : "",
                  placeholder: selected ? "" : "—",
                  disabled: weightDisabled,
                  // 置灰时也在行内给出原因，避免用户以为是保存中/未勾选。
                  title: balanced ? "均衡分配不使用优先级" : undefined,
                  "aria-label": row.name + " 优先级",
                  "aria-invalid": row.weightInvalid ? "true" : undefined,
                  "data-mmp-weight": row.key,
                  onChange: function (event) { handlers.setWeight(row.key, event.currentTarget.value); }
                })
              ]
            }),
            row.invalid
              ? jsx("div", { className: "mmp-err", children: "应为 ≥1 的整数" })
              : null
          ]
        }, row.key);
      }

      function MainModelPoolSettings(props) {
        var state = props.useModelPool(function (snapshot) { return snapshot; });

        if (!state.available) {
          return jsx("section", {
            className: "mmp-panel",
            "data-main-model-pool-settings": true,
            children: jsx("p", { className: "mmp-note", children: "插件当前未运行，暂时无法配置。" })
          });
        }

        var formDisabled = !state.writable || state.saving;
        var listDisabled = formDisabled || !state.enabled;
        var handlers = {
          toggleRow: props.toggleRow,
          setLimit: props.setLimit,
          setWeight: props.setWeight
        };

        var listChildren = [];
        if (state.catalogStatus === "loading" && state.groups.length === 0) {
          listChildren.push(jsx("div", { className: "mmp-empty", children: "正在读取模型目录…" }, "loading"));
        } else {
          if (state.catalogEmpty) {
            listChildren.push(jsx("div", {
              className: "mmp-empty",
              children: "模型目录为空，请先检查 provider 配置"
            }, "empty"));
          }
          for (var g = 0; g < state.groups.length; g++) {
            var group = state.groups[g];
            listChildren.push(jsxs("div", {
              className: "mmp-group",
              "data-mmp-group": group.id,
              children: [
                jsx("div", { className: "mmp-groupName", children: group.name }),
                group.rows.map(function (row) {
                  return renderRow(row, listDisabled, handlers, state.balanced);
                })
              ]
            }, group.id));
          }
          if (state.catalogStatus === "error" && state.catalogFailure) {
            listChildren.push(jsxs("p", {
              className: "mmp-catalogError",
              children: [
                state.catalogFailure,
                jsx("button", {
                  type: "button",
                  className: "mmp-retry",
                  onClick: props.retryCatalog,
                  children: "重试"
                })
              ]
            }, "catalog-error"));
          }
        }

        var children = [];

        children.push(jsxs("div", {
          className: "mmp-head",
          children: [
            jsxs("div", {
              className: "mmp-headText",
              children: [
                jsx("div", { className: "mmp-title", children: "主会话模型池" }),
                jsx("div", {
                  className: "mmp-sub",
                  children: "新建会话时按所选策略从池中选模型，池内全部占满则回退全局默认模型。"
                }),
                jsx("div", {
                  className: "mmp-sub mmp-subMuted",
                  children: "已有会话、fork 与子代理不受影响。"
                })
              ]
            }),
            jsx("button", {
              type: "button",
              role: "switch",
              className: "mmp-switch" + (state.enabled ? "" : " off"),
              "aria-checked": state.enabled ? "true" : "false",
              "aria-label": "启用主会话模型池",
              "data-mmp-switch": state.enabled ? "on" : "off",
              disabled: formDisabled,
              onClick: function () { props.setEnabled(!state.enabled); }
            })
          ]
        }, "head"));

        children.push(jsx("div", { className: "mmp-divider" }, "divider"));

        // 分配策略在候选列表上方：先定策略，再理解「优先级」为何可能置灰。
        children.push(jsxs("div", {
          className: "mmp-strategy",
          children: [
            jsxs("div", {
              className: "mmp-strategyRow",
              children: [
                jsx("span", { className: "mmp-strategyLabel", children: "分配策略" }),
                jsx("select", {
                  className: "mmp-select",
                  value: state.strategy,
                  disabled: listDisabled,
                  "aria-label": "分配策略",
                  "data-mmp-strategy": state.strategy,
                  onChange: function (event) { props.setStrategy(event.currentTarget.value); },
                  children: state.strategyOptions.map(function (option) {
                    return jsx("option", { value: option.value, children: option.label }, option.value);
                  })
                })
              ]
            }),
            state.balanced
              ? jsx("div", {
                className: "mmp-hint",
                "data-mmp-strategy-hint": true,
                children: "均衡分配不使用优先级"
              })
              : null
          ]
        }, "strategy"));

        children.push(jsxs("div", {
          className: "mmp-sec",
          children: [
            jsxs("div", {
              className: "mmp-secTitle",
              children: [
                "候选模型",
                jsx("span", {
                  "data-mmp-count": state.selectedCount + "/" + state.totalCount,
                  children: state.selectedCount + " / " + state.totalCount
                })
              ]
            }),
            jsx("button", {
              type: "button",
              className: "mmp-link",
              disabled: listDisabled || state.selectedCount === 0,
              onClick: props.clearSelected,
              children: "清空已选"
            })
          ]
        }, "section"));

        children.push(jsx("div", {
          className: "mmp-groups" + (state.enabled ? "" : " off"),
          "data-mmp-groups": state.enabled ? "on" : "off",
          children: listChildren
        }, "groups"));

        if (state.failed) {
          children.push(jsx("p", {
            className: "mmp-failed",
            children: "保存失败，请检查填写内容后重试。"
          }, "failed"));
        }

        children.push(jsxs("div", {
          className: "mmp-foot",
          children: [
            jsx("div", {
              className: "mmp-summary",
              "data-mmp-summary": true,
              children: state.summary
            }),
            jsxs("div", {
              className: "mmp-actions",
              children: [
                jsx("button", {
                  type: "button",
                  className: "mmp-ghost",
                  "data-mmp-discard": true,
                  disabled: state.saving || !state.dirty,
                  onClick: props.discard,
                  children: "放弃更改"
                }),
                jsx("button", {
                  type: "button",
                  className: "mmp-primary",
                  "data-mmp-save": true,
                  disabled: !state.canSave,
                  onClick: props.save,
                  children: state.saving ? "保存中…" : "保存"
                })
              ]
            })
          ]
        }, "foot"));

        return jsxs("section", {
          className: "mmp-panel",
          "data-main-model-pool-settings": true,
          children: children
        });
      }

      function registerSettings(ctx) {
        var scope = ctx.configForms.get(SETTINGS_NS);
        var controller = new ModelPoolController(scope, ctx);
        ctx.effect(function () { return function () { controller.dispose(); }; }, "main-model-pool: 配置表单");
        ctx.effect(function () {
          return ctx.configForms.whileServed([SETTINGS_NS], function () {
            return ctx.slots.inject("settings.section", function () {
              return ctx.slots.register({
                name: "settings.section",
                id: SETTINGS_NS,
                order: 82,
                label: "主会话模型池",
                inject: function () { return controller.inject(); }
              }, MainModelPoolSettings);
            });
          });
        }, "main-model-pool: 设置页入口");
      }

      function apply(ctx) {
        registerSettings(ctx);
      }

      exports.apply = apply;
      // remote / remote.session 是读模型目录（ctx.remote.session.modelCatalog）的前置：
      // 不声明会抛 cannot get property "remote" without inject，整个条目 boot 失败。
      exports.inject = ["slots", "remote", "remote.session", "configForms"];

      // 无 DOM 依赖的测试出口。
      exports.__test = {
        SETTINGS_NS: SETTINGS_NS,
        DEFAULT_MAX_CONCURRENT: DEFAULT_MAX_CONCURRENT,
        DEFAULT_WEIGHT: DEFAULT_WEIGHT,
        STRATEGY_OPTIONS: STRATEGY_OPTIONS,
        STRATEGY_VALUES: STRATEGY_VALUES,
        DEFAULT_STRATEGY: DEFAULT_STRATEGY,
        normalizeStrategy: normalizeStrategy,
        parsePositiveInt: parsePositiveInt,
        poolKey: poolKey,
        parsePoolKey: parsePoolKey,
        normalizePools: normalizePools,
        ModelPoolController: ModelPoolController,
        MainModelPoolSettings: MainModelPoolSettings
      };
      return module.exports;
    }
  });
})();
