// ==UserScript==
// @name         Grasp Rat Intel Overlay
// @namespace    https://grasp-rat-game.h-e.top/
// @version      0.6.0
// @description  纯信息层：合并全场实时/快照/小地图数据标记场上玩家，富敌高亮，活人显示名字与血量，原生面板按绘制签名直接不绘制，不做任何自动操作。
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
    const CANVAS_MAX_DPR = 1.75;
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

    // 隐藏原生面板：按“绘制签名”识别，而不是复刻坐标。
    // 游戏 drawEntity 每个面板都先用唯一底色画背景框，再用等宽字体画各行文字：
    //   ctx.fillStyle = 'rgba(15, 23, 42, .76)'; ctx.fillRect(labelX-5, labelY-11, w, h);
    //   ctx.font = '11px ui-monospace,...'; ctx.fillText(...) x N 行
    // 这个底色全局只有面板在用，所以 hook 到该底色的 fillRect 直接跳过并记录矩形，
    // 随后落在该矩形内的 fillText/strokeText 也跳过。这样无论近/远/自己都统一隐藏，
    // 不依赖任何坐标换算（worldToScreen 把相机烘进数学式里，canvas 变换恒为 dpr）。
    const PANEL_BG_RAW = 'rgba(15, 23, 42, .76)';
    // 文字命中面板矩形时的容差（等宽字体量宽和端上细微差异）。
    const PANEL_HIT_PAD = 4;

    // 金币档位阈值，按 log 递增：5 / 10 / 20 / 50 / 100 / 200。
    const DROP_TIERS = [
      { min: 200, radius: 30, color: "232, 121, 249", label: "≥200" }, // 品红
      { min: 100, radius: 25, color: "248, 113, 113", label: "≥100" }, // 红
      { min: 50, radius: 20, color: "251, 146, 60", label: "≥50" },    // 橙
      { min: 20, radius: 14, color: "250, 204, 21", label: "≥20" },    // 黄
      { min: 10, radius: 11, color: "74, 222, 128", label: "≥10" },    // 绿
      { min: 5, radius: 9, color: "45, 212, 191", label: "≥5" },       // 青（>=5 特殊色）
      { min: 0, radius: 7, color: "148, 163, 184", label: "<5" }       // 灰
    ];

    // 金币数字标注阈值：>=5 起标数字（与 >=5 特殊色一致）。
    const LABEL_MIN_DROP = 5;
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
        '<button type="button" data-intel="toggle">情报层 ON</button>',
        '<div class="intel-legend" data-intel="legend"></div>'
      ].join("");

      const style = document.createElement("style");
      style.textContent = `
        #${CANVAS_ID} {
          position: fixed;
          inset: 0;
          width: 100%;
          height: 100%;
          display: block;
          pointer-events: none;
          z-index: 2147483600;
        }
        #${PANEL_ID} {
          position: fixed;
          top: 14px;
          right: 14px;
          z-index: 2147483601;
          display: grid;
          gap: 6px;
          justify-items: end;
          font: 13px/1.35 "Microsoft YaHei", "Microsoft YaHei UI", Arial, sans-serif;
          color: #e5edf8;
          pointer-events: none;
          text-shadow: 0 0 6px rgba(2, 6, 23, .7);
        }
        #${PANEL_ID} button {
          min-height: 30px;
          padding: 0 12px;
          color: #bae6fd;
          background: rgba(2, 6, 23, .55);
          border: 1px solid rgba(56, 189, 248, .42);
          border-radius: 4px;
          cursor: pointer;
          font: inherit;
          letter-spacing: .06em;
          pointer-events: auto;
        }
        #${PANEL_ID} button:hover { background: rgba(8, 47, 73, .72); }
        #${PANEL_ID}.off button {
          color: rgba(148, 163, 184, .85);
          border-color: rgba(148, 163, 184, .35);
        }
        #${PANEL_ID} .intel-legend {
          display: grid;
          gap: 3px;
          padding: 7px 9px;
          background: rgba(2, 6, 23, .5);
          border: 1px solid rgba(125, 211, 252, .16);
          border-radius: 4px;
        }
        #${PANEL_ID}.off .intel-legend { display: none; }
        #${PANEL_ID} .intel-legend-row {
          display: flex;
          align-items: center;
          gap: 7px;
          justify-content: flex-end;
          color: rgba(226, 232, 240, .82);
          font-size: 12px;
        }
        #${PANEL_ID} .intel-dot {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          box-shadow: 0 0 6px currentColor;
        }
        #${PANEL_ID} .intel-note {
          margin-top: 3px;
          color: rgba(148, 163, 184, .8);
          font-size: 11px;
        }
      `;

      document.head.appendChild(style);
      document.body.appendChild(canvasEl);
      document.body.appendChild(panel);

      const ctx = canvasEl.getContext("2d");
      const toggleBtn = panel.querySelector('[data-intel="toggle"]');
      const legend = panel.querySelector('[data-intel="legend"]');

      // 图例：颜色档 + 活跃/非活跃说明。
      legend.innerHTML = DROP_TIERS
        .map(tier => `<div class="intel-legend-row"><span>${tier.label}</span><span class="intel-dot" style="color:rgba(${tier.color},1)"></span></div>`)
        .join("")
        + '<div class="intel-note">活跃=呼吸环+血量+名字 / 静止=稳定环(挨打才显血) / 边缘=视野外</div>';

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
        suppressActive: false
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

        for (const entity of state.entities || []) {
          const userId = Number(entity.user_id);
          if (!Number.isFinite(userId) || userId === meId) continue;
          if (!isAliveEntity(entity)) continue;
          const x = Number(entity.x);
          const y = Number(entity.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          byId.set(userId, {
            userId,
            x,
            y,
            drop: enemyDrop(entity),
            name: resolvePlayerName(userId, entity),
            source: "entity",
            entity
          });
        }

        // farSnapshot：30s 全场快照，实体结构同 state.entities（含 hp/name/life）。
        const far = state.farSnapshot && Array.isArray(state.farSnapshot.entities)
          ? state.farSnapshot.entities : [];
        for (const entity of far) {
          const userId = Number(entity && entity.user_id);
          if (!Number.isFinite(userId) || userId === meId) continue;
          if (!isAliveEntity(entity)) continue;
          if (byId.has(userId)) continue; // 已有实时实体，实时优先。
          const x = Number(entity.x);
          const y = Number(entity.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          // 落在实时区内却不在实时 entities 里 → 已死/离线的陈旧快照，丢弃。
          if (inLiveZone(x, y)) continue;
          byId.set(userId, {
            userId,
            x,
            y,
            drop: enemyDrop(entity),
            name: resolvePlayerName(userId, entity),
            source: "far",
            entity
          });
        }

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
            // 已有实体：保留实时坐标，仅在 minimap Drop 更高时更新。
            if (drop > existing.drop) existing.drop = drop;
          } else {
            // 实时区内却没有对应实体 → 已死/离线的陈旧点，丢弃（反 desync 核心）。
            if (inLiveZone(x, y)) continue;
            byId.set(userId, {
              userId, x, y, drop,
              name: resolvePlayerName(userId, null),
              source: "minimap", entity: null
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

      function canvasRect() {
        const worldCanvas = typeof canvas !== "undefined" ? canvas : document.getElementById("world");
        if (worldCanvas && typeof worldCanvas.getBoundingClientRect === "function") {
          const rect = worldCanvas.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return rect;
        }
        return document.body.getBoundingClientRect();
      }

      // 优先使用平滑视觉坐标，减少抖动。
      function renderWorldPoint(player) {
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
        return typeof style === "string" && style.indexOf("15, 23, 42") !== -1;
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
          fillRect: gctx.fillRect
        };

        const shouldSkipText = function (x, y) {
          if (!overlay.suppressActive || !overlay.panelRects.length) return false;
          return textInPanelRect(x, y);
        };

        gctx.fillText = function (text, x, y, maxWidth) {
          if (shouldSkipText(x, y)) return;
          return orig.fillText.call(this, text, x, y, maxWidth);
        };
        gctx.strokeText = function (text, x, y, maxWidth) {
          if (shouldSkipText(x, y)) return;
          return orig.strokeText.call(this, text, x, y, maxWidth);
        };
        gctx.fillRect = function (x, y, w, h) {
          if (!overlay.suppressActive) return orig.fillRect.call(this, x, y, w, h);
          // 帧起点：整块背景铺满 canvas -> 清空上一帧记录的面板框。
          const cw = this.canvas ? this.canvas.clientWidth : 0;
          const ch = this.canvas ? this.canvas.clientHeight : 0;
          if (cw && ch && x <= 1 && y <= 1 && w >= cw - 2 && h >= ch - 2) {
            overlay.panelRects.length = 0;
            return orig.fillRect.call(this, x, y, w, h);
          }
          // 面板底色框：记录矩形，跳过绘制。
          if (isPanelBg(this.fillStyle)) {
            if (overlay.panelRects.length < 512) overlay.panelRects.push({ x, y, w, h });
            return;
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
            delete gctx.__intelHooked;
          } catch (_) {}
        }
        overlay.gctx = null;
        overlay.gctxOrig = null;
        overlay.gameCanvas = null;
        overlay.suppressActive = false;
        overlay.panelRects = [];
      }

      function prepareCanvas() {
        const width = Math.max(1, Math.round(window.innerWidth));
        const height = Math.max(1, Math.round(window.innerHeight));
        const dpr = Math.min(CANVAS_MAX_DPR, Math.max(1, Number(window.devicePixelRatio || 1)));
        const pixelWidth = Math.max(1, Math.round(width * dpr));
        const pixelHeight = Math.max(1, Math.round(height * dpr));
        if (canvasEl.width !== pixelWidth || canvasEl.height !== pixelHeight) {
          canvasEl.width = pixelWidth;
          canvasEl.height = pixelHeight;
          canvasEl.style.width = width + "px";
          canvasEl.style.height = height + "px";
        }
        overlay.dpr = dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        return { width, height };
      }

      function clearCanvas() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      }

      function drawMarker(point, tier, active, pulse, drop, now, entity, name) {
        const color = tier.color;
        const baseRadius = tier.radius;
        const emphasis = drop >= EMPHASIS_DROP;

        ctx.save();
        ctx.translate(point.x, point.y);

        if (active) {
          // 活跃玩家一律强化：全都画向外扩散的呼吸环（富敌再加一圈更大更亮的）。
          const expand = (now % 1600) / 1600;
          ctx.beginPath();
          ctx.arc(0, 0, baseRadius + 4 + expand * (emphasis ? 22 : 14), 0, Math.PI * 2);
          ctx.lineWidth = emphasis ? 2.4 : 1.8;
          ctx.setLineDash([]);
          ctx.strokeStyle = `rgba(${color}, ${(1 - expand) * (emphasis ? 0.6 : 0.45)})`;
          ctx.shadowBlur = 0;
          ctx.stroke();

          // 活跃：实心圈 + 呼吸光晕。全体活跃都比原来更亮，富敌更甚。
          const glow = (emphasis ? 14 : 10) + pulse * (emphasis ? 16 : 12);
          const ringAlpha = 0.9 + pulse * 0.1;

          ctx.beginPath();
          ctx.arc(0, 0, baseRadius, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${color}, ${(emphasis ? 0.28 : 0.2) + pulse * 0.12})`;
          ctx.fill();

          ctx.lineWidth = emphasis ? 3.4 : 2.8;
          ctx.setLineDash([]);
          ctx.strokeStyle = `rgba(${color}, ${ringAlpha})`;
          ctx.shadowBlur = glow;
          ctx.shadowColor = `rgba(${color}, .9)`;
          ctx.stroke();
        } else {
          // 静止（挂机）：不再虚化消失，改用清晰但“稳定”的状态标识——
          // 实心稳定环（不呼吸）+ 中心点，与活跃的呼吸/扩散区分，一眼能认出“在场但没动”。
          ctx.beginPath();
          ctx.arc(0, 0, baseRadius, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${color}, .1)`;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
          ctx.strokeStyle = `rgba(${color}, .78)`;
          ctx.shadowBlur = 0;
          ctx.stroke();
          // 中心实心点：静止标识。
          ctx.beginPath();
          ctx.arc(0, 0, Math.max(1.6, baseRadius * 0.28), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${color}, .9)`;
          ctx.fill();
        }

        // 血条（原生面板已被隐藏，血量得由我们补回来）。仅可见实体有 hp 数据。
        // 活跃玩家一直显示血量；静止（僵尸）只有“最近刚掉血”才显示——
        // 因为血量不回，用 hp<max 判断会让所有被打过的僵尸永久挂血条。
        let hpBottom = -baseRadius - 4;
        if (entity) {
          const damagedRecently = recentlyDamaged(entity.user_id, now);
          if (active || damagedRecently) {
            const drawn = drawHpBar(0, -baseRadius - 4, entity);
            if (drawn) hpBottom = -baseRadius - 4 - HP_BAR_H - HP_BAR_GAP;
          }
        }

        // 金币数字：>=5 起标注（与 >=5 特殊色一致），放在血条上方。
        if (drop >= LABEL_MIN_DROP) {
          drawDropLabel(0, hpBottom - 3, drop, color, active, emphasis);
        }

        // 只有活跃玩家显示名字；静止（僵尸/挂机）不显示，减少画面噪音。
        if (active && entity && name) {
          drawNameLabel(0, baseRadius + 4, name, color, active);
        }

        ctx.restore();
      }

      // 玩家名字标签：画在标记正下方，深色描边保证任何背景下都清晰。
      function drawNameLabel(x, y, name, color, active) {
        let text = String(name);
        if (text.length > NAME_MAX_CHARS) text = text.slice(0, NAME_MAX_CHARS - 1) + "…";
        ctx.setLineDash([]);
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.font = `${active ? 600 : 500} 12px "Microsoft YaHei", Arial, sans-serif`;
        ctx.shadowBlur = 0;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(2, 6, 23, .9)";
        ctx.strokeText(text, x, y);
        ctx.fillStyle = active ? "rgba(236, 244, 255, .98)" : "rgba(203, 213, 225, .82)";
        ctx.fillText(text, x, y);
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

        ctx.save();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
        // 底槽。
        ctx.fillStyle = "rgba(2, 6, 23, .78)";
        ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
        // 血量：绿->黄->红 随比例过渡。
        let fill;
        if (ratio > 0.5) fill = "74, 222, 128";
        else if (ratio > 0.25) fill = "250, 204, 21";
        else fill = "248, 113, 113";
        ctx.fillStyle = `rgba(${fill}, .95)`;
        ctx.fillRect(x, y, w * ratio, h);
        // 边框。
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(226, 232, 240, .5)";
        ctx.strokeRect(x, y, w, h);

        // 数字 HP。
        ctx.font = '600 11px "Microsoft YaHei", Arial, sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "rgba(2, 6, 23, .9)";
        ctx.fillText(Math.round(hp) + "/" + Math.round(maxHp), cx + 0.6, y - 1.4);
        ctx.fillStyle = "rgba(236, 244, 255, .98)";
        ctx.fillText(Math.round(hp) + "/" + Math.round(maxHp), cx, y - 2);
        ctx.restore();
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
        const x = Math.round(surface.width / 2 - w / 2);
        const y = SELF_HP_TOP;

        ctx.save();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
        // 底槽。
        ctx.fillStyle = "rgba(2, 6, 23, .82)";
        ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
        // 血量：绿->黄->红。
        let fill;
        if (ratio > 0.5) fill = "74, 222, 128";
        else if (ratio > 0.25) fill = "250, 204, 21";
        else fill = "248, 113, 113";
        ctx.fillStyle = `rgba(${fill}, .95)`;
        ctx.fillRect(x, y, w * ratio, h);
        // 边框 + 低血时红色呼吸描边。
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = ratio <= 0.25
          ? `rgba(248, 113, 133, ${0.7 + 0.3 * Math.abs(Math.sin(Date.now() / 300))})`
          : "rgba(226, 232, 240, .55)";
        ctx.strokeRect(x, y, w, h);
        // 数字 HP。
        ctx.font = '700 12px "Microsoft YaHei", Arial, sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const label = "HP " + Math.round(hp) + " / " + Math.round(maxHp);
        ctx.fillStyle = "rgba(2, 6, 23, .92)";
        ctx.fillText(label, surface.width / 2 + 0.7, y + h / 2 + 0.7);
        ctx.fillStyle = "rgba(240, 247, 255, .98)";
        ctx.fillText(label, surface.width / 2, y + h / 2);
        ctx.restore();
      }

      // 金币数字。富敌活跃时加金币片背景，进一步突出。
      function drawDropLabel(x, y, drop, color, active, emphasis) {
        const text = String(drop);
        ctx.setLineDash([]);
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        const fontSize = emphasis ? (active ? 17 : 14) : (active ? 15 : 13);
        const weight = active ? 700 : 500;
        ctx.font = `${weight} ${fontSize}px "Microsoft YaHei", Arial, sans-serif`;

        if (emphasis && active) {
          const w = ctx.measureText(text).width;
          const padX = 6;
          const chipW = w + padX * 2;
          const chipH = fontSize + 6;
          const chipX = x - chipW / 2;
          const chipY = y - chipH;
          ctx.shadowBlur = 8;
          ctx.shadowColor = `rgba(${color}, .8)`;
          roundRect(chipX, chipY, chipW, chipH, 4);
          ctx.fillStyle = "rgba(2, 6, 23, .82)";
          ctx.fill();
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = `rgba(${color}, .95)`;
          ctx.shadowBlur = 0;
          ctx.stroke();
          ctx.fillStyle = `rgba(${color}, 1)`;
          ctx.fillText(text, x, y - 3);
          return;
        }

        const labelAlpha = active ? 0.98 : 0.42;
        ctx.shadowBlur = active ? 6 : 0;
        ctx.shadowColor = "rgba(2, 6, 23, .9)";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(2, 6, 23, .85)";
        ctx.strokeText(text, x, y);
        ctx.fillStyle = `rgba(${color}, ${labelAlpha})`;
        ctx.fillText(text, x, y);
      }

      function roundRect(x, y, w, h, r) {
        const radius = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.arcTo(x + w, y, x + w, y + h, radius);
        ctx.arcTo(x + w, y + h, x, y + h, radius);
        ctx.arcTo(x, y + h, x, y, radius);
        ctx.arcTo(x, y, x + w, y, radius);
        ctx.closePath();
      }

      // 视野外玩家：贴到屏幕边缘，用朝外三角 + Drop 数字提示方位。
      function drawEdgeMarker(point, tier, drop, active, pulse, surface, now) {
        const cx = surface.width / 2;
        const cy = surface.height / 2;
        let dx = point.x - cx;
        let dy = point.y - cy;
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
        const halfW = Math.max(1, surface.width / 2 - EDGE_MARGIN);
        const halfH = Math.max(1, surface.height / 2 - EDGE_MARGIN);
        const scale = Math.min(halfW / Math.abs(dx || 1e-6), halfH / Math.abs(dy || 1e-6));
        const ex = cx + dx * scale;
        const ey = cy + dy * scale;
        const angle = Math.atan2(dy, dx);
        const color = tier.color;
        const emphasis = drop >= EMPHASIS_DROP;
        const size = emphasis ? 12 : 9;

        ctx.save();
        ctx.translate(ex, ey);

        // 朝外的三角。
        ctx.save();
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(size, 0);
        ctx.lineTo(-size * 0.7, size * 0.7);
        ctx.lineTo(-size * 0.7, -size * 0.7);
        ctx.closePath();
        ctx.fillStyle = `rgba(${color}, ${active ? 0.92 : 0.5})`;
        if (emphasis && active) {
          ctx.shadowBlur = 8 + pulse * 8;
          ctx.shadowColor = `rgba(${color}, .8)`;
        }
        ctx.fill();
        ctx.restore();

        // Drop 数字放在三角内侧（朝屏幕中心方向偏移）。
        const labelX = -Math.cos(angle) * (size + 10);
        const labelY = -Math.sin(angle) * (size + 10);
        drawDropLabel(labelX, labelY + size * 0.5, drop, color, active, emphasis);
        ctx.restore();
      }

      function render() {
        try {
          if (!overlay.enabled) {
            clearCanvas();
            return;
          }
          hookGameCanvas();
          const now = Date.now();
          if (document.hidden) {
            overlay.suppressActive = false;
            clearCanvas();
            return;
          }
          const surface = prepareCanvas();
          const rect = canvasRect();
          let view = null;
          try {
            view = viewParams();
          } catch (_) {
            overlay.suppressActive = false;
            return;
          }
          if (!view) {
            overlay.suppressActive = false;
            return;
          }

          // 先算 view，再 buildPlayers——反 desync 的实时区判定要用相机中心。
          const players = buildPlayers(view);
          trackMotion(players, now);

          const pulse = 0.5 + 0.5 * Math.sin(now / 600);

          // 隐藏原生面板：只要 hook 成功就开启签名抑制，让游戏所有实体面板（近/远/自己）都不画。
          // 抑制矩形由 hook 在游戏自身绘制时按底色签名记录，这里不再复刻任何坐标。
          overlay.suppressActive = !!overlay.gctx;

          const onScreen = [];        // 视野内：正常标记
          const offScreen = [];       // 视野外：边缘雷达标记

          for (const player of players) {
            const world = renderWorldPoint(player);
            let sp;
            try {
              sp = worldToScreen(Number(world.x), Number(world.y), view);
            } catch (_) {
              continue;
            }
            const localX = Number(sp.x);
            const localY = Number(sp.y);
            if (!Number.isFinite(localX) || !Number.isFinite(localY)) continue;
            const winPoint = { x: rect.left + localX, y: rect.top + localY };
            const drop = player.drop;
            const tier = dropTier(drop);
            const active = movedRecently(player.userId, now);

            const margin = tier.radius + 24;
            const visible = winPoint.x >= -margin && winPoint.y >= -margin
              && winPoint.x <= surface.width + margin && winPoint.y <= surface.height + margin;

            if (visible) {
              onScreen.push({ point: winPoint, tier, drop, active, entity: player.entity, name: player.name });
            } else if (drop >= EDGE_MIN_DROP) {
              offScreen.push({ point: winPoint, tier, drop, active });
            }
          }

          // 自己的血条：固定在屏幕顶部中间，醒目大条。
          drawSelfHpBar(surface);

          // 边缘雷达标记：Drop 高的优先，限制数量避免边缘拥挤。
          offScreen.sort((a, b) => b.drop - a.drop);
          for (const marker of offScreen.slice(0, EDGE_MAX_MARKERS)) {
            drawEdgeMarker(marker.point, marker.tier, marker.drop, marker.active, pulse, surface, now);
          }

          // 视野内：先画挂机（虚化底层），再画活跃（强调压顶）。
          onScreen.sort((a, b) => Number(a.active) - Number(b.active));
          for (const marker of onScreen) {
            drawMarker(marker.point, marker.tier, marker.active, pulse, marker.drop, now, marker.entity, marker.name);
          }
        } catch (_) {
          overlay.suppressActive = false;
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
          // 关闭时恢复原生面板绘制。
          overlay.suppressActive = false;
          overlay.panelRects = [];
          clearCanvas();
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

      overlay.setEnabled = setEnabled;
      overlay.destroy = destroy;

      setEnabled(true);
      startLoop();
    }
  }
})();
