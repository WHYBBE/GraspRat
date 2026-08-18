// ==UserScript==
// @name         Grasp Rat Intel Overlay
// @namespace    https://grasp-rat-game.h-e.top/
// @version      0.14.3
// @description  纯信息层：合并全场实时/快照/小地图数据标记场上玩家，富敌高亮，Active=实线+名+残血HP，Passive=虚线(drop≥20标名)，原生面板按绘制签名直接不绘制，不做任何自动操作。
// @match        https://grasp-rat-game.h-e.top/*
// @run-at       document-end
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  "use strict";

  const code = `(${pageMain.toString()})();`;

  try {
    if (typeof unsafeWindow !== "undefined" && unsafeWindow.eval) {
      unsafeWindow.eval(code);
      return;
    }
  } catch (_) {
    // Fall back to a page script element below.
  }

  const script = document.createElement("script");
  script.textContent = code;
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();

  function pageMain() {
    "use strict";

    const OVERLAY_KEY = "__graspRatIntelOverlay";
    const CANVAS_ID = "grasp-rat-intel-canvas";
    const PANEL_ID = "grasp-rat-intel-panel";

    // 活跃判定：最近这段时间内坐标动过就算 active。
    const MOVING_ENEMY_MEMORY_MS = 10000;
    const ENEMY_MOVE_EPSILON_CM = 30;
    const ENEMY_MEMORY_KEEP_MS = MOVING_ENEMY_MEMORY_MS * 3;
    // 与游戏一致：不压低 dpr，避免缩放/高分屏标注漂移。
    const CANVAS_MAX_DPR = 4;
    // 静止（僵尸）血条只在“最近掉血”后这段时间内显示。
    // 这游戏血量不回，永久残血几乎人人都是，所以不能用 hp<max 判断，
    // 只能记录 HP 变化：检测到 HP 下降后的这段时间内才给静止僵尸显示血条。
    const RECENT_DAMAGE_MS = 6000;
    // 实时区半径（cm）：游戏在活跃视野半径内实时流式推送实体（ACTIVE_VIEW_RADIUS_CM=50000）。
    // 该区内 state.entities 是权威；非实时来源（快照/minimap）的点若落在此区内却不在 entities 里，
    // 判为已死/离线的陈旧数据并丢弃，避免死人/离线圈滞留到下次快照刷新（最长 60s）。
    const LIVE_ZONE_CM = 50000;

    // 屏幕外玩家改画在屏幕边缘（雷达式），只标注有意义的 Drop，避免边缘被低价值点挤满。
    const EDGE_MIN_DROP = 10;
    const EDGE_MAX_MARKERS = 16;
    const EDGE_MARGIN = 30;
    // Drop 达到这个档就算“富敌”，用强化效果（扩散环 + 金币片）重点强调。
    const EMPHASIS_DROP = 50;
    // 活跃玩家血条尺寸（CSS 像素）。原生面板被隐藏后由我们补画血量。
    const HP_BAR_W = 34;
    const HP_BAR_H = 5;
    const HP_BAR_GAP = 13;
    // 自己的血条（固定在屏幕顶部中间），做大一点更醒目。
    const SELF_HP_BAR_W = 200;
    const SELF_HP_BAR_H = 14;
    const SELF_HP_TOP = 12;
    // 近距标签防重叠：屏幕距离小于此值时纵向错开名字/掉落标注。
    const LABEL_STACK_DIST = 42;
    const LABEL_STACK_STEP = 10;
    // 游戏默认视野 100m 时 scale=1；scale = viewRadiusCm / 10000。

    // 隐藏原生面板：按“绘制签名”识别，而不是复刻坐标。
    // 游戏 drawEntity 每个面板都先用唯一底色画背景框，再用等宽字体画各行文字：
    //   ctx.fillStyle = 'rgba(15, 23, 42, .76)'; ctx.fillRect(labelX-5, labelY-11, w, h);
    //   ctx.font = '11px ui-monospace,...'; ctx.fillText(...) x N 行
    // 这个底色全局只有面板在用，所以 hook 到该底色的 fillRect 直接跳过并记录矩形，
    // 随后落在该矩形内的 fillText/strokeText 也跳过。这样无论近/远/自己都统一隐藏，
    // 不依赖任何坐标换算（worldToScreen 把相机烘进数学式里，canvas 变换恒为 dpr）。
    const PANEL_BG_RAW = 'rgba(15, 23, 42, .76)';
    // 文字命中面板矩形时的容差（等宽字体量宽和端上细微差异）。
    const PANEL_HIT_PAD = 10;

    // 金币颜色档位：<3 / 3-20 / 20-50 / 50-100 / 100-500 / 500-2000 / 2000+。
    const DROP_TIERS = [
      { min: 2000, radius: 30, color: "255, 255, 255", label: "≥2000" }, // 白光
      { min: 500, radius: 25, color: "224, 115, 105", label: "500-2000" }, // 珊瑚红
      { min: 100, radius: 20, color: "215, 125, 165", label: "100-500" },  // 粉玫红
      { min: 50, radius: 14, color: "176, 137, 211", label: "50-100" },    // 薰衣草紫
      { min: 20, radius: 11, color: "112, 157, 207", label: "20-50" },     // 清透蓝紫
      { min: 3, radius: 8, color: "232, 160, 105", label: "3-20" },         // 柔和杏橙
      { min: 0, radius: 6, color: "51, 65, 85", label: "<3" }                // 暗灰
    ];

    // 金币数字标注阈值：>=3 起标数字（与 >=3 特殊色一致）。
    const LABEL_MIN_DROP = 3;
    // Passive 仅 drop≥此值才显示名字（低价值 Passive 不刷名）。
    const DEAD_NAME_MIN_DROP = 20;
    // 玩家名字最长显示字符数，超出截断，避免遮挡。
    const NAME_MAX_CHARS = 14;

    if (window[OVERLAY_KEY] && typeof window[OVERLAY_KEY].destroy === "function") {
      window[OVERLAY_KEY].destroy("replaced");
    }
    const existingCanvas = document.getElementById(CANVAS_ID);
    if (existingCanvas) existingCanvas.remove();
    const existingPanel = document.getElementById(PANEL_ID);
    if (existingPanel) existingPanel.remove();

    const ready = () => {
      try {
        return typeof state !== "undefined" && state
          && typeof viewParams === "function"
          && typeof worldToScreen === "function";
      } catch (_) {
        return false;
      }
    };

    // 与游戏 draw() 同一套实体坐标（插值+smooth）。没有则退回 state.entities。
    function gameRenderEntities() {
      try {
        if (typeof getRenderEntities === "function") return getRenderEntities() || [];
      } catch (_) {}
      return (typeof state !== "undefined" && state && state.entities) || [];
    }

    let waitTimer = 0;
    let waitCount = 0;

    function waitForGame() {
      if (ready()) {
        clearInterval(waitTimer);
        setupOverlay();
        return;
      }
      waitCount += 1;
      if (waitCount > 240) {
        console.warn("[RatIntelOverlay] Game variables not found. Reload the page.");
        clearInterval(waitTimer);
      }
    }

    waitTimer = window.setInterval(waitForGame, 500);
    waitForGame();

    function setupOverlay() {
      const canvasEl = document.createElement("canvas");
      canvasEl.id = CANVAS_ID;
      canvasEl.setAttribute("aria-hidden", "true");

      const panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.innerHTML = [
        '<div class="intel-legend" data-intel="legend"></div>',
        '<div class="intel-row">',
        '<button type="button" data-intel="legend-toggle" title="图例">图例</button>',
        '<button type="button" data-intel="toggle">情报层 ON</button>',
        '</div>'
      ].join("");

      const style = document.createElement("style");
      style.textContent = `
        #${CANVAS_ID} {
          position: absolute;
          left: 0;
          top: 0;
          display: block;
          pointer-events: none;
          /* 低于左侧 .side(z-index:20)，避免圆点盖住原生信息面板 */
          z-index: 10;
        }
        #${PANEL_ID} {
          position: fixed;
          right: 12px;
          bottom: 12px;
          z-index: 30;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 4px;
          font: 12px/1.3 "Microsoft YaHei", "Microsoft YaHei UI", Arial, sans-serif;
          color: #e5edf8;
          pointer-events: none;
          text-shadow: 0 0 6px rgba(2, 6, 23, .7);
        }
        #${PANEL_ID} .intel-row {
          display: flex;
          gap: 4px;
          pointer-events: auto;
        }
        #${PANEL_ID} button {
          min-height: 26px;
          padding: 0 10px;
          color: #bae6fd;
          background: rgba(2, 6, 23, .62);
          border: 1px solid rgba(56, 189, 248, .42);
          border-radius: 4px;
          cursor: pointer;
          font: inherit;
          letter-spacing: .04em;
        }
        #${PANEL_ID} button:hover { background: rgba(8, 47, 73, .78); }
        #${PANEL_ID}.off button[data-intel="toggle"] {
          color: rgba(148, 163, 184, .85);
          border-color: rgba(148, 163, 184, .35);
        }
        #${PANEL_ID} .intel-legend {
          display: none;
          gap: 2px;
          padding: 6px 8px;
          background: rgba(2, 6, 23, .72);
          border: 1px solid rgba(125, 211, 252, .16);
          border-radius: 4px;
          max-width: 168px;
        }
        #${PANEL_ID}.legend-open .intel-legend { display: grid; }
        #${PANEL_ID}.off .intel-legend { display: none !important; }
        #${PANEL_ID} .intel-legend-row {
          display: flex;
          align-items: center;
          gap: 6px;
          justify-content: flex-end;
          color: rgba(226, 232, 240, .82);
          font-size: 11px;
        }
        #${PANEL_ID} .intel-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          box-shadow: 0 0 5px currentColor;
        }
        #${PANEL_ID} .intel-note {
          margin-top: 2px;
          color: rgba(148, 163, 184, .78);
          font-size: 10px;
          text-align: right;
        }
      `;

      document.head.appendChild(style);
      // 挂到 #world 同级 .map-shell，与游戏 canvas 同盒模型，缩放时不漂移。
      const mapShell = document.querySelector(".map-shell")
        || (document.getElementById("world") && document.getElementById("world").parentElement)
        || document.body;
      mapShell.appendChild(canvasEl);
      document.body.appendChild(panel);

      const ctx = canvasEl.getContext("2d");
      let drawCtx = ctx;
      const toggleBtn = panel.querySelector('[data-intel="toggle"]');
      const legendToggleBtn = panel.querySelector('[data-intel="legend-toggle"]');
      const legend = panel.querySelector('[data-intel="legend"]');

      // 图例默认折叠。
      legend.innerHTML = DROP_TIERS
        .map(tier => `<div class="intel-legend-row"><span>${tier.label}</span><span class="intel-dot" style="color:rgba(${tier.color},1)"></span></div>`)
        .join("")
        + '<div class="intel-note">Active=实线+名 · 残血显HP · Passive=虚线+被打显HP(drop≥20标名) · 边=外</div>';

      const overlay = {
        raf: 0,
        dpr: 1,
        enabled: true,
        enemyMotion: new Map(),
        canvas: canvasEl,
        ctx,
        panel,
        style,
        // 游戏 canvas hook 相关。
        gameCanvas: null,
        gctx: null,
        gctxOrig: null,
        // 按“绘制签名”隐藏原生面板：拦截面板底色 fillRect（rgba(15,23,42,.76)），
        // 记录其矩形，再跳过落在矩形内的 fillText/strokeText。game 端 fillRect 和 fillText
        // 的参数同在一套 CSS 像素用户坐标里（游戏用数学做相机，canvas 变换恒为 dpr），
        // 所以无需任何坐标换算，且能覆盖 state.entities 之外的 farSnapshot（外圈）实体面板。
        panelRects: [],
        suppressActive: false,
        drawWrapped: false,
        origDraw: null,
        paintingIntel: false
      };
      window[OVERLAY_KEY] = overlay;

      function currentUserId() {
        return Number(state && state.currentUserId);
      }

      function enemyDrop(entity) {
        const value = Number(entity.death_reward_preview ?? entity.death_drop_coins ?? 0);
        return Number.isFinite(value) ? value : 0;
      }

      // 存活判定：与游戏 drawEntity 完全一致——dead = life === 'Dead' || hp <= 0。
      // 注意不能只判 life：死亡实体可能 life 缺失但 hp<=0，之前用 `entity.life && ...`
      // 前置守卫会短路，导致死人漏过过滤、被当活人画出来还显示名字。
      function isAliveEntity(entity) {
        if (!entity) return false;
        if (entity.life === "Dead") return false;
        const hp = Number(entity.hp);
        if (Number.isFinite(hp) && hp <= 0) return false;
        return true;
      }

      // 「活人/Active」= current_join_mode === "Active"（与游戏/Swift 一致）。
      // Passive = 虚线圈；真死 life/hp 不画。
      function isActiveJoin(entity) {
        return !!(entity && entity.current_join_mode === "Active");
      }

      // 有 hp 且 ≠100 就画血条（Active 残血 / Passive 被打后都显示）。
      function shouldShowHp(entity) {
        if (!entity) return false;
        const hp = Number(entity.hp);
        if (!Number.isFinite(hp)) return false;
        return hp !== 100;
      }

      // 玩家名字：优先实体自带 name，退回游戏 state.userNames，再退回 User+id。
      function resolvePlayerName(userId, entity) {
        if (entity && entity.name) return String(entity.name);
        try {
          const names = state && state.userNames;
          if (names && typeof names.get === "function") {
            const n = names.get(Number(userId));
            if (n) return String(n);
          }
        } catch (_) {}
        return "";
      }

      // 合并三路数据形成“全场玩家”列表：
      //   1) state.entities  实时（WebSocket），死亡/离线立即移除——实时区内的权威来源。
      //   2) state.farSnapshot.entities  30s 快照，带完整 hp/name，补齐中圈。
      //   3) state.minimap.points  60s 快照，只有 u/d/x/y，补齐远处视野外。
      // 反 desync：游戏在活跃视野半径（LIVE_ZONE_CM）内实时推送实体，该区内 state.entities
      // 就是权威。任何非实时来源（快照/minimap）的点若落在实时区内却不在 entities 里，
      // 说明已死/离线，直接丢弃，避免死人圈滞留到下次快照（最长 60s）。实时区外才保留。
      function buildPlayers(view) {
        const meId = currentUserId();
        const byId = new Map();
        const cx = view ? Number(view.centerX) : NaN;
        const cy = view ? Number(view.centerY) : NaN;
        const haveCenter = Number.isFinite(cx) && Number.isFinite(cy);
        const liveZoneSq = LIVE_ZONE_CM * LIVE_ZONE_CM;
        const inLiveZone = (x, y) => haveCenter
          && ((x - cx) * (x - cx) + (y - cy) * (y - cy)) <= liveZoneSq;

        // 1) getRenderEntities：alive = Active join；Passive 画虚线。
        for (const entity of gameRenderEntities()) {
          const userId = Number(entity && entity.user_id);
          if (!Number.isFinite(userId) || userId === meId) continue;
          // 真死不画；Passive 仍画（虚线）
          if (!isAliveEntity(entity)) continue;
          const x = Number(entity.x);
          const y = Number(entity.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          byId.set(userId, {
            userId, x, y,
            drop: enemyDrop(entity),
            name: resolvePlayerName(userId, entity),
            source: entity.farSnapshot ? "far-render" : "render",
            alive: isActiveJoin(entity),
            entity
          });
        }

        // 2) 实时 entities 补漏
        for (const entity of state.entities || []) {
          const userId = Number(entity.user_id);
          if (!Number.isFinite(userId) || userId === meId) continue;
          if (!isAliveEntity(entity)) continue;
          if (byId.has(userId)) continue;
          const x = Number(entity.x);
          const y = Number(entity.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          byId.set(userId, {
            userId, x, y,
            drop: enemyDrop(entity),
            name: resolvePlayerName(userId, entity),
            source: "entity",
            alive: isActiveJoin(entity),
            entity
          });
        }

        // 3) farSnapshot 补中远圈（实时区外）
        const far = state.farSnapshot && Array.isArray(state.farSnapshot.entities)
          ? state.farSnapshot.entities : [];
        for (const entity of far) {
          const userId = Number(entity && entity.user_id);
          if (!Number.isFinite(userId) || userId === meId) continue;
          if (!isAliveEntity(entity)) continue;
          if (byId.has(userId)) continue;
          const x = Number(entity.x);
          const y = Number(entity.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (inLiveZone(x, y)) continue;
          byId.set(userId, {
            userId, x, y,
            drop: enemyDrop(entity),
            name: resolvePlayerName(userId, entity),
            source: "far",
            alive: isActiveJoin(entity),
            entity
          });
        }

        // 4) minimap 补极远
        const points = state.minimap && Array.isArray(state.minimap.points) ? state.minimap.points : [];
        for (const point of points) {
          const userId = Number(point && (point.u ?? point.user_id));
          if (!Number.isFinite(userId) || userId === meId) continue;
          const x = Number(point && point.x);
          const y = Number(point && point.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          const drop = Number(point && (point.d ?? point.drop ?? point.death_reward_preview ?? point.death_drop_coins)) || 0;
          const existing = byId.get(userId);
          if (existing) {
            if (drop > existing.drop) existing.drop = drop;
          } else {
            if (inLiveZone(x, y)) continue;
            byId.set(userId, {
              userId, x, y, drop,
              name: resolvePlayerName(userId, null),
              source: "minimap",
              alive: false, // minimap 无 join_mode，按 Passive 虚线圈
              entity: null
            });
          }
        }

        return Array.from(byId.values());
      }

      function trackMotion(players, now) {
        const seen = new Set();
        for (const player of players) {
          const key = String(player.userId);
          seen.add(key);
          const last = overlay.enemyMotion.get(key);
          const moved = last && Math.hypot(player.x - last.x, player.y - last.y) >= ENEMY_MOVE_EPSILON_CM;
          // HP 只有可见实体有；检测到相比上次记录下降，就打“最近掉血”时间戳。
          const hp = player.entity ? Number(player.entity.hp) : NaN;
          const prevHp = last ? last.hp : NaN;
          const damaged = Number.isFinite(hp) && Number.isFinite(prevHp) && hp < prevHp;
          overlay.enemyMotion.set(key, {
            x: player.x,
            y: player.y,
            lastSeenAt: now,
            lastMovedAt: moved ? now : (last ? last.lastMovedAt : 0),
            hp: Number.isFinite(hp) ? hp : prevHp,
            lastDamagedAt: damaged ? now : (last ? last.lastDamagedAt || 0 : 0)
          });
        }
        for (const [key, value] of overlay.enemyMotion) {
          if (!seen.has(key) && now - value.lastSeenAt > ENEMY_MEMORY_KEEP_MS) {
            overlay.enemyMotion.delete(key);
          }
        }
      }

      function movedRecently(userId, now) {
        const motion = overlay.enemyMotion.get(String(userId));
        return !!motion && motion.lastMovedAt > 0 && now - motion.lastMovedAt <= MOVING_ENEMY_MEMORY_MS;
      }

      function recentlyDamaged(userId, now) {
        const motion = overlay.enemyMotion.get(String(userId));
        return !!motion && motion.lastDamagedAt > 0 && now - motion.lastDamagedAt <= RECENT_DAMAGE_MS;
      }

      function dropTier(drop) {
        for (const tier of DROP_TIERS) {
          if (drop >= tier.min) return tier;
        }
        return DROP_TIERS[DROP_TIERS.length - 1];
      }

      // 以游戏实际可视半径判断：1.5km 及更近显示低价值数字，超过 1.5km 隐藏。
      function labelPolicy(view) {
        const scale = Math.max(0.1, Number(view && view.scale) || 1);
        const minDrop = scale <= 15 ? LABEL_MIN_DROP : 20;
        // scale≈1: 100m；≈5: 500m；≈10: 1km；≈50+: 5km+
        if (scale <= 2) {
          return { minDrop, minLabelPx: 28, edgeMin: minDrop, edgeMax: 16, markerScale: 1 };
        }
        if (scale <= 6) {
          return { minDrop, minLabelPx: 32, edgeMin: minDrop, edgeMax: 14, markerScale: 0.95 };
        }
        if (scale <= 15) {
          return { minDrop, minLabelPx: 36, edgeMin: minDrop, edgeMax: 12, markerScale: 0.85 };
        }
        if (scale <= 40) {
          return { minDrop, minLabelPx: 40, edgeMin: minDrop, edgeMax: 12, markerScale: 0.75 };
        }
        return { minDrop, minLabelPx: 44, edgeMin: minDrop, edgeMax: 12, markerScale: 0.65 };
      }

      // 屏幕空间贪心：高 drop / 活跃优先，近距离只留一个数字（远景仍参与标注）。
      function selectLabeled(markers, policy) {
        const cand = markers
          .filter(m => m.drop >= policy.minDrop)
          .sort((a, b) => {
            if (a.drop !== b.drop) return b.drop - a.drop;
            return Number(b.active) - Number(a.active);
          });
        const kept = [];
        const minPx = policy.minLabelPx;
        for (const m of cand) {
          let clash = false;
          for (const k of kept) {
            if (Math.hypot(m.point.x - k.point.x, m.point.y - k.point.y) < minPx) {
              clash = true;
              break;
            }
          }
          if (!clash) kept.push(m);
        }
        const set = new Set(kept);
        for (const m of markers) m.showDropLabel = set.has(m);
        return kept;
      }

      function canvasRect() {
        const worldCanvas = typeof canvas !== "undefined" ? canvas : document.getElementById("world");
        if (worldCanvas && typeof worldCanvas.getBoundingClientRect === "function") {
          const rect = worldCanvas.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return rect;
        }
        return document.body.getBoundingClientRect();
      }

      // render/far-render 已是 getRenderEntities 插值坐标，直接用；其它来源再读 visualEntities。
      function renderWorldPoint(player) {
        if (player.source === "render" || player.source === "far-render") {
          return { x: player.x, y: player.y };
        }
        const userId = Number(player.userId);
        const visuals = state.visualEntities;
        if (Number.isFinite(userId) && visuals && typeof visuals.get === "function") {
          const visual = visuals.get(userId);
          if (visual && Number.isFinite(Number(visual.x)) && Number.isFinite(Number(visual.y))) {
            return { x: Number(visual.x), y: Number(visual.y) };
          }
        }
        return { x: player.x, y: player.y };
      }

      // ---- 游戏 canvas hook：让挂机号的原生标签框根本不绘制 ----

      function findGameCanvas() {
        if (typeof canvas !== "undefined" && canvas && typeof canvas.getContext === "function") return canvas;
        return document.getElementById("world");
      }

      // 是否为面板底色。游戏 drawEntity 用 rgba(15,23,42,.76) 画标签框背景，
      // 这个颜色全局只有面板在用。fillStyle 读回时浏览器会归一化（.76 -> 0.76），
      // 所以只匹配稳定的 rgb 片段 "15, 23, 42"。
      function isPanelBg(style) {
        if (style == null) return false;
        const s = String(style);
        if (s.indexOf("15, 23, 42") !== -1) return true;
        if (s.indexOf("15,23,42") !== -1) return true;
        if (/rgba?\(\s*15[\s,]+23[\s,]+42\b/i.test(s)) return true;
        if (/#0f172a([0-9a-f]{2})?\b/i.test(s)) return true;
        const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/i);
        if (m) {
          const r = +m[1], g = +m[2], b = +m[3];
          const a = m[4] == null ? 1 : +m[4];
          // 深 slate + 半透明 ≈ 面板底色
          if (r <= 30 && g <= 40 && b <= 70 && a >= 0.55 && a <= 0.92) return true;
        }
        return false;
      }

      // 游戏原生存活实体使用 #34d399；压暗这组颜色，把视觉焦点留给活跃高亮。
      function mutedNativeGreen(style) {
        const raw = String(style == null ? "" : style).toLowerCase();
        if (!raw.includes("52, 211, 153") && !raw.includes("#34d399")) return null;
        const match = raw.match(/rgba?\(\s*52\s*,\s*211\s*,\s*153(?:\s*,\s*([\d.]+))?\s*\)/);
        const hexMatch = raw.match(/#34d399([\da-f]{2})?/i);
        if (!match && !hexMatch) return null;
        const alpha = match
          ? (Number.isFinite(Number(match[1])) ? Number(match[1]) * 0.85 : 0.85)
          : (hexMatch[1] ? parseInt(hexMatch[1], 16) / 255 * 0.85 : 0.85);
        return `rgba(45, 178, 132, ${Math.max(0.12, alpha)})`;
      }

      function isPanelText(text) {
        if (typeof text !== "string") return false;
        if (/^(HP |Drop |STA |INV |Loss |User )/i.test(text)) return true;
        if (/ DEAD$/i.test(text)) return true;
        if (/^STA\s/i.test(text) || /^Drop\s/i.test(text) || /^Loss\s/i.test(text)) return true;
        if (/^INV\s/i.test(text) || /^HP\s/i.test(text)) return true;
        return false;
      }

      function isPanelFont(font) {
        const f = String(font || "");
        return f.indexOf("11px") !== -1 && f.toLowerCase().indexOf("mono") !== -1;
      }

      // 文字锚点是否落在已记录的某个面板框内（含容差）。
      function textInPanelRect(x, y) {
        const rects = overlay.panelRects;
        for (let i = rects.length - 1; i >= 0; i--) {
          const r = rects[i];
          if (x >= r.x - PANEL_HIT_PAD && x <= r.x + r.w + PANEL_HIT_PAD
            && y >= r.y - PANEL_HIT_PAD && y <= r.y + r.h + PANEL_HIT_PAD) return true;
        }
        return false;
      }

      // 按“绘制签名”隐藏原生面板：
      //   1) 游戏每帧最先用整块背景铺满 canvas（drawGrid），以此为帧起点清空上一帧的面板框；
      //   2) 拦截面板底色 fillRect：记录矩形并跳过绘制（背景不画）；
      //   3) 跳过落在这些矩形内的 fillText/strokeText（各行文字不画）。
      // fillRect 与 fillText 的参数同在一套 CSS 像素用户坐标里（游戏用数学做相机，
      // canvas 变换恒为 dpr），所以无需坐标换算，且能覆盖 farSnapshot（外圈）实体面板。
      function hookGameCanvas() {
        if (overlay.gctx) return true;
        const worldCanvas = findGameCanvas();
        if (!worldCanvas || typeof worldCanvas.getContext !== "function") return false;
        let gctx;
        try {
          gctx = worldCanvas.getContext("2d");
        } catch (_) {
          return false;
        }
        if (!gctx) return false;
        if (gctx.__intelHooked) {
          overlay.gameCanvas = worldCanvas;
          overlay.gctx = gctx;
          return true;
        }

        const orig = {
          fillText: gctx.fillText,
          strokeText: gctx.strokeText,
          fillRect: gctx.fillRect,
          fill: gctx.fill,
          stroke: gctx.stroke
        };

        const shouldSkipText = function (text, x, y, font) {
          if (!overlay.enabled || overlay.paintingIntel) return false;
          // 1) 落在已记录面板框内（含名字行）
          if (overlay.panelRects.length && textInPanelRect(x, y)) return true;
          // 2) 面板固定文案
          if (isPanelText(text)) return true;
          // 3) 11px mono 面板字体：拦名字行，放行金币数字与 server 幽灵字
          if (isPanelFont(font)) {
            const t = String(text == null ? "" : text);
            if (t === "server") return false;
            if (/^\d+$/.test(t)) return false;
            return true;
          }
          return false;
        };

        gctx.fillText = function (text, x, y, maxWidth) {
          if (shouldSkipText(text, x, y, this.font)) return;
          return orig.fillText.call(this, text, x, y, maxWidth);
        };
        gctx.strokeText = function (text, x, y, maxWidth) {
          if (shouldSkipText(text, x, y, this.font)) return;
          return orig.strokeText.call(this, text, x, y, maxWidth);
        };
        gctx.fill = function (fillRule) {
          const original = this.fillStyle;
          const muted = mutedNativeGreen(original);
          if (muted) this.fillStyle = muted;
          try {
            return orig.fill.call(this, fillRule);
          } finally {
            if (muted) this.fillStyle = original;
          }
        };
        gctx.stroke = function () {
          const original = this.strokeStyle;
          const muted = mutedNativeGreen(original);
          if (muted) this.strokeStyle = muted;
          try {
            return orig.stroke.call(this);
          } finally {
            if (muted) this.strokeStyle = original;
          }
        };
        gctx.fillRect = function (x, y, w, h) {
          if (!overlay.enabled || overlay.paintingIntel) return orig.fillRect.call(this, x, y, w, h);
          // 帧起点：整块背景铺满 canvas -> 清空上一帧面板框
          const cw = this.canvas ? this.canvas.clientWidth : 0;
          const ch = this.canvas ? this.canvas.clientHeight : 0;
          if (cw && ch && x <= 1 && y <= 1 && w >= cw - 2 && h >= ch - 2) {
            overlay.panelRects.length = 0;
            return orig.fillRect.call(this, x, y, w, h);
          }
          // 面板底色：颜色 + 尺寸启发式
          if (w > 24 && h > 24 && w < 360 && h < 160 && isPanelBg(this.fillStyle)) {
            if (overlay.panelRects.length < 512) {
              overlay.panelRects.push({ x: x - 2, y: y - 2, w: w + 4, h: h + 8 });
            }
            return; // 不画原生面板底
          }
          return orig.fillRect.call(this, x, y, w, h);
        };

        gctx.__intelHooked = true;
        overlay.gameCanvas = worldCanvas;
        overlay.gctx = gctx;
        overlay.gctxOrig = orig;
        return true;
      }

      function unhookGameCanvas() {
        const gctx = overlay.gctx;
        const orig = overlay.gctxOrig;
        if (gctx && orig) {
          try {
            gctx.fillText = orig.fillText;
            gctx.strokeText = orig.strokeText;
            gctx.fillRect = orig.fillRect;
            gctx.fill = orig.fill;
            gctx.stroke = orig.stroke;
            delete gctx.__intelHooked;
          } catch (_) {}
        }
        if (overlay.drawWrapped && overlay.origDraw) {
          try {
            const g = typeof window !== "undefined" ? window : globalThis;
            g.drawMinimap = overlay.origDraw;
          } catch (_) {}
          try { drawMinimap = overlay.origDraw; } catch (_) {}
        }
        overlay.gctx = null;
        overlay.gctxOrig = null;
        overlay.gameCanvas = null;
        overlay.suppressActive = false;
        overlay.panelRects = [];
        overlay.drawWrapped = false;
        overlay.origDraw = null;
        drawCtx = ctx;
      }

      function prepareCanvas() {
        // 严格对齐游戏 resize()：同一 rect、同一 floor(dpr)、同一 CSS 像素用户空间。
        // 远处误差随半径放大，通常是 canvas 几何/拉伸与 #world 不一致导致。
        const world = findGameCanvas();
        if (!world) {
          return { width: 1, height: 1 };
        }
        const rect = world.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        // 与 app.js resize() 一致
        const cssW = Math.max(1, rect.width);
        const cssH = Math.max(1, rect.height);
        const pixelWidth = Math.max(1, Math.floor(cssW * dpr));
        const pixelHeight = Math.max(1, Math.floor(cssH * dpr));
        if (canvasEl.width !== pixelWidth || canvasEl.height !== pixelHeight) {
          canvasEl.width = pixelWidth;
          canvasEl.height = pixelHeight;
        }
        canvasEl.style.width = cssW + "px";
        canvasEl.style.height = cssH + "px";
        // 叠在 #world 上：相对父盒定位，避免 inset:0 与 world 实际盒不一致
        const parent = canvasEl.parentElement;
        if (parent && parent !== document.body) {
          const pr = parent.getBoundingClientRect();
          canvasEl.style.left = (rect.left - pr.left) + "px";
          canvasEl.style.top = (rect.top - pr.top) + "px";
          canvasEl.style.right = "auto";
          canvasEl.style.bottom = "auto";
        }
        // viewParams 用 clientWidth/Height；与之对齐作为绘制用户空间
        const width = Math.max(1, world.clientWidth || Math.round(cssW));
        const height = Math.max(1, world.clientHeight || Math.round(cssH));
        overlay.dpr = dpr;
        // 与游戏相同：setTransform(dpr) 后 1 用户单位 = 1 CSS 像素
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        return { width, height };
      }

      function clearCanvas() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      }

      // 近距标签：最多错开 1 档，避免堆叠把数字推飞到远离圆点。
      // 真正的去重交给 selectLabeled（同屏只留高 drop）。
      function assignLabelStacks(markers) {
        const order = markers
          .map((m, i) => ({ i, x: m.point.x, y: m.point.y, drop: m.drop }))
          .sort((a, b) => a.y - b.y || a.x - b.x || b.drop - a.drop);
        const stacks = new Array(markers.length).fill(0);
        for (let a = 0; a < order.length; a++) {
          const A = order[a];
          let stack = 0;
          for (let b = 0; b < a; b++) {
            const B = order[b];
            if (Math.hypot(A.x - B.x, A.y - B.y) < LABEL_STACK_DIST && stacks[B.i] === 0) {
              stack = 1;
              break;
            }
          }
          stacks[A.i] = stack;
        }
        for (let i = 0; i < markers.length; i++) markers[i].labelStack = stacks[i];
      }

      function drawMarker(point, tier, active, pulse, drop, now, entity, name, labelStack, showDropLabel, markerScale, alive) {
        const color = tier.color;
        const ms = Number.isFinite(markerScale) ? markerScale : 1;
        const baseRadius = Math.max(4, tier.radius * ms);
        const emphasis = drop >= EMPHASIS_DROP && alive;
        const legendary = drop >= 2000 && alive;
        const subdued = drop < 20;
        const negligible = drop < 3;
        const stack = labelStack || 0;
        const labelLift = stack * LABEL_STACK_STEP;
        const isAlive = alive !== false;

        drawCtx.save();
        drawCtx.translate(point.x, point.y);

        if (isAlive) {
          // 存活目标用浅色轮廓从压暗的原生实体中提出来，移动目标再加强一层呼吸光。
          drawCtx.beginPath();
          drawCtx.arc(0, 0, baseRadius + (active ? 5 : 3), 0, Math.PI * 2);
          drawCtx.lineWidth = active ? 2.2 : 1.2;
          drawCtx.strokeStyle = active
            ? `rgba(240, 253, 250, ${0.72 + pulse * 0.2})`
            : "rgba(226, 232, 240, .42)";
          drawCtx.shadowBlur = active ? 8 + pulse * 8 : 0;
          drawCtx.shadowColor = active ? "rgba(240, 253, 250, .8)" : "transparent";
          drawCtx.stroke();
          drawCtx.shadowBlur = 0;
        }

        if (!isAlive) {
          // Passive：虚线圈 + 淡填充，与 Active 实线圈区分。
          drawCtx.beginPath();
          drawCtx.arc(0, 0, baseRadius, 0, Math.PI * 2);
           drawCtx.fillStyle = `rgba(${color}, ${negligible ? 0.025 : 0.06})`;
          drawCtx.fill();
          drawCtx.lineWidth = 2;
          drawCtx.setLineDash([4, 3]);
           drawCtx.strokeStyle = `rgba(${color}, ${negligible ? 0.22 : 0.55})`;
          drawCtx.shadowBlur = 0;
          drawCtx.stroke();
          drawCtx.setLineDash([]);
          drawCtx.beginPath();
          drawCtx.arc(0, 0, Math.max(1.2, baseRadius * 0.22), 0, Math.PI * 2);
           drawCtx.fillStyle = `rgba(${color}, ${negligible ? 0.16 : 0.45})`;
          drawCtx.fill();
        } else if (active) {
          // Active 且在动：呼吸环 + 实心圈。
          const expand = (now % 1600) / 1600;
          drawCtx.beginPath();
          drawCtx.arc(0, 0, baseRadius + 4 + expand * (emphasis ? 22 : 14), 0, Math.PI * 2);
          drawCtx.lineWidth = emphasis ? 2.4 : 1.8;
          drawCtx.setLineDash([]);
           drawCtx.strokeStyle = `rgba(${color}, ${(1 - expand) * (emphasis ? 0.6 : (negligible ? 0.08 : (subdued ? 0.2 : 0.45)))})`;
          drawCtx.shadowBlur = 0;
          drawCtx.stroke();

          const glow = subdued ? 0 : (emphasis ? 14 : 10) + pulse * (emphasis ? 16 : 12);
          const ringAlpha = 0.9 + pulse * 0.1;

          drawCtx.beginPath();
          drawCtx.arc(0, 0, baseRadius, 0, Math.PI * 2);
           drawCtx.fillStyle = `rgba(${color}, ${negligible ? 0.025 : (emphasis ? 0.28 : 0.2) + pulse * 0.12})`;
          drawCtx.fill();

          drawCtx.lineWidth = legendary ? 4.2 : (emphasis ? 3.4 : (subdued ? 1.8 : 2.8));
          drawCtx.setLineDash([]);
           drawCtx.strokeStyle = `rgba(${color}, ${negligible ? 0.25 : (subdued ? 0.55 : ringAlpha)})`;
          drawCtx.shadowBlur = legendary ? 22 + pulse * 14 : glow;
          drawCtx.shadowColor = legendary
            ? `rgba(255, 255, 255, ${0.8 + pulse * 0.2})`
            : `rgba(${color}, .9)`;
          drawCtx.stroke();

          if (legendary) {
            // 最高档叠加一圈细闪光，保持白色标记在复杂场景中醒目。
            drawCtx.beginPath();
            drawCtx.arc(0, 0, baseRadius + 7 + pulse * 3, 0, Math.PI * 2);
            drawCtx.lineWidth = 1.2;
            drawCtx.strokeStyle = `rgba(255, 255, 255, ${0.45 + pulse * 0.35})`;
            drawCtx.shadowBlur = 12;
            drawCtx.shadowColor = "rgba(255, 255, 255, .9)";
            drawCtx.stroke();
          }
        } else {
          // Active 静止：实心稳定环（非虚线）+ 中心点。
          drawCtx.beginPath();
          drawCtx.arc(0, 0, baseRadius, 0, Math.PI * 2);
           drawCtx.fillStyle = `rgba(${color}, ${negligible ? 0.03 : 0.1})`;
          drawCtx.fill();
          drawCtx.lineWidth = 2;
          drawCtx.setLineDash([]);
           drawCtx.strokeStyle = `rgba(${color}, ${negligible ? 0.3 : 0.78})`;
          drawCtx.shadowBlur = 0;
          drawCtx.stroke();
          drawCtx.beginPath();
          drawCtx.arc(0, 0, Math.max(1.6, baseRadius * 0.28), 0, Math.PI * 2);
           drawCtx.fillStyle = `rgba(${color}, ${negligible ? 0.25 : 0.9})`;
          drawCtx.fill();
        }

        // 血量：hp≠100 时显示（含 Passive 被打残血）。
        let hpBottom = -baseRadius - 2 - labelLift;
        if (entity && shouldShowHp(entity)) {
          const drawn = drawHpBar(0, -baseRadius - 2 - labelLift, entity);
          if (drawn) hpBottom = -baseRadius - 2 - labelLift - HP_BAR_H - HP_BAR_GAP;
        }

        // 金币数字：贴在环上，由 LOD + 屏幕去重决定是否画。
        if (showDropLabel && drop >= LABEL_MIN_DROP) {
          drawDropLabel(0, hpBottom - 1, drop, color, active && isAlive, emphasis);
        }

        // Active 始终显示名字；Passive 仅 drop≥20 才标名。
        if (name) {
          if (isAlive) {
            drawNameLabel(0, baseRadius + 4 + labelLift, name, color, active);
          } else if (drop >= DEAD_NAME_MIN_DROP) {
            drawNameLabel(0, baseRadius + 4 + labelLift, name, color, false);
          }
        }

        drawCtx.restore();
      }

      // 玩家名字标签：画在标记正下方，深色描边保证任何背景下都清晰。
      function drawNameLabel(x, y, name, color, active) {
        let text = String(name).replace(/\s*DEAD$/i, "").trim();
        if (text.length > NAME_MAX_CHARS) text = text.slice(0, NAME_MAX_CHARS - 1) + "…";
        drawCtx.setLineDash([]);
        drawCtx.textAlign = "center";
        drawCtx.textBaseline = "top";
        drawCtx.font = `${active ? 600 : 500} 12px "Microsoft YaHei", Arial, sans-serif`;
        drawCtx.shadowBlur = 0;
        drawCtx.lineWidth = 3;
        drawCtx.strokeStyle = "rgba(2, 6, 23, .9)";
        drawCtx.strokeText(text, x, y);
        drawCtx.fillStyle = active ? "rgba(236, 244, 255, .98)" : "rgba(203, 213, 225, .82)";
        drawCtx.fillText(text, x, y);
      }

      // 活跃玩家血条：画在标记正上方。返回是否真的画了（无 hp 数据则不画）。
      function drawHpBar(cx, bottomY, entity) {
        const hp = Number(entity.hp);
        const maxHp = Number(entity.max_hp);
        if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0) return false;
        const ratio = Math.max(0, Math.min(1, hp / maxHp));
        const w = HP_BAR_W;
        const h = HP_BAR_H;
        const x = cx - w / 2;
        const y = bottomY - h;

        drawCtx.save();
        drawCtx.setLineDash([]);
        drawCtx.shadowBlur = 0;
        // 底槽。
        drawCtx.fillStyle = "rgba(2, 6, 23, .78)";
        drawCtx.fillRect(x - 1, y - 1, w + 2, h + 2);
        // 血量：绿->黄->红 随比例过渡。
        let fill;
        if (ratio > 0.5) fill = "74, 222, 128";
        else if (ratio > 0.25) fill = "250, 204, 21";
        else fill = "248, 113, 113";
        drawCtx.fillStyle = `rgba(${fill}, .95)`;
        drawCtx.fillRect(x, y, w * ratio, h);
        // 边框。
        drawCtx.lineWidth = 1;
        drawCtx.strokeStyle = "rgba(226, 232, 240, .5)";
        drawCtx.strokeRect(x, y, w, h);

        // 数字 HP。
        drawCtx.font = '600 11px "Microsoft YaHei", Arial, sans-serif';
        drawCtx.textAlign = "center";
        drawCtx.textBaseline = "bottom";
        drawCtx.fillStyle = "rgba(2, 6, 23, .9)";
        drawCtx.fillText(Math.round(hp) + "/" + Math.round(maxHp), cx + 0.6, y - 1.4);
        drawCtx.fillStyle = "rgba(236, 244, 255, .98)";
        drawCtx.fillText(Math.round(hp) + "/" + Math.round(maxHp), cx, y - 2);
        drawCtx.restore();
        return true;
      }

      // 找自己的实体（带 hp/max_hp）。优先 state.entities 里 user_id == 当前用户，
      // 退回 localVisual（也是从服务器实体展开，通常含 hp）。
      function selfEntity() {
        const meId = currentUserId();
        if (!Number.isFinite(meId) || !meId) return null;
        for (const entity of state.entities || []) {
          if (Number(entity.user_id) === meId) return entity;
        }
        const lv = state.localVisual;
        if (lv && Number(lv.user_id) === meId && Number.isFinite(Number(lv.hp))) return lv;
        return null;
      }

      // 自己的血条：固定在屏幕顶部中间，做大更醒目。原生面板被隐藏后由我们补画。
      function drawSelfHpBar(surface) {
        const me = selfEntity();
        if (!me) return;
        const hp = Number(me.hp);
        const maxHp = Number(me.max_hp);
        if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0) return;
        const ratio = Math.max(0, Math.min(1, hp / maxHp));
        const w = SELF_HP_BAR_W;
        const h = SELF_HP_BAR_H;
        // 对齐游戏视觉中心（screenCenter 已为左侧栏预留），而非整窗正中。
        let cx = surface.width / 2;
        try {
          const view = viewParams();
          if (view && Number.isFinite(view.cx)) cx = view.cx;
        } catch (_) {}
        const x = Math.round(cx - w / 2);
        const y = SELF_HP_TOP;

        drawCtx.save();
        drawCtx.setLineDash([]);
        drawCtx.shadowBlur = 0;
        // 底槽。
        drawCtx.fillStyle = "rgba(2, 6, 23, .82)";
        drawCtx.fillRect(x - 2, y - 2, w + 4, h + 4);
        // 血量：绿->黄->红。
        let fill;
        if (ratio > 0.5) fill = "74, 222, 128";
        else if (ratio > 0.25) fill = "250, 204, 21";
        else fill = "248, 113, 113";
        drawCtx.fillStyle = `rgba(${fill}, .95)`;
        drawCtx.fillRect(x, y, w * ratio, h);
        // 边框 + 低血时红色呼吸描边。
        drawCtx.lineWidth = 1.5;
        drawCtx.strokeStyle = ratio <= 0.25
          ? `rgba(248, 113, 133, ${0.7 + 0.3 * Math.abs(Math.sin(Date.now() / 300))})`
          : "rgba(226, 232, 240, .55)";
        drawCtx.strokeRect(x, y, w, h);
        // 数字 HP。
        drawCtx.font = '700 12px "Microsoft YaHei", Arial, sans-serif';
        drawCtx.textAlign = "center";
        drawCtx.textBaseline = "middle";
        const label = "HP " + Math.round(hp) + " / " + Math.round(maxHp);
        drawCtx.fillStyle = "rgba(2, 6, 23, .92)";
        drawCtx.fillText(label, cx + 0.7, y + h / 2 + 0.7);
        drawCtx.fillStyle = "rgba(240, 247, 255, .98)";
        drawCtx.fillText(label, cx, y + h / 2);
        drawCtx.restore();
      }

      // 金币数字统一使用深色底和白字，避免被地图网格和实体颜色吞掉。
      function drawDropLabel(x, y, drop, color, active, emphasis) {
        const text = String(drop);
        const subdued = drop < 20;
        drawCtx.setLineDash([]);
        drawCtx.textAlign = "center";
        drawCtx.textBaseline = "bottom";
        const legendary = drop >= 2000;
        const fontSize = legendary ? (active ? 18 : 16) : (emphasis ? (active ? 17 : 15) : (active ? 15 : 13));
        const weight = active ? 700 : 600;
        drawCtx.font = `${weight} ${fontSize}px "Microsoft YaHei", Arial, sans-serif`;

        const w = drawCtx.measureText(text).width;
        const padX = legendary || emphasis ? 7 : 5;
        const chipW = w + padX * 2;
        const chipH = fontSize + (emphasis ? 8 : 6);
        const chipX = x - chipW / 2;
        const chipY = y - chipH;
        roundRect(chipX, chipY, chipW, chipH, 4);
        drawCtx.fillStyle = active
          ? `rgba(2, 6, 23, ${subdued ? 0.78 : 0.94})`
          : `rgba(2, 6, 23, ${subdued ? 0.62 : 0.78})`;
        drawCtx.fill();
        drawCtx.lineWidth = legendary ? 2.5 : (emphasis ? 2 : (subdued ? 1 : 1.5));
        drawCtx.strokeStyle = `rgba(${color}, ${legendary ? 1 : (subdued ? 0.55 : (active ? 1 : 0.8))})`;
        drawCtx.shadowBlur = legendary ? 14 : (emphasis && active ? 8 : 0);
        drawCtx.shadowColor = legendary ? "rgba(255, 255, 255, .95)" : `rgba(${color}, .85)`;
        drawCtx.stroke();
        drawCtx.shadowBlur = 0;

        drawCtx.lineWidth = 3;
        drawCtx.strokeStyle = "rgba(2, 6, 23, .95)";
        drawCtx.strokeText(text, x, y - (emphasis ? 3 : 2));
        drawCtx.fillStyle = subdued ? "rgba(226, 232, 240, .78)" : "rgba(248, 250, 252, 1)";
        drawCtx.fillText(text, x, y - (emphasis ? 3 : 2));
      }

      function roundRect(x, y, w, h, r) {
        const radius = Math.min(r, w / 2, h / 2);
        drawCtx.beginPath();
        drawCtx.moveTo(x + radius, y);
        drawCtx.arcTo(x + w, y, x + w, y + h, radius);
        drawCtx.arcTo(x + w, y + h, x, y + h, radius);
        drawCtx.arcTo(x, y + h, x, y, radius);
        drawCtx.arcTo(x, y, x + w, y, radius);
        drawCtx.closePath();
      }

      // 视野外玩家：贴到屏幕边缘，用朝外三角 + Drop 数字提示方位。
      function drawEdgeMarker(point, tier, drop, active, pulse, surface, now, showDropLabel) {
        // 以游戏视觉中心为锚（已为左侧栏预留），避免贴边方位偏到整窗中心。
        let cx = surface.width / 2;
        let cy = surface.height / 2;
        try {
          const view = viewParams();
          if (view && Number.isFinite(view.cx) && Number.isFinite(view.cy)) {
            cx = view.cx;
            cy = view.cy;
          }
        } catch (_) {}
        let dx = point.x - cx;
        let dy = point.y - cy;
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
        const halfW = Math.max(1, Math.min(cx, surface.width - cx) - EDGE_MARGIN);
        const halfH = Math.max(1, Math.min(cy, surface.height - cy) - EDGE_MARGIN);
        const scale = Math.min(halfW / Math.abs(dx || 1e-6), halfH / Math.abs(dy || 1e-6));
        const ex = cx + dx * scale;
        const ey = cy + dy * scale;
        const angle = Math.atan2(dy, dx);
        const color = tier.color;
        const emphasis = drop >= EMPHASIS_DROP;
        const size = emphasis ? 12 : 9;

        drawCtx.save();
        drawCtx.translate(ex, ey);

        // 朝外的三角。
        drawCtx.save();
        drawCtx.rotate(angle);
        drawCtx.beginPath();
        drawCtx.moveTo(size, 0);
        drawCtx.lineTo(-size * 0.7, size * 0.7);
        drawCtx.lineTo(-size * 0.7, -size * 0.7);
        drawCtx.closePath();
        drawCtx.fillStyle = `rgba(${color}, ${active ? 0.92 : 0.5})`;
        if (emphasis && active) {
          drawCtx.shadowBlur = 8 + pulse * 8;
          drawCtx.shadowColor = `rgba(${color}, .8)`;
        }
        drawCtx.fill();
        drawCtx.restore();

        // Drop 数字放在三角内侧（朝屏幕中心方向偏移）。
        const labelX = -Math.cos(angle) * (size + 10);
        const labelY = -Math.sin(angle) * (size + 10);
        if (showDropLabel) {
          drawDropLabel(labelX, labelY + size * 0.5, drop, color, active, emphasis);
        }
        drawCtx.restore();
      }

      // 不能改 window.draw：游戏内部 rAF(draw) 绑定的是函数自身名字，外层替换无效。
      // 改在 draw() 末尾必调的 drawMinimap 之后叠画，与本帧 world 绘制同一 ctx/变换。
      function wrapGameDraw() {
        if (overlay.drawWrapped) return true;
        try {
          const g = typeof window !== "undefined" ? window : globalThis;
          let orig = null;
          if (typeof drawMinimap === "function" && !drawMinimap.__intelWrapped) {
            orig = drawMinimap;
          } else if (typeof g.drawMinimap === "function" && !g.drawMinimap.__intelWrapped) {
            orig = g.drawMinimap;
          }
          if (!orig) return false;
          const wrapped = function () {
            orig.apply(this, arguments);
            if (overlay.enabled) {
              try { paintIntelOnGame(); } catch (_) {}
            }
          };
          wrapped.__intelWrapped = true;
          try { g.drawMinimap = wrapped; } catch (_) {}
          try { drawMinimap = wrapped; } catch (_) {}
          overlay.origDraw = orig; // 复用字段存 orig drawMinimap
          overlay.drawWrapped = true;
          return true;
        } catch (_) {
          return false;
        }
      }

      function paintIntelOnGame() {
        const world = findGameCanvas();
        if (!world) return;
        let gctx;
        try { gctx = world.getContext("2d"); } catch (_) { return; }
        if (!gctx) return;
        const width = Math.max(1, world.clientWidth || 1);
        const height = Math.max(1, world.clientHeight || 1);
        const dpr = window.devicePixelRatio || 1;
        // 与游戏用户空间一致（resize 后 transform 为 dpr）
        drawCtx = gctx;
        overlay.paintingIntel = true;
        try {
          drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
          paintIntel({ width, height });
        } finally {
          overlay.paintingIntel = false;
          drawCtx = ctx;
        }
      }

      function paintIntel(surface) {
        let view = null;
        try { view = viewParams(); } catch (_) { return; }
        if (!view) return;

        const now = Date.now();
        const players = buildPlayers(view);
        trackMotion(players, now);
        const pulse = 0.5 + 0.5 * Math.sin(now / 600);
        const policy = labelPolicy(view);
        const onScreen = [];
        const offScreen = [];

        for (const player of players) {
          const worldPt = renderWorldPoint(player);
          let sp;
          try {
            sp = worldToScreen(Number(worldPt.x), Number(worldPt.y), view);
          } catch (_) {
            continue;
          }
          const localX = Number(sp.x);
          const localY = Number(sp.y);
          if (!Number.isFinite(localX) || !Number.isFinite(localY)) continue;
          // 游戏网格用半像素；这里不 round，保持与 worldToScreen 浮点一致
          const point = { x: localX, y: localY };
          const drop = player.drop;
          const tier = dropTier(drop);
          const alive = player.alive !== false;
          const active = alive && movedRecently(player.userId, now);
          const margin = tier.radius * policy.markerScale + 24;
          const visible = point.x >= -margin && point.y >= -margin
            && point.x <= surface.width + margin && point.y <= surface.height + margin;
          if (visible) {
            onScreen.push({
              point, tier, drop, active, alive,
              entity: player.entity, name: player.name,
              labelStack: 0, showDropLabel: false
            });
          } else if (drop >= policy.edgeMin) {
            offScreen.push({ point, tier, drop, active, alive, showDropLabel: drop >= policy.minDrop });
          }
        }

        drawSelfHpBar(surface);
        offScreen.sort((a, b) => b.drop - a.drop);
        for (const marker of offScreen.slice(0, policy.edgeMax)) {
          drawEdgeMarker(marker.point, marker.tier, marker.drop, marker.active, pulse, surface, now, marker.showDropLabel);
        }
        selectLabeled(onScreen, policy);
        // 名字/残血也参与错开（Active 始终有名）
        assignLabelStacks(onScreen.filter(m => {
          if (m.showDropLabel) return true;
          if (m.alive && m.name) return true;
          if (m.entity && shouldShowHp(m.entity)) return true;
          if (!m.alive && m.name && m.drop >= DEAD_NAME_MIN_DROP) return true;
          return false;
        }));
        // Passive 先画，Active 压顶；同组内静止先于运动
        onScreen.sort((a, b) => {
          if (a.alive !== b.alive) return Number(a.alive) - Number(b.alive);
          return Number(a.active) - Number(b.active);
        });
        for (const marker of onScreen) {
          drawMarker(
            marker.point, marker.tier, marker.active, pulse, marker.drop,
            now, marker.entity, marker.name, marker.labelStack,
            marker.showDropLabel, policy.markerScale, marker.alive
          );
        }
      }

      function render() {
        try {
          if (!overlay.enabled) {
            clearCanvas();
            return;
          }
          hookGameCanvas();
          const wrapped = wrapGameDraw();
          if (document.hidden) {
            clearCanvas();
            return;
          }
          // 主路径：挂到游戏 draw，在同一 canvas/同一变换上画情报 → 中心到边缘零漂移
          if (wrapped || overlay.drawWrapped) {
            clearCanvas();
            return;
          }
          // 回退：独立情报 canvas
          const surface = prepareCanvas();
          drawCtx = ctx;
          paintIntel(surface);
        } catch (_) {
          clearCanvas();
        }
      }

      function frame() {
        overlay.raf = 0;
        render();
        if (canvasEl.isConnected) {
          overlay.raf = window.requestAnimationFrame(frame);
        }
      }

      function startLoop() {
        if (!overlay.raf) overlay.raf = window.requestAnimationFrame(frame);
      }

      function setEnabled(next) {
        overlay.enabled = !!next;
        panel.classList.toggle("off", !overlay.enabled);
        toggleBtn.textContent = overlay.enabled ? "情报层 ON" : "情报层 OFF";
        if (!overlay.enabled) {
          overlay.suppressActive = false;
          overlay.panelRects = [];
          panel.classList.remove("legend-open");
          if (legendToggleBtn) legendToggleBtn.textContent = "图例";
          clearCanvas();
        } else {
          hookGameCanvas();
          wrapGameDraw();
          overlay.suppressActive = !!overlay.gctx;
        }
      }

      function destroy() {
        if (overlay.raf) {
          window.cancelAnimationFrame(overlay.raf);
          overlay.raf = 0;
        }
        unhookGameCanvas();
        canvasEl.remove();
        panel.remove();
        style.remove();
      }

      toggleBtn.addEventListener("click", () => setEnabled(!overlay.enabled));
      if (legendToggleBtn) {
        legendToggleBtn.addEventListener("click", () => {
          panel.classList.toggle("legend-open");
          legendToggleBtn.textContent = panel.classList.contains("legend-open") ? "收起" : "图例";
        });
      }

      overlay.setEnabled = setEnabled;
      overlay.destroy = destroy;

      setEnabled(true);
      startLoop();
    }
  }
})();
