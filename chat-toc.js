/**
 * 功能三：聊天目录 + 分页视图入口
 *
 * 目录部分：直接扫描内存里的 chat 数组，取用户发言楼层作为章节（用户楼 + 其回复楼），
 * 支持搜索与一键跳转；跳转交给 chat-pager.js 算出目标页并整页渲染。
 *
 * 渲染部分：只有分页一种模式，实现全在 chat-pager.js。
 * 本模块只负责「目录」以及功能开关的收口（applyChatView）。
 */

import { chat, chatElement } from '../../../../script.js';
import { settings } from './settings.js';
import { T, getContext } from './utils.js';
import { applyChatPaged, teardownPaged, pagerApi } from './chat-pager.js';

const view = () => settings.chatView;

/** DOM 里现有消息的 id 区间 [first, last]，没有则返回 null */
function currentRange() {
    const ids = chatElement.find('.mes')
        .map((i, el) => Number(el.getAttribute('mesid')))
        .get()
        .filter(Number.isInteger);
    if (ids.length === 0) return null;
    return [Math.min(...ids), Math.max(...ids)];
}

/** 回到最新一页并停在底部 */
async function jumpToLatest() {
    await pagerApi.goLatest();
}

/** 跳到第 index 楼所在的页 */
async function jumpTo(index) {
    await pagerApi.goToIndex(index);
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
        jumpTo(start);
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
 * 生命周期
 * ------------------------------------------------------------------ */

/** 应用聊天视图设置（可反复调用） */
export function applyChatView() {
    if (!view().enabled) {
        // 交还给核心：撤掉翻页条，把核心的「显示更多消息」补回来（如果画面不是从第 0 楼开始）
        teardownPaged();
        const range = currentRange();
        if (range && range[0] > 0 && chatElement.find('#show_more_messages').length === 0) {
            chatElement.prepend('<div id="show_more_messages">Show more messages</div>');
        }
        return;
    }

    applyChatPaged();
}

/** 初始化聊天视图与目录 */
export function initChatView() {
    applyChatView();
}

/** 供测试/外部调用（分页器的「目录」按钮也走这里） */
export const chatViewApi = { openToc, buildChapters, jumpToLatest, jumpTo, currentRange };
