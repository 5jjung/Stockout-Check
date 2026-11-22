// ==UserScript==
// @name         코드그라피 사이즈 품절 수집
// @namespace    stockout-check
// @version      1.0.0
// @description  무신사 탭이 열려 있는 동안 10분마다 감시 상품의 사이즈별 재고를 확인해 구글 시트에 적습니다.
// @match        https://www.musinsa.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───── 설정 (이 두 줄만 채우세요) ─────
  const WEBAPP_URL = '여기에_Apps_Script_웹앱_URL';
  const TOKEN = '여기에_토큰';
  // ────────────────────────────────────
  const INTERVAL_MIN = 10;   // 몇 분마다 확인할지
  const PARALLEL = 2;        // 동시에 확인하는 상품 수
  const API = 'https://goods-detail.musinsa.com/api2/goods';

  if (window.top !== window.self) return; // 페이지 안 작은 창(iframe)에서는 실행 안 함

  // 무신사 탭을 여러 개 열어도 한 탭만 수집하도록 (2분간 신호 없으면 다른 탭이 이어받음)
  const TAB_ID = Math.random().toString(36).slice(2);
  const isLeader = () => {
    const lock = GM_getValue('leader', null);
    if (!lock || lock.id === TAB_ID || Date.now() - lock.t > 120000) {
      GM_setValue('leader', { id: TAB_ID, t: Date.now() });
      return true;
    }
    return false;
  };
  setInterval(() => { const l = GM_getValue('leader', null); if (l && l.id === TAB_ID) GM_setValue('leader', { id: TAB_ID, t: Date.now() }); }, 30000);

  // 화면 오른쪽 아래 작은 상태 표시
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;background:#111;color:#fff;font:12px/1.4 sans-serif;padding:6px 10px;border-radius:6px;opacity:.85;pointer-events:none;max-width:320px';
  const show = (t) => { badge.textContent = `품절수집 · ${t}`; if (!badge.isConnected) document.body.appendChild(badge); };

  // 구글 시트(웹앱) 통신
  function webapp(method, payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: method === 'GET' ? `${WEBAPP_URL}?token=${encodeURIComponent(TOKEN)}` : WEBAPP_URL,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        data: method === 'POST' ? JSON.stringify({ token: TOKEN, rows: payload }) : undefined,
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
  async function run() {
    if (running || !isLeader()) return;
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

  if (WEBAPP_URL.startsWith('여기에') || TOKEN.startsWith('여기에')) { show('설정 필요: WEBAPP_URL, TOKEN'); return; }
  // 다른 탭이 방금 수집했으면 기다렸다가, 아니면 바로 시작
  const last = GM_getValue('lastRun', null);
  const wait = last ? Math.max(5000, INTERVAL_MIN * 60000 - (Date.now() - last.t)) : 5000;
  setTimeout(() => { run(); setInterval(run, INTERVAL_MIN * 60000); }, wait);
  show(`대기 중 · ${Math.round(wait / 60000)}분 후 확인`);
})();
