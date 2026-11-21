'use strict'
// Word 範本（.docx／.dotx）：只取出樣式（styles.xml）與佈景主題（theme1.xml），存在本機供匯出 Word 時套用
var Markloupe = globalThis.Markloupe || (globalThis.Markloupe = {})

;(() => {
  const MAX_FILE = 10 * 1024 * 1024
  const MAX_PART = 4 * 1024 * 1024 // 解壓後單一部分的上限：避免壓縮炸彈
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

  class TemplateError extends Error {}

  /** 解壓 deflate 資料，超過 MAX_PART 就中止 */
  async function inflate(data) {
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > MAX_PART) {
        await reader.cancel()
        throw new TemplateError('docxTemplateTooLarge')
      }
      chunks.push(value)
    }
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.length
    }
    return out
  }

  /** 由 zip 的中央目錄找出指定檔案並解壓成文字；沒有這個檔案時回傳 null。格式不對時丟出 TemplateError */
  async function readEntry(buf, name) {
    const view = new DataView(buf)
    // 中央目錄結尾（EOCD）在檔案最後 22 bytes 起、往前最多 64 KB（zip 註解）的範圍內
    let eocd = -1
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 0xffff); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new TemplateError('docxTemplateInvalid')
    const count = view.getUint16(eocd + 10, true)
    let p = view.getUint32(eocd + 16, true)
    const utf8 = new TextDecoder()
    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new TemplateError('docxTemplateInvalid')
      const method = view.getUint16(p + 10, true)
      const size = view.getUint32(p + 20, true)
      const fullSize = view.getUint32(p + 24, true)
      const [nameLen, extraLen, commentLen] = [28, 30, 32].map(o => view.getUint16(p + o, true))
      const local = view.getUint32(p + 42, true)
      const entry = utf8.decode(new Uint8Array(buf, p + 46, nameLen))
      p += 46 + nameLen + extraLen + commentLen
      if (entry !== name) continue
      if (fullSize > MAX_PART) throw new TemplateError('docxTemplateTooLarge')
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
      const data = new Uint8Array(buf, start, size)
      if (method === 0) return utf8.decode(data)
      if (method === 8) return utf8.decode(await inflate(data))
      throw new TemplateError('docxTemplateInvalid')
    }
    return null
  }

  const rootOf = xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    return doc.querySelector('parsererror') ? null : doc.documentElement
  }

  /**
   * 讀取使用者選的 Word 範本
   * @param {File} file
   * @returns {Promise<{name: string, styles: string, theme: string|null}>}
   * @throws {Error} message 為說明原因的訊息 key（docxTemplateInvalid、docxTemplateTooLarge、docxTemplateNoStyles）
   */
  Markloupe.readDocxTemplate = async function (file) {
    if (file.size > MAX_FILE) throw new TemplateError('docxTemplateTooLarge')
    try {
      const buf = await file.arrayBuffer()
      const styles = await readEntry(buf, 'word/styles.xml')
      const root = styles && rootOf(styles)
      if (root?.namespaceURI !== W || root.localName !== 'styles') throw new TemplateError('docxTemplateNoStyles')
      // 佈景主題字型（例如「標題」用 +主要字型）要有 theme1.xml 才能解析；讀不到或格式不對就不帶
      const theme = await readEntry(buf, 'word/theme/theme1.xml').catch(() => null)
      const themeRoot = theme && rootOf(theme)
      return { name: file.name, styles, theme: themeRoot?.namespaceURI === A && themeRoot.localName === 'theme' ? theme : null }
    } catch (err) {
      if (err instanceof TemplateError) throw err
      throw new TemplateError('docxTemplateInvalid') // 讀取 zip 時超出範圍等
    }
  }
})()
