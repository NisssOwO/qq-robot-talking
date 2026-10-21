// tts-fish.mjs 的离线回归：不发真实请求（fetch 全部注入）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateMp3Seconds, measureSeconds, saveTtsAudio, cleanupTtsFiles, synthesizeFish, TtsError } from '../src/tts-fish.mjs';

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`);
};
const expectCode = async (label, code, fn) => {
  try {
    await fn();
    check(label, false, '没有抛错');
  } catch (error) {
    const got = error instanceof TtsError ? error.code : `非 TtsError(${error?.name})`;
    check(label, got === code, `code=${got}`);
  }
};

const key = 'test-key';
const voiceId = 'voice-1';

await expectCode('缺 key', 'no-key', () => synthesizeFish({ apiKey: '', voiceId, text: 'a' }));
await expectCode('空文本', 'empty-text', () => synthesizeFish({ apiKey: key, voiceId, text: '   ' }));

const respondOnce = (status, body, type = 'application/json') => async () => new Response(body, { status, headers: { 'content-type': type } });

await expectCode('401', 'auth', () => synthesizeFish({ apiKey: key, voiceId, text: 'a', fetchImpl: respondOnce(401, '{"message":"bad key"}') }));
await expectCode('429', 'rate', () => synthesizeFish({ apiKey: key, voiceId, text: 'a', fetchImpl: respondOnce(429, 'rate limited') }));
await expectCode('500', 'server', () => synthesizeFish({ apiKey: key, voiceId, text: 'a', fetchImpl: respondOnce(500, 'boom') }));
await expectCode('超时', 'timeout', () => synthesizeFish({
  apiKey: key, voiceId, text: 'a',
  fetchImpl: async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; },
}));
await expectCode('200 但返回 HTML', 'bad-response', () => synthesizeFish({ apiKey: key, voiceId, text: 'a', fetchImpl: respondOnce(200, '<html>oops</html>', 'text/html') }));
await expectCode('200 但空音频', 'empty-audio', () => synthesizeFish({ apiKey: key, voiceId, text: 'a', fetchImpl: respondOnce(200, new Uint8Array(0), 'audio/mpeg') }));

// 正常返回：假 mp3（128kbps 帧头）
const fakeMp3 = Buffer.alloc(128000);
fakeMp3[0] = 0xff; fakeMp3[1] = 0xfb; fakeMp3[2] = 0x90; fakeMp3[3] = 0x00;
const okResult = await synthesizeFish({ apiKey: key, voiceId, text: 'a', fetchImpl: respondOnce(200, fakeMp3, 'audio/mpeg') });
check('正常合成', okResult.buffer.length === 128000, `len=${okResult.buffer.length}`);

// 时长估算：128kbps 下 128000 字节 = 8 秒
const estimated = estimateMp3Seconds(fakeMp3);
check('时长估算≈8s', Math.abs(estimated - 8) < 0.6, `got=${estimated.toFixed(2)}`);

// 落盘 + 清理
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-test-'));
const voiceDir = path.join(tmp, 'audio');
for (let i = 0; i < 25; i += 1) {
  saveTtsAudio(fakeMp3, { voiceDir, keepFiles: 20, now: Date.now() + i * 1000 });
}
const saved = fs.readdirSync(path.join(voiceDir, 'tts'));
check('保留 20 个', saved.length === 20, `got=${saved.length}`);
const removed = cleanupTtsFiles(path.join(voiceDir, 'tts'), 20);
check('已无可清理', removed.removed === 0, `removed=${removed.removed}`);

// 用户自己的语音不该被清理
fs.writeFileSync(path.join(voiceDir, 'mine.mp3'), fakeMp3);
cleanupTtsFiles(path.join(voiceDir, 'tts'), 1);
check('自定义文件不受影响', fs.existsSync(path.join(voiceDir, 'mine.mp3')));

// measureSeconds 在无 ffprobe 时退回估算
const one = saveTtsAudio(fakeMp3, { voiceDir, keepFiles: 5 });
const measured = await measureSeconds(one.file, { ffprobePath: 'definitely-not-exist-ffprobe' });
check('measureSeconds 有结果', measured.seconds > 0, `source=${measured.source} seconds=${measured.seconds.toFixed(2)}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
