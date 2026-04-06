# 쇼핑 내역 정리 — 크롬 확장프로그램

쿠팡, 네이버쇼핑, 11번가 구매 내역을 자동으로 수집하고 한 곳에서 관리하는 크롬 확장프로그램입니다.

---

## 설치 방법

### 1단계 — 파일 다운로드
[최신 Releases](https://github.com/JooMyungjin/mjshoppinglist/releases) 파일(mj-shopping-list-v0.0.0.zip
)을 다운로드 받습니다.

`files` 폴더를 로컬에 저장합니다 (zip 압축 해제 또는 폴더 복사).


### 2단계 — 크롬 확장프로그램 로드

<img width="492" height="158" alt="image" src="https://github.com/user-attachments/assets/9454a899-5e00-4dfb-b3bc-a90aafa35c0a" />


1. 크롬 주소창에 `chrome://extensions/` 입력
2. 우측 상단 **개발자 모드** 토글 ON
3. **압축 해제된 확장 프로그램 로드** 클릭
4. `files` 폴더 선택

설치 완료 후 크롬 우측 상단 퍼즐 아이콘(🧩) → **쇼핑 내역 정리** 고정하면 편리합니다.

---

## 기본 사용법

### 상품 수집

1. 쿠팡 / 네이버 주문 내역 / 11번가 주문 내역 페이지를 엽니다
2. 확장프로그램 아이콘 클릭
3. **▶ 현재 탭에서 가져오기** — 현재 페이지의 주문 내역 수집
4. **⟳ 전체 기간 자동 수집** — 페이지를 넘기며 전체 내역 자동 수집

> 각 사이트별 주문 내역 페이지 경로
> - 쿠팡: 로켓와우 주문 내역 페이지
> - 네이버: orders.pay.naver.com
> - 11번가: 마이11번가 > 주문배송 내역

### 목록 보기 / 그래프 보기

수집 후 상단의 **목록** / **그래프** 버튼으로 전환합니다.

- **목록**: 날짜·금액 기준 정렬, 상품명 검색, 카테고리·날짜·금액 필터
- **그래프**: 카테고리별 도넛 차트 및 금액 현황

### 필터 사용

| 필터 | 설명 |
|------|------|
| 카테고리 칩 | 식품, 생활, 패션 등 카테고리 선택 |
| 날짜 범위 | `20240101` ~ `20241231` 형식으로 기간 입력 |
| 금액 범위 | 최소·최대 금액 설정 |
| 상품명 검색 | 키워드 입력 시 실시간 필터 |

### 카테고리 수정

- 목록에서 카테고리 뱃지(예: `식품`)를 클릭하면 직접 수정 가능
- 태그(🏷) 클릭으로 개인화 태그 추가, `×`로 삭제

### CSV 내보내기

하단 **CSV** 버튼 → 현재 필터 기준으로 다운로드

---

## 구글 시트 연동 (선택)

수집한 데이터를 구글 스프레드시트에 자동 저장할 수 있습니다.
연동하면 **날짜 / 상품명 / 가격 / 카테고리 / 태그 / 쇼핑몰 / 주문번호** 7개 컬럼으로 시트에 기록됩니다.

---

### 1단계 — 구글 스프레드시트 생성

1. [Google Sheets](https://sheets.google.com) 접속 후 **새 스프레드시트** 생성
2. 시트 이름은 자유롭게 설정 (연동 시 별도로 지정 가능)

---

### 2단계 — Apps Script 작성

1. 스프레드시트 상단 메뉴 **확장 프로그램 → Apps Script** 클릭
2. 기본으로 작성된 코드를 전부 지우고 아래 코드를 붙여넣기

```javascript
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(data.sheetName || '구매내역');
    if (!sheet) sheet = ss.insertSheet(data.sheetName || '구매내역');

    const header = ['날짜', '상품명', '가격(원)', '카테고리', '개인화태그', '쇼핑몰', '주문번호'];

    // 헤더 (시트가 비어있을 때만)
    if (sheet.getLastRow() === 0) {
      const headerRange = sheet.getRange(1, 1, 1, header.length);
      headerRange.setValues([header]);
      headerRange.setBackground('#1a1a2e');
      headerRange.setFontColor('#a89df5');
      headerRange.setFontWeight('bold');
    }

    // 기존 데이터에서 중복 키 수집 (orderId|상품명)
    const existingKeys = new Set();
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, header.length).getValues().forEach(row => {
        existingKeys.add(row[6] + '|' + row[1]);
      });
    }

    // 기존에 없는 항목만 추출
    const newItems = data.items.filter(i =>
      !existingKeys.has((i.orderId || '') + '|' + (i.name || ''))
    );

    const rows = newItems.map(i => [
      i.date || '',
      i.url ? `=HYPERLINK("${i.url}","${(i.name || '').replace(/"/g, '""')}")` : (i.name || ''),
      i.currency === 'USD' ? (i.priceKrw || i.price || 0) : (i.price || 0),
      i.category || '',
      (i.tags || []).join(', '),
      i.store || '',
      i.orderId || ''
    ]);

    if (!rows.length) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, count: 0, added: 0 }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, header.length).setValues(rows);

    // 주문번호별 색상 그룹핑
    // 같은 주문번호 = 옵션 상품 포함 → 같은 배경색
    const GROUP_COLORS = [
      '#ffffff', // 흰색 (단일 주문)
      '#eef2ff', // 연보라
      '#fef9ee', // 연노랑
      '#eefaf4', // 연초록
      '#fef0f0', // 연빨강
      '#f0f8ff', // 연파랑
    ];

    // 주문번호별 등장 순서 매핑
    const orderColorMap = {};
    let colorIdx = 0;
    const orderCount = {};

    // 먼저 각 주문번호 등장 횟수 카운트
    rows.forEach(row => {
      const orderId = row[6];
      orderCount[orderId] = (orderCount[orderId] || 0) + 1;
    });

    // 색상 할당 (2개 이상인 주문번호만 색상 부여, 순차 반복)
    let multiColorIdx = 0;
    rows.forEach(row => {
      const orderId = row[6];
      if (orderColorMap[orderId] === undefined) {
        if (orderCount[orderId] > 1) {
          // 여러 옵션 있는 주문 → 순차 색상 (1번부터)
          multiColorIdx = (multiColorIdx % (GROUP_COLORS.length - 1)) + 1;
          orderColorMap[orderId] = GROUP_COLORS[multiColorIdx];
        } else {
          orderColorMap[orderId] = GROUP_COLORS[0]; // 단일 주문 = 흰색
        }
      }
    });

    // 행별 배경색 적용
    rows.forEach((row, i) => {
      const orderId = row[6];
      const color = orderColorMap[orderId] || GROUP_COLORS[0];
      sheet.getRange(startRow + i, 1, 1, header.length).setBackground(color);
    });

    // 취소/반품 행 가격 취소선
    rows.forEach((row, i) => {
      if (row[3] === '취소/반품') {
        sheet.getRange(startRow + i, 3).setFontLine('line-through');
      }
    });

    // USD 아이템 원달러 가격 셀 노트
    newItems.forEach((item, i) => {
      if (item.currency === 'USD' && item.price) {
        sheet.getRange(startRow + i, 3).setNote(`US $${Number(item.price).toFixed(2)}`);
      }
    });

    // 열 너비 자동 조정
    sheet.autoResizeColumns(1, header.length);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, count: data.items.length, added: rows.length }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```


3. **저장** (Ctrl+S 또는 ⌘S)

---

### 3단계 — 웹 앱으로 배포

1. Apps Script 편집기 우측 상단 **배포 → 새 배포** 클릭
2. 설정값 확인
   - 유형: **웹 앱**
   - 다음 사용자로 실행: **나**
   - 액세스 권한: **모든 사용자**
3. **배포** 클릭
4. Google 계정 권한 허용 팝업이 뜨면
   - **고급** 클릭 → **안전하지 않은 페이지로 이동** 클릭 → **허용**
5. 배포 완료 후 표시되는 **웹 앱 URL** 복사
   - 형태: `https://script.google.com/macros/s/.../exec`

> **코드 수정 후 재배포 시** 반드시 **새 배포** 가 아닌 **배포 관리 → 수정** 으로 진행해야 기존 URL이 유지됩니다.

---

### 4단계 — 확장프로그램에 연결

1. 확장프로그램 하단 설정 패널 열기
2. **Apps Script 웹 앱 URL** 입력란에 복사한 URL 붙여넣기
3. **시트 이름** 입력 (비워두면 기본값 `구매내역` 사용)
4. **저장 및 연결** 클릭 → 상단에 **시트 연결됨** 표시 확인

---

### 동기화 방법

| 방법 | 설명 |
|------|------|
| 수동 동기화 | 하단 **구글 시트 동기화** 버튼 클릭 → 전체 데이터 전송 |
| 자동 동기화 | 설정에서 **자동 동기화** 토글 ON → 수집할 때마다 자동 전송 |

- 중복 데이터는 주문번호 기준으로 자동 필터링되어 중복 저장되지 않습니다.
- 시트가 없으면 자동으로 생성하고 헤더 행을 추가합니다.

---

## AI 카테고리 자동 분류 (선택)

`기타`로 분류된 상품을 AI가 자동으로 카테고리 분류합니다.

### 지원 AI

| AI | API Key 형식 | 발급 |
|----|-------------|------|
| Claude | `sk-ant-...` | console.anthropic.com |
| Gemini | `AIza...` | aistudio.google.com |
| Groq | `gsk_...` | console.groq.com |

### 사용법

1. 설정 패널에서 AI 제공사 선택 (Claude / Gemini / Groq)
2. API Key 입력 후 **저장 및 연결**
3. **🤖 기타 항목 자동 분류** 버튼 클릭

### 커스텀 분류 규칙

설정 패널 하단 **분류 규칙**에서 키워드별 카테고리를 직접 등록할 수 있습니다.
규칙 등록 후 **🏷️ 카테고리 재분류** 버튼으로 전체 재적용.

---

## 주의사항

- 개발자 모드로 설치한 확장프로그램은 크롬 업데이트 후 간헐적으로 비활성화될 수 있습니다. 비활성화 시 `chrome://extensions/`에서 다시 활성화하세요.
- 수집된 데이터는 브라우저 로컬 스토리지에 저장됩니다. **초기화** 버튼 클릭 시 전체 삭제되므로 주의하세요.
- 구글 시트 연동 없이도 CSV로 데이터를 보관할 수 있습니다.
