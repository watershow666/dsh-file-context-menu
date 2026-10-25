# dsh-file-context-menu

> A native-style right-click context menu for file cards, inline file chips and bare paths in the DeepSeek Harness (DSH) desktop chat flow — reveal in folder, save as, copy path, add back to the composer.

给 DSH 聊天流里的文件卡片加一套原生风格的右键菜单。

覆盖五类位置：

- **引用文件**：用户在输入框引用、渲染在对话流里的文件 chip（`conversation.user.text.node` 的 `file` / `folder` 节点）。
- **输出文件**：AI 生成并在对话流里交付的文件卡片（`conversation.chat.turnTail` 下的 `deliverables.*`）。
- **行内文件 chip**：正文 markdown 里渲染成 `</> 文件名`（或文件图标 + 文件名）的小 chip，文本只有文件名本身。
- **裸路径文本**：正文/行内代码里写成 `E:\...\xxx` 的绝对路径（`elementsFromPoint` + caret 取 token，不依赖卡片骨架）。
- **网址链接**：正文里的 `<a href>`（markdown 链接、引用源 chip）和裸 URL 文本（`https://…` / `mailto:`），右键可复制地址或在浏览器打开。

行内 chip 的解析顺序：元素及祖先的 `title` / `aria-label` / `data-*` / `href`（含 `file://` 反解）→ fiber props 里的路径字符串 → 只拿到文件名时由宿主在工作区内检索（结果按根目录 + 文件名为键缓存 60 秒，扫描深度 8、条目上限两万）。只有带图标证据的元素才会被当成 chip，普通正文里的文件名文本不响应右键。

## 菜单项

文件菜单：

| 菜单项 | 行为 | 实现 |
| --- | --- | --- |
| 打开文件夹 | 资源管理器定位并选中该文件 | `openWorkspacePath({ path, action: 'reveal' })`，失败回落 `explorer.exe /select` |
| 另存为 | 系统保存对话框 + 复制文件 | 优先 `showSaveFilePicker()`（浏览器直接写字节）；不可用时走宿主 PowerShell `SaveFileDialog`。目录时置灰 |
| 复制路径 | 复制绝对路径 | `navigator.clipboard.writeText`，失败回落 `Set-Clipboard` |
| 添加到对话框 | 把绝对路径文本追加进当前会话输入框 | 优先 `conversation.input.for(scope).setDraft()`；拿不到会话作用域时回落到 DOM 编辑框（contenteditable / textarea） |

链接菜单：

| 菜单项 | 行为 | 实现 |
| --- | --- | --- |
| 打开链接 | 用默认浏览器打开 | 宿主 `/file-menu/link`，服务端只放行 `http(s)://` 与 `mailto:`，`Start-Process` 交给 shell |
| 复制链接地址 | 复制完整 URL | `navigator.clipboard.writeText`，失败回落 `Set-Clipboard` |

菜单在点击空白处、滚动、滚轮、Escape、窗口失焦时关闭。

## 安装

在 DSH 里用 `plugin_manager` 安装（不要在 profile 里手写 `package.json` / `cordis.patch.yml`）：

```
plugin_manager install_bundle  target = <本目录绝对路径>
```

装完后刷新页面（客户端插件在页面加载时注册）。

## 结构

- `index.js` — Host 半边，只提供 `/file-menu/*` 私有 HTTP 路由（打开、读取字节、另存为、路径解析、剪贴板、诊断）。全部经过 `ctx.connection.requestRejection` 的浏览器信任围栏。
- `client.js` — Client 半边，同页运行：`contextmenu` 捕获 → 判定文件卡片 → 解析绝对路径 → 渲染菜单 → 分发动作。
- `cordis.patch.yml` — 挂载声明（一个宿主空行，功能全在 client.js）。

## 路径解析策略（三级递降）

1. DOM 属性：`data-path` / `data-file-path` / `title` / `aria-label` 等；
2. React fiber 反射：`__reactFiber$*` → `memoizedProps`，同时取出当前 `sessionId`（DOM 属性里没有）；
3. 只拿到文件名时，交给宿主在该会话工作区内按名检索。

## 诊断

客户端每次右键都会 POST `/file-menu/report`，宿主把面包屑追加到：

```
%TEMP%\dsh-file-context-menu.log
```

（通常是 `C:\Users\<用户名>\AppData\Local\Temp\dsh-file-context-menu.log`）

看这个文件即可判断：插件是否加载、命中的元素、解析出的绝对路径、本次走到了哪条解析分支。

## 已知限制

- 菜单只覆盖对话流内的文件卡片、行内文件 chip、裸路径文本和网址链接；侧边栏文件树、预览页工具栏不在范围内。
- 行内 chip 若既没有带路径的悬浮提示、fiber props 里也没有路径，就只能靠文件名在工作区检索；重名时返回第一个命中，找不到时菜单照常弹出、执行动作时提示「找不到该文件的绝对路径」（日志记 `action-no-path`，未命中时记 `chip-miss`）。
- 会话工作区之外的文件（例如系统临时目录里的产物），`openWorkspacePath` 可能拒绝，此时回落宿主原生 `Start-Process` / `explorer /select`。
- `添加到对话框` 写入的是绝对路径文本（不转成工作区相对路径、不生成引用 chip），目录会带尾部 `\`。
- 路径与 sessionId 的解析依赖 React fiber 内部属性（`__reactFiber$*`），DSH 大版本升级后可能需要重新校准。
