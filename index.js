/**
 * ST Tools（酒馆增强套件）
 *
 * 一个扩展打包两个功能，各自独立开关：
 *   1. 模型选择器（model-picker.js）
 *   2. 聊天文件增强：管理聊天文件秒开 + 复制聊天文件（chat-files.js）
 */

import { settings } from './settings.js';
import { getContext } from './utils.js';
import { initModelPicker, applyModelPicker, renderTargetList } from './model-picker.js';
import { initChatFiles, applyChatFiles } from './chat-files.js';
import { initChatView, applyChatView } from './chat-toc.js';

/** 绑定设置面板里的一组开关 */
function bindToggles() {
    const context = getContext();

    const bind = (id, get, set, onChanged) => {
        const checkbox = document.getElementById(id);
        if (!checkbox) return;
        checkbox.checked = Boolean(get());
        checkbox.addEventListener('change', () => {
            set(checkbox.checked);
            context.saveSettingsDebounced();
            onChanged();
        });
    };

    // 模型选择器
    bind('stmp_enabled', () => settings.modelPicker.enabled, v => settings.modelPicker.enabled = v, applyModelPicker);
    bind('stmp_enable_mobile', () => settings.modelPicker.enableMobile, v => settings.modelPicker.enableMobile = v, applyModelPicker);
    bind('stmp_takeover_select2', () => settings.modelPicker.takeoverSelect2, v => settings.modelPicker.takeoverSelect2 = v, applyModelPicker);

    // 聊天文件增强
    bind('stcfp_enabled', () => settings.chatFiles.enabled, v => settings.chatFiles.enabled = v, applyChatFiles);
    bind('stcfp_fast_open', () => settings.chatFiles.fastOpen, v => settings.chatFiles.fastOpen = v, applyChatFiles);
    bind('stcfp_copy_button', () => settings.chatFiles.copyButton, v => settings.chatFiles.copyButton = v, applyChatFiles);

    // 聊天视图与目录
    bind('stcv_enabled', () => settings.chatView.enabled, v => settings.chatView.enabled = v, applyChatView);
    bind('stcv_auto_jump', () => settings.chatView.autoJumpLatest, v => settings.chatView.autoJumpLatest = v, applyChatView);

    const bindNumber = (id, get, set, onChanged) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.value = String(get());
        input.addEventListener('change', () => {
            const value = Number(input.value);
            if (!Number.isFinite(value) || value <= 0) {
                input.value = String(get());
                return;
            }
            set(value);
            context.saveSettingsDebounced();
            onChanged();
        });
    };
    bindNumber('stcv_page', () => settings.chatView.pageSize, v => settings.chatView.pageSize = v, applyChatView);
    bindNumber('stcv_window', () => settings.chatView.windowSize, v => settings.chatView.windowSize = v, applyChatView);
    bindNumber('stcv_max', () => settings.chatView.maxMessages, v => settings.chatView.maxMessages = v, applyChatView);

    // 渲染模式：分页 / 虚拟化 / 窗口
    const modeSelect = document.getElementById('stcv_mode');
    if (modeSelect) {
        const normalize = v => (v === 'window' || v === 'virtual' ? v : 'paged');
        modeSelect.value = normalize(settings.chatView.mode);
        modeSelect.addEventListener('change', () => {
            settings.chatView.mode = normalize(modeSelect.value);
            context.saveSettingsDebounced();
            applyChatView();
        });
    }

    // 目标下拉的全选 / 全不选
    document.getElementById('stmp_targets_all')?.addEventListener('click', () => {
        settings.modelPicker.disabledTargets = [];
        context.saveSettingsDebounced();
        renderTargetList();
        applyModelPicker();
    });
    document.getElementById('stmp_targets_none')?.addEventListener('click', () => {
        settings.modelPicker.disabledTargets = Array.from(document.querySelectorAll('select[id^="model_"][id$="_select"]')).map(x => x.id);
        context.saveSettingsDebounced();
        renderTargetList();
        applyModelPicker();
    });
}

async function loadSettingsUi() {
    const context = getContext();
    const html = await context.renderExtensionTemplateAsync('third-party/st-model-picker', 'settings');
    document.getElementById('extensions_settings')?.insertAdjacentHTML('beforeend', html);
    bindToggles();
    renderTargetList();
}

(async function init() {
    try {
        await loadSettingsUi();
        initModelPicker();
        initChatFiles();
        initChatView();
        console.log('[ST Tools] ready');
    } catch (error) {
        console.error('[ST Tools] init failed:', error);
    }
})();
