/**
 * 功能三：聊天视图窗口化 + 目录跳转
 *
 * 目标：让超长聊天也能秒开、并能任意跳转，思路与小说阅读器一致 —— 绝不把全部消息放进 DOM。
 *
 * 1. 只展示最新 N 楼：核心 printMessages() 本身就只渲染最后 N 条（N = power_user.chat_truncation）。
 *    但我们不去改这个字段 —— 它常被别的优化类扩展（如 cocktail 的首屏渲染条数）占用，抢字段会互相打架。
 *    改为：核心渲染完之后，我们立刻把窗口裁到 windowSize。
 * 2. 目录：直接扫描内存里的 chat 数组，取用户发言楼层作为章节（用户楼 + 回复楼）。
 * 3. 跳转：用核心导出的 redisplayChat() 渲染任意窗口 [k, k+N)，mesid 与真实索引一致，
 *    因此编辑、滑动、样式钉等交互全部照常。
 * 4. 滑动窗口：下滑追加后续 N 楼；向上由我们自己的「加载更早」按钮补；
 *    DOM 内消息数超过上限就从另一端裁掉，保证任何时刻 DOM 规模恒定。
 *
 * 注：顶部「加载更早」用的是自有 id（#stcv_show_more），而不是核心的 #show_more_messages。
 * 核心那个按钮被多个优化扩展监听（含「滚到顶部就自动加载」），跳转后必然停在顶部，
 * 会被它们立刻触发，把刚裁掉的旧楼层又灌回来。自有按钮既避免误触发，也让每次加载量可控。
 */

import { chat, chatElement, redisplayChat, updateMessageElement, refreshSwipeButtons, updateEditArrowClasses, updateViewMessageIds, animation_duration } from '../../../../script.js';
import { applyStylePins } from '../../../power-user.js';
import { settings } from './settings.js';
import { T, getContext } from './utils.js';

const SHOW_MORE_ID = 'stcv_show_more';

let scrollTicking = false;
let loading = false;

const view = () => settings.chatView;

/* ------------------------------------------------------------------ *
 * 窗口信息
 * ------------------------------------------------------------------ */

/** 当前 DOM 里已渲染的消息 id 范围 [first, last]，没有则返回 null */
function currentRange() {
    const ids = chatElement.find('.mes')
        .map((i, el) => Number(el.getAttribute('mesid')))
        .get()
        .filter(n => Number.isInteger(n));
    if (ids.length === 0) return null;
    return [Math.min(...ids), Math.max(...ids)];
}

function renderedCount() {
    return chatElement.find('.mes').length;
}

/** 统一顶部按钮状态：只保留我们自己的那个 */
function syncShowMoreButton() {
    if (!view().enabled) return;

    chatElement.find('#show_more_messages').remove();

    const range = currentRange();
    const need = Boolean(range && range[0] > 0);
    const has = chatElement.find(`#${SHOW_MORE_ID}`).length > 0;

    if (need && !has) {
        const $btn = $('<div id="stcv_show_more"></div>').text(T('Load earlier messages'));
        $btn.on('click', () => loadOlder());
        const first = chatElement.find('.mes').first();
        if (first.length) {
            first.before($btn);
        } else {
            chatElement.prepend($btn);
        }
    }
    if (!need && has) {
        chatElement.find(`#${SHOW_MORE_ID}`).remove();
    }
}

/**
 * 超过上限时从头部裁掉最老的，保证 DOM 规模恒定。
 * 删除头部会让内容整体上移，这里同步补偿 scrollTop，避免画面跳动。
 * @param {number} max 保留上限
 */
function trimTop(max = Math.max(view().windowSize, view().maxMessages)) {
    const el = chatElement[0];
    const prevHeight = el?.scrollHeight ?? 0;
    let count = renderedCount();
    let trimmed = false;

    while (count > max) {
        const first = chatElement.find('.mes').first();
        if (first.length === 0) break;
        first.remove();
        count--;
        trimmed = true;
    }

    if (trimmed && el) {
        el.scrollTop -= (prevHeight - el.scrollHeight);
    }
    syncShowMoreButton();
}

/** 向上加载后从尾部裁掉，避免窗口两端同时膨胀 */
function trimBottom() {
    const max = Math.max(view().windowSize, view().maxMessages);
    let count = renderedCount();
    while (count > max) {
        const last = chatElement.find('.mes').last();
        if (last.length === 0) break;
        last.remove();
        count--;
    }
    syncShowMoreButton();
}

/**
 * 打开/切换聊天后把窗口压到 windowSize，并滚到底部。
 * 核心（以及其他优化扩展）可能渲染了更多条，这里统一收到我们的窗口大小。
 */
function trimToWindow() {
    if (!view().enabled) return;
    const before = renderedCount();
    trimTop(view().windowSize);
    if (renderedCount() !== before) {
        getContext()?.scrollChatToBottom?.();
    }
}

/* ------------------------------------------------------------------ *
 * 渲染与跳转
 * ------------------------------------------------------------------ */

/**
 * 全量重渲染窗口：先清空再按真实 mesid 渲染 [start, start+windowSize)。
 *
 * 这是本模块**唯一**的重建入口。核心的 redisplayChat() 依赖「DOM 里存在 startIndex 那条消息」
 * 作为锚点来删除旧内容；窗口化后 DOM 里往往没有那个锚点，直接调用会把整段又追加一遍，
 * 造成同一楼层出现两次。所以这里必定先清空。
 *
 * @param {number} startId 起始消息 id（mesid）
 * @param {object} [options]
 * @param {'top'|'bottom'} [options.scroll] 渲染完滚到窗口顶部还是聊天底部
 */
async function renderWindow(startId, { scroll = 'top' } = {}) {
    const start = Math.max(0, Math.min(startId, Math.max(0, chat.length - 1)));
    const end = Math.min(start + view().windowSize, chat.length);

    chatElement.find('.mes').remove();
    chatElement.find('#show_more_messages').remove();
    chatElement.find(`#${SHOW_MORE_ID}`).remove();

    await redisplayChat({ targetChat: chat.slice(0, end), startIndex: start, fade: false });

    syncShowMoreButton();

    if (scroll === 'bottom') {
        getContext()?.scrollChatToBottom?.();
    } else {
        chatElement.find(`.mes[mesid="${start}"]`)[0]?.scrollIntoView({ block: 'start' });
    }
}

/** 回到最新窗口并滚到底部 */
async function jumpToLatest() {
    await renderWindow(Math.max(0, chat.length - view().windowSize), { scroll: 'bottom' });
}

/** 下滑到底时继续加载后续 N 楼，直到最新 */
async function loadNewer() {
    if (loading) return;
    const range = currentRange();
    if (!range) return;
    const nextStart = range[1] + 1;
    if (nextStart >= chat.length) return;

    loading = true;
    try {
        const nextEnd = Math.min(nextStart + view().windowSize, chat.length);
        const elements = [];
        for (let i = nextStart; i < nextEnd; i++) {
            elements.push(updateMessageElement(chat[i], { messageId: i })[0]);
        }
        chatElement.append(elements);
        refreshSwipeButtons(false, false);
        updateEditArrowClasses();
        applyStylePins();
        trimTop();
    } finally {
        loading = false;
    }
}

/**
 * 把窗口尾部补齐到 targetEnd（含）。
 * 删除楼层后窗口末尾会少一条，用增量追加补回来，比整个窗口重渲染便宜得多。
 * @param {number} targetEnd 要补到的消息 id
 */
async function fillTail(targetEnd) {
    if (loading) return;
    const range = currentRange();
    if (!range) return;
    const start = range[1] + 1;
    const end = Math.min(targetEnd + 1, chat.length);
    if (start >= end) return;

    loading = true;
    try {
        const elements = [];
        for (let i = start; i < end; i++) {
            elements.push(updateMessageElement(chat[i], { messageId: i })[0]);
        }
        chatElement.append(elements);
        refreshSwipeButtons(false, false);
        updateEditArrowClasses();
        applyStylePins();
        trimTop(view().windowSize);
    } finally {
        loading = false;
    }
}

/** 点击顶部按钮：向前加载 N 楼，并保持滚动位置不跳 */
async function loadOlder() {
    if (loading) return;
    const range = currentRange();
    if (!range || range[0] === 0) return;

    loading = true;
    try {
        const prevEnd = range[0];
        const prevStart = Math.max(0, prevEnd - view().windowSize);
        const prevHeight = chatElement.prop('scrollHeight') ?? 0;

        const elements = [];
        for (let i = prevStart; i < prevEnd; i++) {
            elements.push(updateMessageElement(chat[i], { messageId: i })[0]);
        }
        chatElement.find('.mes').first().before(elements);

        refreshSwipeButtons(false, false);
        updateEditArrowClasses();
        applyStylePins();

        const el = chatElement[0];
        if (el) {
            el.scrollTop += (el.scrollHeight - prevHeight);
        }

        trimBottom();
        if (range[0] === 0 || currentRange()?.[0] === 0) {
            chatElement.find(`#${SHOW_MORE_ID}`).remove();
        }
    } finally {
        loading = false;
    }
}

/* ------------------------------------------------------------------ *
 * 目录
 * ------------------------------------------------------------------ */

/** 章节 = 用户发言楼层 + 其回复楼层（下一楼若仍是用户发言，则该章只有一楼） */
function buildChapters() {
    const chapters = [];
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message?.is_user || message.is_system) continue;
        const nextIndex = i + 1;
        const hasReply = chat[nextIndex] && !chat[nextIndex].is_user;
        const preview = String(message.mes ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
        chapters.push({
            start: i,
            end: hasReply ? nextIndex : i,
            label: hasReply ? `#${i} + #${nextIndex}` : `#${i}`,
            preview: preview || '(空消息)',
        });
    }
    return chapters;
}

function openToc() {
    const context = getContext();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    const chapters = buildChapters();
    const range = currentRange();
    const activeStart = range ? range[0] : null;

    const $wrap = $('<div class="stcv_popup"></div>');
    const $title = $('<h3 class="stcv_title"></h3>').text(`${T('Chat chapters')}（${chapters.length}）`);
    const $search = $('<input>', {
        type: 'text',
        class: 'text_pole stcv_search',
        spellcheck: false,
        placeholder: T('Search chapters...'),
    }).attr('autocomplete', 'off');
    const $latest = $('<button class="stcv_latest menu_button"></button>').text(T('Jump to latest'));
    const $searchWrap = $('<div class="stcv_search_wrap"></div>')
        .append($('<i class="fa-solid fa-magnifying-glass stcv_search_icon"></i>'))
        .append($search);
    const $list = $('<div class="stcv_list"></div>');
    const $empty = $('<div class="stcv_empty"></div>').text(T('No matching chapters')).css('display', 'none');

    $wrap.append($title, $searchWrap, $latest, $list, $empty);

    const popup = new Popup($wrap, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: T('Close'),
        allowVerticalScrolling: true,
        animation: 'fast',
        onOpen: () => $search.trigger('focus'),
    });

    function jump(start) {
        popup.complete(POPUP_RESULT.AFFIRMATIVE);
        renderWindow(start);
    }

    function render() {
        const query = String($search.val() ?? '').trim().toLowerCase();
        $list.empty();
        let visible = 0;

        chapters.forEach(chapter => {
            if (query) {
                const haystack = `${chapter.label} ${chapter.preview}`.toLowerCase();
                if (!haystack.includes(query)) return;
            }
            const isActive = activeStart !== null && chapter.start <= activeStart && chapter.end >= activeStart;
            const $item = $('<div class="stcv_item"></div>')
                .attr({ tabindex: 0, 'data-start': chapter.start })
                .toggleClass('stcv_active', isActive);
            $item.append($('<span class="stcv_label"></span>').text(chapter.label));
            $item.append($('<span class="stcv_preview"></span>').text(chapter.preview));
            $item.on('click', () => jump(chapter.start));
            $list.append($item);
            visible++;
        });

        $empty.css('display', visible === 0 ? '' : 'none');
    }

    $search.on('input', render);
    $latest.on('click', () => {
        popup.complete(POPUP_RESULT.AFFIRMATIVE);
        jumpToLatest();
    });

    render();
    $list.find('.stcv_active').get(0)?.scrollIntoView({ block: 'center' });
    return popup.show();
}

/* ------------------------------------------------------------------ *
 * 魔法棒菜单入口
 * ------------------------------------------------------------------ */

function injectMenuItem() {
    if (document.getElementById('option_chat_toc')) return;
    const menu = document.getElementById('options');
    if (!menu) return;

    const item = document.createElement('a');
    item.id = 'option_chat_toc';
    item.className = 'interactable';
    item.tabIndex = 0;
    item.innerHTML = '<i class="fa-lg fa-solid fa-list-ul"></i><span data-i18n="Chat chapters">聊天目录</span>';
    item.addEventListener('click', () => {
        // 核心对 #options [id] 是直接绑定，后插入的项不会走核心处理，这里自己收菜单
        $('#options').fadeOut(animation_duration);
        openToc();
    });

    const anchor = document.getElementById('option_select_chat');
    if (anchor) {
        anchor.after(item);
    } else {
        menu.appendChild(item);
    }
}

function removeMenuItem() {
    document.getElementById('option_chat_toc')?.remove();
}

/**
 * 有些扩展（如菜单清理类）会重建魔法棒菜单，导致我们注入的项被冲掉。
 * 这里盯着菜单，发现项没了就补回来。
 */
let menuObserver = null;

function watchMenu() {
    if (menuObserver) return;
    const menu = document.getElementById('options');
    if (!menu) return;
    menuObserver = new MutationObserver(() => {
        if (view().enabled && !document.getElementById('option_chat_toc')) {
            injectMenuItem();
        }
    });
    menuObserver.observe(menu, { childList: true, subtree: true });
}

/* ------------------------------------------------------------------ *
 * 事件与生命周期
 * ------------------------------------------------------------------ */

function onScroll() {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
        scrollTicking = false;
        if (!view().enabled) return;
        const el = chatElement[0];
        if (!el) return;
        const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 200;
        if (nearBottom) {
            loadNewer();
        }
    });
}

let listenersBound = false;

function bindEvents() {
    if (listenersBound) return;
    listenersBound = true;

    chatElement.on('scroll', onScroll);

    const context = getContext();
    const eventTypes = context?.eventTypes ?? {};
    const eventSource = context?.eventSource;

    // 向上加载更早楼层后，从尾部裁掉多余的，防止窗口两端同时膨胀
    eventSource?.on(eventTypes.MORE_MESSAGES_LOADED, () => {
        if (!view().enabled) return;
        trimBottom();
    });

    // 收到新消息
    const onNewMessage = () => {
        if (!view().enabled) return;
        const range = currentRange();
        if (!range) return;

        // 停在旧楼层：按设置决定是否跳回最新
        if (range[1] < chat.length - 1) {
            if (view().autoJumpLatest) {
                jumpToLatest();
            } else {
                trimTop();
            }
            return;
        }

        // 已经在最新：核心刚把新消息追加好，这里只维持窗口规模，绝不重新渲染
        // （重渲染会把已有楼层再画一遍，正是「出现两条新输入」的原因）
        const el = chatElement[0];
        const atBottom = !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 400;
        trimTop(atBottom ? view().windowSize : Math.max(view().windowSize, view().maxMessages));
    };
    [eventTypes.MESSAGE_RECEIVED, eventTypes.MESSAGE_SENT].forEach(type => {
        if (type) eventSource?.on(type, onNewMessage);
    });

    // 删除楼层：核心删完会按 DOM 顺序重排 mesid，这里跟着校正一次并收口窗口，
    // 否则后续按 mesid 的编辑/滑动/续载全部会错位
    if (eventTypes.MESSAGE_DELETED) {
        eventSource?.on(eventTypes.MESSAGE_DELETED, () => {
            if (!view().enabled) return;
            const range = currentRange();
            if (!range) {
                syncShowMoreButton();
                return;
            }
            if (range[1] < chat.length - 1) {
                // 删掉一条后窗口尾部会缺一条。补一条要完整渲染一个气泡（比删除本身还贵），
                // 放到下一个事件循环再做，删除操作本身立刻返回，点击手感不拖泥带水。
                setTimeout(() => fillTail(chat.length - 1), 0);
                return;
            }
            // 窗口大小本来就合规就别动 DOM，省掉一次布局重排
            if (renderedCount() > view().windowSize) {
                trimTop(view().windowSize);
            } else {
                syncShowMoreButton();
            }
        });
    }

    // 切换/打开聊天：核心渲染完后把窗口压到 windowSize
    if (eventTypes.CHAT_CHANGED) {
        eventSource?.on(eventTypes.CHAT_CHANGED, () => {
            if (!view().enabled) return;
            // 让其它扩展的渲染逻辑先跑完
            setTimeout(trimToWindow, 0);
        });
    }
}

/** 应用聊天视图设置（可反复调用） */
export function applyChatView() {
    if (!view().enabled) {
        removeMenuItem();
        // 交还给核心：移除我们的按钮，把核心那个补回来（如果窗口不是从第 0 楼开始）
        chatElement.find(`#${SHOW_MORE_ID}`).remove();
        const range = currentRange();
        if (range && range[0] > 0 && chatElement.find('#show_more_messages').length === 0) {
            chatElement.prepend('<div id="show_more_messages">Show more messages</div>');
        }
        return;
    }

    injectMenuItem();
    watchMenu();
    bindEvents();
    syncShowMoreButton();
    trimToWindow();
}

/** 初始化聊天视图与目录 */
export function initChatView() {
    applyChatView();
}

/** 供测试/外部调用 */
export const chatViewApi = { renderWindow, jumpToLatest, loadNewer, loadOlder, openToc, buildChapters, currentRange, renderedCount };
