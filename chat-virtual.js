/**
 * 功能三 B：虚拟化聊天渲染（virtual scroll）
 *
 * 与窗口模式（chat-toc.js）的区别：窗口模式只渲染「最新 N 楼」，滚动条因此只有 N 楼的长度，
 * 拖不动、也跳不到远处；虚拟化模式用上下占位元素把完整高度撑出来，滚动条覆盖全部楼层，
 * DOM 里始终只有视口附近那几条。思路与小说阅读器一致 —— 排版/测量与挂载解耦。
 *
 * 关键取舍：
 * 1. **不自己造 .mes 的 DOM**。消息气泡仍由核心的 updateMessageElement() 产出，
 *    这样所有依赖 .mes 结构的扩展（data_table / cocktail / JS-Slash-Runner …）照常工作。
 *    我们只决定「哪几条在 DOM 里」和「上下各补多高」。
 * 2. **用占位元素而不是 padding**。#chat 是 display:flex 的滚动容器，给它加 padding 会把
 *    容器自身撑大（实测 clientHeight 从 399 变成十万级），视口高度彻底失真、布局也被撑坏。
 *    占位元素是 flex item，不改变容器高度，内容照常溢出滚动。
 * 3. **高度不必一开始就知道**。没量过的消息先估算，进入视口后实测回填，
 *    并同步补偿 scrollTop，避免画面跳动。实测值按消息对象存进 WeakMap，
 *    所以删除楼层导致索引位移后，缓存依然命中。
 */

import { chat, chatElement, updateMessageElement, refreshSwipeButtons, updateEditArrowClasses } from '../../../../script.js';
import { applyStylePins } from '../../../power-user.js';
import { settings } from './settings.js';
import { getContext } from './utils.js';

/** 核心给 #chat 的上下 padding，内容坐标要减掉它 */
const BASE_PAD = 10;
/** 视口上下各多挂载几屏，避免滚动时白屏 */
const BUFFER_SCREENS = 1.2;

const view = () => settings.chatView;
const isActive = () => view().enabled && view().mode === 'virtual';
const messageCount = () => chat.length;

/* ------------------------------------------------------------------ *
 * 高度索引
 * ------------------------------------------------------------------ */

/** 实测高度缓存：按消息对象存，删除楼层导致索引位移后依然命中 */
const measured = new WeakMap();

/** @type {number[]} 与 chat 等长；未实测的项是估算值 */
let heights = [];
/** @type {number[]} 前缀和，offsets[i] = 前 i 条消息的总高 */
let offsets = [];
let dirty = true;
/**
 * heights 是否与当前 chat 完全对齐。
 * 不能用「长度相等」判断：measureInto() 给空数组的高索引赋值会把数组撑成长度 N 的稀疏数组
 * （中间全是空洞），长度看着对齐了，实际大部分是 undefined，前缀和会算成 NaN。
 */
let heightsValid = false;

/** @type {Map<number, HTMLElement>} 当前挂载在 DOM 里的消息 */
let mounted = new Map();

/** 上下占位元素 */
let topSpacer = null;
let bottomSpacer = null;
let spacerTop = 0;

let syncing = false;
let scrollTicking = false;
let resizeObserver = null;
let resizeTicking = false;
let listenersBound = false;

/** 实测样本：字符数总和 / 高度总和，用来校准估算 */
let sampleChars = 0;
let sampleHeights = 0;

function recordSample(mes, h) {
    const len = String(mes?.mes ?? '').length;
    if (len === 0 || !(h > 0)) return;
    sampleChars += len;
    sampleHeights += h;
}

/**
 * 未实测消息的估算高度。
 * 有实测样本之后改用「每字符平均高度」估算，比固定行高准得多 ——
 * 估算越准，未挂载楼层造成的滚动条漂移就越小。
 */
function estimateHeight(mes) {
    const len = String(mes?.mes ?? '').length;
    if (sampleChars > 0 && sampleHeights > 0) {
        const perChar = sampleHeights / sampleChars;
        return Math.max(70, 56 + len * perChar);
    }
    const lines = Math.max(1, Math.ceil(len / 45));
    return 78 + lines * 25;
}

/** 保证 heights 与 chat 等长；新出现的消息优先用缓存的实测值，其次保留旧值，最后估算 */
function ensureHeights() {
    const len = messageCount();
    if (heightsValid && heights.length === len) return;

    const next = new Array(len);
    for (let i = 0; i < len; i++) {
        const cached = measured.get(chat[i]);
        if (typeof cached === 'number' && cached > 0) {
            next[i] = cached;
        } else if (typeof heights[i] === 'number' && heights[i] > 0) {
            next[i] = heights[i];
        } else {
            next[i] = estimateHeight(chat[i]);
        }
    }
    heights = next;
    heightsValid = true;
    dirty = true;
}

function recomputeOffsets() {
    if (!dirty) return;
    const len = heights.length;
    offsets = new Array(len + 1);
    offsets[0] = 0;
    for (let i = 0; i < len; i++) {
        offsets[i + 1] = offsets[i] + heights[i];
    }
    dirty = false;
}

function totalHeight() {
    recomputeOffsets();
    return offsets[offsets.length - 1] ?? 0;
}

/** 高度 y（内容坐标）落在第几条消息里 */
function indexAt(y) {
    recomputeOffsets();
    const len = heights.length;
    if (len === 0) return 0;
    let lo = 0;
    let hi = offsets.length - 1;
    const clamped = Math.max(0, Math.min(y, Math.max(0, offsets[hi] - 1)));
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offsets[mid] <= clamped) lo = mid; else hi = mid - 1;
    }
    return Math.min(lo, len - 1);
}

/* ------------------------------------------------------------------ *
 * 挂载与卸载
 * ------------------------------------------------------------------ */

function measureInto(id, el) {
    if (!Number.isInteger(id) || id < 0 || id >= messageCount()) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0 && chat[id]) {
        const changed = Math.abs(h - heights[id]) > 0.5;
        // 只统计第一次量到的值，避免同一条反复计入把平均值带偏
        if (measured.get(chat[id]) === undefined) recordSample(chat[id], h);
        measured.set(chat[id], h);
        heights[id] = h;
        if (changed) dirty = true;
    }
}

/** 扫描 DOM 里已有的 .mes（核心或其它扩展刚渲染的），登记到 mounted */
function collectExisting() {
    chatElement.find('.mes').each((i, el) => {
        const id = Number(el.getAttribute('mesid'));
        if (!Number.isInteger(id) || mounted.has(id)) return;
        mounted.set(id, el);
        measureInto(id, el);
    });
}

/** 清掉已经被外部（核心重渲染、删除楼层）移出 DOM 的失效引用 */
function pruneDetached() {
    for (const [id, el] of Array.from(mounted)) {
        if (!el.isConnected) mounted.delete(id);
    }
}

async function emitRendered(id) {
    const context = getContext();
    const type = chat[id]?.is_user ? context?.eventTypes?.USER_MESSAGE_RENDERED : context?.eventTypes?.CHARACTER_MESSAGE_RENDERED;
    if (!type || !context?.eventSource) return;
    // 扩展靠这个事件装饰消息（按钮注入、表格、翻译等），虚拟化下必须补发，
    // 否则滚到旧楼层时这些装饰不会出现
    await context.eventSource.emit(type, id);
}

/** 把 [first, last] 内缺失的消息挂到 DOM，并保持 mesid 升序 */
async function mountRange(first, last) {
    const pending = [];
    for (let i = first; i <= last; i++) {
        if (!mounted.has(i) && chat[i]) pending.push(i);
    }
    if (pending.length === 0) return false;

    for (const i of pending) {
        const el = updateMessageElement(chat[i], { messageId: i })[0];
        if (!el) continue;

        let placed = false;
        for (let j = i - 1; j >= 0; j--) {
            const prev = mounted.get(j);
            if (prev && prev.isConnected) { prev.after(el); placed = true; break; }
        }
        if (!placed) {
            for (let j = i + 1; j < messageCount(); j++) {
                const next = mounted.get(j);
                if (next && next.isConnected) { next.parentNode?.insertBefore(el, next); placed = true; break; }
            }
        }
        // 兜底：插到下占位之前。不能直接 append，那样会跑到占位元素后面
        if (!placed) {
            if (bottomSpacer?.isConnected) bottomSpacer.parentNode?.insertBefore(el, bottomSpacer);
            else chatElement[0].append(el);
        }

        mounted.set(i, el);
        measureInto(i, el);
    }

    for (const i of pending) {
        await emitRendered(i);
    }

    refreshSwipeButtons(false, false);
    updateEditArrowClasses();
    applyStylePins();
    return true;
}

/** 卸载区间外的消息，卸载前先量一次真实高度 */
function unmountOutside(first, last) {
    let changed = false;
    for (const [id, el] of Array.from(mounted)) {
        if (id < first || id > last) {
            measureInto(id, el);
            el.remove();
            mounted.delete(id);
            changed = true;
        }
    }
    return changed;
}

/* ------------------------------------------------------------------ *
 * 占位与滚动位置补偿
 * ------------------------------------------------------------------ */

/** 保证上下占位存在，且下占位一定在最后（核心 append 新消息会跑到它后面） */
function ensureSpacers() {
    const el = chatElement[0];
    if (!el) return;

    if (!topSpacer || !topSpacer.isConnected) {
        topSpacer = document.createElement('div');
        topSpacer.id = 'stvv_top_spacer';
        topSpacer.className = 'stvv_spacer';
        el.prepend(topSpacer);
    }
    if (!bottomSpacer || !bottomSpacer.isConnected) {
        bottomSpacer = document.createElement('div');
        bottomSpacer.id = 'stvv_bottom_spacer';
        bottomSpacer.className = 'stvv_spacer';
        el.append(bottomSpacer);
    }
    // 每次都挪一次，把核心刚 append 的消息重新压到占位之前
    el.append(bottomSpacer);
}

/**
 * 用上下占位把「没挂载的那些楼层」的高度补出来。
 * 上占位高度变化时同步补偿 scrollTop，这样视口里看到的那条消息不会上下跳。
 */
function updateSpacers({ compensate = true, first, last } = {}) {
    const el = chatElement[0];
    if (!el) return;
    ensureSpacers();

    if (typeof first !== 'number' || typeof last !== 'number') {
        let f = Infinity;
        let l = -1;
        for (const id of mounted.keys()) {
            if (id < f) f = id;
            if (id > l) l = id;
        }
        if (f === Infinity) f = 0;
        first = f;
        last = l;
    }

    recomputeOffsets();
    const nextTop = offsets[first] ?? 0;
    const nextBottom = Math.max(0, totalHeight() - (offsets[last + 1] ?? 0));
    const delta = nextTop - spacerTop;

    topSpacer.style.height = `${nextTop}px`;
    bottomSpacer.style.height = `${nextBottom}px`;
    spacerTop = nextTop;

    if (compensate && Math.abs(delta) > 0.5) {
        el.scrollTop += delta;
    }
}

/** 视口上下各留一段缓冲，并按 maxMessages 收紧，避免一次挂载过多 */
function visibleRange() {
    const el = chatElement[0];
    const count = messageCount();
    if (count === 0) return [0, -1];
    if (!el) return [0, Math.min(count, view().windowSize) - 1];

    const top = Math.max(0, el.scrollTop - BASE_PAD);
    const buffer = Math.max(400, el.clientHeight * BUFFER_SCREENS);
    let first = indexAt(top - buffer);
    let last = indexAt(top + el.clientHeight + buffer);

    const limit = Math.max(3, view().maxMessages || 30);
    if (last - first + 1 > limit) {
        // 超限时以视口中心为基准收缩
        const center = indexAt(top + el.clientHeight / 2);
        first = Math.max(0, center - Math.floor(limit / 2));
        last = Math.min(count - 1, first + limit - 1);
    }
    return [Math.max(0, first), Math.min(count - 1, last)];
}

function scrollToBottom() {
    const el = chatElement[0];
    if (el) el.scrollTop = el.scrollHeight;
}

function isAtBottom(tolerance = 150) {
    const el = chatElement[0];
    if (!el) return true;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - tolerance;
}

/** DOM 里最后一条不一定是聊天最后一条，核心的 .last_mes 样式要跟着修 */
function fixLastMes() {
    chatElement.find('.mes').removeClass('last_mes');
    const lastReal = messageCount() - 1;
    const el = mounted.get(lastReal);
    if (el) el.classList.add('last_mes');
}

/* ------------------------------------------------------------------ *
 * 尺寸变化：图片/媒体异步加载会改变高度，量到就回填
 * ------------------------------------------------------------------ */

function onElementsResized(entries) {
    let changed = false;
    for (const entry of entries) {
        const el = entry.target;
        const id = Number(el.getAttribute('mesid'));
        if (!Number.isInteger(id) || !mounted.has(id)) continue;
        const h = el.getBoundingClientRect().height;
        if (h > 0 && Math.abs(h - heights[id]) > 0.5) {
            heights[id] = h;
            if (chat[id]) measured.set(chat[id], h);
            dirty = true;
            changed = true;
        }
    }
    if (changed && !resizeTicking) {
        resizeTicking = true;
        requestAnimationFrame(() => {
            resizeTicking = false;
            updateSpacers({ compensate: true });
        });
    }
}

function observeMounted() {
    if (!resizeObserver) {
        resizeObserver = new ResizeObserver(onElementsResized);
    }
    for (const el of mounted.values()) {
        resizeObserver.observe(el);
    }
}

/* ------------------------------------------------------------------ *
 * 主同步
 * ------------------------------------------------------------------ */

async function sync({ compensate = true } = {}) {
    if (!isActive() || syncing) return;
    syncing = true;
    try {
        if (messageCount() === 0) return;
        // 不管是谁把 .mes 放进 DOM 的（核心首屏、别的扩展、新消息），先全部登记，
        // 这样区间外的都能被正确卸载，不会留一堆旧楼层在 DOM 里
        collectExisting();
        pruneDetached();
        ensureHeights();
        const [first, last] = visibleRange();
        // 先按目标区间把上下占位撑好，再动 DOM。
        // 顺序反了的话，卸载旧消息会让内容高度骤减，浏览器立刻把 scrollTop 夹回顶部，
        // 表现为「滚到一半弹回开头」。
        updateSpacers({ compensate: false, first, last });
        unmountOutside(first, last);
        await mountRange(first, last);
        updateSpacers({ compensate });
        fixLastMes();
        observeMounted();
    } finally {
        syncing = false;
    }
}

function onScroll() {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
        scrollTicking = false;
        if (!isActive()) return;
        sync({ compensate: true });
    });
}

/* ------------------------------------------------------------------ *
 * 对外：跳转到指定楼层
 * ------------------------------------------------------------------ */

/**
 * 滚到第 i 楼并把它对齐到视口顶部。
 * 未实测的楼层高度是估算的，所以定位两次：第一次按估算跳，挂载后实测回填再精修一次。
 */
export async function scrollToIndex(index) {
    if (!isActive()) return;
    const el = chatElement[0];
    if (!el) return;

    const target = Math.max(0, Math.min(index, messageCount() - 1));
    ensureHeights();
    recomputeOffsets();
    el.scrollTop = BASE_PAD + (offsets[target] ?? 0);
    await sync({ compensate: false });

    ensureHeights();
    recomputeOffsets();
    el.scrollTop = BASE_PAD + (offsets[target] ?? 0);
    await sync({ compensate: false });
}

export async function scrollToLatest() {
    if (!isActive()) return;
    const count = messageCount();
    if (count === 0) return;

    const start = Math.max(0, count - Math.max(view().windowSize, 8));
    collectExisting();
    ensureHeights();

    // 先把末尾一段挂上再滚到底。否则会陷入
    //「按估算高度滚到底 → 挂载 → 实测比估算高 → 总高变长 → 又不在底部」的震荡，
    // 表现为打开聊天时停在半空而不是最新一条
    unmountOutside(start, count - 1);
    await mountRange(start, count - 1);
    updateSpacers({ compensate: false });
    scrollToBottom();
    await sync({ compensate: false });
    scrollToBottom();
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

/** 打开/切换聊天：核心渲染完后接管 */
async function onChatChanged() {
    if (!isActive()) return;
    // 让核心和其它扩展的渲染先跑完
    await new Promise(resolve => setTimeout(resolve, 0));
    if (!isActive()) return;

    resetState();
    collectExisting();
    chatElement.find('#show_more_messages').remove();
    ensureHeights();
    await scrollToLatest();
}

/** 新消息：核心已经 append 好了，登记进来并维持底部 */
function onNewMessage() {
    if (!isActive()) return;
    const atBottom = isAtBottom(400);
    collectExisting();
    ensureHeights();
    updateSpacers({ compensate: true });

    // 走 scrollToLatest 而不是简单的 scrollToBottom：新消息实测后总高会变长，
    // 直接滚到底会因为「挂上 → 变高 → 又不在底部」而差一截
    if (atBottom || view().autoJumpLatest) {
        scrollToLatest();
    } else {
        sync({ compensate: true });
    }
}

/** 删除楼层：索引整体位移，重建高度表（实测值靠 WeakMap 保住） */
function onMessageDeleted() {
    if (!isActive()) return;
    invalidateHeights();
    mounted = new Map();
    collectExisting();
    ensureHeights();
    updateSpacers({ compensate: true });
    sync({ compensate: true });
}

/** 丢弃高度索引，下次 ensureHeights() 会重建（实测值由 WeakMap 保住） */
function invalidateHeights() {
    heights = [];
    offsets = [];
    dirty = true;
    heightsValid = false;
}

function resetState() {
    invalidateHeights();
    mounted = new Map();
    spacerTop = 0;
}

/** 退出虚拟化时把 #chat 还给核心 */
export function teardownVirtual() {
    topSpacer?.remove();
    bottomSpacer?.remove();
    topSpacer = null;
    bottomSpacer = null;
    if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
    }
    resetState();
}

function bindEvents() {
    if (listenersBound) return;
    listenersBound = true;

    chatElement.on('scroll.stvv', onScroll);

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

    // 窗口尺寸变了，之前量到的高度全部失效
    window.addEventListener('resize', () => {
        if (!isActive()) return;
        invalidateHeights();
        ensureHeights();
        updateSpacers({ compensate: true });
        sync({ compensate: true });
    });
}

/** 应用虚拟化设置（可反复调用） */
export function applyChatVirtual() {
    if (!isActive()) {
        teardownVirtual();
        return;
    }
    bindEvents();
    onChatChanged();
}

/** 当前挂载情况，供测试与调试 */
export const virtualApi = {
    sync,
    scrollToIndex,
    scrollToLatest,
    totalHeight,
    mountedIds: () => Array.from(mounted.keys()).sort((a, b) => a - b),
    heights: () => heights.slice(),
    offsets: () => offsets.slice(),
};
