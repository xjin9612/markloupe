'use strict'
// Service worker：content script 無權或不該自己做的事（讀本機檔案與資料夾、寫回任務、讀擴充功能內的檔案），以及快捷鍵與設定同步
importScripts('/src/shared/settings.js', '/src/shared/i18n.js', '/src/shared/roots.js', '/src/shared/hash.js', '/src/shared/lines.js', '/src/shared/web-access.js')

// 首次安裝：開啟引導頁（說明如何開啟「允許存取檔案網址」）；更新時不打擾
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') })
  if (reason === 'update') migrateLegacy()
  syncWebScripts()
  // 新裝置：先套用雲端已有的設定，之後在這台改設定時才不會以預設值蓋掉其他電腦的設定
  if (reason === 'install') Markloupe.isSyncEnabled().then(on => on && Markloupe.pullSync())
})

/** 舊名稱 MarkLens 的設定與授權資料夾搬到目前的名稱；具名函式方便測試直接呼叫 */
function migrateLegacy() {
  return Promise.all([Markloupe.migrateLegacyStorage(), Markloupe.Roots.migrateLegacy()])
}

/*
 * ---------- 網頁上的 .md ----------
 * manifest 的 content script 只處理本機檔案，安裝時不必要求「所有網站」的權限。
 * 使用者授予網站權限後，以 manifest 中同樣的兩組腳本動態註冊到網頁網址；撤銷權限時移除。
 * 擴充功能更新後腳本清單可能改變，所以 onInstalled 也重新註冊。
 */
let webSync = Promise.resolve()

/**
 * manifest 中本機檔案的比對網址（file:///*.md）套到已授權的網站上。
 * 使用者在擴充功能詳細資料頁把網站存取限制為特定網站時，授權的是那幾個網站（https://example.com/*），不是全部
 */
function webMatches(matches, origins) {
  const sites = origins.map(o => /^(\*|https?):\/\/([^/]+)\//.exec(o)).filter(Boolean)
  return sites.flatMap(([, scheme, host]) => matches.map(m => m.replace(/^file:\/\/\//, `${scheme}://${host}/`)))
}

/** 依目前的網站權限註冊或移除網頁用的 content script；依序執行，避免同時註冊同一個 id */
function syncWebScripts() {
  const run = async () => {
    const { origins = [] } = await chrome.permissions.getAll()
    const groups = chrome.runtime.getManifest().content_scripts
    const ids = groups.map((_, i) => `web-${i}`)
    const existing = (await chrome.scripting.getRegisteredContentScripts({ ids })).map(s => s.id)
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing })
    if (!webMatches(['file:///'], origins).length) return
    await chrome.scripting.registerContentScripts(
      groups.map((g, i) => ({
        id: ids[i],
        matches: webMatches(g.matches, origins),
        js: g.js,
        css: g.css,
        runAt: g.run_at,
      })),
    )
  }
  webSync = webSync.then(run, run)
  return webSync
}
chrome.permissions.onAdded.addListener(syncWebScripts)
chrome.permissions.onRemoved.addListener(syncWebScripts)

// 跨裝置同步：其他電腦改了設定，寫回這台的 storage.local，已開的分頁照常由 storage.onChanged 套用
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync' || !(Markloupe.SETTINGS_KEY in changes || Markloupe.SYNC_CSS_KEY in changes)) return
  if (await Markloupe.isSyncEnabled()) await Markloupe.pullSync()
})
chrome.runtime.onStartup.addListener(async () => {
  if (await Markloupe.isSyncEnabled()) await Markloupe.pullSync()
})

/** 瀏覽器快捷鍵（manifest 的 commands）；具名函式方便測試直接呼叫 */
async function onCommand(command, tab) {
  if (command === 'cycle-theme') {
    // 主題是全域設定，所有分頁同步
    const s = await Markloupe.loadSettings()
    await Markloupe.saveSettings({ theme: Markloupe.nextOf(Markloupe.THEME_ORDER, s.theme) })
    return
  }
  if (tab?.id != null) await chrome.tabs.sendMessage(tab.id, { type: 'command', name: command }).catch(() => {})
}
chrome.commands.onCommand.addListener(onCommand)

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return
  const handler = Object.hasOwn(HANDLERS, msg?.type) && HANDLERS[msg.type]
  if (!handler) return
  handler(msg, sender).then(reply, err => reply({ status: 'error', error: `${err.name}: ${err.message}` }))
  return true // 非同步回覆
})

/* ---------- 上次讀取的檔案內容（自動更新比對用） ---------- */
// service worker 閒置時會被終止，快取隨之清空，下一次讀取就完整回傳一次，不影響正確性
const lastRead = new Map()
const LAST_READ_LIMIT = 20

function rememberRead(key, bytes) {
  lastRead.delete(key)
  lastRead.set(key, bytes)
  if (lastRead.size > LAST_READ_LIMIT) lastRead.delete(lastRead.keys().next().value)
}

function sameBytes(a, b) {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/*
 * 檔案分頁的狀態與清單快取：依分頁存在 storage.session（只有擴充功能讀得到，關閉瀏覽器即清除）。
 * 不放頁面的 sessionStorage：同一分頁之後開啟的本機 HTML 讀得到，等於讓它取得任意資料夾的清單
 */
const FILES_CACHE_LIMIT = 50 // 每個分頁最多快取幾個資料夾的清單，超過時丟掉最舊的
const filesKey = tabId => `files:${tabId}`
let filesWrites = Promise.resolve()
async function filesState(tabId) {
  const k = filesKey(tabId)
  return (await chrome.storage.session.get(k))[k] || { root: null, open: [], dirs: {} }
}
function updateFiles(tabId, fn) {
  filesWrites = filesWrites
    .then(async () => {
      const s = await filesState(tabId)
      fn(s)
      await chrome.storage.session.set({ [filesKey(tabId)]: s })
    })
    .catch(() => {})
  return filesWrites
}
chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove(filesKey(tabId)))

// 關閉「記錄最近開過的文件」（popup、同步或匯入設定）時清除最近的紀錄；釘選的保留
chrome.storage.onChanged.addListener((changes, area) => {
  const c = changes[Markloupe.SETTINGS_KEY]
  if (area === 'local' && c && c.newValue?.recentFiles === false && c.oldValue?.recentFiles !== false) updateList(Markloupe.RECENT_KEY, () => [])
})

/*
 * 最近開過與釘選的文件（popup 列出）：存在 storage.local，不同步（本機路徑在各台電腦不同）。
 * 依序寫入，各分頁同時開啟文件也不會互相蓋掉
 */
const RECENT_LIMIT = 20 // 最近開過的文件最多記幾份（本機與網頁合計）
const PINNED_LIMIT = 20 // 釘選滿了要先取消一個才能再釘
let listWrites = Promise.resolve()
function updateList(key, fn) {
  listWrites = listWrites
    .then(async () => {
      const list = (await chrome.storage.local.get(key))[key] || []
      await chrome.storage.local.set({ [key]: await fn(list) })
    })
    .catch(() => {})
  return listWrites
}
const isDocUrl = url => typeof url === 'string' && /^(file|https?):/i.test(url) && url.length <= 4096

const POS_LIMIT = 300 // 閱讀位置最多記幾份文件，超過時丟掉最久沒讀的
let positions = Promise.resolve() // 閱讀位置依序寫入，各分頁同時捲動也不會互相蓋掉

const HANDLERS = {
  /**
   * 代 content script 讀取「它自己所在頁面」的本機檔案
   * 只接受 sender.url，不接受任意路徑，避免被用來讀取其他檔案
   */
  async 'read-self'(msg, sender) {
    const url = (sender.url || '').split('#')[0]
    if (!url.startsWith('file:') || !isLocalFile(url)) return { text: null }
    // 快取以分頁區分：同一個檔案開在兩個分頁時，各自都要拿到變更
    const cacheKey = `${sender.tab?.id}:${sender.frameId}:${url}`
    let bytes
    try {
      bytes = new Uint8Array(await (await fetch(url, { cache: 'no-store' })).arrayBuffer())
    } catch {
      return { text: null }
    }
    // 自動更新：內容與上次相同就不回傳，省下大檔的傳輸與頁面端比對
    const same = sameBytes(lastRead.get(cacheKey), bytes)
    rememberRead(cacheKey, bytes)
    if (msg.ifChanged && same) return { unchanged: true }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    } catch {
      // 不是合法 UTF-8：交給瀏覽器原本的解碼結果
      return { text: null }
    }
  },

  /** 開啟授權頁；完成後可切回原分頁 */
  async 'open-grant'(_msg, sender) {
    const back = sender.tab?.id != null ? `?back=${sender.tab.id}` : ''
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/grant/grant.html${back}`) })
    return { status: 'ok' }
  },

  'toggle-task': toggleTask,

  /** popup 與閱讀頁的設定寫入（Markloupe.saveSettings、setSyncEnabled）在這裡依序執行 */
  async 'save-settings'(msg) {
    if (!msg.value || typeof msg.value !== 'object' || Array.isArray(msg.value)) return { status: 'error', error: 'invalid patch' }
    return { status: 'ok', value: await Markloupe.saveSettings(msg.value) }
  },
  async 'set-sync'(msg) {
    await Markloupe.setSyncEnabled(msg.value === true)
    return { status: 'ok' }
  },

  /** 記住閱讀位置；無痕視窗不記：storage.local 在關閉無痕視窗後仍在 */
  async 'save-position'(msg, sender) {
    if (sender.tab?.incognito || !Number.isFinite(msg.y)) return { status: 'ok' }
    const key = (sender.url || '').split('#')[0]
    positions = positions.then(async () => {
      const data = (await chrome.storage.local.get(Markloupe.POS_KEY))[Markloupe.POS_KEY] || {}
      delete data[key] // 重新插入，讓最近使用的排在最後
      data[key] = msg.y
      const keys = Object.keys(data)
      for (const k of keys.slice(0, Math.max(0, keys.length - POS_LIMIT))) delete data[k]
      await chrome.storage.local.set({ [Markloupe.POS_KEY]: data })
    })
    positions = positions.catch(() => {})
    await positions
    return { status: 'ok' }
  },

  /** 閱讀頁開啟時記進最近開過的文件；無痕視窗與關閉這項設定時不記 */
  async 'record-visit'(msg, sender) {
    const url = (sender.url || '').split('#')[0]
    if (sender.tab?.incognito || !isDocUrl(url)) return { status: 'ok' }
    const title = String(msg.title || '').trim().slice(0, 200)
    // 在寫入佇列裡才檢查設定：剛關閉記錄（佇列裡有清除）時不會再寫進一筆
    await updateList(Markloupe.RECENT_KEY, async list =>
      (await Markloupe.loadSettings()).recentFiles ? [{ url, title, at: Date.now() }, ...list.filter(e => e.url !== url)].slice(0, RECENT_LIMIT) : list,
    )
    // 釘選的文件換了標題時跟著更新
    await updateList(Markloupe.PINNED_KEY, list => list.map(e => (e.url === url && title ? { ...e, title } : e)))
    return { status: 'ok' }
  },

  /**
   * popup 與側邊欄修改清單：pin、unpin、remove（從最近移除）、clear（清空最近）
   * @returns {{status: 'ok'|'full'|'error', limit?: number}} full：釘選已滿 limit 份
   */
  async 'recent-update'(msg) {
    const { action, url } = msg
    if (action === 'clear') await updateList(Markloupe.RECENT_KEY, () => [])
    else if (!isDocUrl(url)) return { status: 'error', error: 'invalid url' }
    else if (action === 'remove') await updateList(Markloupe.RECENT_KEY, list => list.filter(e => e.url !== url))
    else if (action === 'unpin') await updateList(Markloupe.PINNED_KEY, list => list.filter(e => e.url !== url))
    else if (action === 'pin') {
      const title = String(msg.title || '').trim().slice(0, 200)
      let full = false
      await updateList(Markloupe.PINNED_KEY, list => {
        if (list.some(e => e.url === url)) return list
        full = list.length >= PINNED_LIMIT
        return full ? list : [...list, { url, title }]
      })
      if (full) return { status: 'full', limit: PINNED_LIMIT }
    } else return { status: 'error', error: 'invalid action' }
    return { status: 'ok' }
  },

  /** 檔案分頁的起點、展開的子資料夾與快取的清單（只限發出請求的分頁） */
  async 'files-state'(msg, sender) {
    if (sender.tab?.id == null) return { status: 'error' }
    return { status: 'ok', ...(await filesState(sender.tab.id)) }
  },
  async 'files-save'(msg, sender) {
    if (sender.tab?.id == null || typeof msg.root !== 'string' || !isLocalFolder(msg.root)) return { status: 'error', error: 'invalid root' }
    const open = Array.isArray(msg.open) ? msg.open.filter(p => typeof p === 'string').slice(0, 500) : []
    await updateFiles(sender.tab.id, s => Object.assign(s, { root: msg.root, open }))
    return { status: 'ok' }
  },

  /**
   * 側邊欄「檔案」分頁：列出資料夾的 Markdown 與子資料夾（讀取 Chrome 對 file:// 資料夾產生的清單頁）
   * root：樹的起點（本機資料夾網址，預設為頁面所在資料夾）。只接受本機路徑：不接受網路位置（UNC，
   *   file://主機/… 或 file:////主機/…），避免連線其他電腦
   * path：從起點往下的資料夾名稱陣列，不接受 .. 等跳脫
   */
  async 'list-dir'(msg, sender) {
    const url = (sender.url || '').split(/[?#]/)[0]
    if (!url.startsWith('file:')) return { status: 'unsupported' }
    const pageDir = url.slice(0, url.lastIndexOf('/') + 1)
    const root = msg.root ?? pageDir
    if (!isLocalFolder(root)) {
      return { status: 'error', error: 'invalid root' }
    }
    const segs = Array.isArray(msg.path) ? msg.path : []
    if (segs.length > 32 || !segs.every(s => typeof s === 'string' && s && s !== '.' && s !== '..' && !/[\\/]/.test(s))) {
      return { status: 'error', error: 'invalid path' }
    }
    const dir = root + segs.map(s => `${encodeURIComponent(s)}/`).join('')
    const entries = await dirEntries(dir)
    if (!entries) return { status: 'error' }
    const ignore = ignorePatterns((await Markloupe.loadSettings()).fileIgnore)
    const dirs = []
    const files = []
    for (const { name, href, isDir } of entries) {
      if (ignore.some(re => re.test(name))) continue
      if (isDir) dirs.push(name)
      else if (MD_FILE_RE.test(name)) files.push({ name, url: dir + href })
    }
    dirs.sort(NATURAL.compare)
    files.sort((a, b) => NATURAL.compare(a.name, b.name))
    if (sender.tab?.id != null) {
      await updateFiles(sender.tab.id, s => {
        delete s.dirs[dir] // 重新插入，讓它排到最後（最新）
        s.dirs[dir] = { dirs, files }
        const urls = Object.keys(s.dirs)
        for (const old of urls.slice(0, Math.max(0, urls.length - FILES_CACHE_LIMIT))) delete s.dirs[old]
      })
    }
    return { status: 'ok', dirs, files }
  },

  /**
   * 標出失效的相對連結：回傳指向的本機檔案或資料夾不存在的網址。
   * 只讀連結所在資料夾的清單頁（檔名），不讀檔案內容；資料夾讀不到時再看上一層有沒有它，
   * 上一層也讀不到就當成存在，不標示
   */
  async 'check-links'(msg, sender) {
    const page = (sender.url || '').split(/[?#]/)[0]
    if (!page.startsWith('file:') || !isLocalFile(page)) return { status: 'unsupported' }
    const urls = (Array.isArray(msg.urls) ? msg.urls : []).filter(u => typeof u === 'string').slice(0, LINK_CHECK_MAX)
    // Windows 與 macOS 的檔案系統預設不分大小寫
    const os = (await chrome.runtime.getPlatformInfo()).os
    const fold = os === 'win' || os === 'mac' ? s => s.toLowerCase() : s => s
    const listings = new Map()
    const names = dir => {
      if (!listings.has(dir)) {
        listings.set(
          dir,
          listings.size >= LINK_CHECK_DIRS || !isLocalFolder(dir)
            ? Promise.resolve(null)
            : dirEntries(dir).then(list => list && new Set(list.map(e => fold(e.name)))),
        )
      }
      return listings.get(dir)
    }
    const exists = async path => {
      const cut = path.replace(/\/$/, '').lastIndexOf('/') + 1
      const dir = path.slice(0, cut)
      const name = fold(decodeName(path.slice(cut).replace(/\/$/, '')))
      if (!name || dir === 'file:///') return true
      const list = await names(dir)
      if (list) return list.has(name)
      return exists(dir)
    }
    const missing = []
    for (const u of urls) {
      const path = u.split(/[?#]/)[0]
      if (!path.startsWith('file:///') || !isLocalFile(path)) continue
      if (!(await exists(path))) missing.push(u)
    }
    return { status: 'ok', missing }
  },

  /** content script 透過這裡取得整份語系檔（content script 無權直接讀取擴充功能內的檔案） */
  async 'read-messages'(msg) {
    if (!Markloupe.UI_LANGS.includes(msg.lang)) return { status: 'error', error: 'unknown language' }
    const res = await fetch(chrome.runtime.getURL(`_locales/${msg.lang}/messages.json`))
    return { status: 'ok', messages: await res.json() }
  },

  /**
   * 匯出 HTML 用：讀取擴充功能內的樣式與字型
   * 只允許固定的幾個檔案，不能被拿來讀取擴充功能的其他內容
   */
  async 'read-asset'(msg) {
    const path = String(msg.path || '')
    if (!ASSET_RE.test(path)) return { status: 'error', error: 'not allowed' }
    const res = await fetch(chrome.runtime.getURL(path))
    if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` }
    if (path.endsWith('.css')) return { status: 'ok', text: await res.text() }
    return { status: 'ok', base64: toBase64(new Uint8Array(await res.arrayBuffer())) }
  },

  /**
   * 匯出時內嵌圖片：回傳圖片的 MIME 類型與 base64。失敗時 reason 為
   * not-allowed、no-permission（讀取失敗且沒有網站權限，原因不一定是權限）、unreachable、too-large、not-image 之一。
   * 匯出檔可能被分享出去：網路上的文件不能內嵌 file:// 圖片，也不能內嵌內網或本機服務的圖片（與文件同源的除外）
   */
  async 'read-image'(msg, sender) {
    let url
    try {
      url = new URL(String(msg.url))
    } catch {
      return { status: 'error', reason: 'not-allowed' }
    }
    const local = url.protocol === 'file:'
    let from
    try {
      from = new URL(sender.url)
    } catch {
      return { status: 'error', reason: 'not-allowed' }
    }
    const fromFile = from.protocol === 'file:'
    // 網路上的文件：內網圖片只接受與文件同源的
    const webAllowed = target => /^https?:$/.test(target.protocol) && (fromFile || !privateHost(target.hostname) || from.origin === target.origin)
    if (local ? !fromFile || !isLocalFile(url.href) : !webAllowed(url)) return { status: 'error', reason: 'not-allowed' }
    let res
    try {
      // 不帶 cookie：允許任何網站跨站讀取（Access-Control-Allow-Origin: *）的圖床不接受帶 cookie 的請求
      res = await fetch(url.href, { credentials: 'omit' })
    } catch {
      // 沒有網站權限時，跨站讀取被擋與連不上無法區分
      const denied = !local && !(await chrome.permissions.contains({ origins: Markloupe.WEB_ORIGINS }))
      return { status: 'error', reason: denied ? 'no-permission' : 'unreachable' }
    }
    // 重新導向後的網址也要符合規則。導向的目的地在檢查前已收到請求；瀏覽器顯示這張圖片時同樣會請求它
    if (!local && !webAllowed(new URL(res.url))) return { status: 'error', reason: 'not-allowed' }
    if (!res.ok) return { status: 'error', reason: 'unreachable' }
    const bytes = await readLimited(res, IMAGE_MAX)
    if (!bytes) return { status: 'error', reason: 'too-large' }
    const mime = imageType(bytes)
    if (!mime) return { status: 'error', reason: 'not-image' }
    return { status: 'ok', mime, base64: toBase64(bytes) }
  },
}

const IMAGE_MAX = 10 * 1024 * 1024

/** 讀完回應本文；超過 max 位元組就中斷並回傳 null。沒有本文（例如 204）時回傳空陣列 */
async function readLimited(res, max) {
  if (Number(res.headers.get('content-length')) > max) return null
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.length
  }
  return bytes
}

/** 內網或本機服務的主機：localhost、.local、沒有點號的名稱、私有與保留的 IP。以網域名稱指向內網的情況判斷不到 */
function privateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || !/[.:]/.test(h)) return true
  const v4 = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]]
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  return h.includes(':') && (h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:'))
}

function toBase64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** 依檔頭判斷圖片格式；不是瀏覽器能顯示的圖片時回傳 null */
function imageType(b) {
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to))
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 4) === 'GIF8') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'image/avif'
  if (ascii(0, 2) === 'BM') return 'image/bmp'
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon'
  const head = new TextDecoder().decode(b.subarray(0, 1024)).replace(/^\uFEFF/, '').trimStart()
  if (head.startsWith('<') && /<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

/** 沒有主機名稱的 file:// 網址。WSL（file://wsl.localhost/…）與網路共用的網址 Chrome 一律拒絕讀取，不必發出請求 */
function isLocalFile(url) {
  try {
    const u = new URL(url)
    return u.host === '' && !u.pathname.startsWith('//')
  } catch {
    return false
  }
}

/** 本機資料夾網址：file:///X/…/，沒有主機名稱、不是 //主機 開頭的網路路徑、不含 . 或 .. 段落 */
function isLocalFolder(root) {
  if (typeof root !== 'string' || !root.startsWith('file:///') || !root.endsWith('/')) return false
  let u
  try {
    u = new URL(root)
  } catch {
    return false
  }
  if (u.host !== '' || u.pathname.startsWith('//')) return false
  // URL 會把 . 與 .. 正規化掉，所以檢查原始字串（含 %2e 這類編碼寫法）
  let path
  try {
    path = decodeURIComponent(root.slice('file://'.length))
  } catch {
    return false
  }
  return !path.split('/').some(s => s === '.' || s === '..') && !path.includes('\\')
}

const MD_FILE_RE = /\.(md|markdown|mkd|mdx)$/i
const LINK_CHECK_MAX = 500 // 一份文件最多檢查的連結數
const LINK_CHECK_DIRS = 50 // 最多讀取的資料夾清單數

function decodeName(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * 讀取 Chrome 對 file:// 資料夾產生的清單頁，回傳 [{ name, href, isDir }]；讀不到時回傳 null。
 * 清單頁每一列是 addRow("顯示名稱", "編碼後的網址", 是否為資料夾, …)；非 ASCII 檔名的顯示名稱可能是空字串，所以用網址欄位
 */
async function dirEntries(dir) {
  let html
  try {
    html = await (await fetch(dir)).text()
  } catch {
    return null
  }
  const out = []
  for (const m of html.matchAll(/addRow\("(?:[^"\\]|\\.)*","((?:[^"\\]|\\.)*)",([01]),/g)) {
    let href
    try {
      href = JSON.parse(`"${m[1]}"`)
    } catch {
      continue
    }
    const name = decodeName(href.replace(/\/$/, ''))
    if (name && name !== '..') out.push({ name, href, isDir: m[2] === '1' })
  }
  return out
}

/** 「檔案列表略過」設定：逗號或換行分隔，* 為萬用字元，不分大小寫（.* 代表以 . 開頭的名稱） */
function ignorePatterns(text) {
  return String(text || '')
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(p => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i'))
}
const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const ASSET_RE = /^(?:src\/shared\/tokens\.css|src\/content\/content\.css|vendor\/katex\/katex\.min\.css|vendor\/katex\/fonts\/KaTeX_[A-Za-z0-9-]+\.woff2)$/

/* ---------- 任務勾選寫回 ---------- */

// 任務清單行：可有引用前綴（>）、縮排，無序（- * +）或有序（1. 1)）清單，後接 [ ] / [x]。
// 清單符號可以有多個（- - [ ]），也可以沒有（項目第一行只有 -，[ ] 寫在下一行）；行號由解析器標記，不會對到清單外的行
// > 之後的空白只由下一段的 [ \t]* 比對：同一段空白有兩種切法時，對不上的長行會指數回溯（ReDoS）
const TASK_LINE_RE = /^((?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*\[)([ xX])(\])/

/**
 * 切換原文第 line 行（0 起算）的勾選狀態
 * @param {{line:number, from:' '|'x', to:' '|'x', hash:string}} msg
 *   from：頁面認為目前的狀態；hash：頁面持有的原文 SHA-256，用來偵測檔案是否已被其他地方修改
 * @returns {{status:'ok'|'no-root'|'permission'|'ambiguous'|'conflict'|'not-utf8'|'unsupported'|'error', text?:string, root?:string, path?:string}}
 *   no-root：授權資料夾中沒有這個路徑，或同路徑的是別處的同名檔案（內容與頁面不同，或寫入後頁面所在的檔案沒變）
 *   ambiguous：多個授權資料夾都有內容相同的這個檔案，無法判斷是哪一份；path：寫入的檔案（授權資料夾名稱起算）
 */
async function toggleTask(msg, sender) {
  const url = (sender.url || '').split('#')[0]
  if (!url.startsWith('file:')) return { status: 'unsupported' }
  // to 會原樣寫進檔案：只接受勾選框的兩種狀態與非負整數行號
  const STATES = [' ', 'x']
  if (!Number.isInteger(msg.line) || msg.line < 0 || !STATES.includes(msg.from) || !STATES.includes(msg.to) || typeof msg.hash !== 'string') {
    return { status: 'error', error: 'invalid message' }
  }

  const candidates = await Markloupe.Roots.locate(url)
  if (!candidates.length) return { status: 'no-root' }
  const granted = []
  for (const c of candidates) {
    if ((await c.root.handle.queryPermission({ mode: 'readwrite' })) !== 'granted') continue
    // 巢狀的授權資料夾（例如 D:\A 與 D:\A\sub）會找到同一個實體檔案，只留一個
    let dup = false
    for (const g of granted) if (await g.file.isSameEntry(c.file)) dup = true
    if (!dup) granted.push(c)
  }
  if (!granted.length) return { status: 'permission', root: candidates[0].root.handle.name }

  // 授權資料夾只以名稱對應到網址路徑，可能對到別處的同名檔案（例如授權 D:\notes，開的是 E:\backup\notes\todo.md）：
  // 與頁面實際所在的檔案內容一致的才可能是同一個檔案，寫入後再確認頁面所在的檔案確實變了
  const read = async c => {
    const file = await c.file.getFile()
    return { file, bytes: new Uint8Array(await file.arrayBuffer()) }
  }
  const readPage = async () => new Uint8Array(await (await fetch(url, { cache: 'no-store' })).arrayBuffer())
  let pageBytes
  try {
    pageBytes = await readPage()
  } catch (err) {
    return { status: 'error', error: `${err.name}: ${err.message}` }
  }
  const same = []
  for (const c of granted) {
    const r = await read(c)
    if (sameBytes(r.bytes, pageBytes)) same.push([c, r])
  }
  if (!same.length) return { status: 'no-root' }
  // 兩份內容完全相同的副本：無法確定是哪一個檔案，不寫入
  if (same.length > 1) return { status: 'ambiguous' }
  const [found, { file: before, bytes }] = same[0]
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) // 預設會去掉 BOM，與頁面讀到的一致
  } catch {
    return { status: 'not-utf8' }
  }

  // 檔案已被其他地方修改（例如編輯器剛存檔）：不寫入，回傳最新內容讓頁面更新
  if ((await Markloupe.sha256(text)) !== msg.hash) return { status: 'conflict', text }

  // 保留每行原本的換行字元（LF / CRLF / CR）
  const lines = Markloupe.splitLines(text)
  const line = lines[msg.line]
  const m = line != null && TASK_LINE_RE.exec(line)
  if (!m || m[2].toLowerCase() !== msg.from) return { status: 'conflict', text }

  lines[msg.line] = m[1] + msg.to + m[3] + line.slice(m[0].length)
  const updated = lines.join('')
  // 讀檔之後又被改過（例如編輯器剛存檔）：不以舊內容覆寫
  const now = await found.file.getFile()
  if (now.lastModified !== before.lastModified || now.size !== before.size) return { status: 'conflict', text: await now.text() }
  await writeFile(found.file, (hasBom ? '\uFEFF' : '') + updated)
  // 頁面所在的檔案沒變：寫到的是別處內容相同的同名檔案，還原它
  let after
  try {
    after = await readPage()
  } catch {
    after = pageBytes
  }
  if (sameBytes(after, pageBytes)) {
    await writeFile(found.file, bytes)
    return { status: 'no-root' }
  }
  return { status: 'ok', text: updated, path: found.path }
}

async function writeFile(handle, data) {
  const writable = await handle.createWritable()
  await writable.write(data)
  await writable.close()
}
