import fs from 'node:fs';

const root = 'F:/产出/shiny colors';
const consoleToken = fs.readFileSync(`${root}/state/console-token`, 'utf8').trim();
const social = JSON.parse(fs.readFileSync(`${root}/state/social-v2.json`, 'utf8'));
const conv = social.conversations?.['group:123456789'];
const agentToken = String(conv?.agentToken ?? '');
const key = 'group:123456789';

const cfgPath = `${root}/config.json`;
const originalRaw = fs.readFileSync(cfgPath, 'utf8');
const original = JSON.parse(originalRaw);

const api = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:3100${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-console-token': consoleToken, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const line = (label, value) => console.log(`${label}: ${value}`);

// ── 1) 超 60 秒 → 降级（先做：失败不占限流额度）────────────────────────────
const longText = 'あ'.repeat(700);
const tooLong = await api('/api/tts/preview', { target: 'private:1000000000', text: longText });
line('① 超长文本', `status=${tooLong.status} code=${tooLong.body.code ?? '-'} msg=${String(tooLong.body.error ?? '').slice(0, 40)}`);

// ── 2) 错误密钥 → 认证失败降级 ─────────────────────────────────────────────
let authResult;
try {
  const broken = JSON.parse(originalRaw);
  broken.tts.apiKey = 'sk-invalid-for-test';
  fs.writeFileSync(cfgPath, `${JSON.stringify(broken, null, 2)}\n`);
  await api('/api/tts/config', { enabled: true }); // 让桥接重读 cfg.tts
  authResult = await api('/api/tts/preview', { target: 'private:1000000000', text: 'てすと' });
} finally {
  fs.writeFileSync(cfgPath, originalRaw);
  await api('/api/tts/config', { enabled: original.tts.enabled === true });
}
line('② 错误密钥', `status=${authResult?.status} code=${authResult?.body.code ?? '-'} msg=${String(authResult?.body.error ?? '').slice(0, 40)}`);

// ── 3) 试听（成功路径）────────────────────────────────────────────────────
const preview = await api('/api/tts/preview', {
  target: 'private:1000000000',
  text: 'どうもですー。今日もお疲れさまですー。……ちょっとだけ、声、出してみました。',
});
line('③ 试听', `status=${preview.status} ok=${preview.body.ok} seconds=${preview.body.seconds} source=${preview.body.source} msgId=${preview.body.messageId}`);

// ── 4) 限流（同一 scope 每分钟 2 条）──────────────────────────────────────
const r1 = await api('/api/tts/preview', { target: 'private:1000000000', text: 'はい、もう一回だけですー。' });
const r2 = await api('/api/tts/preview', { target: 'private:1000000000', text: 'はい、三回目ですー。' });
line('④ 限流 第2次', `status=${r1.status} ok=${r1.body.ok}`);
line('④ 限流 第3次', `status=${r2.status} ok=${r2.body.ok} msg=${String(r2.body.error ?? '').slice(0, 40)}`);

// ── 5) AI 通道（等同 qq_tts_say）──────────────────────────────────────────
const said = await api('/api/socialV2/tts-say', {
  key,
  token: agentToken,
  ja: 'おやすみなさいですー。明日も、ちゃんと起きてくださいねー。',
  zh: '晚安啦——明天也要好好起床哦——',
});
line('⑤ AI 通道', `status=${said.status} ok=${said.body.ok} seconds=${said.body.seconds} textSent=${said.body.textSent} code=${said.body.code ?? '-'}`);

line('config 已恢复', fs.readFileSync(cfgPath, 'utf8') === originalRaw ? 'yes' : 'NO（需检查）');
