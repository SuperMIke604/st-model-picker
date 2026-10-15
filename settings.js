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
        chatFiles: { ...DEFAULT_SETTINGS.chatFiles },
    };
}

const stored = migrate(extension_settings[MODULE_NAME]);

export const settings = {
    modelPicker: Object.assign({}, DEFAULT_SETTINGS.modelPicker, stored?.modelPicker ?? {}),
    chatFiles: Object.assign({}, DEFAULT_SETTINGS.chatFiles, stored?.chatFiles ?? {}),
};

settings.modelPicker.disabledTargets = Array.isArray(settings.modelPicker.disabledTargets)
    ? settings.modelPicker.disabledTargets
    : [];

extension_settings[MODULE_NAME] = settings;
