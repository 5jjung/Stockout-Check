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
  if (!checkToken_(e.parameter.token)) return json_({ ok: false, error: '토큰 불일치' });
  return json_({ ok: true, goodsNos: watchedGoods_() });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: '형식 오류' }); }
  if (!checkToken_(body.token)) return json_({ ok: false, error: '토큰 불일치' });
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
    .addSeparator()
    .addItem('지금 바로 확인', 'runCheckNow')
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
