'use strict'
// 側邊欄「最近」分頁（只在本機文件）：釘選與最近開過的文件，與 popup 共用 background 記錄的清單
var Markloupe = globalThis.Markloupe || (globalThis.Markloupe = {})

;(() => {
  const { h, t, icon } = Markloupe

  /** 顯示在標題下方的位置：本機檔案為所在的上兩層資料夾，網頁為網站 */
  function where(url) {
    try {
      const u = new URL(url)
      if (u.protocol !== 'file:') return u.host
      return decodeURIComponent(u.pathname).split('/').filter(Boolean).slice(-3, -1).join('/')
    } catch {
      return ''
    }
  }

  Markloupe.RecentList = class {
    constructor() {
      this.page = location.href.split('#')[0]
      this.query = ''
      this.pinned = []
      this.recent = []
      this.started = false
      this.list = h('ul', { class: 'ml-files-list ml-recent-list' })
      this.el = h('nav', { class: 'ml-files ml-recent', hidden: true }, [this.list])
      this.list.addEventListener('click', e => this.onClick(e))
      chrome.storage.onChanged.addListener((changes, area) => {
        if (this.started && area === 'local' && (Markloupe.RECENT_KEY in changes || Markloupe.PINNED_KEY in changes)) this.load()
      })
    }

    async load() {
      this.started = true
      try {
        const data = await chrome.storage.local.get([Markloupe.RECENT_KEY, Markloupe.PINNED_KEY])
        this.pinned = data[Markloupe.PINNED_KEY] || []
        this.recent = data[Markloupe.RECENT_KEY] || []
      } catch {
        // 擴充功能已重新載入：維持上次的清單
      }
      this.render()
    }

    setQuery(q) {
      this.query = q.trim().toLowerCase()
      if (this.started) this.render()
    }

    render() {
      const q = this.query
      const match = e => !q || `${e.title}\n${where(e.url)}`.toLowerCase().includes(q)
      const pinnedUrls = new Set(this.pinned.map(e => e.url))
      const pinned = this.pinned.filter(match)
      const recent = this.recent.filter(e => !pinnedUrls.has(e.url) && match(e))
      const items = []
      if (pinned.length) items.push(this.head(t('recentPinned')), ...pinned.map(e => this.item(e, true)))
      if (recent.length) items.push(this.head(t('recentRecent')), ...recent.map(e => this.item(e, false)))
      if (!items.length) items.push(h('li', { class: 'ml-files-note', text: t(q ? 'recentNoMatch' : 'recentEmpty') }))
      this.list.replaceChildren(...items)
    }

    head(text) {
      return h('li', { class: 'ml-recent-head', text })
    }

    item(entry, pinned) {
      const current = entry.url === this.page
      let full = entry.url
      try {
        full = decodeURI(entry.url)
      } catch {
        // 不合法的 % 編碼：顯示原網址
      }
      const name = entry.title || full.split('/').pop()
      const action = (act, iconName, label) =>
        h('button', { class: 'ml-recent-act', type: 'button', title: label, attrs: { 'aria-label': label, 'data-act': act } }, [icon(iconName)])
      const pin = action(pinned ? 'unpin' : 'pin', 'pin', t(pinned ? 'recentUnpin' : 'recentPin'))
      pin.setAttribute('aria-pressed', String(pinned))
      return h('li', { class: `ml-files-file ml-recent-item${current ? ' active' : ''}`, attrs: { 'data-url': entry.url } }, [
        h('a', { class: 'ml-files-row', href: entry.url, title: full, attrs: current ? { 'aria-current': 'page' } : {} }, [
          icon('file'),
          h('span', { class: 'ml-recent-text' }, [h('span', { class: 'ml-files-name', text: name }), h('span', { class: 'ml-recent-where', text: where(entry.url) })]),
        ]),
        pin,
        ...(pinned ? [] : [action('remove', 'close', t('recentRemove'))]),
      ])
    }

    async onClick(e) {
      const li = e.target.closest('.ml-recent-item')
      if (!li) return
      const url = li.dataset.url
      const act = e.target.closest('[data-act]')?.dataset.act
      if (act) {
        const entry = [...this.pinned, ...this.recent].find(x => x.url === url)
        const res = await chrome.runtime.sendMessage({ type: 'recent-update', action: act, url, title: entry?.title }).catch(() => null)
        if (res?.status === 'full') Markloupe.toast(t('recentPinFull', res.limit))
        return
      }
      // 一般連結：同分頁開啟，中鍵或 Ctrl＋點擊開新分頁
    }
  }
})()
