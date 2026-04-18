// 아이콘 클릭 → 새 탭으로 열기 (중복 방지)
chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL('app.html');
  chrome.tabs.query({ url }, tabs => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
});

// 메시지 라우터
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'itemsCollected') {
    handleCollected(msg.items).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'syncToSheet') {
    syncToSheet(msg.items, msg.webhookUrl, msg.sheetName)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

async function handleCollected(newItems) {
  const { items = [] } = await chrome.storage.local.get('items');
  const keys = new Set(items.map(i => i.orderId + '|' + i.name + '|' + i.price));
  // 네이버: 쇼핑과 페이 간 크로스소스 중복 방지 (orderId 다르더라도 name+price+date 동일 시 제외)
  const naverKeys = new Set(
    items.filter(i => i.store === 'naver').map(i => `${i.name}|${i.price}|${i.date}`)
  );
  const added = newItems.filter(i => {
    if (keys.has(i.orderId + '|' + i.name + '|' + i.price)) return false;
    if (i.store === 'naver' && naverKeys.has(`${i.name}|${i.price}|${i.date}`)) return false;
    return true;
  });
  if (!added.length) return;
  const merged = [...added, ...items];
  await chrome.storage.local.set({ items: merged });
  // 앱 탭에 알림
  try { await chrome.runtime.sendMessage({ action: 'newItems', items: added }); } catch {}
  // 자동 동기화
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (settings.autoSync && settings.webhookUrl) {
    const converted = await convertUsdItemsBg(merged, settings);
    await chrome.storage.local.set({ items: converted, settings });
    await syncToSheet(converted, settings.webhookUrl, settings.sheetName || '구매내역');
  }
}

async function convertUsdItemsBg(items, settings) {
  if (!settings.rateCache) settings.rateCache = {};
  const today = new Date().toISOString().slice(0, 10);
  const needConvert = items.filter(i => i.currency === 'USD' && !i.priceKrw && i.price);
  if (!needConvert.length) return items;
  const dates = [...new Set(needConvert.map(i => (i.date || today).slice(0, 10)))];
  const rates = {};
  for (const d of dates) {
    if (settings.rateCache[d]) { rates[d] = settings.rateCache[d]; continue; }
    try {
      const res = await fetch(`https://api.frankfurter.app/${d}?from=USD&to=KRW`);
      if (res.ok) {
        const data = await res.json();
        const rate = data?.rates?.KRW;
        if (rate) { rates[d] = rate; settings.rateCache[d] = rate; }
      }
    } catch {}
  }
  items.forEach(item => {
    if (item.currency === 'USD' && !item.priceKrw && item.price) {
      const d = (item.date || today).slice(0, 10);
      if (rates[d]) item.priceKrw = Math.round(item.price * rates[d]);
    }
  });
  return items;
}

async function syncToSheet(items, webhookUrl, sheetName = '구매내역') {
  if (!webhookUrl) return { ok: false, error: 'URL 미설정' };
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ items, sheetName })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return { ok: true, ...data };
}

