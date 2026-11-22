// 슬랙 알림 (SLACK_WEBHOOK_URL 이 없으면 아무것도 안 함)
const { SLACK_WEBHOOK_URL, DRY_RUN } = require('./config');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// lines: ['• <url|상품명> — 내용', ...]  30줄씩 나눠 보냄
async function sendSlack(title, lines) {
  if (!lines.length) return;
  if (DRY_RUN) { console.log(`[DRY-RUN] 슬랙으로 보냈을 메시지\n${title}\n${lines.join('\n')}`); return; }
  if (!SLACK_WEBHOOK_URL) return;
  for (let i = 0; i < lines.length; i += 30) {
    const text = (i === 0 ? `${title}\n` : '') + lines.slice(i, i + 30).join('\n');
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, unfurl_links: false }),
    });
    if (!res.ok) console.error(`[슬랙 오류] HTTP ${res.status}`);
  }
}

module.exports = { sendSlack, esc };
