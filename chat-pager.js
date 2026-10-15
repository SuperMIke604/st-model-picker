/**
 * 功能三 C：分页阅读（paged）
 *
 * 起点中文网网页版那种读法：把整段聊天按固定楼数切成若干页，一次只渲染当前页，
 * 底部常驻翻页条「上一页 / 第 X / Y 页 / 下一页 / 最新」。
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
 * 3. **仍然用核心的 redisplayChat() 产出气泡**，mesid 与真实索引一致，
 *    编辑、滑动、样式钉、以及依赖 .mes 结构的扩展照常工作。
 * 4. **清空再渲染**。核心 redisplayChat 依赖 DOM 里存在 startIndex 锚点来删除旧内容，
 *    换页后锚点不在，不清空会把整段再追加一遍（表现为同一楼层出现两次）。
 */

import { chat, chatElement, redisplayChat, refreshSwipeButtons, updateEditArrowClasses } from '../../../../script.js';
import { applyStylePins } from '../../../power-user.js';
import { settings } from './settings.js';
import { T, getContext } from './utils.js';

const PAGER_ID = 'stcv_pager';

const view = () => settings.chatView;
const isActive = () => view().enabled && view().mode === 'paged';

/** 每页楼数，至少 1 */
const pageSize = () => Math.max(1, Number(view().pageSize) || 20);
/** 总页数，至少 1 */
const pageCount = () => Math.max(1, Math.ceil(chat.length / pageSize()));

/** 当前页码（0 起） */
let currentPage = 0;
/** 翻页条 jQuery 对象 */
let $bar = null;
let rendering = false;
let listenersBound = false;

/* ------------------------------------------------------------------ *
 * 页区间
 * ------------------------------------------------------------------ */

/** 第 p 页的消息索引区间 [start, end) */
function pageRange(p) {
    const size = pageSize();
    const start = p * size;
    return [start, Math.min(start + size, chat.length)];
}

function clampPage(p) {
    return Math.max(0, Math.min(p, pageCount() - 1));
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
        }
        updateBar();
    } finally {
        rendering = false;
    }
}

/* ------------------------------------------------------------------ *
 * 翻页条
 * ------------------------------------------------------------------ */

function ensureBar() {
    if ($bar && $bar[0]?.isConnected) return $bar;

    $bar = $(`<div id="${PAGER_ID}" class="stcv_pager"></div>`);
    $bar.append($('<div class="stcv_page_btn menu_button" data-act="prev"></div>').text(T('Previous page')));
    $bar.append($('<span class="stcv_page_info"></span>'));
    $bar.append($('<div class="stcv_page_btn menu_button" data-act="next"></div>').text(T('Next page')));
    $bar.append($('<div class="stcv_page_btn menu_button stcv_page_latest" data-act="latest"></div>').text(T('Jump to latest')));

    $bar.on('click', '.stcv_page_btn', function () {
        if ($(this).hasClass('stcv_disabled')) return;
        const act = $(this).attr('data-act');
        if (act === 'prev') renderPage(currentPage - 1);
        else if (act === 'next') renderPage(currentPage + 1);
        else if (act === 'latest') goLatest();
    });

    // 插到 #chat 之后：放在里面会随聊天内容滚走
    chatElement.after($bar);
    return $bar;
}

/** 刷新页码、楼层范围与按钮可用状态 */
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

function renderedCount() {
    return chatElement.find('.mes').length;
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
    const page = Math.floor(target / pageSize());
    await renderPage(page, { scroll: 'top' });
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
            // 停在旧页：总页数变了，刷新页码即可
            updateBar();
        }
        return;
    }

    if (renderedCount() > pageSize()) {
        // 最后一页正好满了，新消息会开一个新页
        goLatest();
    } else {
        updateBar();
    }
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

/** 退出分页模式时把翻页条撤掉 */
export function teardownPaged() {
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
    bindEvents();
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
    pageCount,
    currentPage: () => currentPage,
};
