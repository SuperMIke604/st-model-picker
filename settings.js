import { extension_settings } from '../../../extensions.js';

export const MODULE_NAME = 'st-model-picker';

const DEFAULT_SETTINGS = {
    /** 功能一：模型选择器 */
    modelPicker: {
        enabled: true,
        enableMobile: true,
        takeoverSelect2: false,
        disabledTargets: [],
    },
    /** 功能二：聊天文件增强 */
    chatFiles: {
        enabled: true,
        fastOpen: true,
        copyButton: true,
    },
    /** 功能三：聊天视图窗口化 + 目录跳转 */
    chatView: {
        enabled: true,
        /** 每次加载多少楼（也是打开聊天时渲染的最新楼层数） */
        windowSize: 10,
        /** DOM 内最多保留多少条消息，超出从另一端裁掉 */
        maxMessages: 30,
        /** 收到新消息时自动回到最新窗口 */
        autoJumpLatest: true,
    },
};

/**
 * 兼容旧版扁平结构（最初版本只有模型选择器）。
 * @param {object} raw 已保存的设置
 * @returns {object} 迁移后的设置
 */
function migrate(raw) {
    if (!raw) {
        return raw;
    }
    const isLegacy = !raw.modelPicker && (raw.enabled !== undefined || raw.enableMobile !== undefined || raw.takeoverSelect2 !== undefined);
    if (!isLegacy) {
        return raw;
    }
    return {
        modelPicker: {
            enabled: raw.enabled,
            enableMobile: raw.enableMobile,
            takeoverSelect2: raw.takeoverSelect2,
            disabledTargets: raw.disabledTargets ?? [],
        },
    };
}

const stored = migrate(extension_settings[MODULE_NAME]);

export const settings = {
    modelPicker: Object.assign({}, DEFAULT_SETTINGS.modelPicker, stored?.modelPicker ?? {}),
    chatFiles: Object.assign({}, DEFAULT_SETTINGS.chatFiles, stored?.chatFiles ?? {}),
    chatView: Object.assign({}, DEFAULT_SETTINGS.chatView, stored?.chatView ?? {}),
};

settings.modelPicker.disabledTargets = Array.isArray(settings.modelPicker.disabledTargets)
    ? settings.modelPicker.disabledTargets
    : [];

extension_settings[MODULE_NAME] = settings;
