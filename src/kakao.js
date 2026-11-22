// 카카오톡 "나에게 보내기" — 문제 생겼을 때만
//   실제 전송은 구글 Apps Script(웹앱)가 함 (카카오 로그인 정보를 거기에만 보관)
//   필요한 값: WEBAPP_URL (Apps Script 웹앱 주소), WEBAPP_TOKEN (크롬 수집에 넣은 토큰과 같은 값)

const { DRY_RUN } = require('./config');

const URL = (process.env.WEBAPP_URL || '').trim();
const TOKEN = (process.env.WEBAPP_TOKEN || '').trim();

// dedupe: { key, minutes } — 같은 key 는 그 시간 안에 한 번만 (Apps Script 가 기억)
async function sendKakao(text, dedupe) {
  if (!text) return;
  if (DRY_RUN) { console.log(`[DRY-RUN] 카카오톡으로 보냈을 메시지\n${text}`); return; }
  if (!URL || !TOKEN) return; // 설정 전이면 조용히 건너뜀
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: TOKEN, action: 'kakao', text, dedupe }),
      redirect: 'follow',
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) console.error(`[카카오톡 실패] ${j.msg || j.error || `HTTP ${res.status}`}`);
    else if (j.skipped) console.log('   [카카오톡] 같은 알림을 최근에 보내서 건너뜀');
    else console.log('   [카카오톡] 전송');
  } catch (e) {
    console.error(`[카카오톡 실패] ${e.message}`);
  }
}

module.exports = { sendKakao };
