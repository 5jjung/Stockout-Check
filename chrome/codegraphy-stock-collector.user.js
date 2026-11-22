// ==UserScript==
// @name         코드그라피 사이즈 품절 수집
// @namespace    stockout-check
// @version      1.1.0
// @description  무신사 탭이 열려 있는 동안 10분마다 감시 상품의 사이즈별 재고를 확인해 구글 시트에 적습니다.
// @match        https://www.musinsa.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @updateURL    https://raw.githubusercontent.com/5jjung/Stockout-Check/main/chrome/codegraphy-stock-collector.user.js
// @downloadURL  https://raw.githubusercontent.com/5jjung/Stockout-Check/main/chrome/codegraphy-stock-collector.user.js
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───── 설정 ─────
  // 코드에 직접 쓰지 않고, Tampermonkey 메뉴 "설정 입력 (웹앱 주소·토큰)"으로 넣습니다.
  // (그래야 스크립트가 자동 업데이트돼도 설정이 지워지지 않음)
  const cfg = () => ({ url: GM_getValue('webappUrl', ''), token: GM_getValue('token', '') });
  // ────────────────
  const INTERVAL_MIN = 10;   // 몇 분마다 확인할지
  const PARALLEL = 2;        // 동시에 확인하는 상품 수
  const API = 'https://goods-detail.musinsa.com/api2/goods';

  if (window.top !== window.self) return; // 페이지 안 작은 창(iframe)에서는 실행 안 함

  // 무신사 탭을 여러 개 열어도 한 탭만 수집하도록 (2분간 신호 없으면 다른 탭이 이어받음)
  const TAB_ID = Math.random().toString(36).slice(2);
  const isLeader = (force = false) => {
    const lock = GM_getValue('leader', null);
    if (force || !lock || lock.id === TAB_ID || Date.now() - lock.t > 90000) {
      GM_setValue('leader', { id: TAB_ID, t: Date.now() });
      return true;
    }
    return false;
  };
  setInterval(() => { const l = GM_getValue('leader', null); if (l && l.id === TAB_ID) GM_setValue('leader', { id: TAB_ID, t: Date.now() }); }, 30000);
  // 탭을 닫거나 새로고침하면 수집 담당을 바로 내려놓음 (다른 탭·새 페이지가 즉시 이어받음)
  window.addEventListener('pagehide', () => { const l = GM_getValue('leader', null); if (l && l.id === TAB_ID) GM_setValue('leader', null); });

  // 화면 오른쪽 아래 작은 상태 표시
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;background:#111;color:#fff;font:12px/1.4 sans-serif;padding:6px 10px;border-radius:6px;opacity:.85;pointer-events:none;max-width:320px';
  const show = (t) => { badge.textContent = `품절수집 · ${t}`; if (!badge.isConnected) document.body.appendChild(badge); };

  // 구글 시트(웹앱) 통신
  function webapp(method, payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: method === 'GET' ? `${cfg().url}?token=${encodeURIComponent(cfg().token)}` : cfg().url,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        data: method === 'POST' ? JSON.stringify({ token: cfg().token, rows: payload }) : undefined,
        onload: (r) => { try { const j = JSON.parse(r.responseText); j.ok ? resolve(j) : reject(new Error(j.error)); } catch (e) { reject(new Error(`웹앱 응답 오류 (${r.status})`)); } },
        onerror: () => reject(new Error('웹앱 연결 실패')),
        ontimeout: () => reject(new Error('웹앱 시간 초과')),
        timeout: 60000,
      });
    });
  }

  // 무신사 데이터 요청 (이 탭의 로그인·쿠키 그대로 사용)
  async function get(url, body) {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return { status: 404 };
    if (!res.ok) return { status: res.status };
    return { status: 200, json: await res.json() };
  }

  // JSON 안에서 옵션 목록·재고 목록을 "모양"으로 찾기 (주소/구조가 조금 바뀌어도 동작)
  function find(json, test, depth = 0) {
    if (!json || typeof json !== 'object' || depth > 8) return null;
    if (Array.isArray(json)) {
      const objs = json.filter((x) => x && typeof x === 'object');
      if (objs.length && objs.every(test)) return objs;
      for (const x of objs) { const f = find(x, test, depth + 1); if (f) return f; }
      return null;
    }
    for (const v of Object.values(json)) { const f = find(v, test, depth + 1); if (f) return f; }
    return null;
  }
  function findDetail(json, goodsNo, depth = 0) {
    if (!json || typeof json !== 'object' || depth > 8) return null;
    if (!Array.isArray(json) && typeof json.goodsSaleType === 'string' && (json.goodsNo == null || String(json.goodsNo) === goodsNo)) return json;
    for (const v of Object.values(json)) { const f = findDetail(v, goodsNo, depth + 1); if (f) return f; }
    return null;
  }

  // 상품 하나 확인 → 시트에 적을 재고 데이터
  async function collect(goodsNo) {
    const d = await get(`${API}/${goodsNo}`);
    if (d.status === 404) return { gone: true };
    if (d.status !== 200) return { error: `상세 HTTP ${d.status}` };
    const detail = findDetail(d.json, goodsNo);
    if (!detail) return { error: '상세 정보 없음' };

    const o = await get(`${API}/${goodsNo}/v2/options?goodsSaleType=${encodeURIComponent(detail.goodsSaleType)}`);
    const options = (o.json && find(o.json, (x) => Array.isArray(x.optionValues))) || [];

    let inventory = [];
    const valueNos = [...new Set(options.flatMap((x) => x.optionValues.map((v) => v.no)).filter((v) => v != null))];
    if (options.length && valueNos.length) {
      const inv = await get(`${API}/${goodsNo}/options/v2/prioritized-inventories`, { optionValueNos: valueNos });
      inventory = (inv.json && find(inv.json, (x) => 'productVariantId' in x && 'outOfStock' in x)) || [];
    }
    const stock = {
      detail: { goodsSaleType: detail.goodsSaleType, isOutOfStock: detail.isOutOfStock === true, goodsNm: detail.goodsNm || '' },
      options: options.map((x) => ({
        no: x.no, managedCode: x.managedCode, activated: x.activated, isDeleted: x.isDeleted,
        outOfStock: typeof x.outOfStock === 'boolean' ? x.outOfStock : undefined,
        optionValues: x.optionValues.map((v) => ({ no: v.no, name: v.name })),
      })),
      inventory: inventory.map((x) => ({ productVariantId: x.productVariantId, outOfStock: x.outOfStock })),
    };
    if (options.length && !inventory.length && !stock.options.every((x) => typeof x.outOfStock === 'boolean')) {
      stock.error = '옵션별 재고를 받지 못함';
    }
    return stock;
  }

  let running = false;
  async function run(force = false) {
    if (running) return;
    if (!cfg().url || !cfg().token) { show('설정 필요: Tampermonkey 메뉴 → 설정 입력'); return; }
    if (!isLeader(force)) { show('다른 무신사 탭에서 수집 중 · 이 탭은 대기'); return; }
    running = true;
    const started = new Date();
    try {
      show('상품 목록 받는 중…');
      const { goodsNos } = await webapp('GET');
      const rows = [];
      let ok = 0; let fail = 0;
      const queue = [...goodsNos];
      await Promise.all(Array.from({ length: PARALLEL }, async () => {
        while (queue.length) {
          const g = queue.shift();
          let stock;
          try { stock = await collect(g); } catch (e) { stock = { error: e.message }; }
          if (stock.error) fail++; else ok++;
          rows.push([g, new Date().toISOString(), '', JSON.stringify(stock), stock.error || '']);
          show(`확인 중 ${ok + fail}/${goodsNos.length}`);
        }
      }));
      for (let i = 0; i < rows.length; i += 40) await webapp('POST', rows.slice(i, i + 40));
      const next = new Date(started.getTime() + INTERVAL_MIN * 60000);
      show(`${started.toTimeString().slice(0, 5)} 완료 · 성공 ${ok} / 실패 ${fail} · 다음 ${next.toTimeString().slice(0, 5)}`);
      GM_setValue('lastRun', { t: Date.now(), ok, fail });
    } catch (e) {
      show(`오류: ${e.message}`);
    } finally {
      running = false;
    }
  }

  GM_registerMenuCommand('지금 바로 수집', () => run(true));
  GM_registerMenuCommand('설정 입력 (웹앱 주소·토큰)', () => {
    const url = prompt('Apps Script 웹 앱 URL (https://script.google.com/macros/s/…/exec)', cfg().url);
    if (url === null) return;
    const token = prompt('토큰 (Apps Script setup 실행 로그에 나온 값)', cfg().token);
    if (token === null) return;
    GM_setValue('webappUrl', url.trim());
    GM_setValue('token', token.trim());
    run(true);
  });

  // 1분마다 "할 차례인지" 확인 → 마지막 수집 후 INTERVAL_MIN 이 지났으면 수집
  //  (탭을 새로고침하거나 여러 개 열어도 늦어지지 않음)
  const tick = () => {
    const last = GM_getValue('lastRun', null);
    const due = !last || Date.now() - last.t >= INTERVAL_MIN * 60000;
    if (due) run();
    else if (!running) {
      const l = GM_getValue('lastRun', null);
      const mins = Math.max(0, Math.ceil((INTERVAL_MIN * 60000 - (Date.now() - l.t)) / 60000));
      show(`마지막 ${new Date(l.t).toTimeString().slice(0, 5)} · 성공 ${l.ok} / 실패 ${l.fail} · 약 ${mins}분 후 다시 확인`);
    }
  };
  show('시작 준비 중…');
  setTimeout(tick, 3000);
  setInterval(tick, 60000);
})();
