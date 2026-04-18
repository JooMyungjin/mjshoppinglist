답변전 수정된 코드 검증 후 답변하기

# 프로젝트: CartLog (크롬 확장프로그램)

## 개요
쿠팡, 네이버쇼핑, 11번가, 알리익스프레스 구매 내역을 자동 수집·관리하는 크롬 확장프로그램

## 파일 구조
```
mjshoppinglist/
├── CLAUDE.md
├── README.md
├── privacy.html
└── files/                  ← 크롬 확장프로그램 실제 파일 (이 폴더를 크롬에 로드)
    ├── manifest.json        ← 확장프로그램 설정
    ├── app.html             ← 메인 UI
    ├── app.js               ← 메인 로직
    ├── background.js        ← 백그라운드 스크립트
    ├── categories.js        ← 카테고리 분류 규칙
    └── icons/               ← 아이콘
```

## 주요 기능
- 쿠팡 / 네이버페이 / 11번가 / 알리익스프레스 주문 내역 자동 수집
- 목록 보기 (정렬, 검색, 필터) / 그래프 보기 (도넛 차트)
- 카테고리 자동 분류 및 수동 편집
- 알리익스프레스 USD → KRW 환율 자동 변환 (Frankfurter API)
- CSV 내보내기
- 구글 시트 연동 (Apps Script 웹앱)
- 개인화 태그 기능

## 기술 스택
- Vanilla JS (프레임워크 없음)
- Chrome Extension Manifest V3
- Chrome Storage (로컬 스토리지)
- Google Apps Script (시트 연동)
- Frankfurter API (환율)

## 코딩 규칙
- 수정하기 전 수정 계획을 먼저 세우고 수정여부 확인 후 진행
- 코드 수정 후 반드시 검증하고 답변
