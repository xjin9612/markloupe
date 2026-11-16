// CRX3 簽署：把 GitHub Release 的商店版 zip 簽成 CRX，上傳到啟用 Verified CRX uploads 的 Chrome Web Store 項目
// 用法：
//   node scripts/crx.mjs sign v1.10.0 --key <私鑰.pem>   下載 Release 的 markloupe-v1.10.0-store.zip、驗證建置來源證明與版本，
//                                                     以私鑰簽成 dist/markloupe-v1.10.0.crx
//   node scripts/crx.mjs verify <檔案.crx>               驗證 CRX 的簽章，印出 CRX ID 與公鑰是否為 repo 中的公鑰
// 私鑰密碼從環境變數 MARKLOUPE_CRX_PASSPHRASE 讀取，沒有時在終端機詢問（不顯示輸入）。
// 簽的是 Release 的 zip 本身，不重新壓縮：CRX 裡的內容與有建置來源證明的檔案逐位元組相同。
// 只使用 Node 標準庫與 gh CLI。格式見 Chromium 的 components/crx_file/crx3.proto
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'xjin9612/markloupe'
export const PUBLIC_KEY_FILE = join(root, 'docs/store/markloupe-crx.pub.pem')

const MAGIC = Buffer.from('Cr24', 'latin1')
const SIGNED_PREFIX = Buffer.from('CRX3 SignedData\0', 'latin1')
// CrxFileHeader 的欄位編號
const F_RSA = 2
const F_ECDSA = 3
const F_SIGNED_DATA = 10000
// AsymmetricKeyProof 與 SignedData 的欄位編號
const F_PUBLIC_KEY = 1
const F_SIGNATURE = 2
const F_CRX_ID = 1

/* ---------- protobuf（只用到長度前綴欄位） ---------- */
function varint(n) {
  const out = []
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return Buffer.from(out)
}

function field(no, bytes) {
  return Buffer.concat([varint(no * 8 + 2), varint(bytes.length), bytes])
}

/** 解出 [欄位編號, 內容] 的陣列；只接受長度前綴與 varint 欄位 */
function fields(buf) {
  const out = []
  let pos = 0
  const read = () => {
    let n = 0
    let mul = 1
    for (;;) {
      if (pos >= buf.length) throw new Error('protobuf 長度不足')
      const b = buf[pos++]
      n += (b & 0x7f) * mul
      if (b < 0x80) return n
      mul *= 128
    }
  }
  while (pos < buf.length) {
    const key = read()
    const type = key % 8
    if (type === 0) {
      read()
    } else if (type === 2) {
      const len = read()
      if (pos + len > buf.length) throw new Error('protobuf 長度不足')
      out.push([Math.floor(key / 8), buf.subarray(pos, pos + len)])
      pos += len
    } else {
      throw new Error(`不支援的 protobuf 型別 ${type}`)
    }
  }
  return out
}

const u32 = n => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

/* ---------- CRX3 ---------- */
/** CRX ID：公鑰（SubjectPublicKeyInfo DER）SHA-256 的前 16 個位元組 */
export function crxId(spki) {
  return createHash('sha256').update(spki).digest().subarray(0, 16)
}

/** 擴充功能 ID 的寫法：每 4 位元換成 a–p */
export function crxIdString(id) {
  return [...id].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('')
}

function signedPayload(signedData, archive) {
  return Buffer.concat([SIGNED_PREFIX, u32(signedData.length), signedData, archive])
}

/** 以 RSA 私鑰把 zip 簽成 CRX3 */
export function signCrx(archive, privateKey) {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const signedData = field(F_CRX_ID, crxId(spki))
  const signature = sign('sha256', signedPayload(signedData, archive), privateKey)
  const header = Buffer.concat([field(F_RSA, Buffer.concat([field(F_PUBLIC_KEY, spki), field(F_SIGNATURE, signature)])), field(F_SIGNED_DATA, signedData)])
  return Buffer.concat([MAGIC, u32(3), u32(header.length), header, archive])
}

/**
 * 驗證 CRX3：每個簽章都要正確，且其中一把公鑰的雜湊等於檔頭記載的 CRX ID（開發者金鑰）。
 * 驗證失敗時丟出錯誤；成功時回傳 { id, publicKey（開發者金鑰的 DER）, archive }
 */
export function verifyCrx(buf) {
  if (buf.length < 12 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('不是 CRX 檔')
  if (buf.readUInt32LE(4) !== 3) throw new Error(`不支援的 CRX 版本 ${buf.readUInt32LE(4)}`)
  const headerEnd = 12 + buf.readUInt32LE(8)
  if (headerEnd > buf.length) throw new Error('CRX 檔頭長度不足')
  const header = fields(buf.subarray(12, headerEnd))
  const archive = buf.subarray(headerEnd)
  const signedData = header.find(([no]) => no === F_SIGNED_DATA)?.[1]
  if (!signedData) throw new Error('CRX 缺少 signed_header_data')
  const id = fields(signedData).find(([no]) => no === F_CRX_ID)?.[1]
  if (!id || id.length !== 16) throw new Error('CRX 缺少 crx_id')
  const payload = signedPayload(signedData, archive)
  let developerKey = null
  let proofs = 0
  for (const [no, proof] of header) {
    if (no !== F_RSA && no !== F_ECDSA) continue
    const parts = fields(proof)
    const spki = parts.find(([n]) => n === F_PUBLIC_KEY)?.[1]
    const signature = parts.find(([n]) => n === F_SIGNATURE)?.[1]
    if (!spki || !signature) throw new Error('CRX 的簽章缺少公鑰或簽章')
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== (no === F_RSA ? 'rsa' : 'ec')) throw new Error('CRX 的公鑰類型與簽章欄位不符')
    if (!verify('sha256', payload, key, signature)) throw new Error('CRX 簽章不正確')
    proofs++
    if (crxId(spki).equals(id)) developerKey = spki
  }
  if (!proofs) throw new Error('CRX 沒有簽章')
  if (!developerKey) throw new Error('CRX 的簽章中沒有與 crx_id 相符的公鑰')
  return { id: crxIdString(id), publicKey: Buffer.from(developerKey), archive }
}

/* ---------- zip：只讀出單一檔案 ---------- */
/** 讀出 zip 中名稱為 name 的檔案；找不到時回傳 null */
export function zipEntry(zip, name) {
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是 zip 檔')
  const count = zip.readUInt16LE(eocd + 10)
  let pos = zip.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error('zip 中央目錄損壞')
    const method = zip.readUInt16LE(pos + 10)
    const size = zip.readUInt32LE(pos + 20)
    const nameLen = zip.readUInt16LE(pos + 28)
    const next = pos + 46 + nameLen + zip.readUInt16LE(pos + 30) + zip.readUInt16LE(pos + 32)
    const entryName = zip.toString('utf8', pos + 46, pos + 46 + nameLen).replace(/\\/g, '/')
    if (entryName === name) {
      const local = zip.readUInt32LE(pos + 42)
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const data = zip.subarray(start, start + size)
      if (method === 0) return Buffer.from(data)
      if (method === 8) return inflateRawSync(data)
      throw new Error(`不支援的壓縮方式 ${method}`)
    }
    pos = next
  }
  return null
}

/* ---------- 指令 ---------- */
function fail(msg) {
  console.error(`✘ ${msg}`)
  process.exit(1)
}

/** 在終端機詢問密碼，輸入不顯示 */
function askHidden(prompt) {
  return new Promise((done, reject) => {
    const { stdin, stderr } = process
    if (!stdin.isTTY) return reject(new Error('沒有終端機可輸入密碼；請設定 MARKLOUPE_CRX_PASSPHRASE'))
    stderr.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    let value = ''
    const onData = chunk => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          stderr.write('\n')
          return done(value)
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false)
          stderr.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

function repoPublicKey() {
  if (!existsSync(PUBLIC_KEY_FILE)) fail(`找不到 repo 的公鑰 ${PUBLIC_KEY_FILE}`)
  return createPublicKey(readFileSync(PUBLIC_KEY_FILE)).export({ type: 'spki', format: 'der' })
}

async function signRelease(tag, keyPath, outDir) {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag || '')
  if (!m) fail(`標籤格式應為 vX.Y.Z，收到：${tag}`)
  if (!keyPath) fail('請以 --key 指定私鑰檔')
  const version = m[1]
  const zipName = `markloupe-${tag}-store.zip`
  mkdirSync(outDir, { recursive: true })
  const zipPath = join(outDir, zipName)
  rmSync(zipPath, { force: true })

  console.log(`下載 ${zipName}`)
  execFileSync('gh', ['release', 'download', tag, '--repo', REPO, '--pattern', zipName, '--dir', outDir], { stdio: 'inherit' })
  console.log('驗證建置來源證明')
  try {
    execFileSync(
      'gh',
      ['attestation', 'verify', zipPath, '--repo', REPO, '--source-ref', `refs/tags/${tag}`, '--signer-workflow', `${REPO}/.github/workflows/release.yml`],
      { stdio: 'inherit' },
    )
  } catch {
    fail(`${zipName} 的建置來源證明驗證失敗，不簽署`)
  }
  const zip = readFileSync(zipPath)
  const manifest = JSON.parse(zipEntry(zip, 'manifest.json')?.toString('utf8') ?? 'null')
  if (manifest?.version !== version) fail(`zip 中 manifest.json 的版本是 ${manifest?.version}，不是 ${version}`)

  const passphrase = process.env.MARKLOUPE_CRX_PASSPHRASE ?? (await askHidden('私鑰密碼：'))
  let privateKey
  try {
    privateKey = createPrivateKey({ key: readFileSync(keyPath), passphrase })
  } catch (e) {
    fail(`無法讀取私鑰（密碼錯誤或格式不符）：${e.message}`)
  }
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  if (!spki.equals(repoPublicKey())) fail(`私鑰與 ${PUBLIC_KEY_FILE} 不是同一對`)

  const crx = signCrx(zip, privateKey)
  const { id } = verifyCrx(crx)
  const crxPath = join(outDir, `markloupe-${tag}.crx`)
  writeFileSync(crxPath, crx)
  console.log(`✔ 已簽署 ${crxPath}`)
  console.log(`  CRX ID（金鑰）：${id}`)
  console.log(`  SHA-256：${createHash('sha256').update(crx).digest('hex')}`)
}

function verifyFile(file) {
  if (!file) fail('請指定 CRX 檔')
  let result
  try {
    result = verifyCrx(readFileSync(file))
  } catch (e) {
    fail(e.message)
  }
  const ours = existsSync(PUBLIC_KEY_FILE) && result.publicKey.equals(repoPublicKey())
  console.log(`✔ 簽章正確，CRX ID（金鑰）：${result.id}`)
  console.log(ours ? '  以 repo 的公鑰簽署' : '  不是以 repo 的公鑰簽署')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg, ...rest] = process.argv.slice(2)
  const opt = name => {
    const i = rest.indexOf(name)
    return i >= 0 ? rest[i + 1] : undefined
  }
  if (cmd === 'sign') await signRelease(arg, opt('--key'), resolve(opt('--out') ?? join(root, 'dist')))
  else if (cmd === 'verify') verifyFile(arg)
  else fail('用法：node scripts/crx.mjs sign vX.Y.Z --key <私鑰.pem> [--out 目錄] ｜ node scripts/crx.mjs verify <檔案.crx>')
}
