# Model Picker（模型选择器）

把 SillyTavern 的模型下拉框换成「点击弹出弹窗 + 搜索框 + 分组列表」的单选选择器。

## 特性

- **可搜索**：弹窗内置搜索框，按模型名或分组实时过滤（大小写不敏感、匹配文本与 value）
- **弹窗式**：基于 SillyTavern 原生 Popup（`<dialog>`），与整体 UI 一致
- **PC / 移动端通用**：不依赖 select2，移动端同样可用
- **键盘友好**：输入过滤 → `↑`/`↓` 移动 → `Enter` 选中 → `Esc` 关闭
- **完全无侵入**：原生 `<select>` 保留在 DOM 中（仅隐藏），SillyTavern 的设置读写、`change` 事件、斜杠命令等全部照常工作；连接 API 后动态拉取的模型也能被搜到（列表在每次打开时实时读取）
- **自动本地化**：直接复用 SillyTavern 核心语言包（如 zh-cn 的「搜索模型……」「取消」），无需额外配置
- **可配置**：在 扩展面板 中可按来源启用/禁用，可开关移动端，可选择是否接管 OpenRouter 等已带搜索的下拉

## 安装

方式一（推荐）：在 SillyTavern 的扩展面板 → 「安装扩展」中填入本仓库地址。

方式二（手动）：把本目录整个复制到：

```
SillyTavern/public/scripts/extensions/third-party/st-model-picker/
```

然后刷新页面即可，无需重启。

## 使用

1. 打开 AI 设置面板（AI Response Configuration）
2. 点击模型下拉（外观与原来几乎一致，右侧带放大镜图标）
3. 在弹窗中搜索并点击模型即可

## 设置

扩展面板 → Model Picker：

| 选项 | 说明 | 默认 |
|------|------|------|
| 启用弹窗式模型选择器 | 关闭后恢复原生下拉 | 开 |
| 移动端也启用 | 移动端同样使用弹窗 | 开 |
| 接管已带搜索的下拉 | OpenRouter / Chutes / NanoGPT 等原生已用 select2 实现搜索，默认保持原样 | 关 |
| 接管的模型下拉 | 按来源单独启用/禁用 | 全部启用 |

## 兼容性

- SillyTavern 1.19.x（使用 `SillyTavern.getContext()` 与原生 Popup API）
- 已验证：OpenAI / Claude / Google / VertexAI 等全部 `model_*_select` 下拉；动态填充模型列表（连接后拉取）场景

## License

MIT
