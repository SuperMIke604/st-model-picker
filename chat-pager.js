/**
 * 功能三 C：分页阅读（paged）
 *
 * 起点中文网网页版那种读法：把整段聊天按固定楼数切成若干页，一次只渲染当前页。
 *
 * 翻页条（目录 / 上一页 / 第 X / Y 页 / 下一页 / 最新）插在 #chat 之后、#form_sheld 之前，
 * 但**默认隐藏**，不占任何布局高度；底部栏魔法棒菜单里只注入一个开关项，
 * 点一下唤出翻页条，再点一下收起（状态持久化在 settings.chatView.pagerVisible）。
 *
 * 为什么它比虚拟化更稳：
 * 虚拟化要用估算高度撑滚动条，未实测的楼层只能猜，拖动时必然出现漂移和回弹；
 * 分页里每一页都是真实内容、真实滚动条，页与页之间只是整页替换，
 * 不存在「猜高度」这个环节，跳转永远精确落在目标楼。
 *
 * 关键取舍：
 * 1. **DOM 里始终只有一页**。页数再多，DOM 规模恒等于 pageSize（默认 20 楼），
 *    所以 800 楼和 8000 楼的打开速度、删除速度完全一样。
 * 2. **翻页条放在 #chat 外面**（插在 #chat 之后、#form_sheld 之前）。
 *    放里面会随聊天内容一起滚走，滚到页中间就看不见了。
 * 3. **翻页条默认收起**。常驻会永久占掉聊天区下方一条高度，窄屏尤其碍事；
 *    收进魔法棒菜单后聊天区完整，代价是翻页要多点一次。隐藏只是 display:none，
 *    换页 / 收发消息 / 删除 / 切聊天的逻辑照常跑，页码在唤出的那一刻就是最新的。
 * 4. **第 0 楼不占名额**。第 0 楼是角色开场白 / 系统首条，它额外附在第一页顶部，
 *    不占用每页的名额：每页 10 楼时，第 1 页是 0–10（11 条），第 2 页是 11–20，
 *    第 3 页是 21–30，以此类推。用户的原始要求就是「0 层不参与排序」。
 * 5. **仍然用核心的 redisplayChat() 产出气泡**，mesid 与真实索引一致，
 *    编辑、滑动、样式钉、以及依赖 .mes 结构的扩展照常工作。
 * 6. **清空再渲染**。核心 redisplayChat 依赖 DOM 里存在 startIndex 锚点来删除旧内容，
 *    换页后锚点不在，不清空会把整段再追加一遍（表现为同一楼层出现两次）。
 * 7. **菜单项要自己收起**。核心只对 #options 里原有的 [id] 做原生绑定，
 *    后插入的项不走核心处理，所以点击后要手动 fadeOut，否则菜单会一直挂着。
 */

import { chat, chatElement, redisplayChat, refreshSwipeButtons, updateEditArrowClasses, animation_duration } from '../../../../script.js';
import { applyStylePins } from '../../../power-user.js';
import { settings } from './settings.js';
import { T, getContext } from './utils.js';

const PAGER_ID = 'stcv_pager';
/** 魔法棒菜单里的翻页条开关项 */
const TOGGLE_ID = 'option_stcv_pager_toggle';
/** 魔法棒菜单容器 */
const MENU_CONTAINER_ID = 'options';
/** 开关项的插入锚点：贴在「选择聊天」后面 */
const ANCHOR_IDS = ['option_select_chat'];

const view = () => settings.chatView;
const isActive = () => view().enabled;
/** 翻页条当前是否可见（持久化在设置里） */
const isBarVisible = () => Boolean(view().pagerVisible);

/** 每页楼数，至少 1 */
const pageSize = () => Math.max(1, Number(view().pageSize) || 20);

/**
 * 总页数，至少 1。
 * 第 0 楼额外附在第一页、不占名额，所以正文数量是 len - 1：
 * 第一页放 min(size, content) 条正文，剩下的按 size 切。
 */
function pageCount() {
    const len = chat.length;
    if (len <= 1) return 1;
    const size = pageSize();
    const content = len - 1;
    const first = Math.min(size, content);
    return 1 + Math.ceil(Math.max(0, content - first) / size);
}

/**
 * 第 p 页的消息索引区间 [start, end)。
 * p = 0 时从 0 楼开始、放 size + 1 条（0 楼 + size 条正文）；
 * p ≥ 1 时从 1 + p * size 开始、放 size 条。
 * end 用 Math.max 兜底：总楼数变少时（例如删到只剩几条）不会算出 start > end 的反向区间。
 */
function pageRange(p) {
    const size = pageSize();
    const start = p <= 0 ? 0 : 1 + p * size;
    const count = p <= 0 ? 1 + size : size;
    const end = Math.max(start, Math.min(start + count, chat.length));
    return [start, end];
}

function clampPage(p) {
    return Math.max(0, Math.min(p, pageCount() - 1));
}

/**
 * 消息索引 → 所在页码（0 起）。
 * 第 0 楼和紧随其后的第一页正文都落在第 0 页，所以 1 楼起才参与「每页楼数」的除法：
 * index ≤ 0 → 第 0 页；否则 floor((index - 1) / size)。
 */
function pageOfIndex(index) {
    if (index <= 0) return 0;
    return clampPage(Math.floor((index - 1) / pageSize()));
}

/** 当前页码（0 起） */
let currentPage = 0;
/** 翻页条 jQuery 对象（隐藏时仍在 DOM 里，只是 display:none） */
let $bar = null;
let rendering = false;
let listenersBound = false;

/** 正在注入菜单项的标志：避免自己的 DOM 改动触发 observer 递归补项 */
let injecting = false;
/** 盯着 #options 的观察器：别的扩展重建菜单后把开关项补回来 */
let menuObserver = null;

/**
 * 「读者是否停在页尾」的标志。
 * 不能在新消息到达时现算 —— 那时气泡已经追加进 DOM，scrollHeight 变大，
 * 现算会得到「不在底部」。这里靠 scroll 事件持续维护，新消息到达时读到的就是追加前的状态。
 */
let atBottomFlag = true;

function isAtBottom() {
    const el = chatElement[0];
    return !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 120;
}

function scrollToEnd() {
    const el = chatElement[0];
    if (el) el.scrollTop = el.scrollHeight;
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/**
 * 渲染第 p 页。
 * 这是分页模式**唯一**的重建入口，换页、跳转、删除后校正全都走这里。
 *
 * @param {number} p 页码（0 起），越界会被夹到有效范围
 * @param {object} [options]
 * @param {'top'|'bottom'} [options.scroll] 渲染完滚到页顶还是页底
 */
async function renderPage(p, { scroll = 'top' } = {}) {
    if (rendering) return;
    rendering = true;
    try {
        currentPage = clampPage(p);
        const [start, end] = pageRange(currentPage);

        chatElement.find('.mes').remove();
        chatElement.find('#show_more_messages').remove();
        chatElement.find('#stcv_show_more').remove();

        await redisplayChat({ targetChat: chat.slice(0, end), startIndex: start, fade: false });

        refreshSwipeButtons(false, false);
        updateEditArrowClasses();
        applyStylePins();

        const el = chatElement[0];
        if (el) {
            // 末页就是「最新」，停在底部才符合聊天的阅读习惯，跟点「最新」的落点一致
            const toBottom = scroll === 'bottom' || currentPage >= pageCount() - 1;
            el.scrollTop = toBottom ? el.scrollHeight : 0;
            atBottomFlag = toBottom;
        }
        updateBar();
    } finally {
        rendering = false;
    }
}

function renderedCount() {
    return chatElement.find('.mes').length;
}

/** 当前页按数学应该有多少条（第 0 页多带一个 0 楼） */
function expectedCount() {
    const [start, end] = pageRange(currentPage);
    return end - start;
}

/* ------------------------------------------------------------------ *
 * 翻页条
 * ------------------------------------------------------------------ */

function ensureBar() {
    if ($bar && $bar[0]?.isConnected) return $bar;

    $bar = $(`<div id="${PAGER_ID}" class="stcv_pager"></div>`);
    $bar.append($('<div class="stcv_page_btn menu_button" data-act="toc"></div>')
        .html(`<i class="fa-solid fa-list-ul"></i> ${T('TOC')}`));
    $bar.append($('<div class="stcv_page_btn menu_button" data-act="prev"></div>').text(T('Previous page')));
    $bar.append($('<span class="stcv_page_info"></span>'));
    $bar.append($('<div class="stcv_page_btn menu_button" data-act="next"></div>').text(T('Next page')));
    $bar.append($('<div class="stcv_page_btn menu_button stcv_page_latest" data-act="latest"></div>').text(T('Jump to latest')));

    $bar.on('click', '.stcv_page_btn', async function () {
        if ($(this).hasClass('stcv_disabled')) return;
        const act = $(this).attr('data-act');
        if (act === 'prev') renderPage(currentPage - 1);
        else if (act === 'next') renderPage(currentPage + 1);
        else if (act === 'latest') goLatest();
        else if (act === 'toc') {
            // 目录实现在 chat-toc.js 里，那里静态引入了本模块，这里反过来动态取，避免循环依赖
            const toc = await import('./chat-toc.js');
            toc.chatViewApi.openToc();
        }
    });

    // 插到 #chat 之后：放在里面会随聊天内容滚走
    chatElement.after($bar);
    return $bar;
}

/**
 * 应用显隐状态。
 * 隐藏用 display:none（jQuery toggle），不是 detach —— 翻页条还在 DOM 里，
 * 页码照常刷新，唤出来的那一刻显示的就是最新值，同时完全不占布局高度。
 */
function applyBarVisibility() {
    if ($bar) $bar.toggle(isBarVisible());
    updateToggleItem();
}

/** 刷新页码、楼层范围与按钮可用状态（隐藏时同样要刷，保证唤出即正确） */
function updateBar() {
    const bar = $bar?.[0];
    if (!bar) return;

    const pages = pageCount();
    const [start, end] = pageRange(currentPage);
    const info = bar.querySelector('.stcv_page_info');
    if (info) {
        const range = end > start ? `#${start}–#${end - 1}` : '—';
        info.textContent = `${T('Page {0} / {1}', currentPage + 1, pages)}  ·  ${range}  ·  ${chat.length} ${T('messages')}`;
    }

    const atFirst = currentPage <= 0;
    const atLast = currentPage >= pages - 1;
    bar.querySelector('[data-act="prev"]')?.classList.toggle('stcv_disabled', atFirst);
    bar.querySelector('[data-act="next"]')?.classList.toggle('stcv_disabled', atLast);
    bar.querySelector('[data-act="latest"]')?.classList.toggle('stcv_disabled', atLast);
}

/**
 * 设置翻页条显隐并持久化。
 * @param {boolean} visible 是否显示
 * @param {object} [options]
 * @param {boolean} [options.save] 是否落盘（默认 true）
 */
function setBarVisible(visible, { save = true } = {}) {
    view().pagerVisible = Boolean(visible);
    applyBarVisibility();
    if (save) {
        getContext()?.saveSettingsDebounced?.();
    }
}

/* ------------------------------------------------------------------ *
 * 魔法棒菜单：翻页条开关
 * ------------------------------------------------------------------ */

/** 开关项文字：显示时是「隐藏翻页条」，隐藏时是「显示翻页条」 */
function toggleText() {
    return isBarVisible() ? T('Hide pager bar') : T('Show pager bar');
}

/** 当前该挂在谁后面 */
function anchorIdFor() {
    return ANCHOR_IDS.find(id => document.getElementById(id)) ?? null;
}

/** 把开关项补进魔法棒菜单（幂等） */
function ensureToggleItem() {
    if (injecting) return;
    injecting = true;
    try {
        const menu = document.getElementById(MENU_CONTAINER_ID);
        if (!menu) return;
        if (document.getElementById(TOGGLE_ID)) {
            updateToggleItem();
            return;
        }

        const item = document.createElement('a');
        item.id = TOGGLE_ID;
        item.className = 'interactable stcv_menu_item';
        item.tabIndex = 0;
        item.innerHTML = '<i class="fa-lg fa-solid fa-bars"></i><span></span>';
        item.querySelector('span').textContent = toggleText();
        // 核心只对菜单里原有的 [id] 做原生绑定，后插入的项不走核心处理，这里自己收菜单
        item.addEventListener('click', () => {
            $('#options').fadeOut(animation_duration);
            setBarVisible(!isBarVisible());
        });

        const anchorEl = anchorIdFor() ? document.getElementById(anchorIdFor()) : null;
        if (anchorEl && menu.contains(anchorEl)) {
            anchorEl.after(item);
        } else {
            menu.appendChild(item);
        }
    } finally {
        injecting = false;
    }
}

/** 同步开关项文字（显隐状态可能被别处改过） */
function updateToggleItem() {
    const label = document.querySelector(`#${TOGGLE_ID} span`);
    if (label) label.textContent = toggleText();
}

function removeToggleItem() {
    document.getElementById(TOGGLE_ID)?.remove();
}

/**
 * 有些扩展会重建魔法棒菜单，把我们注入的开关项冲掉。
 * 这里盯着菜单，发现项没了就补回来（文字按当前显隐状态渲染）。
 */
function watchMenu() {
    if (menuObserver) return;
    const menu = document.getElementById(MENU_CONTAINER_ID);
    if (!menu) return;
    menuObserver = new MutationObserver(() => {
        if (injecting || !isActive()) return;
        if (!document.getElementById(TOGGLE_ID)) ensureToggleItem();
    });
    menuObserver.observe(menu, { childList: true, subtree: true });
}

function stopWatchMenu() {
    menuObserver?.disconnect();
    menuObserver = null;
}

/* ------------------------------------------------------------------ *
 * 对外：跳转
 * ------------------------------------------------------------------ */

/** 跳到最后一页并停在底部 */
async function goLatest() {
    if (chat.length === 0) return;
    await renderPage(pageCount() - 1, { scroll: 'bottom' });
}

/**
 * 跳到指定楼层所在的页，并把该楼对齐到页顶。
 * @param {number} index 消息索引（mesid）
 */
async function goToIndex(index) {
    if (chat.length === 0) return;
    const target = Math.max(0, Math.min(index, chat.length - 1));
    await renderPage(pageOfIndex(target), { scroll: 'top' });
    chatElement.find(`.mes[mesid="${target}"]`)[0]?.scrollIntoView({ block: 'start' });
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

/** 打开/切换聊天：停在最后一页底部 */
async function onChatChanged() {
    if (!isActive()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
    if (!isActive()) return;
    await goLatest();
}

/**
 * 新消息。
 * 停在最后一页时核心已经把新气泡 append 好了，只要它没把这一页撑爆就不用重渲染
 * （重渲染会把已有楼层再画一遍，正是「出现两条新输入」的原因）。
 */
function onNewMessage() {
    if (!isActive()) return;
    const pages = pageCount();
    const atLast = currentPage >= pages - 1;

    if (!atLast) {
        if (view().autoJumpLatest) {
            goLatest();
        } else {
            // 停在旧页：核心照样会把新气泡 append 进 DOM，先摘掉不属于本页的那条，
            // 再刷新页码（总页数变了；翻页条可能正藏着，也得刷）
            // 注：核心追加后还会把 #chat 滚到页尾（script.js 的 doScroll，晚于本处理器约 9ms），
            // 这是核心自己的行为，本模块不去抢，读者仍停在原来那一页。
            pruneOutOfPageMessages();
            updateBar();
        }
        return;
    }

    if (renderedCount() > expectedCount()) {
        // 最后一页正好满了，新消息会开一个新页
        goLatest();
        return;
    }

    updateBar();
    // 本来就在页尾看着，新消息追加后把它带进视野
    // （核心的 scrollChatToBottom 受「自动滚动到底」开关控制，这里自己兜底）
    if (atBottomFlag) {
        scrollToEnd();
    }
}

/**
 * 把不属于当前页的气泡从 DOM 里摘掉，维持「DOM 里始终只有当前一页」的不变量。
 *
 * 为什么需要：停在旧页、且关掉了「自动跳回最新」时，核心的 addOneMessage 仍会把新气泡
 * append 到 #chat 末尾 —— 那是一条不属于当前页的 mesid。留着它有两个后果：
 * 1. 读者正在读第 10 页，画面下方却凭空多出一个最新回复的气泡；
 * 2. domRange() 与当前页区间不再吻合，之后删除楼层会被 onMessageDeleted 判成
 *    「区间不吻合」而整页重渲染，表现为画面闪一下。
 *
 * 所以这里只摘越界的那几条，不重渲染、不动 currentPage —— 保持旧页的阅读位置不动，
 * 这正是 autoJumpLatest = false 的语义。正常情况下一个气泡都不该被摘，返回 0。
 *
 * @returns {number} 被摘掉的气泡数
 */
function pruneOutOfPageMessages() {
    const [start, end] = pageRange(currentPage);
    const stray = chatElement.find('.mes').filter(function () {
        const id = Number(this.getAttribute('mesid'));
        return !Number.isInteger(id) || id < start || id >= end;
    });
    const count = stray.length;
    if (count > 0) stray.remove();
    return count;
}

/** DOM 里现有消息的 id 区间，没有则返回 null */
function domRange() {
    const ids = chatElement.find('.mes')
        .map((i, el) => Number(el.getAttribute('mesid')))
        .get()
        .filter(Number.isInteger)
        .sort((a, b) => a - b);
    if (ids.length === 0) return null;
    return [ids[0], ids[ids.length - 1]];
}

/**
 * 删除楼层：索引整体位移，而且核心会顺手重排一次 DOM（渲染最后 N 条），
 * 所以不能只看条数对不对 —— 必须核对 DOM 里的区间还是不是当前页，
 * 对不上就整页重渲染，避免「页码写着 #800–#802，画面上却是 #783 起」。
 * 只有区间仍然吻合时才跳过重渲染，保证点击手感。
 */
function onMessageDeleted() {
    if (!isActive()) return;
    const pages = pageCount();
    if (currentPage > pages - 1) currentPage = pages - 1;

    const [start, end] = pageRange(currentPage);
    const range = domRange();
    const matches = range !== null && range[0] === start && range[1] === end - 1;

    if (matches) {
        updateBar();
    } else {
        renderPage(currentPage, { scroll: currentPage >= pages - 1 ? 'bottom' : 'top' });
    }
}

function bindEvents() {
    if (listenersBound) return;
    listenersBound = true;

    const context = getContext();
    const eventTypes = context?.eventTypes ?? {};
    const eventSource = context?.eventSource;

    // 维护「停在页尾」标志，供新消息到达时判断要不要跟到底部
    chatElement.on('scroll', () => { atBottomFlag = isAtBottom(); });

    [eventTypes.MESSAGE_RECEIVED, eventTypes.MESSAGE_SENT].forEach(type => {
        if (type) eventSource?.on(type, onNewMessage);
    });
    if (eventTypes.MESSAGE_DELETED) {
        eventSource?.on(eventTypes.MESSAGE_DELETED, onMessageDeleted);
    }
    if (eventTypes.CHAT_CHANGED) {
        eventSource?.on(eventTypes.CHAT_CHANGED, () => { onChatChanged(); });
    }
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

/** 退出分页模式：撤掉菜单项、翻页条与观察器（幂等） */
export function teardownPaged() {
    stopWatchMenu();
    removeToggleItem();
    $bar?.remove();
    $bar = null;
}

/** 应用分页设置（可反复调用） */
export function applyChatPaged() {
    if (!isActive()) {
        teardownPaged();
        return;
    }
    ensureBar();
    ensureToggleItem();
    watchMenu();
    bindEvents();
    applyBarVisibility();
    updateBar();

    // 已经在看某页（例如刚改了每页楼数）就原地重渲染，别把读者甩到最新；
    // 首次进入、或切模式过来 DOM 里没有内容时才跳最后一页
    if (chat.length > 0 && renderedCount() > 0) {
        renderPage(currentPage, { scroll: 'top' });
    } else {
        goLatest();
    }
}

/** 供测试/外部调用 */
export const pagerApi = {
    renderPage,
    goLatest,
    goToIndex,
    updateBar,
    setBarVisible,
    isBarVisible,
    pageCount,
    pageRange,
    pageOfIndex,
    pageSize,
    currentPage: () => currentPage,
};
