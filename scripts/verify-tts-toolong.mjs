import fs from 'node:fs'

const file = 'F:/产出/shiny colors/config.json'
const token = fs.readFileSync('F:/产出/shiny colors/state/console-token', 'utf8').trim()
const h = { 'x-console-token': token, 'content-type': 'application/json' }
const raw = fs.readFileSync(file, 'utf8')

const restart = async () => {
  await fetch('http://127.0.0.1:3100/api/restart', { method: 'POST', headers: h, body: '{}' })
  await new Promise((r) => setTimeout(r, 15000))
}

const patched = raw.replace('"maxSeconds": 60', '"maxSeconds": 2')
fs.writeFileSync(file, patched, 'utf8')
await restart()
try {
  const r = await fetch('http://127.0.0.1:3100/api/tts/preview', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ target: 'private:1000000000', text: 'どうもですー。今日もお疲れさまですー。ちょっとだけ、声、出してみました。……聞こえてますかー。' }),
  })
  const body = await r.json().catch(() => ({}))
  console.log('maxSeconds=2 时:', r.status, JSON.stringify({ ok: body.ok, code: body.code, error: String(body.error ?? '').slice(0, 60) }))
} finally {
  fs.writeFileSync(file, raw, 'utf8')
  await restart()
  console.log('已恢复 maxSeconds=60 并重启')
}
