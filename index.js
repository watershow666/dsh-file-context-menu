/**
 * Host half of `dsh-file-context-menu`.
 *
 * The client half cannot touch the file system (the DSH client runtime has no
 * `fs`, no `shell` and no clipboard service), so every system operation the
 * right-click menu offers lands here on a small private HTTP surface:
 *
 *   POST /file-menu/open     Launch a file with its default handler, or reveal
 *                            it in File Explorer (`action: 'reveal'`).
 *   POST /file-menu/read     Base64 bytes of one file (the `showSaveFilePicker`
 *                            path writes them itself; no target path needed).
 *   POST /file-menu/save     Native Save-As dialog (PowerShell SaveFileDialog)
 *                            followed by a copy — used when the browser picker
 *                            is unavailable.
 *   POST /file-menu/resolve  Turn a bare name or workspace-relative path into an
 *                            absolute path, using the workspace root the client
 *                            sends along.
 *   POST /file-menu/clip     Clipboard fallback (navigator.clipboard can be
 *                            blocked by the shell).
 *   POST /file-menu/report   Diagnostic breadcrumb appended to a log file.
 *
 * All routes run behind `ctx.connection.requestRejection` — the same browser
 * trust fence every DSH plugin route uses — so a random local process cannot
 * drive them.
 */
import { spawn } from 'node:child_process'
import { appendFile, copyFile, readdir, readFile, stat } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'

export const name = 'dsh-file-context-menu'
export const inject = ['webServer', 'connection']

/** Appended breadcrumbs the client posts (`/file-menu/report`) live here. */
const LOG_PATH = join(tmpdir(), 'dsh-file-context-menu.log')

/** Body cap for the JSON routes (bytes). */
const MAX_BODY = 1 << 20
/** Byte cap for `/read` — larger files take the Save-As dialog path instead. */
const MAX_READ = 64 * 1024 * 1024
/** Directory-scan caps for name resolution. */
const MAX_SCAN_ENTRIES = 20000
const MAX_SCAN_DEPTH = 8
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.pnpm', '.svn', '.hg', 'dist', 'build', 'out',
  '.next', '.cache', '.turbo', 'coverage', '__pycache__', '.venv', 'venv',
])

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'])

/* -------------------------------------------------------------------------- *
 * Small helpers
 * -------------------------------------------------------------------------- */

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

/** Read a JSON request body, or `undefined` when it is not valid JSON. */
async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/** A path string we are willing to hand to a native process. */
function cleanPath(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^"+|"+$/g, '')
  if (trimmed === '' || trimmed.length > 4096) return undefined
  return normalize(trimmed)
}

/** Absolute only: the client never gets to drive relative paths by accident. */
function absolutePath(value) {
  const path = cleanPath(value)
  if (path === undefined) return undefined
  return isAbsolute(path) ? path : undefined
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function logLine(entry) {
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true })
    await appendFile(LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    /* diagnostics must never break the feature */
  }
}

/** Run PowerShell and return its trimmed stdout ('' on any failure). */
function powershell(script, env) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch {
      resolve('')
      return
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', () => {})
    child.on('error', () => resolve(''))
    child.on('close', (code) => resolve(code === 0 ? out.trim() : ''))
    setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
    }, 120000).unref()
  })
}

/* -------------------------------------------------------------------------- *
 * Name resolution
 * -------------------------------------------------------------------------- */

async function findByName(root, wanted, budget) {
  const target = wanted.toLowerCase()
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()
    if (depth > MAX_SCAN_DEPTH) continue
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (budget.used++ > MAX_SCAN_ENTRIES) return undefined
      const full = join(dir, entry.name)
      if (entry.isFile()) {
        if (entry.name.toLowerCase() === target) return full
      } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        queue.push({ dir: full, depth: depth + 1 })
      }
    }
  }
  return undefined
}

/**
 * Name search is a directory walk, so repeated right-clicks on the same chip
 * would pay for it every time. Cache per (root, name) for a minute.
 */
const NAME_CACHE_TTL = 60000
const NAME_CACHE_MAX = 256
const nameCache = new Map()

async function findByNameCached(root, wanted) {
  const key = `${root.toLowerCase()}|${wanted.toLowerCase()}`
  const now = Date.now()
  const cached = nameCache.get(key)
  if (cached !== undefined && now - cached.at < NAME_CACHE_TTL) return cached.path
  const found = await findByName(root, wanted, { used: 0 })
  if (nameCache.size >= NAME_CACHE_MAX) nameCache.clear()
  nameCache.set(key, { at: now, path: found })
  return found
}

async function resolveCandidate(request) {
  const root = absolutePath(request.workspaceRoot)
  const candidates = Array.isArray(request.candidates) ? request.candidates : []
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue
    const value = raw.trim().replace(/^"+|"+$/g, '')
    if (value === '') continue
    if (isAbsolute(value)) {
      const path = normalize(value)
      if (existsSync(path)) return { path, via: 'absolute' }
      continue
    }
    if (root !== undefined) {
      const path = normalize(join(root, value))
      if (existsSync(path)) return { path, via: 'workspace-relative' }
    }
  }
  // Last resort: a bare file name, searched inside the workspace.
  const bare = candidates
    .map((raw) => (typeof raw === 'string' ? basename(raw.replace(/\\/g, '/').trim()) : ''))
    .find((value) => value !== '')
  if (root !== undefined && bare !== undefined) {
    const found = await findByNameCached(root, bare)
    if (found !== undefined) return { path: found, via: 'workspace-search' }
  }
  return { path: undefined }
}

/* -------------------------------------------------------------------------- *
 * Native actions
 * -------------------------------------------------------------------------- */

function launchOpen(path) {
  spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-Command', 'Start-Process -LiteralPath $env:DSH_FCM_TARGET',
  ], {
    env: { ...process.env, DSH_FCM_TARGET: path },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref()
}

/** Only absolute web/mail targets may reach the shell. */
const ALLOWED_URL = /^(?:https?:\/\/|mailto:)[^\s"'<>`]+$/i

function launchUrl(url) {
  spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-Command', 'Start-Process $env:DSH_FCM_URL',
  ], {
    env: { ...process.env, DSH_FCM_URL: url },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref()
}

function launchReveal(path) {
  // `explorer.exe /select,"<path>"` — one argument, no shell involved.
  spawn('explorer.exe', [`/select,${path}`], { detached: true, stdio: 'ignore' }).unref()
}

async function saveAs(path) {
  const directory = dirname(path)
  const fileName = basename(path)
  const extension = extname(path)
  const filter = extension === ''
    ? 'All files (*.*)|*.*'
    : `${extension.slice(1).toUpperCase()} files (*${extension})|*${extension}|All files (*.*)|*.*`
  const stdout = await powershell(
    [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$dialog = New-Object System.Windows.Forms.SaveFileDialog',
      '$dialog.FileName = $env:DSH_FCM_NAME',
      '$dialog.InitialDirectory = $env:DSH_FCM_DIR',
      '$dialog.Filter = $env:DSH_FCM_FILTER',
      '$dialog.OverwritePrompt = $true',
      '$dialog.Title = "另存为"',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }',
    ].join('; '),
    { DSH_FCM_NAME: fileName, DSH_FCM_DIR: directory, DSH_FCM_FILTER: filter },
  )
  const target = cleanPath(stdout)
  if (target === undefined) return { saved: false, cancelled: true }
  if (normalize(target) === normalize(path)) return { saved: true, path: target, same: true }
  await copyFile(path, target)
  return { saved: true, path: target }
}

/* -------------------------------------------------------------------------- *
 * Route handler
 * -------------------------------------------------------------------------- */

function routeKey(url) {
  const path = (url ?? '').split('?')[0].replace(/\/+$/, '')
  const marker = '/file-menu'
  const index = path.indexOf(marker)
  if (index < 0) return ''
  return path.slice(index + marker.length).replace(/^\//, '')
}

async function handle(ctx, req, res) {
  if (ctx.connection.requestRejection(req) !== undefined) {
    json(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  const route = routeKey(req.url)
  const body = await readJson(req)
  if (body === undefined) {
    json(res, 400, { ok: false, error: 'invalid body' })
    return
  }

  switch (route) {
    case 'open': {
      const path = absolutePath(body.path)
      if (path === undefined || !existsSync(path)) {
        json(res, 200, { ok: false, error: 'not found' })
        return
      }
      try {
        if (body.action === 'reveal') launchReveal(path)
        else launchOpen(path)
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 200, { ok: false, error: String(error) })
      }
      return
    }

    case 'link': {
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      if (url.length > 2048 || !ALLOWED_URL.test(url)) {
        json(res, 200, { ok: false, error: 'invalid url' })
        return
      }
      try {
        launchUrl(url)
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 200, { ok: false, error: String(error) })
      }
      return
    }

    case 'read': {
      const path = absolutePath(body.path)
      if (path === undefined || !(await isFile(path))) {
        json(res, 200, { ok: false, error: 'not a file' })
        return
      }
      const info = await stat(path)
      if (info.size > MAX_READ) {
        json(res, 200, { ok: false, error: 'too large', size: info.size })
        return
      }
      const bytes = await readFile(path)
      json(res, 200, { ok: true, base64: bytes.toString('base64'), name: basename(path) })
      return
    }

    case 'save': {
      const path = absolutePath(body.path)
      if (path === undefined || !(await isFile(path))) {
        json(res, 200, { ok: false, error: 'not a file' })
        return
      }
      try {
        const result = await saveAs(path)
        json(res, 200, { ok: true, ...result })
      } catch (error) {
        json(res, 200, { ok: false, error: String(error) })
      }
      return
    }

    case 'resolve': {
      const result = await resolveCandidate({
        workspaceRoot: body.workspaceRoot,
        candidates: body.candidates,
      })
      json(res, 200, { ok: true, ...result })
      return
    }

    case 'clip': {
      const text = typeof body.text === 'string' ? body.text.slice(0, 32768) : ''
      if (text === '') {
        json(res, 200, { ok: false, error: 'empty' })
        return
      }
      await powershell('Set-Clipboard -Value $env:DSH_FCM_CLIP', { DSH_FCM_CLIP: text })
      // Set-Clipboard prints nothing, so success is verified by reading back.
      const back = await powershell('Get-Clipboard -Raw')
      json(res, 200, { ok: back.trim() === text.trim() })
      return
    }

    case 'report': {
      await logLine({ kind: 'client', ...body })
      json(res, 200, { ok: true })
      return
    }

    default:
      json(res, 404, { ok: false, error: 'unknown route' })
  }
}

function stdoutsEqual(a, b) {
  return a === b
}

export function apply(ctx) {
  void logLine({ kind: 'host', event: 'apply', pid: process.pid, log: LOG_PATH })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/file-menu',
      handler: (req, res) => handle(ctx, req, res).catch((error) => {
        try {
          json(res, 500, { ok: false, error: String(error) })
        } catch {
          /* response already gone */
        }
      }),
    }),
    'dsh-file-context-menu: /file-menu route',
  )
}

/* Exported for tests / diagnostics. */
export { LOG_PATH, resolveCandidate }
