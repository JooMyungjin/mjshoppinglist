// 팝업에서 executeScript로 주입되는 범용 수집기
// 각 쇼핑몰 구조에 맞게 파싱

// executeScript는 async 함수의 Promise를 result로 받지 못함
// 대신 window.__collectResult에 결과 저장 후 별도 스크립트로 읽는 방식 사용
window.__collectResult = null;
window.__shopCollecting = false;

(async function collect() {
  if (window.__shopCollecting) { window.__collectResult = { count: 0, done: false }; return; }
  window.__shopCollecting = true;
  window.__collectResult = null;

  const url = location.href;
  let items = [];

  if (url.includes('11st.co.kr')) items = await collect11st();
  else if (url.includes('coupang.com')) items = collectCoupang();
  else if (url.includes('naver.com')) items = collectNaver();

  window.__shopCollecting = false;

  if (items.length > 0) {
    chrome.runtime.sendMessage({ action: 'itemsCollected', items });
  }
  window.__collectResult = { count: items.length, done: true };

  // ── 11번가 ──────────────────────────────────────────────────────────────
  async function collect11st() {
    const allPages = !!window.__collectAllPages;
    const result = [];
    let pageCount = 0;

    while (true) {
      await waitStable('tbody tr', 8000);
      await new Promise(r => setTimeout(r, 300));

      const rows = [...document.querySelectorAll('tbody tr')];
      const pageItems = await parse11stRows(rows);
      result.push(...pageItems);
      pageCount++;

      // 일반 가져오기는 현재 페이지만
      if (!allPages) break;

      // 자동수집은 다음 페이지까지
      const nextBtn = findNextPageBtn();
      if (!nextBtn) break;

      chrome.runtime.sendMessage({ action: 'collectProgress', count: result.length, page: pageCount });
      nextBtn.click();
      await new Promise(r => setTimeout(r, 800));
    }

    return result;
  }

  function findNextPageBtn() {
    // 11번가 페이지네이션: 현재 페이지 다음 버튼
    const pager = document.querySelector('.paging, .pagination, [class*="paging"], [class*="pagination"]');
    if (!pager) return null;
    const current = pager.querySelector('.on, .active, [class*="current"], strong');
    if (!current) return null;
    const next = current.nextElementSibling;
    if (next && next.tagName === 'A') return next;
    // "다음" 텍스트 버튼
    return [...pager.querySelectorAll('a')].find(a => /다음|next/i.test(a.textContent)) || null;
  }

  async function parse11stRows(rows) {
    const result = [];
    let date = today(), orderId = '';
    for (const row of rows) {
      const txt = row.textContent.replace(/\s+/g, ' ').trim();
      if (txt.length < 10) continue;
      const dm = txt.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (dm) { date = `${dm[1]}-${dm[2]}-${dm[3]}`; const om = txt.match(/\((\d{10,})\)/); if (om) orderId = om[1]; }
      const pm = txt.match(/([\d,]+)원\s*\(\d+개\)/);
      if (!pm) continue;
      const price = parseInt(pm[1].replace(/,/g, ''));
      if (price <= 0) continue;
      const beforePrice = txt.indexOf(pm[0]);
      let name = '';
      if (txt.includes('상세보기')) {
        const i = txt.indexOf('상세보기') + 4;
        name = txt.slice(i, beforePrice).trimStart().split(/\s+선택:|\s*옵션명\s+\d|\s+지점:/)[0].trim();
      } else if (txt.includes('주문내역삭제')) {
        const i = txt.indexOf('주문내역삭제') + 6;
        name = txt.slice(i, beforePrice).trimStart().split(/\s+지점:|\s+선택:|\s*옵션명\s+\d/)[0].trim();
      } else {
        const baseName = txt.slice(0, beforePrice).split(/옵션명\s+\d/)[0].trim();
        const optMatch = txt.match(/(?:.*옵션명\s+\d+:.)(.+?)\s+[\d,]+원/);
        const optVal = optMatch ? optMatch[1].trim() : '';
        name = optVal ? baseName + ' / ' + optVal : baseName;
      }
      if (!name || name.length < 2) continue;
      const key = orderId + '|' + name + '|' + price;
      if (result.some(i => i.orderId + '|' + i.name + '|' + i.price === key)) continue;
      const cancelled = /주문내역삭제|주문취소|취소완료|반품|환불|교환/.test(txt);
      const url = await get11stProductUrl(row);
      result.push({ store: '11st', name, price, date, url, orderId: orderId || hash(name+price+date), category: cancelled ? '취소/반품' : category(name), collectedAt: new Date().toISOString() });
    }
    return result;
  }

  // 상품명 클릭 → 팝업에서 "상품번호: XXXXXXXXXX" 추출
  async function get11stProductUrl(row) {
    const trigger = row.querySelector(
      'a[onclick], button[onclick], [class*="prdName"] a, [class*="prod_name"] a, [class*="goodsName"] a, td.goods a, td.product a'
    );
    if (!trigger) return '';
    trigger.click();
    const popup = await new Promise(resolve => {
      const deadline = Date.now() + 2000;
      const tick = setInterval(() => {
        const el = [...document.querySelectorAll(
          '[class*="layer"], [class*="popup"], [class*="modal"], [class*="dialog"]'
        )].find(el => /상품번호/.test(el.textContent) && el.offsetParent !== null);
        if (el || Date.now() > deadline) { clearInterval(tick); resolve(el || null); }
      }, 80);
    });
    if (!popup) return '';
    const m = popup.textContent.match(/상품번호[^\d]*(\d{7,})/);
    const closeBtn = popup.querySelector(
      '[class*="close"], [class*="btn_close"], button[title*="닫"], a[title*="닫"]'
    );
    if (closeBtn) closeBtn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    return m ? `https://www.11st.co.kr/products/${m[1]}` : '';
  }

  // ── 쿠팡 ────────────────────────────────────────────────────────────────
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
      const dateStr = dateEls[Math.min(i, dateEls.length-1)]?.textContent.trim() || '';
      const linkEl = el.closest('a') || el.querySelector('a') || el.parentElement?.closest('a');
      const url = linkEl?.href || '';
      result.push({ store: 'coupang', name, price, date: parseDate(dateStr), orderId: hash('cp'+name+price), url, category: category(name), collectedAt: new Date().toISOString() });
    });
    return result;
  }

  // ── 네이버 쇼핑 ─────────────────────────────────────────────────────────
  function collectNaver() {
    const result = [];
    const cards = document.querySelectorAll('[class*="orderItem_"],[class*="OrderItem_"],[class*="order_item"],[class*="order-item"]');
    cards.forEach(card => {
      const nameEl = card.querySelector('[class*="productName_"],[class*="itemName_"],[class*="product_name"],[class*="goods_name"]');
      const priceEl = card.querySelector('[class*="totalPayment_"],[class*="paymentPrice_"],[class*="payment_price"],[class*="pay_price"]');
      const dateEl = card.querySelector('[class*="orderDate_"],[class*="order_date"],time');
      const name = nameEl?.textContent.trim() || '';
      const price = parseInt((priceEl?.textContent || '').replace(/[^0-9]/g, '')) || 0;
      if (!name || !price) return;
      const dateStr = dateEl?.getAttribute('datetime') || dateEl?.textContent.trim() || '';
      const url = card.querySelector('[class*="OrderProductItem_btn_detail"],[class*="btn_detail"]')?.href || '';
      result.push({ store: 'naver', name, price, date: parseDate(dateStr), orderId: hash('nv'+name+price), url, category: category(name), collectedAt: new Date().toISOString() });
    });
    return result;
  }

  // ── 헬퍼 ────────────────────────────────────────────────────────────────
  function waitStable(sel, timeout) {
    return new Promise(resolve => {
      let last = 0, stableCount = 0, timer = null;
      const check = () => {
        const n = document.querySelectorAll(sel).length;
        if (n >= 2 && n === last) {
          stableCount++;
          // 3번 연속 같으면 안정화 완료
          if (stableCount >= 3 && !timer) timer = setTimeout(resolve, 300);
        } else {
          last = n;
          stableCount = 0;
          if (timer) { clearTimeout(timer); timer = null; }
        }
      };
      // 100ms마다 체크
      const interval = setInterval(check, 100);
      const ob = new MutationObserver(check);
      ob.observe(document.body, { childList: true, subtree: true });
      check();
      setTimeout(() => { clearInterval(interval); ob.disconnect(); resolve(); }, timeout);
    });
  }

  function parseDate(str) {
    if (!str) return today();
    const m = str.match(/(\d{4})[.\-년]\s*(\d{1,2})[.\-월]\s*(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0,10);
    return today();
  }

  function today() { return new Date().toISOString().slice(0,10); }

  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    return Math.abs(h).toString(36);
  }

  function category(name) {
    const n = (name||'').toLowerCase();
    if (/호텔|리조트|워터파크|펜션|숙박|여행|패키지|티켓|입장권|공연|뮤지컬|콘서트|이용권/.test(n)) return '여행/문화';
    if (/식품|음식|과자|라면|쌀|고기|채소|과일|음료|커피|간식|캔|버거|치킨|피자|닭|갈비|밤|견과|빵/.test(n)) return '식품';
    if (/청소|세탁|주방|욕실|화장지|세제|수납|정리|나사|볼트|철물|피스|앙카|led|방등|전등/.test(n)) return '생활';
    if (/옷|의류|바지|티셔츠|원피스|자켓|신발|가방|베스트|다운/.test(n)) return '패션';
    if (/노트북|핸드폰|스마트폰|태블릿|이어폰|마우스|키보드|충전기|케이블|모니터/.test(n)) return '전자';
    if (/책|도서|교재|학습/.test(n)) return '도서';
    if (/화장품|스킨|로션|크림|선크림|마스크팩/.test(n)) return '뷰티';
    if (/영양제|비타민|프로틴|건강/.test(n)) return '건강';
    return '기타';
  }
})();
