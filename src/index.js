// 시즌 신상품 품절 체크 — 실행 시작점
//   npm run check   : 한 번 확인 (GitHub Actions 가 이걸 주기적으로 실행)
//   npm run watch   : 켜 둔 동안 INTERVAL_MINUTES 마다 계속 확인 (PC에서 실시간 감시용)
//   npm run dry     : 시트·슬랙에 아무것도 쓰지 않고 결과만 출력

const { DRY_RUN, WATCH, INTERVAL_MINUTES, TABS } = require('./config');
const { createSheets } = require('./sheets');
const { fetchProducts, productUrl } = require('./musinsa');
const { toSnapshot, evaluate } = require('./stock');
const { sendSlack, esc } = require('./slack');
const { stamp, sleep } = require('./time');

async function runOnce() {
  const startedAt = Date.now();
  const sheets = createSheets();
  const seasons = await sheets.readSeasons();
  const { products, sizeOrder } = await sheets.readRegistry();

  // 시즌설정에서 ON 인 시즌의 상품만 (같은 상품번호가 두 번 있으면 위쪽 줄 기준)
  const seen = new Set();
  const targets = products.filter((p) => {
    if (seasons.get(p.season) !== true) return false;
    const key = `${p.season}|${p.goodsNo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const onCount = targets.filter((p) => p.watch).length;
  console.log(`[시작] ${stamp()} · 시즌 ON: ${[...seasons].filter(([, on]) => on).map(([s]) => s).join(', ') || '없음'}`
    + ` · 확인할 상품 ${targets.length}개 (감시 ON ${onCount} / 재입고 일정 없음 ${targets.length - onCount})`
    + (DRY_RUN ? ' [DRY-RUN: 시트·슬랙에 쓰지 않음]' : ''));
  if (!targets.length) return;

  // 1) 무신사 조회
  let done = 0;
  const raws = await fetchProducts([...new Set(targets.map((p) => p.goodsNo))], {
    onEach: (g, raw) => {
      done++;
      if (raw.error) console.warn(`   [조회 실패] ${g}: ${raw.error}`);
      if (done % 20 === 0) console.log(`   … ${done}개 확인`);
    },
  });

  // 2) 시즌별로 직전 상태와 비교
  const now = stamp();
  const logRows = [];
  const historyRows = [];
  const slackLines = [];
  let failed = 0;

  for (const season of [...new Set(targets.map((p) => p.season))]) {
    if (!DRY_RUN) await sheets.ensureSeasonTab(season);
    const tab = await sheets.readSeasonTab(season).catch(() => ({ rows: new Map(), lastRow: 1 }));
    const updates = [];
    let nextRow = tab.lastRow + 1;

    for (const product of targets.filter((p) => p.season === season)) {
      const snap = toSnapshot(raws.get(product.goodsNo), sizeOrder);
      if (snap.error) failed++;
      const prev = tab.rows.get(product.goodsNo);
      const { row, events } = evaluate({ product, prevRow: prev?.values || null, snap, now });
      updates.push({ sheetRow: prev ? prev.sheetRow : nextRow++, values: row });

      const url = productUrl(product.goodsNo);
      const name = row[1];
      for (const ev of events) {
        logRows.push([now, ev.label, name, ev.text, url]);
        historyRows.push([now, season, ev.label, product.goodsNo, name, ev.text, url]);
        console.log(`   [${ev.label}] ${product.goodsNo} ${name} — ${ev.text}`);
        if (ev.notify) {
          const hint = !ev.watched ? ' _(재입고 일정 없음으로 체크 해제된 상품/사이즈 → 상품등록 체크박스 확인)_' : '';
          slackLines.push(`• <${url}|${esc(name)}> — *${ev.label}*: ${esc(ev.text)}${hint}`);
        }
      }
    }
    if (!DRY_RUN) await sheets.writeSeasonRows(season, updates);
    console.log(`   '${season}' 탭 ${updates.length}개 상품 현황 갱신${DRY_RUN ? ' (DRY-RUN: 실제로는 안 씀)' : ''}`);
  }

  // 3) 기록 남기기 + 슬랙
  if (!DRY_RUN) {
    await sheets.appendLog(logRows);
    await sheets.appendHistory(historyRows);
  }
  await sendSlack(`🔔 *시즌 신상품 품절 체크* (${slackLines.length}건)`, slackLines);

  const sec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[완료] 변동 ${logRows.length}건 기록 ('${TABS.log}', '${TABS.history}') · 슬랙 ${slackLines.length}건 · 조회 실패 ${failed}건 · ${sec}초`);
  if (failed === targets.length) throw new Error('모든 상품 조회에 실패했습니다. 무신사 차단 여부를 확인해 주세요 (README "조회가 전부 실패할 때").');
}

async function main() {
  if (!WATCH) return runOnce();
  console.log(`[실시간 감시] ${INTERVAL_MINUTES}분마다 확인합니다. 멈추려면 Ctrl+C`);
  for (;;) {
    const t = Date.now();
    try { await runOnce(); } catch (e) { console.error('[오류]', e.message); }
    await sleep(Math.max(10_000, INTERVAL_MINUTES * 60_000 - (Date.now() - t)));
  }
}

main().catch((e) => { console.error('[실패]', e.message); process.exitCode = 1; });
