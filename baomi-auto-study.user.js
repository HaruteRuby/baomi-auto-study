// ==UserScript==
// @name         中国保密在线：2026三类课程自动学习
// @namespace    https://github.com/HaruteRuby/baomi-auto-study
// @version      1.0.0
// @description  逐类完成保密教育视频；防止列表未加载时误切分类，并阻止重复打开学习标签页。
// @author       HaruteRuby
// @match        https://www.baomi.org.cn/bmCourseDetail/course*
// @match        https://www.baomi.org.cn/bmVideo*
// @homepageURL  https://github.com/HaruteRuby/baomi-auto-study
// @supportURL   https://github.com/HaruteRuby/baomi-auto-study/issues
// @updateURL    https://raw.githubusercontent.com/HaruteRuby/baomi-auto-study/main/baomi-auto-study.user.js
// @downloadURL  https://raw.githubusercontent.com/HaruteRuby/baomi-auto-study/main/baomi-auto-study.user.js
// @license      MIT
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  console.info('[保密网自动学习] v1.0.0 已注入');

  const CONFIG = Object.freeze({
    // 严格按网页显示顺序完成：一个分类全部 status2 后才进入下一个分类。
    categories: ['保密优良传统教育', '保密知识技能教育', '保密纪律教育'],
    tickMs: 1200,
    actionCooldownMs: 2800,
    categoryRenderWaitMs: 3000,
    completeConfirmScans: 3,
    completeConfirmIntervalMs: 1800,
    closeDelayMs: 3000,
    startMuted: true,
    debug: true,
  });

  const STORAGE_KEY = 'codex-baomi-auto-study-v20260717';
  const PANEL_ID = 'codex-baomi-auto-panel';
  const STYLE_ID = 'codex-baomi-auto-style';
  const CHANNEL_NAME = 'codex-baomi-study-channel-v3';
  const CONTROLLER_LOCK = 'codex-baomi-course-list-controller-v3';
  const params = new URLSearchParams(location.search);
  const IS_PLAYER_PAGE = location.pathname === '/bmVideo' ||
    params.has('IsAudition') || params.has('courseStatus') ||
    (Boolean(window.opener) && params.has('status'));

  const storage = {
    get(key, fallback = null) {
      try {
        return window.localStorage.getItem(key) ?? fallback;
      } catch (error) {
        console.warn('[保密网自动学习] localStorage 不可用，改用内存状态：', error);
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (error) {
        console.warn('[保密网自动学习] 无法保存状态，但不影响本次运行：', error);
      }
    },
  };

  const state = {
    enabled: storage.get(STORAGE_KEY, 'running') !== 'paused',
    categoryIndex: 0,
    categoryReadyAt: 0,
    selectedCategoryIndex: -1,
    completeScans: 0,
    lastCompleteScanAt: 0,
    lastActionAt: 0,
    lastAction: '',
    currentCourse: '',
    waitingForPlayer: false,
    playerSeen: false,
    openingSince: 0,
    isController: IS_PLAYER_PAGE,
    controllerRequestPending: false,
    endedAt: 0,
    completionSent: false,
    completed: false,
    timer: 0,
  };

  let channel = null;

  const log = (...args) => {
    if (CONFIG.debug) console.log('[保密网自动学习]', ...args);
  };

  const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();

  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  };

  const broadcast = (type, extra = {}) => {
    try {
      channel?.postMessage({ type, at: Date.now(), ...extra });
    } catch (error) {
      log('跨标签页消息发送失败：', error);
    }
  };

  const canAct = () => Date.now() - state.lastActionAt >= CONFIG.actionCooldownMs;

  const safeClick = (element, name) => {
    if (!element || !isVisible(element) || !canAct()) return false;
    state.lastActionAt = Date.now();
    state.lastAction = name;
    log('点击：', name, element);
    element.click();
    updatePanel();
    return true;
  };

  function injectPanel() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        #${PANEL_ID} {
          position: fixed; z-index: 2147483647; right: 18px; top: 138px;
          width: 300px; box-sizing: border-box; padding: 14px 15px;
          color: #1f2937; background: rgba(255,255,255,.97);
          border: 1px solid #d8dee9; border-radius: 10px;
          box-shadow: 0 8px 28px rgba(0,0,0,.16);
          font-family: "Microsoft YaHei", "微软雅黑", sans-serif;
          font-size: 13px; line-height: 1.55;
        }
        #${PANEL_ID} .codex-title { font-weight: 700; font-size: 15px; margin-bottom: 8px; }
        #${PANEL_ID} .codex-status { min-height: 42px; color: #374151; word-break: break-all; }
        #${PANEL_ID} .codex-meta { color: #6b7280; font-size: 12px; margin: 5px 0 10px; }
        #${PANEL_ID} button {
          border: 0; border-radius: 6px; padding: 7px 11px; cursor: pointer;
          font-family: "Microsoft YaHei", "微软雅黑", sans-serif;
        }
        #${PANEL_ID} .codex-toggle { color: white; background: #2563eb; }
        #${PANEL_ID} .codex-release { margin-left: 7px; color: #7c2d12; background: #ffedd5; }
        #${PANEL_ID} .codex-rescan { margin-left: 7px; color: #374151; background: #e5e7eb; }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="codex-title">保密网自动学习${IS_PLAYER_PAGE ? '（学习页）' : ''}</div>
      <div class="codex-status"></div>
      <div class="codex-meta"></div>
      <button type="button" class="codex-toggle"></button>
      ${IS_PLAYER_PAGE ? '' : '<button type="button" class="codex-release">解除等待</button><button type="button" class="codex-rescan">重新扫描</button>'}
    `;
    panel.querySelector('.codex-toggle').addEventListener('click', () => {
      state.enabled = !state.enabled;
      state.completed = false;
      storage.set(STORAGE_KEY, state.enabled ? 'running' : 'paused');
      updatePanel();
      if (state.enabled) schedule(50);
    });
    panel.querySelector('.codex-release')?.addEventListener('click', () => {
      clearPlayerWait('用户手动解除等待');
      state.selectedCategoryIndex = -1;
      state.categoryReadyAt = 0;
      state.completeScans = 0;
      updatePanel('已解除等待，将重新读取本分类。');
      schedule(100);
    });
    panel.querySelector('.codex-rescan')?.addEventListener('click', () => {
      clearPlayerWait('重新扫描');
      state.categoryIndex = 0;
      state.selectedCategoryIndex = -1;
      state.categoryReadyAt = 0;
      state.completeScans = 0;
      state.completed = false;
      state.lastActionAt = 0;
      updatePanel();
      schedule(100);
    });
    document.body.appendChild(panel);
    updatePanel();
  }

  function updatePanel(message = '') {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const category = CONFIG.categories[state.categoryIndex] || '全部课程';
    let status = message;
    if (!status) {
      if (!state.enabled) status = '已暂停。';
      else if (IS_PLAYER_PAGE && state.currentCourse) status = `正在播放：${state.currentCourse}`;
      else if (IS_PLAYER_PAGE) status = '学习页已接管，等待播放器加载。';
      else if (!state.isController) status = '另一个课程列表页正在控制；本页只监视，不点击。';
      else if (state.completed) status = '三个分类均已确认全部完成。';
      else if (state.waitingForPlayer) status = `等待学习页完成：${state.currentCourse || '当前课程'}`;
      else status = `正在核对：${category}`;
    }
    panel.querySelector('.codex-status').textContent = status;
    panel.querySelector('.codex-meta').textContent = state.lastAction
      ? `最近操作：${state.lastAction}` : '一个分类全部完成后才会切换。';
    panel.querySelector('.codex-toggle').textContent = state.enabled ? '暂停' : '开始';
  }

  function initChannel() {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener('message', (event) => {
        const message = event.data || {};
        if (IS_PLAYER_PAGE) return;
        if (message.type === 'player-ready' && state.waitingForPlayer) {
          state.playerSeen = true;
          updatePanel(`学习页已打开，等待完播：${state.currentCourse}`);
        }
        if (message.type === 'course-finished' && state.waitingForPlayer) {
          log('收到学习页完成通知，刷新列表页。');
          clearPlayerWait('课程已完成');
          updatePanel('课程已完播，正在刷新服务器状态…');
          // 原列表页不会主动刷新 status0/status2，完整重载可确保从服务器读取最新状态。
          window.setTimeout(() => location.reload(), 2500);
        }
        if (message.type === 'player-closed' && state.waitingForPlayer && !message.completed) {
          clearPlayerWait('学习页已关闭');
          state.selectedCategoryIndex = -1;
          state.completeScans = 0;
          updatePanel('学习页已关闭但未确认完播，将重新核对课程状态。');
        }
      });
    } catch (error) {
      console.warn('[保密网自动学习] BroadcastChannel 不可用：', error);
    }
  }

  function tryAcquireController() {
    if (IS_PLAYER_PAGE || state.isController || state.controllerRequestPending) return;
    if (!navigator.locks?.request) {
      state.isController = true;
      updatePanel();
      schedule(100);
      return;
    }
    state.controllerRequestPending = true;
    navigator.locks.request(CONTROLLER_LOCK, { ifAvailable: true }, async (lock) => {
      state.controllerRequestPending = false;
      if (!lock) {
        state.isController = false;
        updatePanel();
        return;
      }
      state.isController = true;
      log('本页取得唯一课程列表控制权。');
      updatePanel();
      schedule(100);
      await new Promise(() => {});
    }).catch((error) => {
      state.controllerRequestPending = false;
      console.warn('[保密网自动学习] 页面控制锁获取失败：', error);
    });
  }

  function getTabs() {
    return [...document.querySelectorAll('.tab-list .tab-item, .course-course-list .tab-item')]
      .filter(isVisible);
  }

  function findCategoryTab(category) {
    return getTabs().find((element) => normalize(element.textContent) === normalize(category));
  }

  function activeCategoryName() {
    const active = getTabs().find((element) =>
      element.getAttribute('active') === 'true' ||
      element.classList.contains('active') || element.classList.contains('is-active')
    );
    return active ? normalize(active.textContent) : '';
  }

  function getCourseCards() {
    const cards = [...document.querySelectorAll(
      '.course-course-list .course-list .course-item.pointer, .course-list .course-item.pointer'
    )];
    return [...new Set(cards)].filter((element) =>
      isVisible(element) &&
      (element.classList.contains('type2') || element.querySelector('.cover-img')) &&
      /\bstatus[012]\b/.test(String(element.className || ''))
    );
  }

  function courseStatus(element) {
    const classes = String(element.className || '');
    const text = normalize(element.textContent);
    if (/\bstatus2\b/.test(classes) || /已学完|已完成|学习完成/.test(text)) return 'complete';
    if (/\bstatus0\b|\bstatus1\b/.test(classes) || /待学习|继续学习|学习中|未学习/.test(text)) return 'unfinished';
    return 'unknown';
  }

  function courseTitle(element) {
    const title = element.querySelector('.titlename, .content .title, [class*="title"]');
    return normalize(title?.textContent || element.textContent).slice(0, 100);
  }

  function clearPlayerWait(reason) {
    log('解除学习页等待：', reason);
    state.waitingForPlayer = false;
    state.playerSeen = false;
    state.openingSince = 0;
    state.currentCourse = '';
    state.lastActionAt = 0;
  }

  function openCourse(card) {
    if (state.waitingForPlayer) return false;
    const title = courseTitle(card);
    // 必须先上锁再点击；即使新标签页打开很慢，下一轮也不会重复点击。
    state.waitingForPlayer = true;
    state.playerSeen = false;
    state.openingSince = Date.now();
    state.currentCourse = title;
    state.completeScans = 0;
    if (!safeClick(card, `打开课程：${title}`)) {
      clearPlayerWait('点击未执行');
      return false;
    }
    broadcast('course-requested', { title });
    updatePanel(`正在打开学习页：${title}`);
    return true;
  }

  function getVisibleDialogs() {
    const selectors = [
      '[role="dialog"]', '.el-dialog__wrapper', '.el-message-box__wrapper',
      '.video-dialog', '.player-dialog', '.course-video-dialog', '.dialog-wrapper',
    ];
    return [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
      .filter(isVisible);
  }

  function handleContinuePrompt() {
    for (const dialog of getVisibleDialogs()) {
      const text = normalize(dialog.textContent);
      if (!/继续|上次|断点|播放/.test(text)) continue;
      const button = [...dialog.querySelectorAll('button, .el-button')]
        .filter(isVisible)
        .find((item) => /^(继续学习|继续播放|确定|我知道了)$/.test(normalize(item.textContent)));
      if (button) return safeClick(button, `确认提示：${normalize(button.textContent)}`);
    }
    return false;
  }

  function getPlayableVideo() {
    const videos = [...document.querySelectorAll('video')];
    return videos.find((video) => isVisible(video) && (video.currentSrc || video.src || video.readyState > 0)) ||
      videos.find((video) => (video.currentSrc || video.src) && !video.ended) || null;
  }

  function hasVisibleCompletionMarker() {
    return [...document.querySelectorAll('.play-endImg, [class*="play-end"], [class*="playEnd"]')]
      .some(isVisible);
  }

  function playerScope(video) {
    return video?.closest(
      '[role="dialog"], .el-dialog__wrapper, .video-dialog, .player-dialog, ' +
      '.course-video-dialog, .dialog-wrapper, .prism-player'
    ) || getVisibleDialogs()[0] || video?.parentElement || document;
  }

  function clickPlayerPlay(scope) {
    const selectors = [
      '.prism-big-play-btn', '.prism-play-btn', '.vjs-big-play-button',
      '.video-play', '.play-btn', '[aria-label="播放"]', '[title="播放"]',
    ];
    for (const selector of selectors) {
      const button = [...scope.querySelectorAll(selector)].find(isVisible);
      if (button && safeClick(button, '点击播放器播放键')) return true;
    }
    return false;
  }

  function closePlayer(video) {
    const scope = playerScope(video);
    const outer = scope.classList?.contains('prism-player')
      ? (scope.closest('[role="dialog"], .el-dialog__wrapper, .video-dialog, .player-dialog') || scope.parentElement)
      : scope;
    const selectors = [
      '.el-dialog__headerbtn', '.el-message-box__headerbtn', '.prism-close-btn',
      '.player-close', '.video-close', '.close-btn', '[aria-label="关闭"]',
      '[aria-label="Close"]', '[title="关闭"]',
    ];
    for (const root of [outer, scope].filter(Boolean)) {
      for (const selector of selectors) {
        const button = [...root.querySelectorAll(selector)].find(isVisible);
        if (button && safeClick(button, '完播后关闭播放器')) return true;
      }
    }
    return false;
  }

  async function playerTick() {
    if (!state.enabled) return;
    if (handleContinuePrompt()) return;

    const video = getPlayableVideo();
    if (!video) {
      updatePanel('等待播放器加载…');
      clickPlayerPlay(document);
      return;
    }

    if (CONFIG.startMuted) video.muted = true;
    video.playbackRate = 1;
    state.currentCourse = normalize(document.title || '当前课程');
    const finished = video.ended || hasVisibleCompletionMarker() ||
      (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime >= video.duration - 0.8);

    if (finished) {
      if (!state.endedAt) {
        state.endedAt = Date.now();
        updatePanel('视频已完播，等待网站保存进度…');
        return;
      }
      if (!state.completionSent && Date.now() - state.endedAt >= CONFIG.closeDelayMs) {
        state.completionSent = true;
        broadcast('course-finished', { title: state.currentCourse });
        updatePanel('已通知课程列表页刷新，正在退出学习页…');
        closePlayer(video);
        window.setTimeout(() => {
          try {
            window.opener?.focus();
          } catch (error) {
            log('无法聚焦原课程列表页：', error);
          }
          window.close();
        }, 1800);
      }
      return;
    }

    state.endedAt = 0;
    const duration = Number.isFinite(video.duration) ? Math.floor(video.duration) : 0;
    const current = Math.floor(video.currentTime || 0);
    updatePanel(`正在播放（${current}/${duration || '?'} 秒）`);
    if (video.paused) {
      // 优先点击网站播放器自身的播放键，确保播放器内部事件和学习进度上报正常触发。
      if (!clickPlayerPlay(playerScope(video))) {
        try {
          await video.play();
        } catch (error) {
          log('播放器按钮及 video.play() 均未成功：', error);
        }
      }
    }
  }

  function advanceCategory() {
    state.categoryIndex += 1;
    state.selectedCategoryIndex = -1;
    state.categoryReadyAt = 0;
    state.completeScans = 0;
    state.lastCompleteScanAt = 0;
    state.lastActionAt = 0;
    if (state.categoryIndex >= CONFIG.categories.length) {
      state.completed = true;
      state.enabled = false;
      storage.set(STORAGE_KEY, 'paused');
      updatePanel();
      log('三个分类均已确认全部完成。');
      return false;
    }
    updatePanel();
    return true;
  }

  async function listTick() {
    if (!state.enabled || state.completed) return;
    if (!state.isController) {
      tryAcquireController();
      updatePanel();
      return;
    }
    if (document.hidden) {
      updatePanel(state.waitingForPlayer ? `学习页运行中：${state.currentCourse}` : '本页位于后台，暂停点击。');
      return;
    }
    if (state.waitingForPlayer) {
      const minutes = Math.floor((Date.now() - state.openingSince) / 60000);
      updatePanel(`等待学习页完播：${state.currentCourse}${minutes ? `（${minutes}分钟）` : ''}`);
      return;
    }

    const category = CONFIG.categories[state.categoryIndex];
    const tab = findCategoryTab(category);
    if (!tab) {
      state.completeScans = 0;
      updatePanel(`尚未找到“${category}”标签，等待页面加载…`);
      return;
    }

    const activeName = activeCategoryName();
    if (activeName !== normalize(category) || state.selectedCategoryIndex !== state.categoryIndex) {
      state.completeScans = 0;
      if (safeClick(tab, `切换到${category}`)) {
        state.selectedCategoryIndex = state.categoryIndex;
        state.categoryReadyAt = Date.now() + CONFIG.categoryRenderWaitMs;
      }
      return;
    }

    if (Date.now() < state.categoryReadyAt) {
      updatePanel(`等待“${category}”课程列表加载…`);
      return;
    }

    const cards = getCourseCards();
    // 核心修复：列表为空绝不视为完成，也绝不切换分类。
    if (cards.length === 0) {
      state.completeScans = 0;
      updatePanel(`“${category}”课程列表尚未加载，继续等待…`);
      return;
    }

    const summary = cards.reduce((result, card) => {
      result[courseStatus(card)].push(card);
      return result;
    }, { complete: [], unfinished: [], unknown: [] });

    if (summary.unfinished.length > 0) {
      state.completeScans = 0;
      const next = summary.unfinished[0];
      updatePanel(`“${category}”：已完成 ${summary.complete.length}/${cards.length}，准备学习下一课。`);
      openCourse(next);
      return;
    }

    if (summary.unknown.length > 0) {
      state.completeScans = 0;
      updatePanel(`“${category}”有 ${summary.unknown.length} 个课程状态无法确认，不切换分类。`);
      return;
    }

    // 所有真实视频卡片均为 status2 后，还要连续确认三次，防止 Vue 重绘空窗误判。
    if (Date.now() - state.lastCompleteScanAt >= CONFIG.completeConfirmIntervalMs) {
      state.completeScans += 1;
      state.lastCompleteScanAt = Date.now();
    }
    updatePanel(`“${category}”全部 ${cards.length} 课已完成，复核 ${state.completeScans}/${CONFIG.completeConfirmScans}…`);
    if (state.completeScans >= CONFIG.completeConfirmScans) advanceCategory();
  }

  async function tick() {
    clearTimeout(state.timer);
    state.timer = 0;
    try {
      if (IS_PLAYER_PAGE) await playerTick();
      else await listTick();
    } catch (error) {
      console.error('[保密网自动学习] 运行异常：', error);
      updatePanel(`发生异常，稍后重试：${error?.message || error}`);
    } finally {
      schedule(CONFIG.tickMs);
    }
  }

  function schedule(delay = CONFIG.tickMs) {
    clearTimeout(state.timer);
    state.timer = window.setTimeout(tick, delay);
  }

  function boot() {
    try {
      injectPanel();
      initChannel();
      if (IS_PLAYER_PAGE) {
        broadcast('player-ready');
        window.addEventListener('beforeunload', () => {
          broadcast('player-closed', { completed: state.completionSent });
        });
      } else {
        tryAcquireController();
      }
      schedule(300);
      log(IS_PLAYER_PAGE ? '学习页模式已启动' : '课程列表页模式已启动', CONFIG);
    } catch (error) {
      console.error('[保密网自动学习] 初始化失败：', error);
      window.alert(`保密网自动学习脚本初始化失败：${error?.message || error}`);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

