// 구글 시트 읽기/쓰기
//   읽기만 하는 탭 : 시즌설정, 상품등록  (사용자가 관리하는 탭은 절대 수정하지 않음)
//   쓰는 탭        : 시즌 탭(예: 26FW) 현황 갱신, 품절_알림기록·통합이력 줄 추가

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { SPREADSHEET_ID, TABS, SEASON_TAB_HEADER, SIZE_COLUMN_START } = require('./config');
const { normalizeSize } = require('./stock');

const SEASON_RE = /^\d{2}(SS|FW)$/;
const truthy = (v) => v === true || /^(true|on|예|y|yes|o|1)$/i.test(String(v ?? '').trim());
const falsy = (v) => v === false || /^(false|off|아니오|n|no|x|0)$/i.test(String(v ?? '').trim());
const q = (tab) => `'${tab.replace(/'/g, "''")}'`;

// 인증: GOOGLE_SERVICE_ACCOUNT_JSON(키 내용) → GOOGLE_APPLICATION_CREDENTIALS(파일 경로) → ./credentials.json
function loadCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(process.cwd(), 'credentials.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  throw new Error('구글 서비스계정 키가 없습니다. GOOGLE_SERVICE_ACCOUNT_JSON 또는 credentials.json 을 준비해 주세요.');
}

function createSheets() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID 가 비어 있습니다.');
  const auth = new google.auth.GoogleAuth({
    credentials: loadCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const api = google.sheets({ version: 'v4', auth });
  const id = SPREADSHEET_ID;

  const read = async (range) => (await api.spreadsheets.values.get({
    spreadsheetId: id, range, valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.values || [];

  // 시즌설정: Map(시즌 → 감시 ON 여부)
  async function readSeasons() {
    const rows = await read(`${q(TABS.seasons)}!A2:B`);
    return new Map(rows
      .map((r) => [String(r[0] ?? '').trim().toUpperCase(), truthy(r[1])])
      .filter(([s]) => SEASON_RE.test(s)));
  }

  // 상품등록: 상품 목록 + 사이즈 체크 상태
  async function readRegistry() {
    const rows = await read(`${q(TABS.registry)}!A1:ZZ`);
    const header = rows[0] || [];
    const sizeOrder = header.slice(SIZE_COLUMN_START).map(normalizeSize);
    const products = [];
    rows.slice(1).forEach((r, i) => {
      const goodsNo = String(r[1] ?? '').trim();
      const season = String(r[0] ?? '').trim().toUpperCase();
      if (!/^\d{5,}$/.test(goodsNo) || !SEASON_RE.test(season)) return; // 빈 줄·메모 줄 건너뜀
      const sizeChecks = new Map();
      sizeOrder.forEach((size, j) => {
        if (!size) return;
        const v = r[SIZE_COLUMN_START + j];
        if (truthy(v)) sizeChecks.set(size, true);
        else if (falsy(v)) sizeChecks.set(size, false); // 체크 해제 = 재입고 일정 없음
      });
      products.push({
        sheetRow: i + 2,
        season,
        goodsNo,
        name: String(r[2] ?? '').trim(),
        watch: truthy(r[3]),
        sizeChecks,
        sizeOrder,
      });
    });
    return { products, sizeOrder };
  }

  // 시즌 탭이 없으면 만들고, 헤더가 비어 있으면 헤더를 씀
  async function ensureSeasonTab(season) {
    const meta = await api.spreadsheets.get({ spreadsheetId: id, fields: 'sheets(properties(title))' });
    const titles = (meta.data.sheets || []).map((s) => s.properties.title);
    if (!titles.includes(season)) {
      await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ addSheet: { properties: { title: season } } }] } });
      console.log(`[안내] '${season}' 탭을 새로 만들었습니다.`);
    }
    const head = (await read(`${q(season)}!A1:I1`))[0] || [];
    if (!head.some((x) => String(x).trim())) {
      await api.spreadsheets.values.update({
        spreadsheetId: id, range: `${q(season)}!A1`, valueInputOption: 'RAW', requestBody: { values: [SEASON_TAB_HEADER] },
      });
    } else if (String(head[0]).trim() !== SEASON_TAB_HEADER[0]) {
      throw new Error(`'${season}' 탭 A1이 '${SEASON_TAB_HEADER[0]}'가 아닙니다. 기존 데이터 보호를 위해 중단합니다.`);
    }
  }

  // 시즌 탭 현재 내용: { rows: Map(상품번호 → {sheetRow, values}), lastRow }
  async function readSeasonTab(season) {
    const values = await read(`${q(season)}!A2:I`);
    const rows = new Map();
    values.forEach((v, i) => {
      const g = String(v[0] ?? '').trim();
      if (g && !rows.has(g)) rows.set(g, { sheetRow: i + 2, values: v });
    });
    return { rows, lastRow: values.length + 1 };
  }

  // 시즌 탭 갱신: 기존 줄은 그 자리에서 덮어쓰고, 새 상품은 아래에 추가 (줄 순서 유지)
  async function writeSeasonRows(season, updates) {
    for (let i = 0; i < updates.length; i += 200) {
      const data = updates.slice(i, i + 200).map((u) => ({ range: `${q(season)}!A${u.sheetRow}:I${u.sheetRow}`, values: [u.values] }));
      await api.spreadsheets.values.batchUpdate({ spreadsheetId: id, requestBody: { valueInputOption: 'RAW', data } });
    }
  }

  async function appendRows(tab, lastCol, rows) {
    if (!rows.length) return;
    await api.spreadsheets.values.append({
      spreadsheetId: id, range: `${q(tab)}!A:${lastCol}`, valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS', requestBody: { values: rows },
    });
  }

  // 크롬 수집 탭: Map(상품번호 → 줄). 탭이 없으면 빈 Map
  async function readBrowserTab() {
    const rows = await read(`${q(TABS.browser)}!A2:E`).catch(() => []);
    return new Map(rows.filter((r) => /^\d{5,}$/.test(String(r[0] ?? '').trim())).map((r) => [String(r[0]).trim(), r]));
  }

  return {
    readBrowserTab,
    readSeasons, readRegistry, ensureSeasonTab, readSeasonTab, writeSeasonRows,
    appendLog: (rows) => appendRows(TABS.log, 'E', rows),         // 시각, 종류, 상품명, 내용, URL
    appendHistory: (rows) => appendRows(TABS.history, 'G', rows), // 시각, 시즌, 종류, 상품번호, 상품명, 내용, 상품 URL
  };
}

module.exports = { createSheets, truthy, falsy };
