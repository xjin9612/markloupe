// scripts/crx.mjs 的測試：自己簽出的 CRX 要與 Chromium 的 --pack-extension 逐位元組相同，驗證要能擋下竄改
// 執行：node test/crx.mjs（需要 Playwright 的 Chromium）
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { crxId, crxIdString, signCrx, verifyCrx, zipEntry } from '../scripts/crx.mjs'

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`✔ ${name}`)
  } catch (e) {
    results.push(`✘ ${name}\n    ${e.message.split('\n').slice(0, 8).join('\n    ')}`)
  }
}

const work = mkdtempSync(join(tmpdir(), 'ml-crx-'))
const ext = join(work, 'ext')
mkdirSync(ext)
const manifest = JSON.stringify({ manifest_version: 3, name: 'CRX 測試', version: '1.2.3' })
writeFileSync(join(ext, 'manifest.json'), manifest)
const script = `console.log(${JSON.stringify('x'.repeat(5000))})\n`
writeFileSync(join(ext, 'content.js'), script)

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyFile = join(work, 'key.pem')
writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
const spki = publicKey.export({ type: 'spki', format: 'der' })

// Chromium 打包後在資料夾旁產生 ext.crx，然後結束；headless 才能在沒有顯示器的 CI 上執行。
// Linux 加 --no-sandbox（與 Playwright 啟動 Chromium 時相同）：Ubuntu 預設不讓一般程式建立 user namespace，沒有可用的 sandbox 時 Chromium 會直接中止
const packArgs = [`--pack-extension=${ext}`, `--pack-extension-key=${keyFile}`, '--headless=new', '--no-message-box']
if (process.platform === 'linux') packArgs.push('--no-sandbox')
try {
  execFileSync(chromium.executablePath(), packArgs, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 })
} catch (e) {
  throw new Error(`Chromium 打包失敗（${e.signal || e.status}）\n${String(e.stderr || '').slice(-2000)}`)
}
const chromeCrx = readFileSync(join(work, 'ext.crx'))

await check('Chromium 打包的 CRX 能通過驗證，CRX ID 由公鑰算出，內含原本的 manifest.json', () => {
  const r = verifyCrx(chromeCrx)
  assert.equal(r.id, crxIdString(crxId(spki)))
  assert.ok(r.publicKey.equals(spki))
  assert.equal(zipEntry(r.archive, 'manifest.json').toString('utf8'), manifest)
  assert.equal(zipEntry(r.archive, 'content.js').toString('utf8'), script)
  assert.equal(zipEntry(r.archive, 'missing.js'), null)
})

await check('同一把金鑰簽同一份 zip，結果與 Chromium 逐位元組相同', () => {
  const ours = signCrx(verifyCrx(chromeCrx).archive, privateKey)
  assert.ok(ours.equals(chromeCrx), `長度 ${ours.length} / ${chromeCrx.length}`)
})

await check('內容或簽章被改過、換成別把金鑰簽的簽章時，驗證失敗', () => {
  const archive = verifyCrx(chromeCrx).archive
  const signed = signCrx(archive, privateKey)
  const body = Buffer.from(signed)
  body[body.length - 30] ^= 1
  assert.throws(() => verifyCrx(body), /簽章不正確/)
  const sig = Buffer.from(signed)
  sig[12 + 300] ^= 1
  assert.throws(() => verifyCrx(sig))
  // 另一把金鑰簽的 CRX 冒用原本的 crx_id
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const forged = signCrx(archive, other)
  const otherId = crxId(createPublicKey(other).export({ type: 'spki', format: 'der' }))
  const at = forged.indexOf(otherId)
  crxId(spki).copy(forged, at)
  assert.throws(() => verifyCrx(forged))
  assert.throws(() => verifyCrx(Buffer.from('PK\x03\x04')), /不是 CRX/)
})

console.log(results.join('\n'))
const failed = results.filter(r => r.startsWith('✘')).length
console.log(`\n${results.length - failed} 通過，${failed} 失敗`)
process.exit(failed ? 1 : 0)
