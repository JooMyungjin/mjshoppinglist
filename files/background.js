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
  if (msg.action === 'claudeClassify') {
    claudeClassify(msg.names, msg.apiKey, msg.examples || [])
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'groqClassify') {
    groqClassify(msg.names, msg.apiKey, msg.examples || [])
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'geminiClassify') {
    geminiClassify(msg.names, msg.apiKey, msg.examples || [])
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
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
  const added = newItems.filter(i => !keys.has(i.orderId + '|' + i.name + '|' + i.price));
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

async function claudeClassify(names, apiKey, examples = []) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: buildPrompt(names, examples)
      }]
    })
  });
  if (!res.ok) throw new Error('API 오류: ' + res.status);
  const data = await res.json();
  return { ok: true, text: data.content[0].text.trim() };
}

async function geminiClassify(names, apiKey, examples = []) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: buildPrompt(names, examples)
          }]
        }],
        generationConfig: { temperature: 0.1 }
      })
    }
  );
  if (!res.ok) throw new Error('Gemini API 오류: ' + res.status);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('Gemini 응답 없음');
  return { ok: true, text };
}

function buildPrompt(names, examples) {
  const exampleStr = examples.length > 0
    ? '\n\n참고 예시 (이미 분류된 데이터):\n' + examples.map(e => `- ${e.name} → ${e.category}`).join('\n')
    : '';
  return `한국 쇼핑몰 상품명을 카테고리로 분류하세요.

카테고리 정의:
- 식품: 음식, 음료, 식재료, 간식, 건강식품 등
- 생활: 청소용품, 주방용품, 인테리어, 공구, 문구 등
- 패션: 의류, 신발, 가방, 악세서리 등
- 전자: 가전, IT기기, 부품, 케이블 등
- 여행/문화: 숙박, 여행패키지, 공연, 티켓, 레저 등
- 건강: 영양제, 의약품, 운동용품 등
- 도서: 책, 교재, 잡지 등
- 기타: 위 어디에도 해당 없을 때만 사용${exampleStr}

분류할 상품명:
${names}

규칙:
1. 확신할 수 없으면 기타보다 가장 가까운 카테고리 선택
2. 브랜드명은 무시하고 상품 종류로 판단
3. JSON만 응답 (다른 텍스트 없이)

{"results": ["카테고리1", "카테고리2", ...]}`;
}

async function groqClassify(names, apiKey, examples = []) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens: 2000,
      messages: [{ role: 'user', content: buildPrompt(names, examples) }]
    })
  });
  if (!res.ok) throw new Error('Groq API 오류: ' + res.status);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Groq 응답 없음');
  return { ok: true, text };
}
