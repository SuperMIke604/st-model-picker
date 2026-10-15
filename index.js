/**
 * Model Picker（模型选择器）
 *
 * 把 SillyTavern 里的模型下拉框（<select id="model_xxx_select">）替换成
 * 「点击弹出弹窗 + 搜索框 + 分组列表」的单选选择器。
 *
 * 设计要点：
 * 1. 不删除原生 <select>，只把它隐藏并保留在 DOM 中 —— 核心的设置读写、
 *    change 事件、斜杠命令 /slash model 等全部照常工作。
 * 2. 模型列表在每次打开弹窗时从原生 select 实时读取，所以连接 API 后
 *    动态拉取到的模型也能被搜到。
 * 3. PC 端和移动端使用同一套实现（SillyTavern 自带的 <dialog> 弹窗），
 *    不依赖 select2，因此可以在移动端使用。
 */

const MODULE_NAME = 'st-model-picker';

const DEFAULT_SETTINGS = {
    /** 总开关 */
    enabled: true,
    /** 移动端是否也启用 */
    enableMobile: true,
    /** 是否接管已经带搜索的 select2 下拉（OpenRouter / Chutes / NanoGPT 等） */
    takeoverSelect2: false,
    /** 单个下拉的黑名单（存 select 的 id） */
    disabledTargets: [],
};

/** 核心语言包里没有的文案，走这里的中英对照 */
const EXTRA_ZH = {
    'No matching models': '没有匹配的模型',
    'This source has no models yet. Connect it first and try again.': '该来源还没有模型列表，请先点击 Connect 连接后再选择。',
    'Type to search, Enter to select.': '输入关键词搜索，回车选中，Esc 关闭。',
    'Select a model to use for this API.': '点击任意模型即可选中。',
};

let context = null;
let settings = null;

/** @type {Map<HTMLSelectElement, {trigger: JQuery, onChange: Function, observer: MutationObserver}>} */
const attached = new Map();

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** 等待 SillyTavern 的扩展上下文就绪 */
function waitForContext() {
    return new Promise((resolve, reject) => {
        let tries = 0;
        const tick = () => {
            const ctx = globalThis.SillyTavern?.getContext?.();
            if (ctx) {
                resolve(ctx);
                return;
            }
            if (++tries > 120) {
                reject(new Error('[Model Picker] SillyTavern context is not available.'));
                return;
            }
            setTimeout(tick, 100);
        };
        tick();
    });
}

/** 等待页面 DOM 就绪 */
function waitForDom() {
    if (document.readyState === 'loading') {
        return new Promise(resolve => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
    }
    return Promise.resolve();
}

/** 翻译：优先核心语言包（zh-cn 已内置 "搜索模型……" / "选择模型" / "取消"），其余走内置对照表 */
function T(text) {
    const locale = String(context?.getCurrentLocale?.() ?? '');
    if (locale.toLowerCase().startsWith('zh') && EXTRA_ZH[text]) {
        return EXTRA_ZH[text];
    }
    return context?.translate?.(text) ?? text;
}

/** 所有待接管的模型下拉 */
function getTargets() {
    return Array.from(document.querySelectorAll('select[id^="model_"][id$="_select"]'));
}

/** 下拉旁边的标题（如 "OpenAI Model"），用于弹窗标题与设置列表 */
function getProviderLabel(select) {
    const heading = select.parentElement?.querySelector('h4');
    if (heading?.textContent?.trim()) {
        return heading.textContent.trim();
    }
    return select.id.replace(/^model_/, '').replace(/_select$/, '');
}

/** 当前选中项的显示文本 */
function getCurrentText(select) {
    const option = select.options?.[select.selectedIndex];
    if (option) {
        return option.textContent?.trim() || option.value;
    }
    return T('Select a model');
}

/* ------------------------------------------------------------------ *
 * 弹窗选择器
 * ------------------------------------------------------------------ */

/** 从原生 select 读出分组结构： [{ label, items: [{ value, text }] }] */
function collectItems(select) {
    const groups = [];
    const push = (label, items) => groups.push({ label: label ?? '', items });

    Array.from(select.children).forEach(child => {
        if (child instanceof HTMLOptGroupElement) {
            const items = Array.from(child.children)
                .filter(o => o instanceof HTMLOptionElement)
                .map(o => ({ value: o.value, text: o.textContent?.trim() || o.value }));
            push(child.label, items);
        } else if (child instanceof HTMLOptionElement) {
            let group = groups.find(g => g.label === '' && !g.standalone);
            if (!group) {
                group = { label: '', items: [], standalone: true };
                groups.push(group);
            }
            group.items.push({ value: child.value, text: child.textContent?.trim() || child.value });
        }
    });

    return groups;
}

function openPicker(select) {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    const selectedValue = String(select.value ?? '');
    const groups = collectItems(select);
    const hasAnyModel = groups.some(g => g.items.length > 0);

    const $wrap = $('<div class="stmp_popup"></div>');
    const $title = $('<h3 class="stmp_title"></h3>').text(getProviderLabel(select));
    // 注意：不能用 props 传 autocomplete，jQuery 会把它当成 jQuery UI 的 autocomplete() 方法去调用
    const $search = $('<input>', {
        type: 'text',
        class: 'text_pole stmp_search',
        spellcheck: false,
        placeholder: T('Search models...'),
    }).attr('autocomplete', 'off');
    const $searchWrap = $('<div class="stmp_search_wrap"></div>')
        .append($('<i class="fa-solid fa-magnifying-glass stmp_search_icon"></i>'))
        .append($search);
    const $list = $('<div class="stmp_list"></div>').attr('role', 'listbox');
    // 弹窗内容此时还没挂到 document 上，jQuery UI 覆写的 show/hide/toggle 会在脱离文档的节点上报错，
    // 所以这里一律直接用 css() 控制显隐。
    const $empty = $('<div class="stmp_empty"></div>').text(T('No matching models')).css('display', 'none');
    const $hint = $('<div class="stmp_hint"></div>')
        .text(T('This source has no models yet. Connect it first and try again.'))
        .css('display', hasAnyModel ? 'none' : '');
    const $footer = $('<div class="stmp_footer"></div>').text(T('Type to search, Enter to select.'));

    $wrap.append($title, $searchWrap, $list, $empty, $hint, $footer);

    const popup = new Popup($wrap, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: T('Cancel'),
        allowVerticalScrolling: true,
        animation: 'fast',
        onOpen: () => {
            $search.trigger('focus');
            $list.find('.stmp_selected').get(0)?.scrollIntoView({ block: 'center' });
        },
    });

    function choose(value) {
        $(select).val(value).trigger('change');
        updateTrigger(select);
        popup.complete(POPUP_RESULT.AFFIRMATIVE);
    }

    function getVisibleItems() {
        return Array.from($list.find('.stmp_item'));
    }

    function setActive(item) {
        $list.find('.stmp_item').removeClass('stmp_active');
        if (!item) return;
        item.classList.add('stmp_active');
        item.scrollIntoView({ block: 'nearest' });
    }

    function render() {
        const query = String($search.val() ?? '').trim().toLowerCase();
        $list.empty();
        let visible = 0;

        groups.forEach(group => {
            const matched = group.items.filter(item => {
                if (!query) return true;
                const value = String(item.value ?? '').toLowerCase();
                const text = String(item.text ?? '').toLowerCase();
                return text.includes(query) || value.includes(query);
            });
            if (matched.length === 0) return;

            const $group = $('<div class="stmp_group"></div>');
            if (group.label) {
                $group.append($('<div class="stmp_group_label"></div>').text(group.label));
            }

            matched.forEach(item => {
                const isSelected = String(item.value) === selectedValue;
                const $item = $('<div class="stmp_item"></div>')
                    .attr({ role: 'option', tabindex: 0, 'data-value': item.value })
                    .toggleClass('stmp_selected', isSelected);
                $item.append($('<span class="stmp_item_text"></span>').text(item.text));
                if (isSelected) {
                    $item.append($('<i class="fa-solid fa-check stmp_item_check"></i>'));
                }
                $item.on('click', () => choose(item.value));
                $group.append($item);
                visible++;
            });

            $list.append($group);
        });

        $empty.css('display', visible === 0 && hasAnyModel ? '' : 'none');
        $footer.css('display', hasAnyModel ? '' : 'none');
    }

    $search.on('input', render);
    $search.on('keydown', event => {
        const items = getVisibleItems();
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const currentIndex = items.findIndex(x => x.classList.contains('stmp_active'));
            const next = event.key === 'ArrowDown'
                ? Math.min(items.length - 1, (currentIndex < 0 ? -1 : currentIndex) + 1)
                : Math.max(0, (currentIndex < 0 ? items.length : currentIndex) - 1);
            setActive(items[next]);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            const active = items.find(x => x.classList.contains('stmp_active')) ?? items[0];
            if (active) choose(active.dataset.value);
        }
    });

    render();
    return popup.show();
}

/* ------------------------------------------------------------------ *
 * 触发器（替换下拉外观的那颗「按钮」）
 * ------------------------------------------------------------------ */

function updateTrigger(select) {
    const state = attached.get(select);
    if (!state) return;
    state.trigger.find('.stmp_value').text(getCurrentText(select));
    state.trigger.attr('title', getCurrentText(select));
}

function attach(select) {
    if (attached.has(select)) return;

    const $select = $(select);
    // 已经被 select2 接管的下拉：默认不动，除非用户开启接管
    if ($select.hasClass('select2-hidden-accessible')) {
        if (!settings.takeoverSelect2) return;
        $select.select2('destroy');
    }

    const $trigger = $('<div class="stmp_trigger"></div>')
        .attr({ role: 'button', tabindex: 0 })
        .append($('<span class="stmp_value"></span>'))
        .append($('<i class="fa-solid fa-magnifying-glass stmp_icon"></i>'));

    $trigger.on('click', () => openPicker(select));
    $trigger.on('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPicker(select);
        }
    });

    $select.addClass('stmp_native_select').after($trigger);

    const onChange = () => updateTrigger(select);
    $select.on('change', onChange);

    // 模型列表是连接 API 后动态填充的，用 MutationObserver 同步显示文本
    const observer = new MutationObserver(() => updateTrigger(select));
    observer.observe(select, { childList: true, subtree: true });

    attached.set(select, { trigger: $trigger, onChange, observer });
    updateTrigger(select);
}

function detach(select) {
    const state = attached.get(select);
    if (!state) return;
    state.observer.disconnect();
    $(select).off('change', state.onChange);
    state.trigger.off().remove();
    $(select).removeClass('stmp_native_select');
    attached.delete(select);
}

function isPlatformEnabled() {
    const mobile = Boolean(context?.isMobile?.());
    return mobile ? settings.enableMobile : true;
}

function applyToAll() {
    getTargets().forEach(select => {
        const wanted = settings.enabled
            && isPlatformEnabled()
            && !settings.disabledTargets.includes(select.id);
        if (wanted) {
            attach(select);
        } else {
            detach(select);
        }
    });
}

/* ------------------------------------------------------------------ *
 * 设置面板
 * ------------------------------------------------------------------ */

function renderTargetList() {
    const $container = $('#stmp_targets');
    if (!$container.length) return;

    $container.empty();
    getTargets().forEach(select => {
        const inputId = `stmp_target_${select.id}`;
        const $label = $('<label class="checkbox_label stmp_target_label"></label>').attr('for', inputId);
        const $input = $('<input>', {
            type: 'checkbox',
            id: inputId,
            checked: !settings.disabledTargets.includes(select.id),
        });
        $input.on('change', () => {
            const list = new Set(settings.disabledTargets);
            if ($input.prop('checked')) {
                list.delete(select.id);
            } else {
                list.add(select.id);
            }
            settings.disabledTargets = Array.from(list);
            context.saveSettingsDebounced();
            applyToAll();
        });
        $label.append($input, $('<span></span>').text(`${getProviderLabel(select)} (${select.id})`));
        $container.append($label);
    });
}

async function loadSettingsUi() {
    const html = await context.renderExtensionTemplateAsync('third-party/st-model-picker', 'settings');
    $('#extensions_settings').append(html);

    $('#stmp_enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = !!$(this).prop('checked');
        context.saveSettingsDebounced();
        applyToAll();
    });
    $('#stmp_enable_mobile').prop('checked', settings.enableMobile).on('change', function () {
        settings.enableMobile = !!$(this).prop('checked');
        context.saveSettingsDebounced();
        applyToAll();
    });
    $('#stmp_takeover_select2').prop('checked', settings.takeoverSelect2).on('change', function () {
        settings.takeoverSelect2 = !!$(this).prop('checked');
        context.saveSettingsDebounced();
        applyToAll();
    });
    $('#stmp_targets_all').on('click', () => {
        settings.disabledTargets = [];
        context.saveSettingsDebounced();
        renderTargetList();
        applyToAll();
    });
    $('#stmp_targets_none').on('click', () => {
        settings.disabledTargets = getTargets().map(x => x.id);
        context.saveSettingsDebounced();
        renderTargetList();
        applyToAll();
    });

    renderTargetList();
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

(async function init() {
    try {
        await waitForDom();
        context = await waitForContext();

        settings = Object.assign({}, DEFAULT_SETTINGS, context.extensionSettings[MODULE_NAME] ?? {});
        settings.disabledTargets = Array.isArray(settings.disabledTargets) ? settings.disabledTargets : [];
        context.extensionSettings[MODULE_NAME] = settings;

        await loadSettingsUi();
        applyToAll();

        console.log('[Model Picker] ready:', attached.size, 'model dropdown(s) upgraded');
    } catch (error) {
        console.error('[Model Picker] init failed', error);
    }
})();
