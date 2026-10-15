/**
 * 功能一：模型选择器
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

import { settings } from './settings.js';
import { T, getContext } from './utils.js';

/** @type {Map<HTMLSelectElement, {trigger: JQuery, onChange: Function, observer: MutationObserver}>} */
const attached = new Map();

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

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

    Array.from(select.children).forEach(child => {
        if (child instanceof HTMLOptGroupElement) {
            const items = Array.from(child.children)
                .filter(o => o instanceof HTMLOptionElement)
                .map(o => ({ value: o.value, text: o.textContent?.trim() || o.value }));
            groups.push({ label: child.label, items });
        } else if (child instanceof HTMLOptionElement) {
            let group = groups.find(g => g.label === '' && g.standalone);
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
    const context = getContext();
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
        const items = Array.from($list.find('.stmp_item'));
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
    // 已被 select2 接管的下拉（OpenRouter / Chutes / NanoGPT 等自带搜索的）一并接管，
    // 全部统一成弹窗选择器，交互一致。
    if ($select.hasClass('select2-hidden-accessible')) {
        try {
            $select.select2('destroy');
        } catch (error) {
            // select2 尚未加载或已销毁，忽略即可
        }
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

    // 模型列表是连接 API 后动态填充的，用 MutationObserver 同步显示文本。
    // 顺带盯着 class：核心偶尔会重新把下拉 select2 化（切换 / 重连 API 时），发现就再拆一次。
    const observer = new MutationObserver(() => {
        updateTrigger(select);
        if (select.classList.contains('select2-hidden-accessible')) {
            try {
                $(select).select2('destroy');
            } catch (error) {
                // 忽略：select2 已销毁
            }
        }
    });
    observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

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
    const mobile = Boolean(getContext()?.isMobile?.());
    return mobile ? settings.modelPicker.enableMobile : true;
}

/** 应用模型选择器设置（可反复调用） */
export function applyModelPicker() {
    getTargets().forEach(select => {
        const wanted = settings.modelPicker.enabled && isPlatformEnabled();
        if (wanted) {
            attach(select);
        } else {
            detach(select);
        }
    });
}

/** 初始化模型选择器 */
export function initModelPicker() {
    applyModelPicker();
}
