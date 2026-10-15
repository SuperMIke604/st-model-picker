import { extension_settings } from '../../../extensions.js';

export const MODULE_NAME = 'st-model-picker';

const DEFAULT_SETTINGS = {
    /** 功能一：模型选择器 */
    modelPicker: {
        enabled: true,
        enableMobile: true,
        /** 不想被接管的下拉 id（select[id^="model_"][id$="_select"]） */
        disabledTargets: [],
    },
    /** 功能二：聊天文件增强 */
    chatFiles: {
        enabled: true,
        fastOpen: true,
        copyButton: true,
    },
    /**
     * 功能三：聊天视图（分页阅读）+ 目录跳转
     * 只有一种模式：按固定楼数切页，一次只渲染一页，底部常驻翻页条。
     */
    chatView: {
        enabled: true,
        /** 每页多少楼 */
        pageSize: 20,
        /** 停在旧页时收到新回复，自动回到最新 */
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

// 旧版本留下的已废弃字段（多渲染模式 / 是否接管 select2），读到了就丢掉，避免脏数据被回写
delete settings.modelPicker.takeoverSelect2;
delete settings.chatView.mode;
delete settings.chatView.windowSize;
delete settings.chatView.maxMessages;

extension_settings[MODULE_NAME] = settings;
