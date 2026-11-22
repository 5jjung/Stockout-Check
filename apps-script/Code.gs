/**
 * 구글 시트 ↔ 크롬 수집 스크립트 연결 (Apps Script 웹앱)
 *
 * 설치: 시트 → 확장 프로그램 → Apps Script → 이 내용 붙여넣기 → 저장
 *       → setup 함수 1회 실행(권한 허용) → 실행 로그의 "토큰" 복사
 *       → 배포 → 새 배포 → 유형: 웹 앱 / 실행: 나 / 액세스: 모든 사용자 → 배포
 *       → 웹 앱 URL 복사
 *
 * GET  ?token=...        → 확인할 상품번호 목록 (시즌 ON + 상품등록 D열 체크)
 * POST {token, rows:[]}  → '브라우저_수집' 탭에 상품별 최신 결과 저장
 *                          rows: [상품번호, 수집시각(ISO), 보는사람수, 재고JSON, 오류]
 */

// GitHub 자동 실행 (시트가 10분마다 GitHub 품절 체크를 눌러 줌 → 컴퓨터 꺼져도 동작)
const GH = { owner: '5jjung', repo: 'Stockout-Check', workflow: 'stock-check.yml', ref: 'main' };

const TAB_SEASONS = '시즌설정';
const TAB_REGISTRY = '상품등록';
const TAB_BROWSER = '브라우저_수집';
const BROWSER_HEADER = ['상품번호', '수집 시각', '보는 사람 수', '재고 데이터', '오류'];

function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  browserSheet_();
  Logger.log('토큰 (크롬 수집 스크립트의 TOKEN 에 붙여넣기): ' + token);
}

function doGet(e) {
  if (e.parameter.code) return kakaoCallback_(e.parameter.code); // 카카오 로그인 후 돌아온 경우
  if (!checkToken_(e.parameter.token)) return json_({ ok: false, error: '토큰 불일치' });
  return json_({ ok: true, goodsNos: watchedGoods_() });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: '형식 오류' }); }
  if (!checkToken_(body.token)) return json_({ ok: false, error: '토큰 불일치' });
  if (body.action === 'kakao') return json_(kakaoFromGithub_(body));
  const rows = (body.rows || []).filter((r) => /^\d{5,}$/.test(String(r[0])));
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = browserSheet_();
    const last = sh.getLastRow();
    const codes = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map((r) => String(r[0])) : [];
    let append = [];
    rows.forEach((r) => {
      const v = [String(r[0]), r[1] || new Date().toISOString(), r[2] === null || r[2] === undefined ? '' : r[2], r[3] || '', r[4] || ''];
      const idx = codes.indexOf(v[0]);
      if (idx >= 0) sh.getRange(idx + 2, 1, 1, 5).setValues([v]);
      else { append.push(v); codes.push(v[0]); }
    });
    if (append.length) sh.getRange(sh.getLastRow() + 1, 1, append.length, 5).setValues(append);
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, saved: rows.length });
}

// 시즌설정 ON + 상품등록 D열 체크된 상품번호
function watchedGoods_() {
  const ss = SpreadsheetApp.getActive();
  const seasonOn = {};
  ss.getSheetByName(TAB_SEASONS).getDataRange().getValues().slice(1).forEach((r) => {
    seasonOn[String(r[0]).trim().toUpperCase()] = r[1] === true || String(r[1]).toUpperCase() === 'TRUE';
  });
  const out = [];
  ss.getSheetByName(TAB_REGISTRY).getDataRange().getValues().slice(1).forEach((r) => {
    const season = String(r[0]).trim().toUpperCase();
    const no = String(r[1]).trim();
    if (/^\d{5,}$/.test(no) && seasonOn[season] && r[3] === true && out.indexOf(no) < 0) out.push(no);
  });
  return out;
}

function browserSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(TAB_BROWSER);
  if (!sh) sh = ss.insertSheet(TAB_BROWSER);
  if (!sh.getRange(1, 1).getValue()) sh.getRange(1, 1, 1, BROWSER_HEADER.length).setValues([BROWSER_HEADER]);
  return sh;
}

function checkToken_(t) {
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return !!token && t === token;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ───────── 시트 메뉴: 품절 체크 ─────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('품절 체크')
    .addItem('① GitHub 연결 (토큰 입력)', 'setGithubToken')
    .addItem('② 10분 자동 실행 켜기', 'enableAutoRun')
    .addItem('자동 실행 끄기', 'disableAutoRun')
    .addItem('③ 카카오톡 연결', 'setupKakao')
    .addSeparator()
    .addItem('지금 바로 확인', 'runCheckNow')
    .addItem('카카오톡 테스트 보내기', 'testKakao')
    .addToUi();
}

function setGithubToken() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('GitHub 연결', 'GitHub 토큰(github_pat_…)을 붙여넣으세요.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().setProperty('GITHUB_TOKEN', r.getResponseText().trim());
  const res = dispatch_();
  ui.alert(res.ok ? '연결 성공! 품절 체크를 한 번 실행했습니다. 이제 ② 10분 자동 실행 켜기를 눌러 주세요.' : '연결 실패: ' + res.msg);
}

function enableAutoRun() {
  removeTriggers_();
  ScriptApp.newTrigger('runCheckNow').timeBased().everyMinutes(10).create();
  SpreadsheetApp.getUi().alert('10분 자동 실행을 켰습니다. (끄려면 메뉴 → 자동 실행 끄기)');
}

function disableAutoRun() {
  removeTriggers_();
  SpreadsheetApp.getUi().alert('자동 실행을 껐습니다.');
}

function runCheckNow() {
  const res = dispatch_();
  if (!res.ok) throw new Error('GitHub 실행 실패: ' + res.msg);
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'runCheckNow').forEach((t) => ScriptApp.deleteTrigger(t));
}

function dispatch_() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) return { ok: false, msg: '토큰이 없습니다. 메뉴 → ① GitHub 연결' };
  const url = 'https://api.github.com/repos/' + GH.owner + '/' + GH.repo + '/actions/workflows/' + GH.workflow + '/dispatches';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ ref: GH.ref }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 204) return { ok: true };
  return { ok: false, msg: 'HTTP ' + code + ' ' + res.getContentText().slice(0, 200) };
}

// ───────── 카카오톡 "나에게 보내기" (문제 생겼을 때만) ─────────
// 카카오 로그인 정보(토큰)는 이 스크립트 속성에만 보관하고 자동 갱신합니다.

function setupKakao() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const k = ui.prompt('카카오톡 연결 (1/2)', '카카오 개발자 앱의 REST API 키를 붙여넣으세요.', ui.ButtonSet.OK_CANCEL);
  if (k.getSelectedButton() !== ui.Button.OK) return;
  props.setProperty('KAKAO_REST_KEY', k.getResponseText().trim());
  const sct = ui.prompt('카카오톡 연결 (2/2)', 'Client Secret 을 켜 두었다면 코드를 붙여넣으세요. (안 켰으면 비워 두고 확인)', ui.ButtonSet.OK_CANCEL);
  if (sct.getSelectedButton() !== ui.Button.OK) return;
  props.setProperty('KAKAO_CLIENT_SECRET', sct.getResponseText().trim());
  const redirect = kakaoRedirect_();
  const url = 'https://kauth.kakao.com/oauth/authorize?response_type=code&scope=talk_message'
    + '&client_id=' + encodeURIComponent(props.getProperty('KAKAO_REST_KEY'))
    + '&redirect_uri=' + encodeURIComponent(redirect);
  const html = HtmlService.createHtmlOutput(
    '<div style="font:14px/1.6 sans-serif">'
    + '<p>① 카카오 개발자 앱 → 카카오 로그인 → <b>Redirect URI</b> 에 아래 주소가 등록돼 있어야 합니다.</p>'
    + '<input style="width:100%" readonly value="' + redirect + '" onclick="this.select()">'
    + '<p>② 아래 버튼 → 카카오 로그인 → 동의하면 "연결 완료" 화면이 뜨고 카톡으로 테스트 메시지가 옵니다.</p>'
    + '<p><a href="' + url + '" target="_blank" style="display:inline-block;padding:8px 14px;background:#FEE500;color:#000;border-radius:6px;text-decoration:none"><b>카카오 로그인하고 연결하기</b></a></p></div>'
  ).setWidth(520).setHeight(300);
  ui.showModalDialog(html, '카카오톡 연결');
}

function testKakao() {
  const r = sendKakao_('✅ 품절 체크 카카오톡 테스트입니다. 문제가 생기면 이 채팅방으로 알려드립니다.');
  SpreadsheetApp.getUi().alert(r.ok ? '카카오톡으로 테스트 메시지를 보냈습니다.' : '실패: ' + r.msg);
}

function kakaoRedirect_() {
  return PropertiesService.getScriptProperties().getProperty('KAKAO_REDIRECT') || ScriptApp.getService().getUrl();
}

function kakaoCallback_(code) {
  const props = PropertiesService.getScriptProperties();
  const payload = {
    grant_type: 'authorization_code',
    client_id: props.getProperty('KAKAO_REST_KEY') || '',
    redirect_uri: kakaoRedirect_(),
    code: code,
  };
  const secret = props.getProperty('KAKAO_CLIENT_SECRET');
  if (secret) payload.client_secret = secret;
  const res = UrlFetchApp.fetch('https://kauth.kakao.com/oauth/token', { method: 'post', payload: payload, muteHttpExceptions: true });
  const j = JSON.parse(res.getContentText() || '{}');
  if (!j.access_token) return HtmlService.createHtmlOutput('<h3>카카오톡 연결 실패</h3><pre>' + res.getContentText().slice(0, 500) + '</pre>');
  saveKakaoTokens_(j);
  const t = sendKakao_('✅ 품절 체크 카카오톡 연결 완료! 품절·재고 부족·크롬 멈춤·실행 실패가 생기면 여기로 알려드립니다.');
  return HtmlService.createHtmlOutput('<h3>카카오톡 연결 완료</h3><p>' + (t.ok ? '카톡으로 테스트 메시지를 보냈습니다. 이 창은 닫으셔도 됩니다.' : '연결은 됐지만 테스트 전송 실패: ' + t.msg) + '</p>');
}

function saveKakaoTokens_(j) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('KAKAO_ACCESS', j.access_token);
  props.setProperty('KAKAO_ACCESS_EXP', String(Date.now() + (Number(j.expires_in || 21599) - 300) * 1000));
  if (j.refresh_token) props.setProperty('KAKAO_REFRESH', j.refresh_token); // 갱신 때 새로 오면 교체
}

function kakaoAccess_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('KAKAO_ACCESS') && Date.now() < Number(props.getProperty('KAKAO_ACCESS_EXP') || 0)) return props.getProperty('KAKAO_ACCESS');
  const refresh = props.getProperty('KAKAO_REFRESH');
  if (!refresh) throw new Error('카카오톡 연결 안 됨 (메뉴 → ③ 카카오톡 연결)');
  const payload = { grant_type: 'refresh_token', client_id: props.getProperty('KAKAO_REST_KEY') || '', refresh_token: refresh };
  const secret = props.getProperty('KAKAO_CLIENT_SECRET');
  if (secret) payload.client_secret = secret;
  const res = UrlFetchApp.fetch('https://kauth.kakao.com/oauth/token', { method: 'post', payload: payload, muteHttpExceptions: true });
  const j = JSON.parse(res.getContentText() || '{}');
  if (!j.access_token) throw new Error('카카오 토큰 갱신 실패 — 메뉴 → ③ 카카오톡 연결을 다시 해 주세요 (' + res.getContentText().slice(0, 150) + ')');
  saveKakaoTokens_(j);
  return j.access_token;
}

// 카톡 한 통은 200자까지 → 줄 단위로 나눠 최대 5통
function sendKakao_(text) {
  try {
    const access = kakaoAccess_();
    const sheetUrl = SpreadsheetApp.getActive().getUrl();
    const chunks = [];
    let cur = '';
    String(text).split('\n').forEach((line) => {
      line = line.slice(0, 195);
      if ((cur + '\n' + line).length > 195 && cur) { chunks.push(cur); cur = line; } else cur = cur ? cur + '\n' + line : line;
    });
    if (cur) chunks.push(cur);
    for (const c of chunks.slice(0, 5)) {
      const tpl = { object_type: 'text', text: c, link: { web_url: sheetUrl, mobile_web_url: sheetUrl }, button_title: '시트 열기' };
      const res = UrlFetchApp.fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
        method: 'post', headers: { Authorization: 'Bearer ' + access }, payload: { template_object: JSON.stringify(tpl) }, muteHttpExceptions: true,
      });
      if (res.getResponseCode() !== 200) return { ok: false, msg: 'HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 150) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
}

// GitHub 품절 체크가 보낸 요청. dedupe {key, minutes}: 같은 key 는 그 시간 안에 한 번만 보냄
function kakaoFromGithub_(body) {
  const props = PropertiesService.getScriptProperties();
  if (body.dedupe && body.dedupe.key) {
    const k = 'KAKAO_LAST_' + body.dedupe.key;
    const last = Number(props.getProperty(k) || 0);
    if (Date.now() - last < Number(body.dedupe.minutes || 60) * 60000) return { ok: true, skipped: true };
    props.setProperty(k, String(Date.now()));
  }
  return sendKakao_(String(body.text || ''));
}
