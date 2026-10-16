/** 扩展共享工具 */

/** 核心语言包里没有的文案，走这里的中英对照 */
const EXTRA_ZH = {
    // 模型选择器
    'No matching models': '没有匹配的模型',
    'This source has no models yet. Connect it first and try again.': '该来源还没有模型列表，请先点击 Connect 连接后再选择。',
    'Type to search, Enter to select.': '输入关键词搜索，回车选中，Esc 关闭。',
    // 聊天文件增强
    'Loading chat files...': '正在加载聊天文件……',
    'Copy chat file': '复制聊天文件',
    'Copying chat file...': '正在复制聊天文件……',
    'Copied to': '已复制为',
    'Copy failed': '复制失败',
    // 聊天视图与目录
    'Search chapters...': '搜索章节 / 楼层……',
    'Jump to latest': '跳到最新',
    'No matching chapters': '没有匹配的章节',
    'Chat chapters': '聊天目录',
    'Load earlier messages': '加载更早的消息',
    'Close': '关闭',
    // 分页阅读
    'Previous page': '上一页',
    'Next page': '下一页',
    'Page {0} / {1}': '第 {0} / {1} 页',
    'messages': '楼',
    'TOC': '目录',
    'Show pager bar': '显示翻页条',
    'Hide pager bar': '隐藏翻页条',
};

/** 获取 SillyTavern 扩展上下文 */
export function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

/**
 * 翻译：优先核心语言包（zh-cn 已内置「搜索模型……」「选择模型」「取消」），其余走内置对照表。
 * 文案里的 {0} {1} 会按顺序替换成 args，用来处理中英文语序不同的句子。
 *
 * @param {string} text 原英文文案
 * @param {...any} args 占位符参数
 * @returns {string} 翻译后的文案
 */
export function T(text, ...args) {
    const context = getContext();
    const locale = String(context?.getCurrentLocale?.() ?? '');
    let out = text;
    if (locale.toLowerCase().startsWith('zh') && EXTRA_ZH[text]) {
        out = EXTRA_ZH[text];
    } else {
        out = context?.translate?.(text) ?? text;
    }
    args.forEach((value, i) => {
        out = out.split(`{${i}}`).join(String(value));
    });
    return out;
}

/** 异步 POST JSON，返回解析后的响应 */
export async function postJson(url, body) {
    const { getRequestHeaders } = await import('../../../../script.js');
    const response = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`${url} -> HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    return contentType.includes('json') ? response.json() : response.text();
}
