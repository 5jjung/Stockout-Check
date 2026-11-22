// 일회성: 감시 OFF 상품을 잘못 기록한 줄('(재입고 일정 없음)' 표시) 삭제
const { google } = require('googleapis');

(async () => {
  const id = process.env.SPREADSHEET_ID;
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const api = google.sheets({ version: 'v4', auth });
  const meta = await api.spreadsheets.get({ spreadsheetId: id, fields: 'sheets(properties(sheetId,title))' });
  const sheetId = (t) => meta.data.sheets.find((s) => s.properties.title === t).properties.sheetId;

  for (const [tab, col] of [['품절_알림기록', 1], ['통합이력', 2]]) {
    const rows = (await api.spreadsheets.values.get({ spreadsheetId: id, range: `'${tab}'!A1:G` })).data.values || [];
    const targets = rows.map((r, i) => ({ i, r })).filter(({ i, r }) => i > 0 && String(r[col] || '').includes('(재입고 일정 없음)'));
    for (const { r } of targets) console.log(`[${tab}] 삭제: ${r.join(' | ')}`);
    const requests = targets.map(({ i }) => i).sort((a, b) => b - a)
      .map((i) => ({ deleteDimension: { range: { sheetId: sheetId(tab), dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } }));
    if (requests.length) await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests } });
    console.log(`[${tab}] ${requests.length}줄 삭제 완료`);
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
