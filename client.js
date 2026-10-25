/**
 * Client half of `dsh-file-context-menu`.
 *
 * Adds a native-looking right-click menu to the two file card families in the
 * chat flow: the reference chips a user inserts into a message (rendered by
 * `conversation.user.text.node`, keys `file` / `folder`) and the deliverable
 * cards a turn produces (`conversation.chat.turnTail` → `deliverables.*`).
 *
 * Design notes
 * ------------
 * - The menu is plain DOM appended to `<body>` (not a slot occupant): a card's
 *   right-click target is not a slot host, and the frame-wide `shell.overlay`
 *   slot is a React surface this feature does not need. Plain DOM keeps the
 *   whole feature in one module and inherits the theme CSS variables anyway.
 * - Absolute paths come from the DOM in three descending steps: data attributes,
 *   then a React fiber walk (`__reactFiber$*` → `memoizedProps`), then bare file
 *   names resolved by the host inside the session workspace. The fiber walk is
 *   deliberate: it is what also yields `sessionId`, which the composer insert
 *   needs and no DOM attribute exposes.
 * - Opening / revealing go through `ctx.remote.session` first — the host's own
 *   `openWorkspacePath` (the DSH equivalent of `shell.openPath` /
 *   `shell.showItemInFolder`). Files the host refuses to open fall back to the
 *   plugin's own host route, which launches them with a native process.
 * - System operations the browser cannot do (Save-As dialog, clipboard) are
 *   posted to `/file-menu/*` on the Host, served by this bundle's `index.js`.
 * - Every resolution attempt posts a breadcrumb to `/file-menu/report`; the
 *   host appends it to `%TEMP%\dsh-file-context-menu.log`. That log is how the
 *   selectors below get validated against a real conversation.
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-context-menu',
  factory() {
    const VERSION = '1.4.0'
    const STYLE_ID = 'dfcm-style'
    const MENU_CLASS = 'dfcm-menu'
    const TOAST_CLASS = 'dfcm-toast'

    /** The AppFrame conversation host, newest spelling first. */
    const COLUMN_SELECTOR = '#root [data-slot="main.conversation"], #root [data-slot="conversation"]'

    /** Extensions we recognise inside a card's text. */
    const EXT = 'md|markdown|mdx|xlsx|xls|xlsm|csv|tsv|docx|doc|pptx|ppt|pdf|txt|json|jsonl|json5|ps1|psm1|bat|cmd|sh|bash|zsh|py|ipynb|js|mjs|cjs|jsx|ts|tsx|vue|svelte|html|htm|css|scss|less|yaml|yml|toml|ini|conf|cfg|log|xml|sql|java|kt|c|h|cc|cpp|hpp|cs|go|rs|rb|php|lua|zip|7z|rar|tar|tgz|gz|bz2|xz|png|jpg|jpeg|gif|webp|bmp|ico|svg|tif|tiff|mp4|mov|avi|mkv|mp3|wav|flac|ogg|drawio|pem|crt|key|env|exe|dll|msi'
    const FILE_EXT = new RegExp(`\\.(?:${EXT})$`, 'i')
    /** A filename token: latin word chars, CJK, spaces, dots, dash, parens. */
    const NAME_RE = new RegExp(
      `[\\w\\u4e00-\\u9fa5][\\w\\u4e00-\\u9fa5 .()（）\\-\\[\\]]*\\.(?:${EXT})(?![\\w])`,
      'gi',
    )
    const ABS_RE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/
    /** Web links the menu can open in the browser or copy. */
    const URL_RE = /^(?:https?:\/\/|mailto:)[^\s"'<>`]+$/i
    /** Containers where a path-looking string is prose, not a file card. */
    const PROSE_SELECTOR = [
      'pre', 'code', 'kbd', 'samp',
      '[class*="markdown"]', '[class*="prose"]', '[class*="codeBlock"]',
      '[data-slot="conversation.chat.reasoning.body"]',
      '[class*="composer"]', '[class*="Composer"]', 'textarea', 'input',
    ].join(',')
    /** Proof that the clicked ancestor chain really is a file card. */
    const CARDISH_RE = /file|card|chip|token|attach|deliver|reference|artifact|asset|pill/i

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = `
.${MENU_CLASS}{
  position: fixed;
  z-index: 2147483000;
  min-width: 208px;
  padding: 5px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24));
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, #2b2b2b));
  box-shadow: 0 12px 32px rgba(0,0,0,.32), 0 2px 8px rgba(0,0,0,.18);
  color: var(--dsw-alias-label-primary, inherit);
  font: 13px/1.4 var(--dsw-font-sans, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
  user-select: none;
  -webkit-user-select: none;
  animation: dfcm-in 90ms ease-out;
}
@keyframes dfcm-in{ from{ opacity:0; transform:translateY(-2px) } to{ opacity:1; transform:none } }
.${MENU_CLASS} .dfcm-row{
  display: flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 9px 0 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  cursor: default;
  white-space: nowrap;
}
.${MENU_CLASS} .dfcm-row[data-disabled="true"]{ opacity: .42; pointer-events: none }
.${MENU_CLASS} .dfcm-row[data-hover="true"]{ background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)) }
.${MENU_CLASS} .dfcm-row svg{ width: 16px; height: 16px; flex: none; opacity: .82 }
.${MENU_CLASS} .dfcm-label{ flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis }
.${MENU_CLASS} .dfcm-hint{ flex: none; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); font-size: 12px }
.${MENU_CLASS} .dfcm-sep{ height: 1px; margin: 5px 6px; background: var(--dsw-alias-border-l1, rgba(127,127,127,.2)) }
.${MENU_CLASS} .dfcm-head{
  padding: 3px 9px 6px 8px;
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  font-size: 12px;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dfcm-sub{
  position: fixed;
  z-index: 2147483001;
  min-width: 196px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 5px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24));
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, #2b2b2b));
  box-shadow: 0 12px 32px rgba(0,0,0,.32), 0 2px 8px rgba(0,0,0,.18);
  color: var(--dsw-alias-label-primary, inherit);
  font: 13px/1.4 var(--dsw-font-sans, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
}
.dfcm-sub .dfcm-row{ display:flex; align-items:center; gap:10px; height:30px; padding:0 9px 0 8px; border-radius: var(--dsw-radius-sm, 6px) }
.dfcm-sub .dfcm-row[data-hover="true"]{ background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)) }
.dfcm-sub .dfcm-row[data-disabled="true"]{ opacity: .42; pointer-events: none }
.dfcm-sub img{ width: 16px; height: 16px; flex: none; object-fit: contain }
.${TOAST_CLASS}{
  position: fixed;
  left: 50%;
  bottom: 32px;
  transform: translateX(-50%);
  z-index: 2147483002;
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3, rgba(40,40,40,.96));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24));
  box-shadow: 0 8px 24px rgba(0,0,0,.3);
  color: var(--dsw-alias-label-primary, #eee);
  font: 13px/1.4 var(--dsw-font-sans, system-ui, "Microsoft YaHei", sans-serif);
  max-width: 70vw;
  pointer-events: none;
}
`

    /* ------------------------------------------------------------------ *
     * Icons (16px, currentColor, stroke style matching the native menus)
     * ------------------------------------------------------------------ */

    const ICONS = {
      open: 'M9 3H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4M10 3h7v7M17 3l-8 8',
      app: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
      folder: 'M3 7a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
      save: 'M12 3v10m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
      copy: 'M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
      link: 'M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1 1M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1-1',
      plus: 'M12 8v8m-4-4h8M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9A1.5 1.5 0 0 1 18.5 16H9l-5 4z',
    }

    function iconSvg(key) {
      const path = ICONS[key] ?? ICONS.open
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.6')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      p.setAttribute('d', path)
      svg.appendChild(p)
      return svg
    }

    /* ------------------------------------------------------------------ *
     * Host transport
     * ------------------------------------------------------------------ */

    function hostHttpBase() {
      if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '') {
        return document.baseURI
      }
      return 'http://127.0.0.1/'
    }

    function routeUrl(name) {
      try {
        return new URL(`file-menu/${name}`, hostHttpBase()).toString()
      } catch {
        return `/file-menu/${name}`
      }
    }

    async function post(name, payload) {
      try {
        const response = await fetch(routeUrl(name), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
        if (!response.ok) return { ok: false, error: `http ${response.status}` }
        const value = await response.json()
        return value !== null && typeof value === 'object' ? value : { ok: false, error: 'bad payload' }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    }

    /** Fire-and-forget breadcrumb; never awaited by the menu. */
    function report(entry) {
      void post('report', { version: VERSION, ...entry })
    }

    /* ------------------------------------------------------------------ *
     * DOM → file path resolution
     * ------------------------------------------------------------------ */

    function fiberOf(node) {
      for (const key of Object.keys(node)) {
        if (key.startsWith('__reactFiber$')) return node[key]
      }
      return undefined
    }

    function propsOf(node) {
      for (const key of Object.keys(node)) {
        if (key.startsWith('__reactProps$')) return node[key]
      }
      const fiber = fiberOf(node)
      return fiber?.memoizedProps
    }

    /** Path-ish keys on a props object, ordered from most to least specific. */
    const PATH_KEYS = [
      'absolutePath', 'fullPath', 'filePath', 'path', 'fsPath', 'filepath',
      'relativePath', 'relPath', 'href', 'url', 'src', 'name', 'fileName',
      'filename', 'title', 'label', 'displayName', 'basename',
    ]
    const SESSION_KEYS = ['sessionId', 'sessionID', 'agentId']

    function collectFromProps(props, bucket, depth, seen) {
      if (props === null || typeof props !== 'object' || depth > 2 || seen.has(props)) return
      seen.add(props)
      if (seen.size > 400) return
      for (const key of PATH_KEYS) {
        const value = props[key]
        if (typeof value === 'string' && value.length > 0 && value.length < 1024) {
          bucket.strings.push(value)
        }
      }
      for (const key of SESSION_KEYS) {
        const value = props[key]
        if (typeof value === 'string' && value.length >= 4 && bucket.sessionId === undefined) {
          bucket.sessionId = value
        } else if (value !== null && typeof value === 'object' && bucket.sessionId === undefined) {
          const id = value.id ?? value.sessionId
          if (typeof id === 'string' && id.length >= 4) bucket.sessionId = id
        }
      }
      for (const key of Object.keys(props)) {
        if (key === 'children' || key === 'style' || key === 'className' || key === 'key' || key === 'ref') continue
        const value = props[key]
        if (Array.isArray(value)) {
          if (depth < 1) {
            for (const item of value.slice(0, 16)) {
              if (item !== null && typeof item === 'object') collectFromProps(item, bucket, depth + 1, seen)
            }
          }
        } else if (value !== null && typeof value === 'object') {
          // React elements carry their props under `.props`.
          const nested = value.props !== undefined && typeof value.props === 'object' ? value.props : value
          collectFromProps(nested, bucket, depth + 1, seen)
        }
      }
    }

    function pushText(bucket, text) {
      if (typeof text !== 'string') return
      const value = text.trim()
      if (value === '' || value.length > 400) return
      bucket.texts.push(value)
    }

    function attributeStrings(node) {
      const out = []
      if (node.getAttribute === undefined) return out
      for (const name of ['data-path', 'data-file', 'data-file-path', 'data-filename', 'data-name', 'data-href', 'title', 'aria-label', 'href', 'download']) {
        const value = node.getAttribute(name)
        if (typeof value === 'string' && value !== '') out.push(value)
      }
      return out
    }

    function extractName(text) {
      NAME_RE.lastIndex = 0
      const match = NAME_RE.exec(text)
      if (match === null) return undefined
      return match[0].replace(/^[\s.,;:]+/, '').trim()
    }

    /**
     * Walk from the clicked node up to the conversation column and gather every
     * usable path hint. Returns `undefined` when the click did not land on a
     * file card, so the native menu keeps working everywhere else.
     */
    function resolveCard(target) {
      const element = target instanceof Element ? target : target?.parentElement
      if (element === null || element === undefined) return undefined
      const column = element.closest(COLUMN_SELECTOR)
      if (column === null) return undefined
      if (element.closest(PROSE_SELECTOR) !== null) return undefined

      const bucket = { strings: [], texts: [], sessionId: undefined }
      const seen = new Set()
      let node = element
      let cardish = false
      let classEvidence = false
      let levels = 0
      const names = []

      while (node !== null && levels < 10) {
        if (node === column) break
        const slot = node.getAttribute?.('data-slot') ?? ''
        const className = typeof node.className === 'string' ? node.className : ''
        const role = node.getAttribute?.('role') ?? ''
        const tag = node.tagName?.toLowerCase() ?? ''
        if (
          CARDISH_RE.test(className) || CARDISH_RE.test(slot) ||
          role === 'button' || tag === 'button' || tag === 'a' ||
          node.getAttribute?.('tabindex') !== null ||
          (node.querySelector?.('svg') ?? null) !== null ||
          (node.getAttribute?.('draggable') ?? '') === 'true'
        ) {
          cardish = true
        }
        if (CARDISH_RE.test(className) || CARDISH_RE.test(slot)) classEvidence = true
        for (const value of attributeStrings(node)) {
          bucket.strings.push(value)
          const name = extractName(value)
          if (name !== undefined) names.push(name)
        }
        const props = propsOf(node)
        if (props !== undefined) collectFromProps(props, bucket, 0, seen)
        // The immediate text of the card is the filename in both card families.
        pushText(bucket, node.textContent)
        names.push(extractName(node.textContent ?? ''))
        node = node.parentElement
        levels += 1
      }

      if (!cardish) return undefined

      const strings = bucket.strings.concat(bucket.texts).filter((value) => typeof value === 'string' && value !== '')
      const absolute = strings.find((value) => ABS_RE.test(value.trim()) && FILE_EXT.test(value.trim().replace(/[\\/]+$/, '')))
      const relative = strings.find((value) => {
        const trimmed = value.trim()
        return !ABS_RE.test(trimmed) && /[\\/]/.test(trimmed) && FILE_EXT.test(trimmed) && trimmed.length < 400
      })
      const name = (absolute ?? relative) !== undefined
        ? extractName(String(absolute ?? relative))
        : names.find((value) => typeof value === 'string' && value !== undefined) ?? extractName(element.textContent ?? '')

      // A name alone is weak evidence: ordinary prose can end in ".md". Require
      // card-shaped chrome in that case, so paragraphs keep the native menu.
      if (absolute === undefined && relative === undefined && !classEvidence) return undefined
      if (absolute === undefined && relative === undefined && name === undefined) return undefined

      return {
        absolute: absolute?.trim(),
        relative: relative?.trim(),
        name,
        sessionId: bucket.sessionId,
        debug: {
          level: levels,
          cardish,
          slot: element.closest('[data-slot]')?.getAttribute('data-slot') ?? '',
          className: (() => {
            const raw = typeof element.className === 'string' ? element.className : ''
            return raw.slice(0, 160)
          })(),
          absolute: absolute ?? null,
          relative: relative ?? null,
          name: name ?? null,
          strings: strings.slice(0, 6).map((value) => String(value).slice(0, 160)),
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * Web links
     *
     * Transcript links render as `<a href>` anchors (markdown links, citation
     * chips) and sometimes as bare URLs in prose. Electron's default menu has
     * no "copy link address", so both shapes become a link hit.
     * ------------------------------------------------------------------ */

    /** Accept only absolute web/mail targets; relative or script URLs are not links. */
    function normalizeUrl(raw) {
      const value = String(raw ?? '').trim()
      if (value === '') return undefined
      if (URL_RE.test(value)) return value
      if (value.startsWith('//')) return `https:${value}`
      return undefined
    }

    function urlHit(url, via, samples, text) {
      const host = (() => {
        try {
          return new URL(url).host
        } catch {
          return url.replace(/^mailto:/i, '')
        }
      })()
      const label = typeof text === 'string' && text.trim() !== '' ? text.trim().slice(0, 80) : host
      return {
        url,
        link: true,
        host,
        name: label,
        debug: { link: true, via, url: url.slice(0, 300), samples: samples ?? [] },
      }
    }

    /** The `<a href>` under the pointer, if it points at a web target. */
    function resolveLink(target) {
      const start = target instanceof Element ? target : target?.parentElement
      if (start === null || start === undefined) return undefined
      if (start.closest(COLUMN_SELECTOR) === null) return undefined
      if (isComposerNode(start)) return undefined
      const anchor = typeof start.closest === 'function' ? start.closest('a[href]') : null
      if (anchor === null) return undefined
      const url = normalizeUrl(anchor.getAttribute('href'))
      if (url === undefined) return undefined
      return urlHit(url, 'anchor', undefined, anchor.textContent ?? '')
    }

    /* ------------------------------------------------------------------ *
     * Inline file chips
     *
     * Markdown file references render as small chips: an icon plus the bare
     * file name (`</> client.js`). The text is not a path, so neither the card
     * ancestry walk nor the prose token check sees it. Two facts make it
     * recoverable: the icon proves the element is a file control, and the real
     * path sits in the chrome around it — a `title`/`aria-label` tooltip, a
     * data attribute, an `href`, or the fiber props of the renderer.
     * ------------------------------------------------------------------ */

    const CHIP_MAX_TEXT = 260
    const CHIP_ATTRS = [
      'title', 'aria-label', 'data-path', 'data-file-path', 'data-filepath',
      'data-abs-path', 'data-absolute-path', 'data-reference', 'href',
    ]

    /** `file:///G:/x` → `G:\x`; leaves other strings untouched. */
    function decodeFileUrl(value) {
      const text = String(value)
      if (!/^file:\/\//i.test(text)) return text
      try {
        return decodeURIComponent(text.replace(/^file:\/{2,3}/i, '')).replace(/\//g, '\\')
      } catch {
        return text.replace(/^file:\/{2,3}/i, '').replace(/\//g, '\\')
      }
    }

    /** Every absolute path hint found in `list`, in encounter order. */
    function absoluteCandidates(list) {
      const out = []
      for (const raw of list) {
        if (typeof raw !== 'string') continue
        const text = decodeFileUrl(raw.trim())
        if (text === '' || text.length > 400) continue
        if (!ABS_RE.test(text)) continue
        out.push(text)
      }
      return out
    }

    /**
     * Build a hit from one chip-shaped element. `text` is the element's whole
     * text (the file name as rendered); the path comes from its chrome.
     */
    function chipHitFrom(node, text, level) {
      const bucket = { strings: [], texts: [], sessionId: undefined }
      const props = propsOf(node)
      if (props !== undefined) collectFromProps(props, bucket, 0, new Set())

      const strings = []
      for (const name of CHIP_ATTRS) {
        const value = node.getAttribute?.(name)
        if (typeof value === 'string' && value !== '') strings.push(value)
      }
      strings.push(...attributeStrings(node))
      strings.push(...bucket.strings, ...bucket.texts, text)

      const name = extractName(text)
      const absolutes = absoluteCandidates(strings)
      const preferred = absolutes.find((value) => {
        const base = basenameOf(value)
        return name !== undefined && base.toLowerCase() === name.toLowerCase()
      })
      const absolute = preferred
        ?? absolutes.find((value) => FILE_EXT.test(value.replace(/[\\/]+$/, '')))
        ?? absolutes[0]

      const relative = absolute === undefined && /[\\/]/.test(text) && FILE_EXT.test(text) ? text : undefined
      // A bare name is only accepted when it is the element's entire text, so a
      // sentence that happens to mention a file keeps the browser menu.
      const bare = absolute === undefined && relative === undefined
        && name !== undefined && text.trim().toLowerCase() === name.trim().toLowerCase()
      if (absolute === undefined && relative === undefined && !bare) return undefined

      const normalized = absolute === undefined ? undefined : absolute.replace(/[\\/]+$/, '')
      return {
        absolute: normalized,
        relative,
        name: name ?? (normalized === undefined ? undefined : basenameOf(normalized)),
        isDir: normalized === undefined ? false : looksLikeDir(normalized),
        chip: true,
        sessionId: bucket.sessionId,
        debug: {
          chip: true,
          level,
          text: text.slice(0, 160),
          absolute: normalized ?? null,
          relative: relative ?? null,
          name: name ?? null,
          strings: strings.slice(0, 6).map((value) => String(value).slice(0, 160)),
        },
      }
    }

    /**
     * Resolve the chip under the pointer. Icon evidence is mandatory and is
     * inherited from inner nodes, so clicking the icon or the label both work.
     */
    function resolveChip(target) {
      const start = target instanceof Element ? target : target?.parentElement
      if (start === null || start === undefined) return undefined
      if (start.closest(COLUMN_SELECTOR) === null) return undefined
      if (isComposerNode(start)) return undefined

      let node = start
      let levels = 0
      let icon = false
      while (node !== null && node !== undefined && node !== document.body && levels < 5) {
        if (typeof node.closest === 'function' && node.closest(COLUMN_SELECTOR) === null) break
        if ((node.querySelector?.('svg, img') ?? null) !== null) icon = true
        if (icon) {
          const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
          if (text !== '' && text.length <= CHIP_MAX_TEXT && !/[\r\n]/.test(text)) {
            const hit = chipHitFrom(node, text, levels)
            if (hit !== undefined) return hit
          }
        }
        node = node.parentElement
        levels += 1
      }
      return undefined
    }

    /** Diagnostic only: what an icon-bearing element near the click looked like. */
    function chipProbe(target) {
      const start = target instanceof Element ? target : target?.parentElement
      if (start === null || start === undefined) return undefined
      let node = start
      let level = 0
      while (node !== null && node !== undefined && node !== document.body && level < 4) {
        if ((node.querySelector?.('svg, img') ?? null) !== null) {
          const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
          if (text !== '' && text.length <= CHIP_MAX_TEXT) {
            return {
              level,
              text: text.slice(0, 120),
              tag: node.tagName?.toLowerCase() ?? '',
              cls: (typeof node.className === 'string' ? node.className : '').slice(0, 100),
              attrs: ['title', 'aria-label', 'data-path', 'href'].map((name) => {
                const value = node.getAttribute?.(name)
                return typeof value === 'string' && value !== '' ? `${name}=${value.slice(0, 80)}` : ''
              }).filter(Boolean),
            }
          }
        }
        node = node.parentElement
        level += 1
      }
      return undefined
    }

    /* ------------------------------------------------------------------ *
     * Bare path tokens in prose
     *
     * The transcript prints paths as plain text (`E:\...\desktop`), usually as
     * inline code. Those are not cards, so the ancestry walk above finds
     * nothing — the click point does. `elementsFromPoint` yields the stack
     * under the cursor and the topmost element whose whole text is a path
     * wins. When a path sits inside a longer sentence, the caret expands to
     * the surrounding whitespace-delimited token instead.
     * ------------------------------------------------------------------ */

    const TOKEN_LEAD = /^[\s`"'“”‘’(<[{]+/
    const TOKEN_TAIL = /[\s`"“”‘’')\]}>]+$/
    const TOKEN_SENTENCE_TAIL = /[。，、；：！？…）】》」』"'`]+$/u
    const TOKEN_DELIM = /[\s"'`()（）【】《》，,;；：:。]/

    /** Trim the punctuation an inline path collects from the sentence around it. */
    function cleanToken(raw) {
      let value = String(raw ?? '').trim()
      if (value === '' || value.length > 400) return undefined
      if (/[\r\n\t]/.test(value)) return undefined
      value = value.replace(TOKEN_LEAD, '').replace(TOKEN_TAIL, '')
      value = value.replace(TOKEN_SENTENCE_TAIL, '').replace(/[.,;:]+$/, '').trim()
      if (value === '' || value.length > 400) return undefined
      if (URL_RE.test(value)) return value
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return undefined
      if (!ABS_RE.test(value)) return undefined
      return value
    }

    function basenameOf(path) {
      const parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/)
      return parts[parts.length - 1] ?? String(path)
    }

    /** Folder heuristic: a trailing separator, or an extension-less leaf. */
    function looksLikeDir(path) {
      return /[\\/]$/.test(path) || !FILE_EXT.test(path.replace(/[\\/]+$/, ''))
    }

    function isComposerNode(node) {
      const closest = node?.closest
      if (typeof closest !== 'function') return false
      try {
        return closest.call(node, '[class*="composer"], [class*="Composer"]') !== null
      } catch {
        return false
      }
    }

    function caretPoint(event) {
      try {
        if (typeof document.caretPositionFromPoint === 'function') {
          const position = document.caretPositionFromPoint(event.clientX, event.clientY)
          if (position !== null && position !== undefined) {
            return { node: position.offsetNode, offset: position.offset }
          }
        }
        if (typeof document.caretRangeFromPoint === 'function') {
          const range = document.caretRangeFromPoint(event.clientX, event.clientY)
          if (range !== null && range !== undefined) {
            return { node: range.startContainer, offset: range.startOffset }
          }
        }
      } catch {
        /* no caret information in this engine */
      }
      return undefined
    }

    function pathTokenAtCaret(event) {
      const caret = caretPoint(event)
      if (caret === undefined) return undefined
      const node = caret.node
      if (node === null || node === undefined || node.nodeType !== 3) return undefined
      const parent = node.parentElement
      if (parent === null || parent === undefined) return undefined
      if (parent.closest(COLUMN_SELECTOR) === null) return undefined
      if (isComposerNode(parent)) return undefined
      const data = String(node.data ?? '')
      const offset = Math.max(0, Math.min(data.length, caret.offset))
      let start = offset
      let end = offset
      while (start > 0 && !TOKEN_DELIM.test(data[start - 1])) start -= 1
      while (end < data.length && !TOKEN_DELIM.test(data[end])) end += 1
      return cleanToken(data.slice(start, end))
    }

    /**
     * Bare URLs in prose contain `:`, which the whitespace tokenizer splits on,
     * so scan the text node for a URL that covers the caret instead.
     */
    const URL_SCAN = /(?:https?:\/\/|mailto:)[^\s"'<>`（）【】《》，；。、！？…]+/gi
    const URL_TRAIL = /[.,;:!?。，；：！？、）】》」』"'`]+$/

    function urlAtCaret(event) {
      const caret = caretPoint(event)
      if (caret === undefined) return undefined
      const node = caret.node
      if (node === null || node === undefined || node.nodeType !== 3) return undefined
      const parent = node.parentElement
      if (parent === null || parent === undefined) return undefined
      if (parent.closest(COLUMN_SELECTOR) === null) return undefined
      if (isComposerNode(parent)) return undefined
      const data = String(node.data ?? '')
      const offset = Math.max(0, Math.min(data.length, caret.offset))
      URL_SCAN.lastIndex = 0
      let match = URL_SCAN.exec(data)
      while (match !== null) {
        const start = match.index
        const end = start + match[0].length
        if (offset >= start && offset <= end) {
          const url = match[0].replace(URL_TRAIL, '')
          return normalizeUrl(url)
        }
        match = URL_SCAN.exec(data)
      }
      return undefined
    }

    /**
     * Resolve the path under the pointer. Returns `{ path, samples }`;
     * `samples` is only used for the diagnostic log when nothing matched.
     */
    function pathTokenAtPoint(event) {
      const samples = []
      const points = typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(event.clientX, event.clientY)
        : []
      for (const node of points) {
        if (!(node instanceof Element)) continue
        if (node.closest(COLUMN_SELECTOR) === null) continue
        if (isComposerNode(node)) continue
        if (menuNode !== undefined && menuNode.contains(node)) continue
        const raw = node.textContent ?? ''
        if (samples.length < 3 && raw.trim() !== '') {
          samples.push({
            tag: node.tagName?.toLowerCase() ?? '',
            cls: (typeof node.className === 'string' ? node.className : '').slice(0, 60),
            text: raw.trim().slice(0, 90),
          })
        }
        const path = cleanToken(raw)
        if (path === undefined) continue
        return { path, samples }
      }
      const caret = pathTokenAtCaret(event)
      if (caret !== undefined) return { path: caret, samples }
      const url = urlAtCaret(event)
      if (url !== undefined) return { path: url, samples }
      return { path: undefined, samples }
    }

    function tokenHit(path, samples) {
      if (URL_RE.test(path)) return urlHit(path, 'token', samples)
      const isDir = looksLikeDir(path)
      const absolute = path.replace(/[\\/]+$/, '')
      return {
        absolute,
        name: basenameOf(absolute),
        isDir,
        token: true,
        sessionId: undefined,
        debug: { token: true, isDir, path: absolute, samples: samples ?? [] },
      }
    }

    /* ------------------------------------------------------------------ *
     * Plugin context accessors (all optional, all guarded)
     * ------------------------------------------------------------------ */

    let pluginCtx = undefined

    function service(key) {
      try {
        return pluginCtx?.get?.(key)
      } catch {
        return undefined
      }
    }

    function sessionRemote() {
      try {
        const remote = service('remote')
        const session = remote?.session
        if (session !== undefined && typeof session.openWorkspacePath === 'function') return session
      } catch {
        /* older assemblies may lack the namespace */
      }
      return undefined
    }

    /** The workspace root that owns `sessionId`, read fresh at click time. */
    function workspaceRootFor(sessionId, path) {
      try {
        const snapshot = service('workspaces')?.list?.getSnapshot?.()
        if (snapshot?.phase !== 'ready' || snapshot.state !== 'idle') return undefined
        const items = Array.isArray(snapshot.items) ? snapshot.items : []
        if (sessionId !== undefined) {
          const owned = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
          if (owned?.path !== undefined) return owned.path
        }
        if (typeof path === 'string') {
          const lower = path.toLowerCase()
          const containing = items.filter((item) => typeof item.path === 'string' && lower.startsWith(item.path.toLowerCase()))
          containing.sort((a, b) => b.path.length - a.path.length)
          if (containing.length > 0) return containing[0].path
        }
      } catch {
        /* no workspaces service in this assembly */
      }
      return undefined
    }

    /* --- session identity (React fiber reflection) --- */

    function reactFiberOf(node) {
      let current = node
      let hops = 0
      while (current !== null && current !== undefined && hops < 6) {
        for (const key of Object.keys(current)) {
          if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
            return current[key]
          }
        }
        current = current.parentElement
        hops += 1
      }
      return undefined
    }

    /**
     * Slot components get `sessionId` as a standard prop, so the fiber chain of
     * the clicked node knows which session rendered it. This is the only
     * session-identity source that works for bare prose paths, which carry no
     * card props at all.
     */
    function sessionIdFromFiber(node) {
      let fiber = reactFiberOf(node)
      let depth = 0
      while (fiber !== null && fiber !== undefined && depth < 80) {
        const props = fiber.memoizedProps ?? fiber.pendingProps
        if (props !== null && typeof props === 'object') {
          for (const key of ['sessionId', 'sessionID']) {
            const value = props[key]
            if (typeof value === 'string' && value !== '') return value
          }
          const nested = props.session
          if (nested !== null && typeof nested === 'object' && typeof nested.id === 'string' && nested.id !== '') {
            return nested.id
          }
        }
        fiber = fiber.return
        depth += 1
      }
      return undefined
    }

    function sessionIdFor(hit) {
      if (hit?.sessionId !== undefined) return hit.sessionId
      if (hit?.node !== undefined) {
        const fromFiber = sessionIdFromFiber(hit.node)
        if (fromFiber !== undefined) {
          hit.sessionId = fromFiber
          return fromFiber
        }
      }
      try {
        const sessions = service('sessions')
        const current = sessions?.current ?? sessions?.active
        const id = typeof current === 'string' ? current : current?.id
        if (typeof id === 'string' && id !== '') return id
      } catch {
        /* ignore */
      }
      try {
        const snapshot = service('workspaces')?.list?.getSnapshot?.()
        const items = Array.isArray(snapshot?.items) ? snapshot.items : []
        const owners = items.filter((item) => Array.isArray(item.sessionIds) && item.sessionIds.length === 1)
        if (owners.length === 1) return owners[0].sessionIds[0]
      } catch {
        /* ignore */
      }
      return undefined
    }

    /* ------------------------------------------------------------------ *
     * Path resolution (client cache + host fallback)
     * ------------------------------------------------------------------ */

    const resolved = new WeakMap()

    async function absolutePathOf(hit) {
      if (hit.absolute !== undefined) return hit.absolute
      const cached = resolved.get(hit)
      if (cached !== undefined) return cached
      const root = workspaceRootFor(hit.sessionId, undefined)
      const candidates = []
      if (hit.relative !== undefined) candidates.push(hit.relative)
      if (hit.name !== undefined) candidates.push(hit.name)
      const result = await post('resolve', { workspaceRoot: root, candidates })
      if (result.ok && typeof result.path === 'string') {
        resolved.set(hit, result.path)
        return result.path
      }
      return undefined
    }

    /* ------------------------------------------------------------------ *
     * Toast
     * ------------------------------------------------------------------ */

    let toastTimer = 0

    function toast(text) {
      if (typeof document === 'undefined') return
      let node = document.querySelector(`.${TOAST_CLASS}`)
      if (node === null) {
        node = document.createElement('div')
        node.className = TOAST_CLASS
        document.body.appendChild(node)
      }
      node.textContent = text
      if (toastTimer !== 0) window.clearTimeout(toastTimer)
      toastTimer = window.setTimeout(() => {
        toastTimer = 0
        node.remove()
      }, 2600)
    }

    /* ------------------------------------------------------------------ *
     * Actions
     * ------------------------------------------------------------------ */

    async function openPath(path, application) {
      const remote = sessionRemote()
      if (remote !== undefined) {
        try {
          const result = await remote.openWorkspacePath(application === undefined ? { path } : { path, application })
          if (result?.ok === true) return true
        } catch {
          /* fall through to the native launch */
        }
      }
      const result = await post('open', { path, action: 'open' })
      return result.ok === true
    }

    /** Hand a web URL to the desktop's default browser (host half validates it). */
    async function openUrl(url) {
      try {
        const result = await post('link', { url })
        return result.ok === true
      } catch {
        return false
      }
    }

    async function revealPath(path) {
      const remote = sessionRemote()
      if (remote !== undefined) {
        try {
          const result = await remote.openWorkspacePath({ path, action: 'reveal' })
          if (result?.ok === true) return true
        } catch {
          /* fall through */
        }
      }
      const result = await post('open', { path, action: 'reveal' })
      return result.ok === true
    }

    async function applicationsFor(path) {
      const remote = sessionRemote()
      if (remote === undefined || typeof remote.workspacePathApplications !== 'function') return []
      try {
        const result = await remote.workspacePathApplications({ path })
        if (result?.ok !== true || !Array.isArray(result.value)) return []
        return result.value
          .filter((app) => app !== null && typeof app === 'object' && typeof app.name === 'string')
          .map((app) => ({
            id: typeof app.id === 'string' ? app.id : app.name,
            name: app.name,
            icon: typeof app.icon === 'string' ? app.icon : undefined,
            isDefault: app.default === true,
          }))
      } catch {
        return []
      }
    }

    function base64Blob(base64) {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return new Blob([bytes])
    }

    async function savePathAs(path, name) {
      // Preferred path: the browser file picker writes the bytes itself, so no
      // target path ever needs to travel back to the host.
      if (typeof window.showSaveFilePicker === 'function') {
        let handle
        try {
          handle = await window.showSaveFilePicker({ suggestedName: name, types: [] })
        } catch (error) {
          if (error?.name === 'AbortError') return 'cancelled'
          handle = undefined
        }
        if (handle !== undefined) {
          const read = await post('read', { path })
          if (read.ok === true && typeof read.base64 === 'string') {
            const writable = await handle.createWritable()
            await writable.write(base64Blob(read.base64))
            await writable.close()
            return 'saved'
          }
        }
      }
      const result = await post('save', { path })
      if (result.ok !== true) return 'failed'
      if (result.cancelled === true) return 'cancelled'
      return result.saved === true ? 'saved' : 'failed'
    }

    async function copyPath(text) {
      try {
        if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* fall through to the host clipboard */
      }
      const result = await post('clip', { text })
      return result.ok === true
    }

    /* --- composer insert --- */

    /** Write `text` into the session draft through the supported draft store. */
    function writeDraft(sessionId, text) {
      try {
        const actx = service('sessions')?.scope?.(sessionId)
        if (actx === undefined) return false
        const conversation = service('conversation')
        const input = conversation?.input?.for?.(actx)
        const before = input?.state?.getSnapshot?.()
        if (before === undefined || before.draftRev === undefined) return false
        if (typeof input.setDraft !== 'function') return false
        const draft = typeof before.draft === 'string' ? before.draft : ''
        const joined = `${draft}${draft === '' || /\s$/.test(draft) ? '' : ' '}${text} `
        input.setDraft(joined)
        const after = input.state.getSnapshot()
        return after.draftRev !== before.draftRev
      } catch {
        return false
      }
    }

    /** The composer editor: the lowest editable box on screen. */
    function composerEditor() {
      let best
      let bestTop = -Infinity
      for (const node of document.querySelectorAll('[contenteditable="true"], textarea')) {
        const rect = node.getBoundingClientRect()
        if (rect.width < 80 || rect.height < 8) continue
        if (rect.bottom < window.innerHeight * 0.4) continue
        if (node.getAttribute('aria-hidden') === 'true' || node.disabled === true) continue
        if (rect.top <= bestTop) continue
        bestTop = rect.top
        best = node
      }
      return best
    }

    function insertIntoComposerDom(text) {
      const editor = composerEditor()
      if (editor === undefined) return false
      const suffix = `${text} `
      try {
        editor.focus()
        if (editor instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          const current = editor.value
          const next = `${current}${current === '' || /\s$/.test(current) ? '' : ' '}${suffix}`
          if (typeof setter === 'function') setter.call(editor, next)
          else editor.value = next
          editor.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }
        if (editor.isContentEditable === true) {
          const selection = window.getSelection()
          if (selection !== null) {
            const range = document.createRange()
            range.selectNodeContents(editor)
            range.collapse(false)
            selection.removeAllRanges()
            selection.addRange(range)
          }
          if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, suffix)) {
            return true
          }
          editor.textContent = `${editor.textContent ?? ''}${suffix}`
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: suffix }))
          return true
        }
      } catch {
        return false
      }
      return false
    }

    /**
     * "添加到对话框": append the absolute path of the clicked item to the current
     * session's draft. The draft store is tried first, the DOM editor second.
     */
    async function addToComposer(hit) {
      const path = await absolutePathOf(hit)
      if (path === undefined) {
        toast('找不到该路径')
        report({ event: 'insert-no-path', debug: hit.debug })
        return
      }
      const text = hit.isDir === true ? `${path}\\` : path
      const sessionId = sessionIdFor(hit)
      if (sessionId !== undefined && writeDraft(sessionId, text)) {
        toast('路径已加入对话框')
        return
      }
      if (insertIntoComposerDom(text)) {
        toast('路径已加入对话框')
        report({ event: 'insert-dom', sessionId: sessionId ?? null, path })
        return
      }
      toast('无法写入对话框')
      report({ event: 'insert-failed', sessionId: sessionId ?? null, path })
    }

    /* ------------------------------------------------------------------ *
     * Menu
     * ------------------------------------------------------------------ */

    let menuNode
    let submenuNode
    let submenuFor
    let activeHit

    function closeSubmenu() {
      submenuFor = undefined
      if (submenuNode !== undefined) {
        submenuNode.remove()
        submenuNode = undefined
      }
    }

    function closeMenu() {
      closeSubmenu()
      if (menuNode !== undefined) {
        menuNode.remove()
        menuNode = undefined
      }
      activeHit = undefined
    }

    function row(spec) {
      const element = document.createElement('div')
      element.className = 'dfcm-row'
      element.dataset.id = spec.id
      if (spec.disabled === true) element.dataset.disabled = 'true'
      element.appendChild(iconSvg(spec.icon))
      const label = document.createElement('span')
      label.className = 'dfcm-label'
      label.textContent = spec.label
      element.appendChild(label)
      if (spec.hint !== undefined && spec.hint !== '') {
        const hint = document.createElement('span')
        hint.className = 'dfcm-hint'
        hint.textContent = spec.hint
        element.appendChild(hint)
      }
      element.addEventListener('pointerenter', () => {
        for (const other of menuNode?.querySelectorAll('.dfcm-row') ?? []) other.dataset.hover = 'false'
        element.dataset.hover = 'true'
        if (spec.submenu === true) showApplications(element, activeHit)
        else closeSubmenu()
      })
      element.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (spec.disabled === true) return
        if (spec.submenu === true) {
          showApplications(element, activeHit)
          return
        }
        void runAction(spec.id)
      })
      return element
    }

    function separator() {
      const element = document.createElement('div')
      element.className = 'dfcm-sep'
      return element
    }

    async function showApplications(anchor, hit) {
      if (submenuNode !== undefined && submenuFor === anchor) return
      closeSubmenu()
      submenuFor = anchor
      const sub = document.createElement('div')
      sub.className = 'dfcm-sub'
      const loading = document.createElement('div')
      loading.className = 'dfcm-row'
      loading.dataset.disabled = 'true'
      loading.textContent = '正在读取应用列表…'
      sub.appendChild(loading)
      document.body.appendChild(sub)
      const rect = anchor.getBoundingClientRect()
      place(sub, rect.right + 4, rect.top - 5)
      submenuNode = sub

      if (hit === undefined) return
      const path = await absolutePathOf(hit)
      if (path === undefined) {
        sub.remove()
        submenuNode = undefined
        return
      }
      const apps = await applicationsFor(path)
      if (submenuNode !== sub) return
      sub.textContent = ''
      sub.appendChild(subRow({ label: '系统默认应用', icon: 'open', isDefault: true, action: () => openPath(path) }))
      if (apps.length === 0) {
        sub.appendChild(subRow({ label: '（没有找到其他可打开的应用）', disabled: true }))
        return
      }
      sub.appendChild(separator())
      for (const app of apps) {
        sub.appendChild(subRow({
          label: app.name,
          icon: 'app',
          image: app.icon,
          isDefault: app.isDefault,
          action: () => openPath(path, app.id),
        }))
      }
    }

    function subRow(spec) {
      const element = document.createElement('div')
      element.className = 'dfcm-row'
      if (spec.disabled === true) element.dataset.disabled = 'true'
      if (spec.image !== undefined) {
        const image = document.createElement('img')
        image.src = spec.image
        image.alt = ''
        image.onerror = () => {
          image.replaceWith(iconSvg(spec.icon ?? 'app'))
        }
        element.appendChild(image)
      } else if (spec.icon !== undefined) {
        element.appendChild(iconSvg(spec.icon))
      }
      const label = document.createElement('span')
      label.className = 'dfcm-label'
      label.textContent = spec.label
      element.appendChild(label)
      if (spec.isDefault === true) {
        const hint = document.createElement('span')
        hint.className = 'dfcm-hint'
        hint.textContent = '默认'
        element.appendChild(hint)
      }
      element.addEventListener('pointerenter', () => {
        for (const other of element.parentElement?.children ?? []) other.dataset.hover = 'false'
        element.dataset.hover = 'true'
      })
      element.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (spec.disabled === true) return
        closeMenu()
        void spec.action()
      })
      return element
    }

    function place(node, x, y) {
      node.style.left = `${Math.round(x)}px`
      node.style.top = `${Math.round(y)}px`
      const rect = node.getBoundingClientRect()
      const margin = 8
      let left = x
      let top = y
      if (left + rect.width > window.innerWidth - margin) left = Math.max(margin, x - rect.width)
      if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - rect.height - margin)
      node.style.left = `${Math.round(left)}px`
      node.style.top = `${Math.round(top)}px`
    }

    async function runAction(id) {
      const hit = activeHit
      closeMenu()
      if (hit === undefined) return
      if (hit.link === true) {
        if (id === 'copyLink') {
          const ok = await copyPath(hit.url)
          toast(ok ? '链接已复制' : '复制失败')
          return
        }
        if (id === 'openLink') {
          const ok = await openUrl(hit.url)
          if (!ok) toast('打开链接失败')
          return
        }
        return
      }
      const path = await absolutePathOf(hit)
      if (path === undefined) {
        toast('找不到该文件的绝对路径')
        report({ event: 'action-no-path', action: id, debug: hit.debug })
        return
      }
      switch (id) {
        case 'open': {
          const ok = await openPath(path)
          if (!ok) toast('打开失败')
          return
        }
        case 'reveal': {
          const ok = await revealPath(path)
          if (!ok) toast('定位失败')
          return
        }
        case 'save': {
          const status = await savePathAs(path, hit.name ?? '')
          if (status === 'saved') toast('已保存')
          else if (status === 'failed') toast('另存为失败')
          return
        }
        case 'copy': {
          const ok = await copyPath(path)
          toast(ok ? '路径已复制' : '复制失败')
          return
        }
        case 'insert': {
          await addToComposer(hit)
          return
        }
        default:
          return
      }
    }

    function openMenu(x, y, hit) {
      closeMenu()
      activeHit = hit
      const menu = document.createElement('div')
      menu.className = MENU_CLASS
      menu.setAttribute('role', 'menu')

      const head = document.createElement('div')
      head.className = 'dfcm-head'
      const isDir = hit.isDir === true

      if (hit.link === true) {
        head.textContent = hit.url.length > 68 ? `${hit.url.slice(0, 65)}…` : hit.url
        head.title = hit.url
        menu.appendChild(head)
        menu.appendChild(row({ id: 'openLink', label: '打开链接', icon: 'open' }))
        menu.appendChild(separator())
        menu.appendChild(row({ id: 'copyLink', label: '复制链接地址', icon: 'link' }))
        document.body.appendChild(menu)
        menuNode = menu
        place(menu, x, y)
        return
      }

      head.textContent = isDir
        ? `${hit.name ?? hit.absolute ?? ''}/`
        : hit.name ?? hit.relative ?? hit.absolute ?? ''
      menu.appendChild(head)

      // Folders have no bytes to save, so `另存为` is files-only. `打开` and
      // `打开方式…` are gone: `打开文件夹` plus the system association cover
      // every launch case the user actually needs.
      menu.appendChild(row({ id: 'reveal', label: '打开文件夹', icon: 'folder' }))
      menu.appendChild(row({ id: 'save', label: '另存为', icon: 'save', disabled: isDir }))
      menu.appendChild(separator())
      menu.appendChild(row({ id: 'copy', label: '复制路径', icon: 'copy' }))
      menu.appendChild(separator())
      menu.appendChild(row({
        id: 'insert',
        label: '添加到对话框',
        icon: 'plus',
        disabled: sessionIdFor(hit) === undefined,
        hint: sessionIdFor(hit) === undefined ? '无会话' : '',
      }))

      document.body.appendChild(menu)
      menuNode = menu
      place(menu, x, y)
    }

    /* ------------------------------------------------------------------ *
     * Global listeners
     * ------------------------------------------------------------------ */

    function onContextMenu(event) {
      if (event.defaultPrevented) return
      if (menuNode !== undefined && menuNode.contains(event.target)) return

      let hit = resolveCard(event.target)
      let samples
      if (hit === undefined) hit = resolveLink(event.target)
      if (hit === undefined) hit = resolveChip(event.target)
      if (hit === undefined) {
        const token = pathTokenAtPoint(event)
        samples = token.samples
        if (token.path !== undefined) hit = tokenHit(token.path, samples)
      }
      if (hit === undefined) {
        if (samples !== undefined && samples.length > 0) {
          report({ event: 'token-miss', samples })
        } else {
          const probe = chipProbe(event.target)
          if (probe !== undefined) report({ event: 'chip-miss', probe })
        }
        if (menuNode !== undefined) closeMenu()
        return
      }
      // `preventDefault` has to happen inside the dispatch, before any await.
      event.preventDefault()
      event.stopPropagation()
      // Keep the clicked node: the fiber chain off it is how the session id is
      // recovered later (nothing in the DOM carries it for prose paths).
      hit.node = event.target instanceof Element ? event.target : event.target?.parentElement
      report({
        event: hit.link === true ? 'link-hit'
          : hit.token === true ? 'token-hit'
            : hit.chip === true ? 'chip-hit'
              : 'hit',
        debug: hit.debug,
      })
      openMenu(event.clientX, event.clientY, hit)
    }

    function onPointerDown(event) {
      if (menuNode === undefined) return
      if (menuNode.contains(event.target)) return
      if (submenuNode !== undefined && submenuNode.contains(event.target)) return
      closeMenu()
    }

    function onKeyDown(event) {
      if (event.key === 'Escape' && menuNode !== undefined) {
        event.preventDefault()
        closeMenu()
      }
    }

    function onScrollOrResize() {
      if (menuNode !== undefined) closeMenu()
    }

    /* ------------------------------------------------------------------ *
     * Module contract
     * ------------------------------------------------------------------ */

    return {
      inject: ['remote', 'sessions', 'workspaces'],
      apply(ctx) {
        pluginCtx = ctx
        if (typeof document === 'undefined') return

        ctx.effect(() => {
          let node = document.getElementById(STYLE_ID)
          if (node === null) {
            node = document.createElement('style')
            node.id = STYLE_ID
            node.setAttribute('data-plugin-css', 'dsh-file-context-menu')
            document.head.appendChild(node)
          }
          node.textContent = CSS
          return () => {
            node.remove()
          }
        }, 'fileContextMenu.styles')

        ctx.effect(() => {
          const listeners = [
            ['contextmenu', onContextMenu, true],
            ['pointerdown', onPointerDown, true],
            ['keydown', onKeyDown, true],
            ['scroll', onScrollOrResize, true],
            ['wheel', onScrollOrResize, true],
            ['resize', onScrollOrResize, false],
            ['blur', onScrollOrResize, false],
          ]
          for (const [type, handler, capture] of listeners) {
            window.addEventListener(type, handler, capture)
          }
          return () => {
            for (const [type, handler, capture] of listeners) {
              window.removeEventListener(type, handler, capture)
            }
            closeMenu()
          }
        }, 'fileContextMenu.listeners')

        report({
          event: 'load',
          remote: sessionRemote() !== undefined,
          conversationColumn: typeof document.querySelector === 'function' ? document.querySelector(COLUMN_SELECTOR) !== null : false,
        })

        // The Remote namespace can materialize after the client assembly boots,
        // so re-probe once the page has settled. The log is the only place this
        // shape is visible without devtools open.
        ctx.effect(() => {
          const timers = [2500, 9000].map((delay) => window.setTimeout(() => {
            let keys = []
            let hasSession = false
            let hasOpen = false
            try {
              const remote = service('remote')
              keys = remote !== undefined && remote !== null ? Object.keys(remote) : []
              hasSession = remote?.session !== undefined && remote?.session !== null
              hasOpen = typeof remote?.session?.openWorkspacePath === 'function'
            } catch (error) {
              keys = [`throw:${String(error).slice(0, 120)}`]
            }
            report({ event: 'probe', remote: sessionRemote() !== undefined, keys, hasSession, hasOpen })
          }, delay))
          return () => {
            for (const timer of timers) window.clearTimeout(timer)
          }
        }, 'fileContextMenu.probe')
      },
    }
  },
})
