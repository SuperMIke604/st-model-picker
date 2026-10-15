/**
 * 功能二：聊天文件增强
 *
 * 针对「管理聊天文件」弹窗的两个增强：
 *
 * 1. 秒开：核心逻辑是「先请求 /api/chats/search 并渲染完所有条目，再显示弹窗」，
 *    聊天文件多时服务端要串行扫描每个 jsonl 文件，点击后要干等。
 *    本扩展在捕获阶段拦截 #option_select_chat 的点击，立刻显示弹窗并铺上骨架屏，
 *    再异步调用核心的 displayPastChats() 填充真实列表。
 *
 * 2. 复制：给每个聊天文件块加一个「复制」按钮。
 *    - 角色聊天：/api/chats/get 读出整个 jsonl → /api/chats/save 写入新文件名
 *    - 群聊：/api/chats/group/get → /api/chats/group/save，并把新 id 写回群元数据 chats 数组
 *    复制完成后刷新列表并高亮新文件。全程只调官方 API。
 */

import { displayPastChats, characters, this_chid, is_send_press, animation_duration, animation_easing } from '../../../../script.js';
import { selected_group, groups, is_group_generating } from '../../../group-chats.js';
import { settings } from './settings.js';
import { T, postJson } from './utils.js';

let blocksObserver = null;

/* ------------------------------------------------------------------ *
 * 功能一：管理聊天文件弹窗秒开
 * ------------------------------------------------------------------ */

function skeletonHtml() {
    return [
        '<div class="stcfp_loading">',
        `<i class="fa-solid fa-spinner fa-spin"></i><span>${T('Loading chat files...')}</span>`,
        '</div>',
        '<div class="stcfp_skeleton_block"></div>',
        '<div class="stcfp_skeleton_block stcfp_w60"></div>',
        '<div class="stcfp_skeleton_block stcfp_w80"></div>',
    ].join('');
}

/**
 * 与核心 script.js 的 option_select_chat 分支保持一致的前置条件判断。
 * 不满足时放行给核心处理（比如未选角色时打开临时助手卡）。
 */
function canOpenChatFiles() {
    return (Boolean(selected_group) && !is_group_generating) || (this_chid !== undefined && !is_send_press);
}

/** 注册捕获阶段的点击拦截：先弹窗、后加载 */
export function initChatFilesListener() {
    // 注意 slash command 走 jQuery .trigger('click')，不经过原生事件，仍走核心慢路径，属可接受。
    document.addEventListener('click', function (event) {
        if (!settings.chatFiles.enabled || !settings.chatFiles.fastOpen) return;
        const option = event.target?.closest?.('#option_select_chat');
        if (!option) return;
        if (!canOpenChatFiles()) return;

        event.stopPropagation();
        event.preventDefault();

        // 复刻核心的显示与菜单收起逻辑
        $('#options').fadeOut(animation_duration);
        $('#select_chat_search').val('');
        $('#shadow_select_chat_popup')
            .css('display', 'block')
            .css('opacity', 0.0)
            .transition({
                opacity: 1.0,
                duration: animation_duration,
                easing: animation_easing,
            });

        // displayPastChats() 第一步会清空列表（同步执行），随后异步取数；
        // 所以这里同步在清空之后补上骨架屏，取数完成后核心自己会重绘真实列表。
        const loading = displayPastChats();
        $('#select_chat_div').html(skeletonHtml());

        loading.catch(error => {
            console.error('[ST Tools] displayPastChats failed:', error);
        });
    }, true);
}

/* ------------------------------------------------------------------ *
 * 功能二：复制聊天文件
 * ------------------------------------------------------------------ */

/** 从当前列表 DOM 收集已占用文件名，生成不重名的新名字 */
function uniqueChatName(baseName) {
    const existing = new Set(
        Array.from(document.querySelectorAll('#select_chat_div .select_chat_block'))
            .map(el => el.getAttribute('file_name'))
            .filter(Boolean),
    );
    if (!existing.has(baseName)) {
        return baseName;
    }
    let candidate = `${baseName} (copy)`;
    for (let i = 2; existing.has(candidate) && i < 100; i++) {
        candidate = `${baseName} (copy ${i})`;
    }
    if (existing.has(candidate)) {
        candidate = `${baseName} (copy ${Date.now()})`;
    }
    return candidate;
}

async function copyChatFile(fileName) {
    const waitingToast = toastr.info(T('Copying chat file...'), '', { timeOut: 0, extendedTimeOut: 0 });
    try {
        let newName;

        if (selected_group) {
            // 群聊：groupChats/<id>.jsonl，且要把新 id 写回群元数据的 chats 数组
            const chatData = await postJson('/api/chats/group/get', { id: fileName });
            if (!Array.isArray(chatData) || chatData.length === 0) {
                throw new Error('chat file is empty');
            }
            newName = uniqueChatName(fileName);
            const saved = await postJson('/api/chats/group/save', { id: newName, chat: chatData, force: true });
            if (!saved?.ok) {
                throw new Error('save failed');
            }
            const group = groups.find(g => g.id === selected_group);
            if (group) {
                group.chats = Array.isArray(group.chats) ? group.chats : [];
                if (!group.chats.includes(newName)) {
                    group.chats.push(newName);
                }
                await postJson('/api/groups/edit', { ...group });
            }
        } else {
            // 角色聊天：chats/<avatar>/<file>.jsonl
            const avatarUrl = characters[this_chid]?.avatar;
            if (!avatarUrl) {
                throw new Error('no character selected');
            }
            const chatData = await postJson('/api/chats/get', { avatar_url: avatarUrl, file_name: fileName });
            if (!Array.isArray(chatData) || chatData.length === 0) {
                throw new Error('chat file is empty');
            }
            newName = uniqueChatName(fileName);
            const saved = await postJson('/api/chats/save', { avatar_url: avatarUrl, file_name: newName, chat: chatData, force: true });
            if (!saved?.ok) {
                throw new Error('save failed');
            }
        }

        toastr.clear(waitingToast);
        toastr.success(`${T('Copied to')} ${newName}`);
        await displayPastChats([newName]);
    } catch (error) {
        console.error('[ST Tools] copy chat failed:', error);
        toastr.clear(waitingToast);
        toastr.error(`${T('Copy failed')}: ${error.message}`);
    }
}

/** 给列表里每个聊天块注入复制按钮（放在删除按钮旁边） */
function decorateChatBlocks() {
    if (!settings.chatFiles.enabled || !settings.chatFiles.copyButton) return;

    document.querySelectorAll('#select_chat_div .select_chat_block_wrapper').forEach(wrapper => {
        if (wrapper.querySelector('.copyChatButton')) return;
        const block = wrapper.querySelector('.select_chat_block');
        const actions = wrapper.querySelector('.select_chat_actions');
        const deleteButton = wrapper.querySelector('.PastChat_cross');
        const fileName = block?.getAttribute('file_name');
        if (!actions || !deleteButton || !fileName) return;

        const button = document.createElement('div');
        button.className = 'copyChatButton opacity50p hoverglow fa-solid fa-copy';
        button.title = T('Copy chat file');
        button.setAttribute('data-i18n', '[title]Copy chat file');
        button.addEventListener('click', async event => {
            // 阻止冒泡到 .select_chat_block（点击块本身是切换聊天）
            event.stopPropagation();
            if (button.classList.contains('stcfp_busy')) return;
            button.classList.add('stcfp_busy');
            try {
                await copyChatFile(fileName);
            } finally {
                button.classList.remove('stcfp_busy');
            }
        });
        deleteButton.before(button);
    });
}

/** 应用聊天文件增强设置（可反复调用） */
export function applyChatFiles() {
    const listElement = document.getElementById('select_chat_div');
    const wanted = settings.chatFiles.enabled && settings.chatFiles.copyButton;

    if (wanted) {
        if (!listElement || blocksObserver) return;
        blocksObserver = new MutationObserver(() => decorateChatBlocks());
        blocksObserver.observe(listElement, { childList: true });
        decorateChatBlocks();
        return;
    }

    blocksObserver?.disconnect();
    blocksObserver = null;
    document.querySelectorAll('#select_chat_div .copyChatButton').forEach(el => el.remove());
}

/** 初始化聊天文件增强 */
export function initChatFiles() {
    initChatFilesListener();
    applyChatFiles();
}
