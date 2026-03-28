// ── 상태 ──────────────────────────────────────────────────────────────────────
let items = [];
let settings = {
  webhookUrl: '', sheetName: '구매내역', autoSync: false,
  lastCollectedAt: null,
  claudeApiKey: '', geminiApiKey: '', groqApiKey: '', aiProvider: 'claude',
  rules: [], customCategories: []
};
let filters = { store: 'all', cat: 'all', tag: 'all', dateFrom: '', dateTo: '', priceMin: '', priceMax: '', search: '' };
let currentView = 'list';

// ── 초기화 ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await load();
  reclassify();
  syncCustomCategories();
  setDefaultDates();
  render();
  bindAll();
});

async function load() {
  const s = await chrome.storage.local.get(['items', 'settings']);
  items = s.items || [];
  if (s.settings) settings = Object.assign(settings, s.settings);
  q('#webhookUrl').value = settings.webhookUrl || '';
  q('#sheetName').value = settings.sheetName || '';
  q('#claudeApiKey').value = settings.claudeApiKey || '';
  q('#geminiApiKey').value = settings.geminiApiKey || '';
  if (q('#groqApiKey')) q('#groqApiKey').value = settings.groqApiKey || '';
  q('#toggleSyncDot').classList.toggle('on', !!settings.autoSync);
  setAiProvider(settings.aiProvider || 'claude');
  renderRules();
  renderCustomCatChips();
}

function save() { chrome.storage.local.set({ items, settings }); }

// ── 탭 탐색 ───────────────────────────────────────────────────────────────────
const SHOP_PATTERNS = [
  'buy.11st.co.kr', '11st.co.kr/my11st',
  'mc.coupang.com', 'coupang.com/np/orders',
  'orders.pay.naver.com', 'shopping.naver.com/my/order', 'pay.naver.com',
  '11st.co.kr', 'coupang.com', 'naver.com'
];

async function findShopTab() {
  const allTabs = await chrome.tabs.query({});
  for (const pattern of SHOP_PATTERNS) {
    const tab = allTabs.find(t => t.url?.includes(pattern));
    if (tab) return tab;
  }
  return null;
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function bindAll() {
  // 뷰 토글
  q('#btnViewList').addEventListener('click', () => setView('list'));
  q('#btnViewChart').addEventListener('click', () => setView('chart'));

  // 필터 칩 (이벤트 위임)
  q('#filterPanel').addEventListener('click', e => {
    if (e.target.closest('[data-del-cat]')) return;
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const type = chip.dataset.filter;
    if (!type) return;
    if (type === 'tag') {
      const isOn = filters.tag === chip.dataset.val;
      qa('[data-filter="tag"]').forEach(c => c.classList.remove('on'));
      filters.tag = isOn ? 'all' : chip.dataset.val;
      if (!isOn) chip.classList.add('on');
    } else {
      qa(`[data-filter="${type}"]`).forEach(c => c.classList.remove('on'));
      chip.classList.add('on');
      filters[type] = chip.dataset.val;
    }
    render();
  });

  // 기간 칩
  q('#dateChips').addEventListener('click', e => {
    const chip = e.target.closest('[data-period]');
    if (!chip) return;
    q('#dateChips').querySelectorAll('[data-period]').forEach(c => c.classList.remove('on'));
    chip.classList.add('on');
    applyDatePeriod(chip.dataset.period);
  });

  // 날짜/가격/검색 필터
  q('#dateFrom').addEventListener('input', e => {
    q('#dateChips').querySelectorAll('[data-period]').forEach(c => c.classList.remove('on'));
    filters.dateFrom = toISO(e.target.value); render();
  });
  q('#dateTo').addEventListener('input', e => { filters.dateTo = toISO(e.target.value); render(); });
  q('#priceMin').addEventListener('input', e => { filters.priceMin = e.target.value; render(); });
  q('#priceMax').addEventListener('input', e => { filters.priceMax = e.target.value; render(); });
  q('#searchQuery').addEventListener('input', e => { filters.search = e.target.value.trim(); render(); });

  // 목록 클릭
  q('#itemList').addEventListener('click', handleListClick);

  // 수집 버튼
  q('#btnCollect').addEventListener('click', collectFromTab);
  q('#btnCollectAuto').addEventListener('click', collectAuto);

  // 액션 버튼
  q('#btnSync').addEventListener('click', syncSheet);
  q('#btnCSV').addEventListener('click', exportCSV);
  q('#btnClear').addEventListener('click', clearAll);
  q('#btnExportRow').addEventListener('click', exportCSV);
  q('#btnClearRow').addEventListener('click', clearAll);

  // 설정
  q('#btnSaveSettings').addEventListener('click', saveSettings);
  q('#toggleSync').addEventListener('click', () => {
    settings.autoSync = !settings.autoSync;
    q('#toggleSyncDot').classList.toggle('on', settings.autoSync);
    save();
  });
  q('#sheetStatus').addEventListener('click', () => q('#settingsPanel').scrollIntoView({ behavior: 'smooth' }));

  // AI
  q('#btnAiClaude').addEventListener('click', () => setAiProvider('claude'));
  q('#btnAiGemini').addEventListener('click', () => setAiProvider('gemini'));
  q('#btnAiGroq').addEventListener('click', () => setAiProvider('groq'));
  q('#btnAddRule').addEventListener('click', addRule);
  q('#btnAutoClassify').addEventListener('click', autoClassify);

  // 메시지 수신
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.action === 'collectProgress') {
      q('#btnCollect').textContent = `⏳ ${msg.page}페이지 (${msg.count}건)`;
    }
    if (msg.action === 'newItems' && msg.items?.length) {
      const keys = new Set(items.map(i => i.orderId + '|' + i.name + '|' + i.price));
      const added = msg.items.filter(i => !keys.has(i.orderId + '|' + i.name + '|' + i.price));
      if (!added.length) return;
      items = [...added, ...items];
      save(); render();
      toast(`✓ ${added.length}건 수집됨`);
    }
  });

  // storage 변화 감지
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.items) { items = changes.items.newValue || []; render(); }
  });
}

// ── 목록 클릭 핸들러 ──────────────────────────────────────────────────────────
function handleListClick(e) {
  // 날짜 미확인 클릭 → 수동 입력
  const dateUnknownEl = e.target.closest('.date-unknown');
  if (dateUnknownEl) {
    const orderKey = dateUnknownEl.dataset.orderKey;
    const input = prompt('날짜를 입력하세요 (예: 2025-12-25):', new Date().toISOString().slice(0, 10));
    if (!input) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) { toast('⚠️ 날짜 형식이 올바르지 않아요 (YYYY-MM-DD)'); return; }
    items.forEach(item => {
      if (item.orderId === orderKey && item.dateUnknown) { item.date = input; item.dateUnknown = false; }
    });
    save(); render(); toast('✓ 날짜가 저장되었습니다');
    return;
  }

  // + 버튼 → 태그 추가
  const addBtn = e.target.closest('.cat-add-btn');
  if (addBtn) {
    const idx = +addBtn.dataset.addIdx;
    const tag = prompt('개인화 태그를 입력하세요 (기존 카테고리는 유지됩니다):', '')?.trim();
    if (!tag) return;
    if (items[idx]) {
      if (!items[idx].tags) items[idx].tags = [];
      if (!items[idx].tags.includes(tag)) items[idx].tags.push(tag);
    }
    if (!settings.customCategories.includes(tag)) settings.customCategories.push(tag);
    save(); renderCustomCatChips(); render();
    return;
  }

  // 태그 × 버튼 → 삭제
  const tagDel = e.target.closest('.tag-del-btn');
  if (tagDel) {
    const idx = +tagDel.dataset.tagIdx;
    const tag = tagDel.dataset.tag;
    if (items[idx]?.tags) {
      items[idx].tags = items[idx].tags.filter(t => t !== tag);
      if (!items.some(i => i.tags?.includes(tag))) {
        settings.customCategories = settings.customCategories.filter(c => c !== tag);
        if (filters.tag === tag) filters.tag = 'all';
      }
      save(); renderCustomCatChips(); render();
    }
    return;
  }

  // 태그 배지 클릭 → 인라인 수정
  const tagBadge = e.target.closest('.tag-badge');
  if (tagBadge && !tagBadge.querySelector('input')) {
    const idx = +tagBadge.dataset.tagIdx;
    const tag = tagBadge.dataset.tag;
    const inp = makeInlineInput(tag, '60px');
    tagBadge.innerHTML = '';
    tagBadge.appendChild(inp);
    inp.focus(); inp.select();
    const done = () => {
      const newTag = inp.value.trim();
      if (newTag && newTag !== tag && items[idx]?.tags) {
        items[idx].tags = items[idx].tags.map(t => t === tag ? newTag : t);
        if (!items.some(i => i.tags?.includes(tag))) settings.customCategories = settings.customCategories.filter(c => c !== tag);
        if (!settings.customCategories.includes(newTag)) settings.customCategories.push(newTag);
        if (filters.tag === tag) filters.tag = newTag;
        save(); renderCustomCatChips();
      }
      render();
    };
    attachInlineInputEvents(inp, done);
    e.stopPropagation();
    return;
  }

  // 카테고리 배지 클릭 → 인라인 수정
  const cat = e.target.closest('.cat-badge');
  if (!cat || cat.querySelector('input')) return;
  const idx = +cat.dataset.idx;
  const inp = makeInlineInput(items[idx]?.category || '', '68px');
  cat.textContent = '';
  cat.appendChild(inp);
  inp.focus(); inp.select();
  const done = () => {
    if (items[idx]) { items[idx].category = inp.value.trim() || '기타'; items[idx].manuallyEdited = true; save(); }
    render();
  };
  attachInlineInputEvents(inp, done);
  e.stopPropagation();
}

function makeInlineInput(value, width) {
  const inp = document.createElement('input');
  inp.value = value;
  inp.style.cssText = `width:${width};font-size:10px;padding:1px 4px;border:1px solid var(--a);border-radius:4px;background:var(--bg3);color:var(--fg);outline:none;`;
  return inp;
}

function attachInlineInputEvents(inp, done) {
  inp.addEventListener('blur', done);
  inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') done(); if (ev.key === 'Escape') render(); });
}

// ── 설정 저장 ─────────────────────────────────────────────────────────────────
function saveSettings() {
  settings.webhookUrl = q('#webhookUrl').value.trim();
  settings.sheetName = q('#sheetName').value.trim() || '구매내역';
  settings.claudeApiKey = q('#claudeApiKey').value.trim();
  settings.geminiApiKey = q('#geminiApiKey').value.trim();
  settings.groqApiKey = q('#groqApiKey')?.value.trim() || '';
  save(); updateStatus();
  toast('✓ 설정이 저장되었습니다');
}

// ── 수집 ──────────────────────────────────────────────────────────────────────
async function collectFromTab() {
  const btn = q('#btnCollect');
  btn.disabled = true; btn.textContent = '⏳ 수집 중...';
  try {
    const tab = await findShopTab();
    if (!tab) { toast('⚠️ 쇼핑몰 주문내역 탭을 열어주세요'); return; }
    const count = await injectCollector(tab.id, false);
    toast(count > 0 ? `✓ ${count}건 수집 완료` : '수집 항목 없음. 페이지가 완전히 로딩됐는지 확인해주세요');
  } catch (e) { toast('❌ 오류: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '▶ 현재 탭에서 가져오기'; }
}

async function collectAuto() {
  const tab = await findShopTab();
  if (!tab) { toast('⚠️ 쇼핑몰 주문내역 탭을 먼저 열어주세요'); return; }
  const is11st = tab.url.includes('11st.co.kr');
  const isNaver = tab.url.includes('naver.com');
  if (!is11st && !isNaver) { toast('⚠️ 현재 전체 자동 수집은 11번가/네이버만 지원해요'); return; }
  const btn = q('#btnCollectAuto');
  btn.disabled = true;
  try { await collectAllYears(tab, is11st ? '11st' : 'naver'); }
  finally { btn.disabled = false; btn.textContent = '⟳ 전체 기간 자동 수집'; }
}

async function collectAllYears(tab, store = '11st') {
  const btn = q('#btnCollectAuto');
  const startYear = 2020, endYear = new Date().getFullYear();
  const totalYears = endYear - startYear + 1;
  let totalCount = 0, emptyStreak = 0, doneYears = 0;
  showProgress('수집 시작...', 0, '');

  for (let year = endYear; year >= startYear; year--) {
    const pct = (doneYears / totalYears) * 100;
    showProgress(`${year}년 수집 중`, pct, `누적 ${totalCount}건`);
    btn.textContent = `⏳ ${year}년 수집 중...`;

    const url = store === 'naver'
      ? `https://shopping.naver.com/my/order?startDate=${year}-01-01&endDate=${year}-12-31`
      : `https://buy.11st.co.kr/my11st/order/OrderList.tmall?shDateFrom=${year}0101&shDateTo=${year}1231&pageNumber=1&type=orderList2nd&ver=02`;

    await chrome.tabs.update(tab.id, { url });
    await waitForTabLoad(tab.id);
    await new Promise(r => setTimeout(r, 2000));

    let yearCount = 0;
    try {
      if (store === 'naver') {
        // 이전내역 더보기 반복 클릭
        let moreCount = 0;
        while (true) {
          const [{ result: hasMore }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => !!document.querySelector('[class*="order_btn_more"]')
          });
          if (!hasMore) break;
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.querySelector('[class*="order_btn_more"]')?.click()
          });
          await new Promise(r => setTimeout(r, 1500));
          moreCount++;
          showProgress(`${year}년 수집 중`, pct, `더보기 ${moreCount}회 · 누적 ${totalCount}건`);
          if (moreCount > 50) break;
        }
        yearCount = await injectCollector(tab.id, false);
        totalCount += yearCount;
      } else {
        // 11번가: 페이지별 순회
        let totalPages = 1;
        for (let page = 1; page <= totalPages; page++) {
          if (page > 1) {
            const pageUrl = `https://buy.11st.co.kr/my11st/order/OrderList.tmall?shDateFrom=${year}0101&shDateTo=${year}1231&pageNumber=${page}&type=orderList2nd&ver=02`;
            await chrome.tabs.update(tab.id, { url: pageUrl });
            await waitForTabLoad(tab.id);
            await new Promise(r => setTimeout(r, 1500));
          }
          const count = await injectCollector(tab.id, false);
          yearCount += count; totalCount += count;
          if (page === 1) {
            const [{ result: tp }] = await chrome.scripting.executeScript({
              target: { tabId: tab.id }, func: () => window.__totalPages || 1
            });
            totalPages = tp || 1;
          }
          showProgress(`${year}년 ${page}/${totalPages}p`, pct, `${year}년 ${yearCount}건 · 누적 ${totalCount}건`);
          btn.textContent = `⏳ ${year}년 ${page}/${totalPages}p (누적 ${totalCount}건)`;
        }
      }

      doneYears++;
      showProgress(`${year}년 완료`, (doneYears / totalYears) * 100, `${year}년 ${yearCount}건 · 누적 ${totalCount}건`);
      btn.textContent = `⏳ ${year}년 ${yearCount}건 (누적 ${totalCount}건)`;

      if (yearCount === 0) {
        emptyStreak++;
        if (emptyStreak >= 3) {
          if (confirm(`${year}년부터 새로운 데이터가 없어요. 수집을 중단할까요?`)) break;
          emptyStreak = 0;
        }
      } else { emptyStreak = 0; }
    } catch (e) { console.warn(`${year}년 실패:`, e.message); doneYears++; }
  }

  settings.lastCollectedAt = new Date().toISOString();
  save();
  showProgress('수집 완료!', 100, `총 ${totalCount}건`);
  setTimeout(hideProgress, 3000);
  toast(`✓ 전체 수집 완료 — 총 ${totalCount}건`);
  render();
}

// ── 수집기 주입 ───────────────────────────────────────────────────────────────
async function injectCollector(tabId, allPages) {
  await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__collectResult = null; window.__shopCollecting = false; } });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['categories.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, func: runCollector, args: [allPages] });
  return pollCollectDone(tabId, 120000);
}

function pollCollectDone(tabId, timeout) {
  return new Promise(resolve => {
    const start = Date.now();
    const poll = async () => {
      try {
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__collectResult });
        if (result?.done) { resolve(result.orderCount ?? result.count ?? 0); return; }
      } catch {}
      if (Date.now() - start > timeout) { resolve(0); return; }
      setTimeout(poll, 1000);
    };
    poll();
  });
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const check = (id, info) => {
      if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(check); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(check);
    setTimeout(resolve, 10000);
  });
}

// ── 수집기 본체 (executeScript func으로 주입) ─────────────────────────────────
function runCollector(allPages) {
  window.__collectAllPages = allPages;
  window.__collectResult = null;
  window.__shopCollecting = true;

  (async () => {
    let collected = [];
    try {
      const url = location.href;
      if (url.includes('11st.co.kr')) collected = await collect11st();
      else if (url.includes('coupang.com')) collected = collectCoupang();
      else if (url.includes('naver.com')) collected = await collectNaver();
    } catch (e) { console.error('[collect error]', e.message); }

    window.__shopCollecting = false;
    if (collected.length > 0) chrome.runtime.sendMessage({ action: 'itemsCollected', items: collected });
    const uniqueOrders = new Set(collected.map(i => i.rawDate || i.orderId)).size;
    window.__collectResult = { count: collected.length, orderCount: uniqueOrders, done: true };
  })();

  // ── 11번가 ────────────────────────────────────────────────────────────────
  async function collect11st() {
    await waitStable('tbody tr', 8000);
    await new Promise(r => setTimeout(r, 500));
    const result = [];
    parse11stRows(document.querySelectorAll('tbody tr')).forEach(i => {
      if (!result.some(r => r.orderId + '|' + r.name + '|' + r.price === i.orderId + '|' + i.name + '|' + i.price))
        result.push(i);
    });
    window.__totalPages = getTotalPages();
    return result;
  }

  function getTotalPages() {
    const pager = document.querySelector('.s_paging,.paging,[class*="paging"]');
    if (!pager) return 1;
    const curPage = parseInt(pager.querySelector('strong')?.textContent.trim()) || 1;
    const nums = [...pager.querySelectorAll('a')].map(a => parseInt(a.textContent.trim())).filter(n => !isNaN(n) && n > 0);
    return nums.length > 0 ? Math.max(...nums, curPage) : curPage;
  }

  function parse11stRows(rows) {
    const result = [];
    let date = new Date().toISOString().slice(0, 10), orderId = '';
    rows.forEach(row => {
      const txt = row.textContent.replace(/\s+/g, ' ').trim();
      if (txt.length < 10) return;
      const dm = txt.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (dm) { date = `${dm[1]}-${dm[2]}-${dm[3]}`; const om = txt.match(/\((\d{10,})\)/); if (om) orderId = om[1]; }
      const pm = txt.match(/([\d,]+)원\s*\(\d+개\)/);
      if (!pm) return;
      const price = parseInt(pm[1].replace(/,/g, ''));
      if (price <= 0) return;
      const bp = txt.indexOf(pm[0]);
      let name = '';
      if (txt.includes('상세보기')) name = txt.slice(txt.indexOf('상세보기') + 4, bp).trimStart().split(/\s*선택:|\s*옵션명\s+\d|\s+지점:/)[0].trim();
      else if (txt.includes('주문내역삭제')) name = txt.slice(txt.indexOf('주문내역삭제') + 6, bp).trimStart().split(/\s+지점:|\s*선택:|\s*옵션명\s+\d/)[0].trim();
      else { let base = txt.slice(0, bp).split(/옵션명\s+\d/)[0].trim().split(/\s*선택:/)[0].trim(); const om = txt.match(/(?:.*옵션명\s+\d+:.)(.+?)\s+[\d,]+원/); name = om ? base + ' / ' + om[1].trim() : base; }
      if (!name || name.length < 2) return;
      const cancelled = /주문내역삭제|주문취소|취소완료|반품|환불|교환/.test(txt);
      result.push({
        store: '11st', name, price, date,
        orderId: orderId || String(Math.abs(name.split('').reduce((h, c) => Math.imul(31, h) + c.charCodeAt(0) | 0, 0))),
        category: cancelled ? '취소/반품' : getCategory(name),
        collectedAt: new Date().toISOString()
      });
    });
    return result;
  }

  // ── 쿠팡 ──────────────────────────────────────────────────────────────────
  function collectCoupang() {
    const result = [];
    const nameEls = document.querySelectorAll('[class*="productName"],[class*="product-name"],[class*="prodName"],[class*="itemName"]');
    const priceEls = document.querySelectorAll('[class*="totalPrice"],[class*="total-price"],[class*="payPrice"],[class*="pay-price"]');
    const dateEls = document.querySelectorAll('[class*="orderDate"],[class*="order-date"],[class*="orderedDate"]');
    nameEls.forEach((el, i) => {
      const name = el.textContent.trim();
      if (!name || name.length < 3) return;
      const price = parseInt((priceEls[i]?.textContent || '').replace(/[^0-9]/g, '')) || 0;
      if (!price) return;
      const dateStr = dateEls[Math.min(i, dateEls.length - 1)]?.textContent.trim() || '';
      result.push({
        store: 'coupang', name, price, date: parseDate(dateStr),
        orderId: String(Math.abs(('cp' + name + price).split('').reduce((h, c) => Math.imul(31, h) + c.charCodeAt(0) | 0, 0))),
        category: getCategory(name), collectedAt: new Date().toISOString()
      });
    });
    return result;
  }

  // ── 네이버 ────────────────────────────────────────────────────────────────
  async function collectNaver() {
    // 1. 이전내역 더보기 버튼 반복 클릭
    let prevMoreCount = 0;
    while (true) {
      const moreBtn = document.querySelector('[class*="order_btn_more"]');
      if (!moreBtn) break;
      moreBtn.click();
      await new Promise(r => setTimeout(r, 1500));
      if (++prevMoreCount > 20) break;
    }
    if (prevMoreCount > 0) await new Promise(r => setTimeout(r, 500));

    // 2. 총 N건 주문 펼쳐보기 클릭 — BundleSummary가 없어질 때까지 대기
    const expandBtns = [...document.querySelectorAll('[class*="OrderProductBundle_btn_expand"]')];
    if (expandBtns.length > 0) {
      const beforeCount = document.querySelectorAll('[class*="OrderProductItem_product_area"]').length;
      expandBtns.forEach(btn => btn.click());
      // 새 product_area가 로딩될 때까지 폴링 (최대 10초)
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        const afterCount = document.querySelectorAll('[class*="OrderProductItem_product_area"]').length;
        const remaining = document.querySelectorAll('[class*="OrderProductBundle_btn_expand"]').length;
        if (afterCount > beforeCount && remaining === 0) break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    const result = [];
    let lastMainOrderId = null, lastMainDate = null, lastMainRawDate = null;

    document.querySelectorAll('[class*="OrderProductBundle_order_card"]').forEach(card => {
      const areas = card.querySelectorAll('[class*="OrderProductItem_product_area"]');
      if (!areas.length) return;

      // 취소 카드 제외
      const statusText = card.querySelector('[class*="OrderProduct_status"]')?.textContent.trim() || '';
      if (/취소|반품|환불|교환완료/.test(statusText)) return;

      // 첫 상품 정보로 카드 대표 orderId 생성
      const firstArea = areas[0];
      const firstDate = firstArea.querySelector('[class*="OrderProductItem_date"]')?.textContent.trim() || '';
      const firstName = firstArea.querySelector('[class*="OrderProductItem_name"]')?.textContent.trim() || '';
      const firstPrice = firstArea.querySelector('[class*="OrderProductItem_price_area"],[class*="OrderProductItem_price_info"]')?.textContent.replace(/[^0-9]/g, '') || '';
      const date0 = parseNaverDate(firstDate);

      // 추가상품 여부 — 날짜가 없거나 메인카드와 날짜가 같을 때만 추가상품으로 처리
      const isSupplementCard = !!card.querySelector('[class*="label_supplement"]')
        && (!firstDate || firstDate === lastMainRawDate);

      let cardOrderId, cardDate;
      if (isSupplementCard && lastMainOrderId) {
        cardOrderId = lastMainOrderId;
        cardDate = lastMainDate;
      } else {
        // rawDate(날짜+시간) 전체를 orderId로 사용 — 해시 충돌 방지
        cardOrderId = 'nv_' + firstDate.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_ㄱ-힣.:]/g, '');
        cardDate = date0;
        lastMainOrderId = cardOrderId;
        lastMainDate = cardDate;
        lastMainRawDate = firstDate;
      }

      areas.forEach(area => {
        const name = area.querySelector('[class*="OrderProductItem_name"]')?.textContent.trim() || '';
        const price = parseInt((area.querySelector('[class*="OrderProductItem_price_area"],[class*="OrderProductItem_price_info"]')?.textContent || '').replace(/[^0-9]/g, '')) || 0;
        if (!name || !price) return;
        const dateStr = area.querySelector('[class*="OrderProductItem_date"]')?.textContent.trim() || '';
        const rawDate = dateStr;
        const date = parseNaverDate(dateStr) || cardDate;
        const dateUnknown = !date;
        if (result.some(r => r.orderId === cardOrderId && r.name === name && r.price === price)) return;
        result.push({
          store: 'naver', name, price,
          date: date || 'DATE_UNKNOWN',
          orderId: cardOrderId, rawDate,
          dateUnknown: dateUnknown || date === 'DATE_UNKNOWN',
          category: getCategory(name),
          collectedAt: new Date().toISOString()
        });
      });
    });

    return result;
  }

  // ── 공통 헬퍼 ─────────────────────────────────────────────────────────────
  function waitStable(sel, timeout) {
    return new Promise(resolve => {
      let last = 0, stable = 0, timer = null;
      const check = () => {
        const n = document.querySelectorAll(sel).length;
        if (n >= 2 && n === last) { stable++; if (stable >= 3 && !timer) timer = setTimeout(resolve, 300); }
        else { last = n; stable = 0; if (timer) { clearTimeout(timer); timer = null; } }
      };
      const iv = setInterval(check, 100);
      const ob = new MutationObserver(check);
      ob.observe(document.body, { childList: true, subtree: true });
      check();
      setTimeout(() => { clearInterval(iv); ob.disconnect(); resolve(); }, timeout);
    });
  }

  function parseDate(str) {
    if (!str) return new Date().toISOString().slice(0, 10);
    const m = str.match(/(\d{4})[.\-년]\s*(\d{1,2})[.\-월]\s*(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
    return new Date().toISOString().slice(0, 10);
  }

  function parseNaverDate(str) {
    if (!str) return null;
    // 4자리 연도 패턴 먼저 체크 (2025.12.27.)
    const m2 = str.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
    if (m2) return `${m2[1]}-${m2[2].padStart(2, '0')}-${m2[3].padStart(2, '0')}`;
    // 월.일. 패턴 (3.27. 19:33 주문)
    const m = str.match(/(\d{1,2})\.(\d{1,2})\./);
    if (m) return `${new Date().getFullYear()}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return null;
  }

  function getCategory(name) {
    return typeof classifyItem === 'function' ? classifyItem(name) : '기타';
  }
}

// ── 렌더링 ────────────────────────────────────────────────────────────────────
function setView(v) {
  currentView = v;
  q('#btnViewList').classList.toggle('on', v === 'list');
  q('#btnViewChart').classList.toggle('on', v === 'chart');
  q('#listPanel').style.display = v === 'list' ? '' : 'none';
  q('#chartPanel').classList.toggle('show', v === 'chart');
  if (v === 'chart') renderChart();
}

function render() {
  renderStats(); renderList(); renderCounts(); updateStatus();
  if (currentView === 'chart') renderChart();
}

function filtered() {
  const sq = filters.search.toLowerCase();
  return items.filter(item => {
    if (filters.store !== 'all' && item.store !== filters.store) return false;
    if (filters.cat !== 'all' && item.category !== filters.cat) return false;
    if (filters.tag !== 'all' && !item.tags?.includes(filters.tag)) return false;
    if (filters.dateFrom && item.date < filters.dateFrom) return false;
    if (filters.dateTo && item.date > filters.dateTo) return false;
    if (filters.priceMin && item.price < +filters.priceMin) return false;
    if (filters.priceMax && item.price > +filters.priceMax) return false;
    if (sq && !(item.name || '').toLowerCase().includes(sq)) return false;
    return true;
  });
}

function renderStats() {
  const now = new Date().toISOString().slice(0, 7);
  const totalOrders = new Set(items.map(i => i.orderId || i.date + '|' + i.store)).size;
  const monthOrders = new Set(items.filter(i => i.date?.startsWith(now)).map(i => i.orderId || i.date + '|' + i.store)).size;
  q('#statTotal').textContent = totalOrders;
  q('#statMonth').textContent = monthOrders;
  q('#statAmount').textContent = Math.round(items.reduce((s, i) => s + (i.price || 0), 0) / 10000);
}

function renderCounts() {
  ['coupang', 'naver', '11st'].forEach(s => {
    const el = q('#cnt-' + s);
    if (el) el.textContent = items.filter(i => i.store === s).length + '건';
  });
}

function renderList() {
  const list = q('#itemList');
  const f = filtered();
  const BADGE = { coupang: '쿠', naver: '네', '11st': '11' };
  const sq = filters.search;

  if (!f.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">📦</div><p>${items.length ? '필터 결과가 없어요' : '구매 내역이 없어요'}</p><small>${items.length ? '필터 조건을 바꿔보세요' : '오른쪽 패널에서 수집해주세요'}</small></div>`;
    return;
  }

  // 주문번호 기준 그룹핑
  const orderMap = new Map();
  f.forEach(item => {
    const key = item.orderId || (item.date + '|' + item.store + '|' + items.indexOf(item));
    if (!orderMap.has(key)) orderMap.set(key, { orderId: item.orderId, date: item.date, store: item.store, items: [] });
    orderMap.get(key).items.push(item);
  });

  const orders = [...orderMap.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  list.innerHTML = orders.map(order => {
    const totalPrice = order.items.reduce((s, i) => s + (i.price || 0), 0);
    const isCancelled = order.items.every(i => i.category === '취소/반품');
    const hasDateUnknown = order.items.some(i => i.dateUnknown);

    const subRows = order.items.map(item => {
      const idx = items.indexOf(item);
      const nameHtml = sq
        ? esc(item.name || '').replace(new RegExp(esc(sq).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
            m => `<mark style="background:rgba(124,111,239,.3);color:var(--a2);border-radius:2px">${m}</mark>`)
        : esc(item.name || '');
      const tags = item.tags?.length ? item.tags.map(tag =>
        `<span class="cat-badge tag-badge" data-tag-idx="${idx}" data-tag="${esc(tag)}" title="클릭해서 수정">🏷 ${esc(tag)}<span class="tag-del-btn" data-tag-idx="${idx}" data-tag="${esc(tag)}" title="삭제">×</span></span>`
      ).join('') : '';
      return `<div class="sub-item">
        <div class="sub-name">${nameHtml}</div>
        <div class="sub-meta">
          <span class="cat-badge" data-idx="${idx}" title="클릭해서 수정">${item.category || '기타'}</span>
          ${tags}
          <span class="cat-add-btn" data-add-idx="${idx}" title="개인화 태그 추가">+</span>
          <span class="sub-price">${fmt(item.price)}</span>
        </div>
      </div>`;
    }).join('');

    const dateDisplay = hasDateUnknown
      ? `<span class="order-date date-unknown" data-order-key="${order.orderId}" title="클릭해서 날짜 입력">📅 날짜 미확인</span>`
      : `<span class="order-date">${order.date || ''}</span>`;

    return `<div class="order-group${isCancelled ? ' cancelled' : ''}">
      <div class="order-head">
        <span class="badge ${order.store || ''}">${BADGE[order.store] || '?'}</span>
        <div class="order-head-info">
          ${dateDisplay}
          <span class="order-id">${order.store === '11st' ? (order.orderId || '') : ''}</span>
        </div>
        <div class="order-total">${order.items.length > 1 ? order.items.length + '개 · ' : ''}${fmt(totalPrice)}</div>
      </div>
      <div class="order-items">${subRows}</div>
    </div>`;
  }).join('');
}

function updateStatus() {
  const connected = !!settings.webhookUrl;
  q('#sheetStatus').className = 'sheet-status' + (connected ? ' connected' : '');
  q('#sheetStatusText').textContent = connected ? '시트 연결됨' : '시트 미연결';
}

// ── 동기화 ────────────────────────────────────────────────────────────────────
async function syncSheet() {
  if (!settings.webhookUrl) { toast('⚠️ Apps Script URL을 먼저 설정해주세요'); q('#settingsPanel').scrollIntoView({ behavior: 'smooth' }); return; }
  q('#btnSync').disabled = true; q('#syncText').textContent = '동기화 중...';
  try {
    const r = await chrome.runtime.sendMessage({ action: 'syncToSheet', items, webhookUrl: settings.webhookUrl, sheetName: settings.sheetName || '구매내역' });
    toast(r.ok ? `✓ ${items.length}건 동기화 완료` : '❌ ' + (r.error || '실패'));
  } catch (e) { toast('❌ ' + e.message); }
  finally { q('#btnSync').disabled = false; q('#syncText').textContent = '구글 시트 동기화'; }
}

// ── 프로그레스 ────────────────────────────────────────────────────────────────
function showProgress(label, pct, sub) {
  q('#progressWrap').classList.add('show');
  q('#progressLabel').textContent = label;
  q('#progressPct').textContent = Math.round(pct) + '%';
  q('#progressBar').style.width = Math.round(pct) + '%';
  q('#progressSub').textContent = sub || '';
}

function hideProgress() {
  q('#progressWrap').classList.remove('show');
  q('#progressBar').style.width = '0%';
}

// ── 차트 ──────────────────────────────────────────────────────────────────────
function renderChart() {
  const canvas = q('#donutChart');
  if (!canvas) return;
  const f = filtered().filter(i => i.category !== '취소/반품');
  const ctx = canvas.getContext('2d');
  const W = 160, cx = W / 2, cy = W / 2, R = 68, r = 42;

  const catMap = new Map();
  f.forEach(i => catMap.set(i.category || '기타', (catMap.get(i.category || '기타') || 0) + (i.price || 0)));
  const total = [...catMap.values()].reduce((s, v) => s + v, 0);

  if (!total) {
    ctx.clearRect(0, 0, W, W);
    q('#chartLegend').innerHTML = '<div style="font-size:12px;color:var(--fg3);padding:8px">데이터가 없어요</div>';
    q('#chartTotalNum').textContent = '-';
    return;
  }

  const entries = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
  ctx.clearRect(0, 0, W, W);
  let angle = -Math.PI / 2;
  const GAP = 0.025;
  entries.forEach(([cat, val]) => {
    const sweep = (val / total) * Math.PI * 2 - GAP;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angle + GAP / 2, angle + GAP / 2 + sweep);
    ctx.closePath();
    ctx.fillStyle = CAT_COLORS[cat] || '#94a3b8';
    ctx.fill();
    angle += sweep + GAP;
  });
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg2').trim() || '#17171c';
  ctx.fill();

  q('#chartTotalNum').textContent = total >= 10000 ? Math.round(total / 10000) + '만원' : fmt(total);
  q('#chartLegend').innerHTML = entries.map(([cat, val]) => {
    const pct = Math.round(val / total * 100);
    return `<div class="legend-item">
      <div class="legend-dot" style="background:${CAT_COLORS[cat] || '#94a3b8'}"></div>
      <span class="legend-name">${cat}</span>
      <span class="legend-pct">${pct}%</span>
      <span class="legend-amt">${val >= 10000 ? Math.round(val / 10000) + '만' : val.toLocaleString()}원</span>
    </div>`;
  }).join('');
}

// ── 내보내기 ──────────────────────────────────────────────────────────────────
function exportCSV() {
  const f = filtered();
  if (!f.length) { toast('내보낼 데이터가 없어요'); return; }
  const rows = [
    ['날짜', '상품명', '가격', '카테고리', '개인화태그', '쇼핑몰', '주문번호'],
    ...f.map(i => [i.date, `"${(i.name || '').replace(/"/g, '""')}"`, i.price, i.category, (i.tags || []).join('|'), i.store, i.orderId || ''])
  ];
  const csv = '\uFEFF' + rows.map(r => r.join(',')).join('\n');
  Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })),
    download: `구매내역_${new Date().toISOString().slice(0, 10)}.csv`
  }).click();
  toast(`✓ ${f.length}건 CSV 다운로드`);
}

function clearAll() {
  if (!confirm('모든 구매 내역을 삭제할까요?')) return;
  items = []; save(); render(); toast('✓ 초기화 완료');
}

// ── 날짜 필터 ─────────────────────────────────────────────────────────────────
function setDefaultDates() { filters.dateFrom = ''; filters.dateTo = ''; buildDateChips(new Date()); }

function buildDateChips(today) {
  const chips = q('#dateChips');
  if (!chips) return;
  chips.querySelectorAll('[data-period^="month"]').forEach(c => c.remove());
  for (let i = 1; i <= 3; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const chip = Object.assign(document.createElement('div'), {
      className: 'chip',
      textContent: (d.getMonth() + 1) + '월'
    });
    chip.dataset.period = `month_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
    chips.appendChild(chip);
  }
}

function applyDatePeriod(period) {
  const today = new Date(), todayStr = today.toISOString().slice(0, 10);
  let from = '', to = todayStr;
  if (period === 'all') { from = ''; to = ''; }
  else if (period === 'today') { from = todayStr; }
  else if (period === '1m') from = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate()).toISOString().slice(0, 10);
  else if (period === '6m') from = new Date(today.getFullYear(), today.getMonth() - 6, today.getDate()).toISOString().slice(0, 10);
  else if (period.startsWith('month_')) {
    const [, year, month] = period.split('_');
    from = `${year}-${month}-01`;
    to = `${year}-${month}-${String(new Date(+year, +month, 0).getDate()).padStart(2, '0')}`;
  }
  filters.dateFrom = from; filters.dateTo = to;
  q('#dateFrom').value = from ? from.replace(/-/g, '') : '';
  q('#dateTo').value = to ? to.replace(/-/g, '') : '';
  render();
}

function toISO(v) {
  const s = (v || '').replace(/\D/g, '');
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

// ── 개인화 태그 ───────────────────────────────────────────────────────────────
function getUsedTags() {
  const used = new Set();
  items.forEach(i => i.tags?.forEach(t => used.add(t)));
  return used;
}

function syncCustomCategories() {
  const used = getUsedTags();
  settings.customCategories = settings.customCategories.filter(c => used.has(c));
  used.forEach(t => { if (!settings.customCategories.includes(t)) settings.customCategories.push(t); });
}

function renderCustomCatChips() {
  const container = document.getElementById('customCatChips');
  const row = document.getElementById('customCatRow');
  if (!container) return;
  const cats = settings.customCategories || [];
  if (row) row.style.display = cats.length ? '' : 'none';
  if (!cats.length) { container.innerHTML = ''; return; }
  container.innerHTML = cats.map(cat =>
    `<div class="chip custom-chip" data-filter="tag" data-val="${esc(cat)}">${esc(cat)}<span class="chip-del" data-del-cat="${esc(cat)}">×</span></div>`
  ).join('');
  container.querySelectorAll('[data-filter="tag"]').forEach(c => c.classList.toggle('on', c.dataset.val === filters.tag));
  container.querySelectorAll('[data-del-cat]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const cat = el.dataset.delCat;
      items.forEach(i => { if (i.tags) i.tags = i.tags.filter(t => t !== cat); });
      settings.customCategories = settings.customCategories.filter(c => c !== cat);
      if (filters.tag === cat) filters.tag = 'all';
      save(); renderCustomCatChips(); render();
    });
  });
}

// ── 카테고리 규칙 ─────────────────────────────────────────────────────────────
function renderRules() {
  const list = q('#ruleList');
  if (!list) return;
  if (!settings.rules.length) { list.innerHTML = '<div style="font-size:11px;color:var(--fg3);padding:4px">등록된 규칙이 없어요</div>'; return; }
  list.innerHTML = settings.rules.map((r, i) =>
    `<div class="rule-item"><span class="rule-keyword">${esc(r.keyword)}</span><span class="rule-arrow">→</span><span class="rule-cat">${esc(r.cat)}</span><span class="rule-del" data-i="${i}">×</span></div>`
  ).join('');
  list.querySelectorAll('.rule-del').forEach(el => {
    el.addEventListener('click', () => { settings.rules.splice(+el.dataset.i, 1); save(); renderRules(); applyRules(); });
  });
}

function addRule() {
  const kw = q('#ruleKeyword').value.trim(), cat = q('#ruleCat').value.trim();
  if (!kw || !cat) { toast('키워드와 카테고리를 모두 입력해 주세요'); return; }
  if (settings.rules.some(r => r.keyword === kw)) { toast('이미 등록된 키워드예요'); return; }
  settings.rules.push({ keyword: kw, cat });
  q('#ruleKeyword').value = ''; q('#ruleCat').value = '';
  save(); renderRules(); applyRules();
  toast('✓ 규칙 추가됨 — 목록에 즉시 적용됩니다');
}

function applyRules() {
  if (!settings.rules.length) return;
  let changed = false;
  items.forEach(item => {
    const n = (item.name || '').toLowerCase();
    for (const r of settings.rules) {
      if (n.includes(r.keyword.toLowerCase())) {
        if (item.category !== r.cat) { item.category = r.cat; changed = true; }
        break;
      }
    }
  });
  if (changed) { save(); render(); }
}

// ── AI 분류 ───────────────────────────────────────────────────────────────────
function setAiProvider(provider) {
  settings.aiProvider = provider;
  ['claude', 'gemini', 'groq'].forEach(p => {
    const btn = q(`#btnAi${p.charAt(0).toUpperCase() + p.slice(1)}`);
    const inp = q(`#${p}ApiKey`);
    if (btn) btn.classList.toggle('on', p === provider);
    if (inp) inp.style.display = p === provider ? '' : 'none';
  });
}

async function autoClassify() {
  const provider = settings.aiProvider || 'claude';
  const apiKey = provider === 'gemini' ? (q('#geminiApiKey')?.value.trim() || settings.geminiApiKey)
    : provider === 'groq' ? (q('#groqApiKey')?.value.trim() || settings.groqApiKey)
    : (q('#claudeApiKey')?.value.trim() || settings.claudeApiKey);
  if (!apiKey) { toast('⚠️ API Key를 입력해 주세요'); return; }
  const unclassified = items.filter(i => !i.category || i.category === '기타');
  if (!unclassified.length) { toast('분류할 항목이 없어요 (기타 없음)'); return; }
  const btn = q('#btnAutoClassify');
  btn.disabled = true; btn.textContent = `⏳ ${unclassified.length}건 분류 중...`;
  try {
    const BATCH = 10;
    const examples = items.filter(i => i.manuallyEdited && i.category && i.category !== '기타').slice(0, 10);
    for (let i = 0; i < unclassified.length; i += BATCH) {
      const batch = unclassified.slice(i, i + BATCH);
      const names = batch.map((item, idx) => `${idx + 1}. ${item.name}`).join('\n');
      const r = await chrome.runtime.sendMessage({
        action: provider === 'gemini' ? 'geminiClassify' : provider === 'groq' ? 'groqClassify' : 'claudeClassify',
        names, apiKey, examples
      });
      if (!r.ok) throw new Error(r.error || 'API 오류');
      let parsed;
      try {
        const jm = r.text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
        if (!jm) throw new Error('no json');
        parsed = JSON.parse(jm[0]);
      } catch {
        const CATS = AI_CATEGORIES.concat(['취소/반품']);
        const cats = [...r.text.matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(s => CATS.includes(s));
        if (!cats.length) throw new Error('JSON 파싱 실패: ' + r.text.slice(0, 100));
        parsed = { results: cats };
      }
      parsed.results.forEach((cat, idx) => { if (batch[idx] && cat) batch[idx].category = cat; });
      btn.textContent = `⏳ ${Math.min(i + BATCH, unclassified.length)}/${unclassified.length}건 완료...`;
    }
    save(); render(); toast(`✓ ${unclassified.length}건 자동 분류 완료`);
  } catch (e) { toast('❌ 분류 실패: ' + e.message); console.error(e); }
  finally { btn.disabled = false; btn.textContent = '🤖 기타 항목 자동 분류'; }
}

function reclassify() {
  let changed = false;
  items.forEach(item => {
    if (item.category && item.category !== '기타') return;
    const c = classifyItem(item.name);
    if (c !== '기타') { item.category = c; changed = true; }
  });
  if (changed) save();
  applyRules();
}

// ── 유틸 ──────────────────────────────────────────────────────────────────────
function fmt(p) { return p ? Number(p).toLocaleString('ko-KR') + '원' : '-'; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function q(sel) { return document.querySelector(sel); }
function qa(sel) { return document.querySelectorAll(sel); }
function toast(msg) {
  const t = q('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 4000);
}
