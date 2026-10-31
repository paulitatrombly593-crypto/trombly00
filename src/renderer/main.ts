import './styles.css';
import { getAnkiAPI } from './api-adapter';
import { Deck, Card, ReviewRating, StorageSchema, AnkiSettings } from '../shared/types';
import { SM2Scheduler, DEFAULT_ANKI_SETTINGS } from '../core/sm2';
import { CsvParser } from '../shared/csv-parser';

const api = getAnkiAPI();
const appElement = document.querySelector<HTMLDivElement>('#app');

if (!appElement) {
  throw new Error('[Critical Error] #app 엘리먼트를 찾을 수 없습니다.');
}

// =========================================================
// ⚙️ Anki 전문 설정 로드 및 국밥 기본값 관리
// =========================================================
const ANKI_SETTINGS_KEY = 'MY_ANKI_PRO_SETTINGS_V2';
const STARRED_CARDS_KEY = 'MY_ANKI_STARRED_CARDS';

type SettingsTab = 'new' | 'review' | 'lapse' | 'general' | 'display';
type SubPageMode = 'none' | 'today-quota' | 'starred-list';

function loadSettings(): AnkiSettings {
  try {
    const raw = localStorage.getItem(ANKI_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_ANKI_SETTINGS };
    return { ...DEFAULT_ANKI_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_ANKI_SETTINGS };
  }
}

let settings: AnkiSettings = loadSettings();
let activeSettingsTab: SettingsTab = 'new';
let isSettingsModalOpen = false;
let isAllCardsModalOpen = false; // 📚 전체 카드 '창 안에 창' 모달 상태
let isQuitConfirmModalOpen = false; // 🛑 학습 종료 확인 모달 상태

// 스크롤할 때만 스크롤바를 보여주고 1초 뒤 숨기는 글로벌 감지기
let scrollHideTimer: number | null = null;
window.addEventListener('scroll', () => {
  document.body.classList.add('is-scrolling');
  if (scrollHideTimer) clearTimeout(scrollHideTimer);
  scrollHideTimer = window.setTimeout(() => {
    document.body.classList.remove('is-scrolling');
  }, 1000);
}, true);

let currentSubPage: SubPageMode = 'none'; // 🔥 오늘 할당량 / ⭐ 중요 표시 전용 페이지 상태

let starredCardIds: Set<string> = new Set(JSON.parse(localStorage.getItem(STARRED_CARDS_KEY) || '[]'));

function saveSettings(newSettings: AnkiSettings): void {
  settings = { ...newSettings };
  localStorage.setItem(ANKI_SETTINGS_KEY, JSON.stringify(settings));
  applyDisplayClasses();
}

function applyDisplayClasses(): void {
  document.body.classList.remove('mode-pc', 'mode-mobile', 'theme-dark', 'theme-light');
  document.body.classList.add(`mode-${settings.viewMode}`, `theme-${settings.themeMode}`);
}

applyDisplayClasses();

// =========================================================
// 📊 단어 진척도(Mastery) 및 EZ Zone 점수 산출 헬퍼
// =========================================================
function getCardMasteryInfo(card: Card): {
  levelText: string;
  progressPct: number;
  barColor: string;
  ezText: string;
  ezClass: string;
} {
  const easePct = Math.round((card.easeFactor || 2.5) * 100);
  let ezText = `EZ ${easePct}% (표준)`;
  let ezClass = 'ez-normal';

  if (easePct >= 260) {
    ezText = `🟢 EZ Zone (${easePct}%)`;
    ezClass = 'ez-high';
  } else if (easePct <= 210) {
    ezText = `🔴 Hard Zone (${easePct}%)`;
    ezClass = 'ez-hard';
  } else {
    ezText = `🔵 Normal Zone (${easePct}%)`;
    ezClass = 'ez-normal';
  }

  if (card.state === 'new') {
    return { levelText: '🌱 미학습 (Lv.0)', progressPct: 5, barColor: '#94a3b8', ezText, ezClass };
  }
  if (card.state === 'learning' || card.state === 'relearning' || card.interval < 3) {
    return { levelText: '🔥 단기암기 (Lv.1)', progressPct: 30, barColor: '#f97316', ezText, ezClass };
  }
  if (card.interval < 21) {
    const pct = Math.min(85, 35 + Math.round((card.interval / 21) * 50));
    return { levelText: '⚡ 장기기억 진입 (Lv.2)', progressPct: pct, barColor: '#3b82f6', ezText, ezClass };
  }
  return { levelText: '👑 완전 마스터 (Lv.3)', progressPct: 100, barColor: '#10b981', ezText, ezClass };
}

// =========================================================
// 🔊 TTS 오디오, 햅틱, 스와이프, 답변 타이머 관리
// =========================================================
function speakText(text: string): void {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  const hasKorean = /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(text);
  utterance.lang = hasKorean ? 'ko-KR' : 'en-US';
  utterance.rate = 0.95;

  const speakerBtn = document.getElementById('btn-speak-card');
  speakerBtn?.classList.add('speaking');
  utterance.onend = () => speakerBtn?.classList.remove('speaking');
  utterance.onerror = () => speakerBtn?.classList.remove('speaking');

  window.speechSynthesis.speak(utterance);
}

function triggerHaptic(ms = 10): void {
  if ('vibrate' in navigator) {
    try { navigator.vibrate(ms); } catch { /* ignore */ }
  }
}

function toggleStarCard(cardId: string): boolean {
  if (starredCardIds.has(cardId)) starredCardIds.delete(cardId);
  else starredCardIds.add(cardId);
  localStorage.setItem(STARRED_CARDS_KEY, JSON.stringify([...starredCardIds]));
  triggerHaptic(15);
  return starredCardIds.has(cardId);
}

let touchStartX = 0;
let touchStartY = 0;

function attachSwipeBackListener(onSwipeBack: () => void): void {
  window.ontouchstart = (e: TouchEvent) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  };

  window.ontouchend = (e: TouchEvent) => {
    if (isSettingsModalOpen || isAllCardsModalOpen) return;
    const deltaX = e.changedTouches[0].clientX - touchStartX;
    const deltaY = e.changedTouches[0].clientY - touchStartY;

    if (Math.abs(deltaX) > 65 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
      triggerHaptic(15);
      const container = document.querySelector<HTMLDivElement>('.container');
      if (container) container.classList.add('slide-exit');
      setTimeout(() => onSwipeBack(), 160);
    }
  };
}

function clearSwipeListener(): void {
  window.ontouchstart = null;
  window.ontouchend = null;
}

// 화면 상태 변수
let selectedDeckId: string | null = null;
let studyingDeckId: string | null = null;
let isStarCramMode = false; // ⭐ 별표 전용 순수 플래시카드 모드 (SM-2 미적용)
let studyQueue: Card[] = [];
let currentCardIndex = 0;
let isAnswerRevealed = false;
let lastReactionText: string = 'Let’s go 🔥';
let reactionFadeTimer: number | null = null;

// 카드당 답변 시간 측정 타이머
let cardStartTimestamp = Date.now();
let timerIntervalId: number | null = null;

function startCardTimer(): void {
  cardStartTimestamp = Date.now();
  if (timerIntervalId) clearInterval(timerIntervalId);
  if (!settings.showTimer) return;

  timerIntervalId = window.setInterval(() => {
    const timerEl = document.getElementById('study-timer-display');
    if (!timerEl) return;
    const elapsed = Math.min(settings.maxAnswerSeconds, Math.floor((Date.now() - cardStartTimestamp) / 1000));
    timerEl.textContent = `⏱️ ${elapsed}s`;
  }, 1000);
}

function stopCardTimer(): number {
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
  const rawSeconds = Math.floor((Date.now() - cardStartTimestamp) / 1000);
  return Math.min(settings.maxAnswerSeconds, Math.max(1, rawSeconds));
}

let currentKeyHandler: ((e: KeyboardEvent) => void) | null = null;

function setKeyboardListener(handler: (e: KeyboardEvent) => void): void {
  if (currentKeyHandler) window.removeEventListener('keydown', currentKeyHandler);
  currentKeyHandler = handler;
  window.addEventListener('keydown', currentKeyHandler);
}

async function readFileWithAutoEncoding(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (utf8Text.includes('\uFFFD')) {
    try { return new TextDecoder('euc-kr').decode(buffer); } catch { return utf8Text; }
  }
  return utf8Text;
}

function buildDailyStudyQueue(deck: Deck, logs: StorageSchema['logs']): { queue: Card[]; dueNewCount: number; dueRevCount: number } {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayLogs = logs.filter(l => l.deckId === deck.id && l.reviewDate.startsWith(todayStr));
  const reviewedCardIdsToday = new Set(todayLogs.map(l => l.cardId));

  const remainingNewQuota = Math.max(0, settings.newCardsPerDay - [...reviewedCardIdsToday].filter(id => {
    const c = deck.cards.find(card => card.id === id);
    return c && c.repetitions <= 1;
  }).length);

  const remainingReviewQuota = Math.max(0, settings.maxReviewsPerDay - todayLogs.length);

  const learningDue = deck.cards.filter(
    c => !c.suspended && (c.state === 'learning' || c.state === 'relearning') && SM2Scheduler.isDue(c)
  );

  const reviewDue = deck.cards
    .filter(c => !c.suspended && c.state === 'review' && SM2Scheduler.isDue(c))
    .slice(0, remainingReviewQuota);

  let newCandidates = deck.cards.filter(c => !c.suspended && c.state === 'new');
  if (settings.newCardOrder === 'random') {
    newCandidates = [...newCandidates].sort(() => Math.random() - 0.5);
  }
  const newDue = newCandidates.slice(0, remainingNewQuota);

  const queue = [...learningDue, ...reviewDue, ...newDue];
  return {
    queue,
    dueNewCount: newDue.length,
    dueRevCount: learningDue.length + reviewDue.length
  };
}

// =========================================================
// 📚 [기능 1] '전체 카드' 창 안에 창(모달) 렌더링 (스크롤 & 진척도/수준 확인)
// =========================================================
function renderAllCardsModalHtml(decks: Deck[]): string {
  if (!isAllCardsModalOpen) return '';

  const allCards: { card: Card; deckName: string }[] = [];
  decks.forEach(d => {
    d.cards.forEach(c => allCards.push({ card: c, deckName: d.name }));
  });

  const now = new Date();
  const rowsHtml = allCards.map(({ card, deckName }) => {
    const m = getCardMasteryInfo(card);
    const dueBadge = SM2Scheduler.formatDueBadge(card, now);
    const isStar = starredCardIds.has(card.id);

    return `
      <div class="deck-item" style="flex-direction: column; align-items: stretch; gap: 6px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
            <span class="tag-badge tag-due-later">📁 ${escapeHtml(deckName)}</span>
            <span class="ez-badge ${m.ezClass}">${m.levelText}</span>
            <span class="ez-badge ${m.ezClass}">${m.ezText}</span>
          </div>
          <button class="btn-modal-star" data-card-id="${card.id}" style="background:transparent; font-size:20px; padding:2px 6px; color:${isStar ? '#84cc16' : 'var(--text-secondary)'};">
            ${isStar ? '★' : '☆'}
          </button>
        </div>
        <div style="font-size: 15px; word-break: break-all;">
          <strong>Q:</strong> ${escapeHtml(card.front)} <span style="color:#60a5fa; margin-left:6px;"><strong>A:</strong> ${escapeHtml(card.back)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 11.5px; color: var(--text-secondary);">
          <span>진척도: <b>${m.progressPct}%</b> (현재 간격: ${card.interval}일)</span>
          <span>${dueBadge}</span>
        </div>
        <div class="mastery-bar-track">
          <div class="mastery-bar-fill" style="width: ${m.progressPct}%; background: ${m.barColor};"></div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="modal-overlay" id="all-cards-modal-overlay">
      <div class="pro-modal-content" style="max-width: 680px;" onclick="event.stopPropagation();">
        <div class="pro-modal-header">
          <div>
            <h3 style="margin: 0; font-size: 17px;">📚 전체 보유 카드 진척도 브라우저 (총 ${allCards.length}장)</h3>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
              모든 단어장의 카드 수준(Lv.0~Lv.3)과 EZ Zone 난이도를 스크롤로 확인하세요.
            </div>
          </div>
          <button id="btn-close-all-cards" class="icon-circle-btn" style="width:32px; height:32px; font-size:14px;">✕</button>
        </div>
        <div style="padding: 16px;">
          <div class="all-cards-modal-list">
            ${rowsHtml || '<p style="text-align:center; color:var(--text-secondary);">등록된 카드가 없습니다.</p>'}
          </div>
        </div>
      </div>
    </div>
  `;
}

function attachAllCardsModalEvents(): void {
  if (!isAllCardsModalOpen) return;
  const close = () => {
    isAllCardsModalOpen = false;
    render();
  };
  document.getElementById('all-cards-modal-overlay')?.addEventListener('click', close);
  document.getElementById('btn-close-all-cards')?.addEventListener('click', close);

  document.querySelectorAll<HTMLButtonElement>('.btn-modal-star').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleStarCard(btn.dataset.cardId!);
      render();
    });
  });
}

// =========================================================
// 🔥 [기능 2] '오늘 할당량' 전용 페이지 (오늘 학습/복습 완료 구분 + 남은 할당량 + EZ Zone)
// =========================================================
async function renderTodayQuotaPage(): Promise<void> {
  const data = await api.getStorageData();
  const todayStr = new Date().toISOString().slice(0, 10);
  const now = new Date();

  // 1) 오늘 학습/복습 완료한 로그 및 카드 매칭
  const todayLogs = data.logs.filter(l => l.reviewDate.startsWith(todayStr));
  const completedItemsHtml = todayLogs.slice().reverse().map(log => {
    const deck = data.decks.find(d => d.id === log.deckId);
    const card = deck?.cards.find(c => c.id === log.cardId);
    if (!card || !deck) return '';

    const isNewLearned = log.lastInterval === 0;
    const typeBadge = isNewLearned
      ? `<span class="tag-badge tag-new">🌱 오늘 신규 학습</span>`
      : `<span class="tag-badge tag-due-later">🔄 오늘 복습 완료</span>`;

    const m = getCardMasteryInfo(card);
    const nextDue = SM2Scheduler.formatDueBadge(card, now);
    const timeStr = new Date(log.reviewDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return `
      <div class="deck-item" style="flex-direction: column; align-items: stretch; gap: 6px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 4px;">
          <div>
            ${typeBadge}
            <span class="ez-badge ${m.ezClass}">${m.ezText}</span>
            <span class="ez-badge ${m.ezClass}">${m.levelText}</span>
          </div>
          <span style="font-size: 11px; color: var(--text-secondary);">🕒 완료 시각: ${timeStr}</span>
        </div>
        <div style="font-size: 15px;">
          <strong>Q:</strong> ${escapeHtml(card.front)} <span style="color:#60a5fa; margin-left:6px;"><strong>A:</strong> ${escapeHtml(card.back)}</span>
        </div>
        <div class="deck-stats">
          📁 [${escapeHtml(deck.name)}] · 선택한 평가: <b>${log.rating}번</b> · 진척도(다음 복습): <b>${nextDue}</b>
        </div>
      </div>
    `;
  }).join('');

  // 2) 오늘 아직 남아있는 할당량 카드 모음
  const pendingCards: { card: Card; deckName: string; deckId: string }[] = [];
  data.decks.forEach(d => {
    const { queue } = buildDailyStudyQueue(d, data.logs);
    queue.forEach(c => pendingCards.push({ card: c, deckName: d.name, deckId: d.id }));
  });

  const pendingItemsHtml = pendingCards.map(({ card, deckName }) => {
    const m = getCardMasteryInfo(card);
    const isNew = card.state === 'new';
    return `
      <div class="deck-item">
        <div style="flex: 1; min-width: 0;">
          <div style="margin-bottom: 4px; display: flex; gap: 4px; flex-wrap: wrap;">
            <span class="tag-badge ${isNew ? 'tag-new' : 'tag-due-now'}">${isNew ? '🌱 신규 배정' : '🔥 복습 대기'}</span>
            <span class="ez-badge ${m.ezClass}">${m.ezText}</span>
            <span class="ez-badge ${m.ezClass}">${m.levelText}</span>
          </div>
          <div style="font-size: 15px; word-break: break-all;">
            <strong>Q:</strong> ${escapeHtml(card.front)} <span style="color:#60a5fa; margin-left:6px;"><strong>A:</strong> ${escapeHtml(card.back)}</span>
          </div>
          <div class="deck-stats">📁 ${escapeHtml(deckName)} · 현재 간격: ${card.interval}일</div>
        </div>
      </div>
    `;
  }).join('');

  appElement!.innerHTML = `
    <div class="container">
      <div class="header" style="justify-content: flex-start; gap: 10px;">
        <button id="btn-back-quota" class="btn-secondary" style="font-size: 13px; padding: 8px 12px;">⬅ 대시보드</button>
        <h3 style="margin: 0; font-size: 18px; flex: 1; text-align: right;">🔥 오늘의 할당량 &amp; 학습 리포트</h3>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">⏳ 남은 오늘 할당량</div>
          <div class="stat-value" style="color: #f43f5e;">${pendingCards.length}장</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">✅ 오늘 학습/복습 완료</div>
          <div class="stat-value" style="color: #10b981;">${todayLogs.length}회</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">🎯 일일 새 카드 목표</div>
          <div class="stat-value">${settings.newCardsPerDay}장</div>
        </div>
      </div>

      <!-- 1. 오늘 학습/복습 완료한 단어 리스트 -->
      <div class="card-box">
        <h4 style="margin: 0 0 12px 0; font-size: 15px; color: #10b981;">
          ✅ 오늘 학습 및 복습 완료한 단어 (${todayLogs.length}건)
        </h4>
        <div style="max-height: 320px; overflow-y: auto;">
          ${completedItemsHtml || '<p style="color: var(--text-secondary); font-size: 13.5px;">오늘 아직 학습을 완료한 단어가 없습니다. 지금 첫 학습을 시작해보세요!</p>'}
        </div>
      </div>

      <!-- 2. 오늘 남은 할당량 리스트 -->
      <div class="card-box" style="flex: 1;">
        <h4 style="margin: 0 0 12px 0; font-size: 15px; color: #f43f5e;">
          🔥 오늘 학습 대기 중인 할당량 (${pendingCards.length}장)
        </h4>
        <div style="max-height: 360px; overflow-y: auto;">
          ${pendingItemsHtml || '<p style="color: var(--text-secondary); font-size: 13.5px;">🎉 오늘 배정된 모든 할당량을 완벽히 끝냈습니다!</p>'}
        </div>
      </div>
    </div>
  `;

  const goBack = () => {
    clearSwipeListener();
    currentSubPage = 'none';
    render();
  };
  document.getElementById('btn-back-quota')?.addEventListener('click', goBack);
  attachSwipeBackListener(goBack);
}

// =========================================================
// ⭐ [기능 3] '중요 표시(별표)' 전용 페이지 & SM-2 제외 순수 플래시카드 복습 모드
// =========================================================
async function renderStarredPage(): Promise<void> {
  const data = await api.getStorageData();
  const starredCards: { card: Card; deckName: string }[] = [];

  data.decks.forEach(d => {
    d.cards.forEach(c => {
      if (starredCardIds.has(c.id)) {
        starredCards.push({ card: c, deckName: d.name });
      }
    });
  });

  const now = new Date();
  const listHtml = starredCards.map(({ card, deckName }) => {
    const m = getCardMasteryInfo(card);
    const dueBadge = SM2Scheduler.formatDueBadge(card, now);

    return `
      <div class="deck-item">
        <div style="flex: 1; min-width: 0;">
          <div style="margin-bottom: 4px; display: flex; gap: 4px; flex-wrap: wrap;">
            <span class="tag-badge tag-due-later">📁 ${escapeHtml(deckName)}</span>
            <span class="ez-badge ${m.ezClass}">${m.levelText}</span>
            <span class="ez-badge ${m.ezClass}">${m.ezText}</span>
          </div>
          <div style="font-size: 15.5px; word-break: break-all;">
            ⭐ <strong>Q:</strong> ${escapeHtml(card.front)}
          </div>
          <div style="color: #60a5fa; margin-top: 3px; font-size: 14px; word-break: break-all;">
            <strong>A:</strong> ${escapeHtml(card.back)}
          </div>
          <div class="deck-stats">원래 스케줄: ${dueBadge}</div>
        </div>
        <button class="btn-danger btn-unstar-card" data-card-id="${card.id}" style="flex-shrink: 0; background:#52525b;">
          ★ 해제
        </button>
      </div>
    `;
  }).join('');

  appElement!.innerHTML = `
    <div class="container">
      <div class="header" style="justify-content: flex-start; gap: 10px;">
        <button id="btn-back-starred" class="btn-secondary" style="font-size: 13px; padding: 8px 12px;">⬅ 대시보드</button>
        <h3 style="margin: 0; font-size: 18px; flex: 1; text-align: right;">⭐ 중요 표시(별표) 단어장</h3>
      </div>

      <!-- 상단 별표 전용 플래시카드 테스트 시작 박스 -->
      <div class="card-box" style="border-color: #84cc16;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div>
            <h4 style="margin: 0; font-size: 16px; color: #84cc16;">⚡ 별표 단어 집중 암기 테스트 (자유 복습 모드)</h4>
            <div style="font-size: 12.5px; color: var(--text-secondary); margin-top: 4px;">
              기존 망각곡선(SM-2) 복습 날짜나 난이도 점수를 건드리지 않고, 부족한 별표 단어만 순수 플래시카드로 반복 테스트합니다!
            </div>
          </div>
          <button id="btn-start-star-cram" class="btn-primary" style="background: #65a30d; padding: 14px 20px; font-size: 15px;" ${starredCards.length === 0 ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''}>
            ⭐ 별표 단어만 복습 시작 (${starredCards.length}장)
          </button>
        </div>
      </div>

      <!-- 별표 단어 스크롤 목록 -->
      <div class="card-box" style="flex: 1;">
        <h4 style="margin: 0 0 12px 0; font-size: 15px;">🗂️ 중요 표시된 단어 목록 (${starredCards.length}개)</h4>
        <div style="max-height: 60dvh; overflow-y: auto;">
          ${listHtml || '<p style="color: var(--text-secondary); font-size: 14px;">아직 별표(★) 표시한 단어가 없습니다. 학습 중 좌측 상단의 ☆ 버튼을 눌러 중요 단어를 모아보세요!</p>'}
        </div>
      </div>
    </div>
  `;

  const goBack = () => {
    clearSwipeListener();
    currentSubPage = 'none';
    render();
  };
  document.getElementById('btn-back-starred')?.addEventListener('click', goBack);
  attachSwipeBackListener(goBack);

  // 별표 해제 버튼
  document.querySelectorAll<HTMLButtonElement>('.btn-unstar-card').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleStarCard(btn.dataset.cardId!);
      render();
    });
  });

  // ⚡ 별표 전용 순수 플래시카드 복습 시작! (SM-2 제외)
  document.getElementById('btn-start-star-cram')?.addEventListener('click', async () => {
    if (starredCards.length === 0) return;
    isStarCramMode = true;
    studyingDeckId = 'STAR_CRAM_MODE';
    studyQueue = starredCards.map(item => ({ ...item.card }));
    currentCardIndex = 0;
    isAnswerRevealed = false;
    lastReactionText = 'Star Cram ⭐';
    await render();
    if (settings.autoPlayAudio && studyQueue[0]) {
      speakText(studyQueue[0].front);
    }
  });
}

// =========================================================
// 🎛️ 전문가용 5대 카테고리 사이드바 설정 모달
// =========================================================
function renderSettingsModalHtml(): string {
  if (!isSettingsModalOpen) return '';

  let rightPanelHtml = '';

  if (activeSettingsTab === 'new') {
    rightPanelHtml = `
      <h4 style="margin: 0 0 12px 0; color: var(--accent-blue);">🌱 새 카드 학습 옵션</h4>
      <div class="setting-row">
        <div>
          <div class="setting-label">익힘 단계 (분 단위)</div>
          <div class="setting-desc">띄어쓰기로 구분 (국밥 기본: 2 10)</div>
        </div>
        <input type="text" id="set-learningSteps" class="setting-input" value="${escapeHtml(settings.learningSteps)}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">새 카드 출제 순서</div>
          <div class="setting-desc">추가한 순서대로 vs 무작위</div>
        </div>
        <select id="set-newCardOrder" class="setting-select">
          <option value="sequential" ${settings.newCardOrder === 'sequential' ? 'selected' : ''}>추가한 순서대로</option>
          <option value="random" ${settings.newCardOrder === 'random' ? 'selected' : ''}>무작위 섞기</option>
        </select>
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">새 카드 / 일 (일일 학습 목표)</div>
          <div class="setting-desc">하루에 새로 외울 최대 단어 수</div>
        </div>
        <input type="number" id="set-newCardsPerDay" class="setting-input" min="0" max="9999" value="${settings.newCardsPerDay}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">졸업 간격 (일)</div>
          <div class="setting-desc">익힘 단계를 모두 통과한 후 첫 복습일</div>
        </div>
        <input type="number" id="set-graduatingInterval" class="setting-input" min="1" max="365" value="${settings.graduatingInterval}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">쉬움(Easy) 즉시 복습 주기 (일)</div>
          <div class="setting-desc">새 카드에서 '쉬움' 선택 시 부여할 간격</div>
        </div>
        <input type="number" id="set-easyInterval" class="setting-input" min="1" max="365" value="${settings.easyInterval}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">초기 수월함 (%)</div>
          <div class="setting-desc">기본 난이도 가중치 (국밥: 250%)</div>
        </div>
        <input type="number" id="set-startingEase" class="setting-input" min="130" max="500" value="${settings.startingEase}" />
      </div>
    `;
  } else if (activeSettingsTab === 'review') {
    rightPanelHtml = `
      <h4 style="margin: 0 0 12px 0; color: var(--accent-blue);">🔄 복습 스케줄링 옵션</h4>
      <div class="setting-row">
        <div>
          <div class="setting-label">최대 복습량 / 일 (일일 복습 목표)</div>
          <div class="setting-desc">하루 최대 복습 카드 수 (국밥: 9999)</div>
        </div>
        <input type="number" id="set-maxReviewsPerDay" class="setting-input" min="1" max="9999" value="${settings.maxReviewsPerDay}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">쉬움 버튼 보너스 (%)</div>
          <div class="setting-desc">쉬움 선택 시 추가 배율 (국밥: 130%)</div>
        </div>
        <input type="number" id="set-easyBonus" class="setting-input" min="100" max="300" value="${settings.easyBonus}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">복습 주기 조정값 (%)</div>
          <div class="setting-desc">전체 복습 간격에 곱할 배율 (기본: 100%)</div>
        </div>
        <input type="number" id="set-intervalModifier" class="setting-input" min="50" max="250" value="${settings.intervalModifier}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">최대 복습 주기 (일)</div>
          <div class="setting-desc">복습 간격 상한선 (시험 대비: 30~180일)</div>
        </div>
        <input type="number" id="set-maxInterval" class="setting-input" min="7" max="36500" value="${settings.maxInterval}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">어려움(Hard) 난이도 구간 (%)</div>
          <div class="setting-desc">어려움 선택 시 간격 증가율 (기본: 120%)</div>
        </div>
        <input type="number" id="set-hardInterval" class="setting-input" min="100" max="200" value="${settings.hardInterval}" />
      </div>
    `;
  } else if (activeSettingsTab === 'lapse') {
    rightPanelHtml = `
      <h4 style="margin: 0 0 12px 0; color: var(--accent-blue);">⚠️ 실패 (망각 및 거머리) 관리</h4>
      <div class="setting-row">
        <div>
          <div class="setting-label">실패 시 익힘 단계 (분 단위)</div>
          <div class="setting-desc">복습 카드를 틀렸을 때 재학습 단계 (예: 10)</div>
        </div>
        <input type="text" id="set-relearningSteps" class="setting-input" value="${escapeHtml(settings.relearningSteps)}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">새 복습 주기 비율 (%)</div>
          <div class="setting-desc">틀린 후 기존 간격 대비 유지 비율 (기본: 0%)</div>
        </div>
        <input type="number" id="set-newIntervalPercent" class="setting-input" min="0" max="100" value="${settings.newIntervalPercent}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">최소 복습 주기 (일)</div>
          <div class="setting-desc">재학습 졸업 후 최소 보장 일수 (기본: 1일)</div>
        </div>
        <input type="number" id="set-minInterval" class="setting-input" min="1" max="30" value="${settings.minInterval}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">거머리(Leech) 기준 실패 횟수</div>
          <div class="setting-desc">계속 틀리는 단어 감지 기준 (국밥: 8~15회)</div>
        </div>
        <input type="number" id="set-leechThreshold" class="setting-input" min="3" max="50" value="${settings.leechThreshold}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">거머리 카드 처리 방식</div>
          <div class="setting-desc">태그만 표시할지 학습에서 보류할지 선택</div>
        </div>
        <select id="set-leechAction" class="setting-select">
          <option value="tag" ${settings.leechAction === 'tag' ? 'selected' : ''}>태그만 달기</option>
          <option value="suspend" ${settings.leechAction === 'suspend' ? 'selected' : ''}>카드 일시 보류</option>
        </select>
      </div>
    `;
  } else if (activeSettingsTab === 'general') {
    rightPanelHtml = `
      <h4 style="margin: 0 0 12px 0; color: var(--accent-blue);">⏱️ 일반 (타이머 및 오디오)</h4>
      <div class="setting-row">
        <div>
          <div class="setting-label">답변 시간 제한 기준 (초)</div>
          <div class="setting-desc">너무 오래 켜둔 경우 최대 기록 시간 (기본: 60초)</div>
        </div>
        <input type="number" id="set-maxAnswerSeconds" class="setting-input" min="10" max="600" value="${settings.maxAnswerSeconds}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">답변 시간 타이머 표시</div>
          <div class="setting-desc">학습 화면 상단에 소요 시간(초) 표시</div>
        </div>
        <input type="checkbox" id="set-showTimer" ${settings.showTimer ? 'checked' : ''} style="width:20px; height:20px;" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">자동으로 오디오(TTS) 재생</div>
          <div class="setting-desc">새 카드가 나오면 즉시 원어민 발음 재생</div>
        </div>
        <input type="checkbox" id="set-autoPlayAudio" ${settings.autoPlayAudio ? 'checked' : ''} style="width:20px; height:20px;" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">정답 확인 시 질문 발음 재재생</div>
          <div class="setting-desc">카드를 뒤집을 때 단어 발음을 한 번 더 듣기</div>
        </div>
        <input type="checkbox" id="set-replayQuestionAudio" ${settings.replayQuestionAudio ? 'checked' : ''} style="width:20px; height:20px;" />
      </div>
    `;
  } else {
    rightPanelHtml = `
      <h4 style="margin: 0 0 12px 0; color: var(--accent-blue);">🎨 화면 모드 및 데이터 백업</h4>
      <div class="setting-row">
        <div>
          <div class="setting-label">화면 레이아웃 모드</div>
          <div class="setting-desc">PC 데스크톱 vs 모바일 엄지 최적화</div>
        </div>
        <select id="set-viewMode" class="setting-select">
          <option value="mobile" ${settings.viewMode === 'mobile' ? 'selected' : ''}>📱 모바일 모드</option>
          <option value="pc" ${settings.viewMode === 'pc' ? 'selected' : ''}>💻 PC 모드</option>
        </select>
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">컬러 테마</div>
          <div class="setting-desc">몰입형 다크 모드 vs 화이트 라이트 모드</div>
        </div>
        <select id="set-themeMode" class="setting-select">
          <option value="dark" ${settings.themeMode === 'dark' ? 'selected' : ''}>🌙 다크 모드</option>
          <option value="light" ${settings.themeMode === 'light' ? 'selected' : ''}>☀️ 라이트 모드</option>
        </select>
      </div>
      <div class="setting-row" style="margin-top: 12px; padding-top: 16px;">
        <div>
          <div class="setting-label">전체 단어장 백업 및 복원</div>
          <div class="setting-desc">JSON 파일로 모든 단어와 복습 기록을 보관합니다</div>
        </div>
        <div style="display: flex; gap: 6px;">
          <button id="btn-export-json" class="btn-secondary" style="padding: 8px 12px; font-size: 12px;">📥 백업 다운로드</button>
          <label class="btn-secondary" style="padding: 8px 12px; font-size: 12px; cursor: pointer;">
            📤 복원
            <input type="file" id="input-import-json" accept=".json" style="display: none;" />
          </label>
        </div>
      </div>
    `;
  }

  return `
    <div class="modal-overlay" id="settings-modal-overlay">
      <div class="pro-modal-content" onclick="event.stopPropagation();">
        <div class="pro-modal-header">
          <h3 style="margin: 0; font-size: 17px;">⚙️ Anki 상세 학습 설정</h3>
          <button id="btn-close-modal-x" class="icon-circle-btn" style="width:32px; height:32px; font-size:14px;">✕</button>
        </div>

        <div class="pro-modal-body">
          <div class="pro-sidebar">
            <button class="pro-tab-btn ${activeSettingsTab === 'new' ? 'active' : ''}" data-tab="new">🌱 새 카드</button>
            <button class="pro-tab-btn ${activeSettingsTab === 'review' ? 'active' : ''}" data-tab="review">🔄 복습</button>
            <button class="pro-tab-btn ${activeSettingsTab === 'lapse' ? 'active' : ''}" data-tab="lapse">⚠️ 실패</button>
            <button class="pro-tab-btn ${activeSettingsTab === 'general' ? 'active' : ''}" data-tab="general">⏱️ 일반</button>
            <button class="pro-tab-btn ${activeSettingsTab === 'display' ? 'active' : ''}" data-tab="display">🎨 화면·백업</button>
          </div>

          <div class="pro-panel">
            ${rightPanelHtml}
          </div>
        </div>

        <div class="pro-modal-footer">
          <button id="btn-restore-defaults" class="btn-secondary" style="font-size: 12.5px; padding: 10px 14px;">
            🔄 국밥 기본값 복원
          </button>
          <button id="btn-save-settings" class="btn-primary" style="font-size: 14px; padding: 10px 22px;">
            확인 및 저장
          </button>
        </div>
      </div>
    </div>
  `;
}

function collectCurrentTabInputs(): void {
  const getVal = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value;
  const getNum = (id: string, fallback: number) => {
    const v = parseFloat(getVal(id) || '');
    return isNaN(v) ? fallback : v;
  };
  const getChk = (id: string, fallback: boolean) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    return el ? el.checked : fallback;
  };

  if (activeSettingsTab === 'new') {
    settings.learningSteps = getVal('set-learningSteps') || '2 10';
    settings.newCardOrder = (getVal('set-newCardOrder') as AnkiSettings['newCardOrder']) || 'sequential';
    settings.newCardsPerDay = getNum('set-newCardsPerDay', 20);
    settings.graduatingInterval = getNum('set-graduatingInterval', 1);
    settings.easyInterval = getNum('set-easyInterval', 4);
    settings.startingEase = getNum('set-startingEase', 250);
  } else if (activeSettingsTab === 'review') {
    settings.maxReviewsPerDay = getNum('set-maxReviewsPerDay', 9999);
    settings.easyBonus = getNum('set-easyBonus', 130);
    settings.intervalModifier = getNum('set-intervalModifier', 100);
    settings.maxInterval = getNum('set-maxInterval', 180);
    settings.hardInterval = getNum('set-hardInterval', 120);
  } else if (activeSettingsTab === 'lapse') {
    settings.relearningSteps = getVal('set-relearningSteps') || '10';
    settings.newIntervalPercent = getNum('set-newIntervalPercent', 0);
    settings.minInterval = getNum('set-minInterval', 1);
    settings.leechThreshold = getNum('set-leechThreshold', 8);
    settings.leechAction = (getVal('set-leechAction') as AnkiSettings['leechAction']) || 'tag';
  } else if (activeSettingsTab === 'general') {
    settings.maxAnswerSeconds = getNum('set-maxAnswerSeconds', 60);
    settings.showTimer = getChk('set-showTimer', true);
    settings.autoPlayAudio = getChk('set-autoPlayAudio', false);
    settings.replayQuestionAudio = getChk('set-replayQuestionAudio', false);
  } else if (activeSettingsTab === 'display') {
    settings.viewMode = (getVal('set-viewMode') as AnkiSettings['viewMode']) || settings.viewMode;
    settings.themeMode = (getVal('set-themeMode') as AnkiSettings['themeMode']) || settings.themeMode;
  }
  saveSettings(settings);
}

function attachSettingsModalEvents(): void {
  if (!isSettingsModalOpen) return;

  document.querySelectorAll<HTMLButtonElement>('.pro-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      collectCurrentTabInputs();
      activeSettingsTab = btn.dataset.tab as SettingsTab;
      render();
    });
  });

  const closeAndSave = () => {
    collectCurrentTabInputs();
    isSettingsModalOpen = false;
    render();
  };

  document.getElementById('settings-modal-overlay')?.addEventListener('click', closeAndSave);
  document.getElementById('btn-close-modal-x')?.addEventListener('click', closeAndSave);
  document.getElementById('btn-save-settings')?.addEventListener('click', closeAndSave);

  document.getElementById('btn-restore-defaults')?.addEventListener('click', () => {
    if (confirm('인터넷 Anki 추천 국밥 세팅(익힘 2 10분, 일일 새 카드 20장, 초기 수월함 250%, 쉬움 보너스 130%)으로 모든 설정을 초기화하시겠습니까?')) {
      saveSettings({
        ...DEFAULT_ANKI_SETTINGS,
        viewMode: settings.viewMode,
        themeMode: settings.themeMode
      });
      render();
    }
  });

  document.getElementById('btn-export-json')?.addEventListener('click', async () => {
    const exportData = await api.getStorageData();
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `my-anki-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const fileInput = document.getElementById('input-import-json') as HTMLInputElement | null;
  fileInput?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await readFileWithAutoEncoding(file);
      const parsed = JSON.parse(text) as StorageSchema;
      if (!parsed || !Array.isArray(parsed.decks)) throw new Error('유효한 백업 파일이 아닙니다.');
      if (confirm(`총 ${parsed.decks.length}개의 단어장을 복원하시겠습니까?`)) {
        await api.importStorageData(parsed);
        alert('성공적으로 복원되었습니다!');
        isSettingsModalOpen = false;
        await render();
      }
    } catch (err) {
      alert(`복원 실패: ${(err as Error).message}`);
    }
  });
}

// =========================================================
// 1. 메인 대시보드 화면 (상단 3개 카드가 모두 인터랙티브 버튼으로 동작!)
// =========================================================
async function renderDashboard(): Promise<void> {
  clearSwipeListener();
  const data = await api.getStorageData();

  let totalCardsCount = 0;
  let totalDueTodayCount = 0;

  const deckListHtml = data.decks
    .map((deck: Deck) => {
      const totalCards = deck.cards.length;
      const { queue, dueNewCount, dueRevCount } = buildDailyStudyQueue(deck, data.logs);
      const dueTotal = queue.length;

      totalCardsCount += totalCards;
      totalDueTodayCount += dueTotal;

      return `
        <div class="deck-item">
          <div style="flex: 1; min-width: 0;">
            <strong style="font-size: 16px; word-break: break-all;">📁 ${escapeHtml(deck.name)}</strong>
            <div class="deck-stats">
              전체: <b>${totalCards}</b>장 · 새 카드 목표: <b style="color:#10b981;">${dueNewCount}</b> · 복습 대기: <span class="due-count">${dueRevCount}</span>
            </div>
          </div>
          <div style="display: flex; gap: 6px; flex-shrink: 0;">
            <button class="btn-primary btn-start-study" data-id="${deck.id}" ${dueTotal === 0 ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''}>
              📖 학습 (${dueTotal})
            </button>
            <button class="btn-secondary btn-manage" data-id="${deck.id}">관리</button>
            <button class="btn-danger btn-delete-deck" data-id="${deck.id}">삭제</button>
          </div>
        </div>
      `;
    })
    .join('');

  appElement!.innerHTML = `
    <div class="container">
      <div class="header">
        <div>
          <h2 style="margin: 0; font-size: 20px;">🧠 My Anki</h2>
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
            일일 목표: 새 카드 ${settings.newCardsPerDay}장 / 최대 복습 ${settings.maxReviewsPerDay}장
          </div>
        </div>
        <button id="btn-open-settings" class="icon-circle-btn" title="상세 설정">⚙️</button>
      </div>

      <!-- ✨ 클릭/터치 가능한 3대 인터랙티브 통계 버튼 -->
      <div class="stats-grid">
        <div class="stat-card stat-card-interactive" id="btn-stat-all-cards">
          <div class="stat-label">📚 전체 카드</div>
          <div class="stat-value">${totalCardsCount}</div>
          <div class="stat-action-hint">클릭하여 진척도 창 열기 ↗</div>
        </div>
        <div class="stat-card stat-card-interactive" id="btn-stat-today-quota">
          <div class="stat-label">🔥 오늘 할당량</div>
          <div class="stat-value" style="color: ${totalDueTodayCount > 0 ? '#f43f5e' : '#10b981'};">
            ${totalDueTodayCount}
          </div>
          <div class="stat-action-hint">오늘 학습·EZ Zone 보기 ➔</div>
        </div>
        <div class="stat-card stat-card-interactive" id="btn-stat-starred">
          <div class="stat-label">⭐ 중요 표시</div>
          <div class="stat-value" style="color: #84cc16;">${starredCardIds.size}</div>
          <div class="stat-action-hint">별표 단어장·집중 복습 ➔</div>
        </div>
      </div>

      <div class="card-box">
        <h3 style="margin-top: 0; font-size: 15px;">➕ 새 단어장 만들기</h3>
        <div class="form-row">
          <input type="text" id="input-deck-name" placeholder="단어장 이름 (예: 토익 빈출 1000제)" />
          <button id="btn-create-deck" class="btn-primary">생성</button>
        </div>
      </div>

      <div class="card-box" style="flex: 1;">
        <h3 style="margin-top: 0; font-size: 15px;">📚 단어장 목록 (${data.decks.length})</h3>
        ${deckListHtml || '<p style="color: var(--text-secondary); font-size: 14px;">단어장을 먼저 생성해주세요.</p>'}
      </div>
    </div>
    ${renderSettingsModalHtml()}
    ${renderAllCardsModalHtml(data.decks)}
  `;

  // 1) 전체 카드 클릭 -> 창 안에 창(모달) 오픈
  document.getElementById('btn-stat-all-cards')?.addEventListener('click', () => {
    triggerHaptic(12);
    isAllCardsModalOpen = true;
    render();
  });

  // 2) 오늘 할당량 클릭 -> 전용 페이지 이동
  document.getElementById('btn-stat-today-quota')?.addEventListener('click', () => {
    triggerHaptic(12);
    currentSubPage = 'today-quota';
    render();
  });

  // 3) 중요 표시 클릭 -> 별표 전용 페이지 이동
  document.getElementById('btn-stat-starred')?.addEventListener('click', () => {
    triggerHaptic(12);
    currentSubPage = 'starred-list';
    render();
  });

  document.getElementById('btn-open-settings')?.addEventListener('click', () => {
    isSettingsModalOpen = true;
    render();
  });

  attachSettingsModalEvents();
  attachAllCardsModalEvents();

  document.getElementById('btn-create-deck')?.addEventListener('click', async () => {
    const input = document.getElementById('input-deck-name') as HTMLInputElement;
    const name = input.value.trim();
    if (!name) return alert('단어장 이름을 입력해주세요!');
    await api.createDeck(name);
    await render();
  });

  document.querySelectorAll('.btn-delete-deck').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = (e.currentTarget as HTMLButtonElement).dataset.id!;
      if (confirm('정말 이 단어장을 삭제하시겠습니까?')) {
        await api.deleteDeck(id);
        await render();
      }
    });
  });

  document.querySelectorAll('.btn-manage').forEach(btn => {
    btn.addEventListener('click', (e) => {
      selectedDeckId = (e.currentTarget as HTMLButtonElement).dataset.id!;
      render();
    });
  });

  document.querySelectorAll('.btn-start-study').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = (e.currentTarget as HTMLButtonElement).dataset.id!;
      const freshData = await api.getStorageData();
      const targetDeck = freshData.decks.find(d => d.id === id);
      if (!targetDeck) return;

      const { queue } = buildDailyStudyQueue(targetDeck, freshData.logs);
      if (queue.length === 0) return alert('오늘 목표 할당량을 모두 학습했거나 복습할 카드가 없습니다!');

      isStarCramMode = false;
      studyingDeckId = id;
      studyQueue = queue;
      currentCardIndex = 0;
      isAnswerRevealed = false;
      lastReactionText = 'Let’s go 🔥';
      await render();
      if (settings.autoPlayAudio && studyQueue[0]) {
        speakText(studyQueue[0].front);
      }
    });
  });
}

// =========================================================
// 2. 단어 관리 화면
// =========================================================
async function renderDeckManage(deckId: string): Promise<void> {
  const data = await api.getStorageData();
  const deck = data.decks.find(d => d.id === deckId);
  if (!deck) { selectedDeckId = null; await renderDashboard(); return; }

  const now = new Date();

  const cardRowsHtml = deck.cards
    .map(card => {
      const dueBadgeText = SM2Scheduler.formatDueBadge(card, now);
      const isDueNow = SM2Scheduler.isDue(card, now) && card.state !== 'new';
      const badgeClass = card.state === 'new' ? 'tag-new' : (isDueNow ? 'tag-due-now' : 'tag-due-later');
      const lastReviewedStr = SM2Scheduler.formatLastReviewed(card);
      const m = getCardMasteryInfo(card);

      const isStar = starredCardIds.has(card.id);
      return `
        <div class="deck-item">
          <div style="flex: 1; min-width: 0;">
            <div style="margin-bottom: 5px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center;">
              <span class="tag-badge ${badgeClass}">${dueBadgeText}</span>
              <span class="ez-badge ${m.ezClass}">${m.ezText}</span>
              ${card.isLeech ? `<span class="tag-badge tag-leech">🩸 거머리(${card.lapses}회 실패)</span>` : ''}
            </div>
            <div style="word-break: break-all; font-size: 15px;">
              <strong>Q:</strong> ${escapeHtml(card.front)}
            </div>
            <div style="color: #60a5fa; margin-top: 3px; word-break: break-all; font-size: 14px;">
              <strong>A:</strong> ${escapeHtml(card.back)}
            </div>
            <div class="deck-stats" style="margin-top: 6px;">
              🕒 최근 학습: <b>${lastReviewedStr}</b> · 간격: <b>${card.interval}일</b> · 수준: <b>${m.levelText}</b>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
            <button class="btn-manage-star" data-card-id="${card.id}" title="중요 단어 별표" style="background: transparent; font-size: 24px; padding: 4px 8px; color: ${isStar ? '#84cc16' : 'var(--text-secondary)'};">
              ${isStar ? '★' : '☆'}
            </button>
            <button class="btn-danger btn-delete-card" data-card-id="${card.id}">삭제</button>
          </div>
        </div>
      `;
    })
    .join('');

  appElement!.innerHTML = `
    <div class="container">
      <div class="header" style="justify-content: flex-start; gap: 10px;">
        <div style="display: flex; gap: 6px; flex-shrink: 0;">
          <button id="btn-back" class="btn-secondary" style="font-size: 13px; padding: 8px 12px;">⬅ 목록</button>
          <button id="btn-open-settings" class="icon-circle-btn">⚙️</button>
        </div>
        <h3 style="margin: 0; font-size: 17px; word-break: break-all; flex: 1; text-align: right;">📁 [${escapeHtml(deck.name)}]</h3>
      </div>

      <div class="card-box">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
          <h4 style="margin: 0; font-size: 15px;">✏️ 새 단어 추가</h4>
          <label class="btn-secondary" style="font-size: 12px; padding: 7px 12px; cursor: pointer; border-radius: 10px;">
            📂 CSV 대량 등록
            <input type="file" id="input-csv-file" accept=".csv, .tsv, .txt" style="display: none;" />
          </label>
        </div>
        <div class="form-row">
          <input type="text" id="input-card-front" placeholder="앞면: 단어/질문 (예: lawn)" />
          <input type="text" id="input-card-back" placeholder="뒷면: 뜻/정답 (예: 잔디, 잔디밭)" />
          <button id="btn-add-card" class="btn-primary">단어 추가</button>
        </div>
      </div>

      <div class="card-box" style="flex: 1;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h4 style="margin: 0; font-size: 15px;">🗂️ 등록된 카드 (${deck.cards.length}개)</h4>
          ${deck.cards.length > 0 ? `<button id="btn-clear-deck-cards" class="btn-danger" style="font-size: 11px; padding: 5px 10px;">전체 삭제</button>` : ''}
        </div>
        ${cardRowsHtml || '<p style="color: var(--text-secondary); font-size: 14px;">등록된 카드가 없습니다.</p>'}
      </div>
    </div>
    ${renderSettingsModalHtml()}
    ${isQuitConfirmModalOpen ? `
      <div class="modal-overlay" id="quit-confirm-overlay">
        <div class="modal-content" style="max-width: 360px; text-align: center;" onclick="event.stopPropagation();">
          <div style="font-size: 38px; margin-bottom: 8px;">⏸️</div>
          <h3 style="margin: 0 0 8px 0; font-size: 18px;">학습을 종료하시겠습니까?</h3>
          <p style="font-size: 13.5px; color: var(--text-secondary); margin: 0 0 22px 0;">
            지금까지 학습한 카드 기록은 안전하게 저장됩니다.<br>(창 바깥의 빈 공간을 누르면 학습으로 돌아갑니다)
          </p>
          <div style="display: flex; gap: 10px;">
            <button id="btn-cancel-quit" class="btn-secondary" style="flex: 1; padding: 13px;">계속 학습하기</button>
            <button id="btn-confirm-quit" class="btn-danger" style="flex: 1; padding: 13px; font-size: 14px;">종료하기</button>
          </div>
        </div>
      </div>
    ` : ''}
  `;

  document.getElementById('btn-open-settings')?.addEventListener('click', () => {
    isSettingsModalOpen = true;
    render();
  });
  attachSettingsModalEvents();

  const goBackToDashboard = () => {
    clearSwipeListener();
    selectedDeckId = null;
    render();
  };

  document.getElementById('btn-back')?.addEventListener('click', goBackToDashboard);
  attachSwipeBackListener(goBackToDashboard);

  document.getElementById('btn-clear-deck-cards')?.addEventListener('click', async () => {
    if (confirm('이 단어장의 모든 카드를 삭제하시겠습니까?')) {
      for (const c of [...deck.cards]) {
        await api.deleteCard(deck.id, c.id);
      }
      await render();
    }
  });

  document.getElementById('btn-add-card')?.addEventListener('click', async () => {
    const front = (document.getElementById('input-card-front') as HTMLInputElement).value.trim();
    const back = (document.getElementById('input-card-back') as HTMLInputElement).value.trim();
    if (!front || !back) return alert('앞면과 뒷면을 모두 입력해주세요!');
    await api.addCard(deck.id, front, back, settings.startingEase);
    await render();
  });

  const csvInput = document.getElementById('input-csv-file') as HTMLInputElement;
  csvInput?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await readFileWithAutoEncoding(file);
      const parseResult = CsvParser.parse(text);
      if (parseResult.validCards.length === 0) return alert('유효한 단어가 없습니다.');
      if (!confirm(`총 ${parseResult.validCards.length}개의 단어를 등록하시겠습니까?`)) return;

      for (const item of parseResult.validCards) {
        await api.addCard(deck.id, item.front, item.back, settings.startingEase);
      }
      alert(`🎉 ${parseResult.validCards.length}개의 단어가 등록되었습니다!`);
      await render();
    } catch (err) {
      alert(`CSV 오류: ${(err as Error).message}`);
    } finally {
      csvInput.value = '';
    }
  });

  document.querySelectorAll('.btn-delete-card').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const cardId = (e.currentTarget as HTMLButtonElement).dataset.cardId!;
      await api.deleteCard(deck.id, cardId);
      await render();
    });
  });
}

  document.querySelectorAll<HTMLButtonElement>('.btn-manage-star').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleStarCard(btn.dataset.cardId!);
      render();
    });
  });

// =========================================================
// 3. 플래시카드 학습룸 (일반 SM-2 모드 + ⭐ 별표 전용 순수 암기 모드 겸용)
// =========================================================
async function renderStudyRoom(): Promise<void> {
  if (currentCardIndex >= studyQueue.length) {
    stopCardTimer();
    clearSwipeListener();
    const wasStarCram = isStarCramMode;

    appElement!.innerHTML = `
      <div class="container" style="justify-content: center; text-align: center;">
        <div class="card-box" style="padding: 48px 20px;">
          <h1 style="font-size: 54px; margin: 0 0 12px 0;">${wasStarCram ? '⭐' : '🎉'}</h1>
          <h2 style="font-size: 22px; margin-bottom: 8px;">
            ${wasStarCram ? '별표 중요 단어 복습 완료!' : '오늘의 학습 목표 달성!'}
          </h2>
          <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 28px;">
            ${wasStarCram
              ? '기존 망각곡선 스케줄에 영향을 주지 않고 별표 단어들을 모두 완벽히 훑어보았습니다!'
              : `할당된 <b>${studyQueue.length}개</b>의 카드를 모두 마쳤습니다.<br>Anki 스케줄러에 따라 다음 복습 주기가 정확히 기록되었습니다.`}
          </p>
          <button id="btn-finish-study" class="btn-primary" style="width: 100%; padding: 16px; font-size: 16px;">
            ${wasStarCram ? '별표 단어장으로 돌아가기' : '대시보드로 돌아가기'}
          </button>
        </div>
      </div>
    `;
    document.getElementById('btn-finish-study')?.addEventListener('click', () => {
      studyingDeckId = null;
      isStarCramMode = false;
      render();
    });
    return;
  }

  const currentCard = studyQueue[currentCardIndex];
  const progressPercent = Math.round(((currentCardIndex + 1) / studyQueue.length) * 100);
  const isStarred = starredCardIds.has(currentCard.id);
  const previewLabels = SM2Scheduler.getPreviewLabels(currentCard, settings);

  appElement!.innerHTML = `
    <div class="container">
      <div class="study-topbar">
        <div style="display: flex; gap: 8px;">
          <button id="btn-quit-study" class="icon-circle-btn" title="나가기">✕</button>
          <button id="btn-open-settings" class="icon-circle-btn" title="설정">⚙️</button>
        </div>
        <div class="study-counter">
          ${isStarCramMode ? '⭐ 자유 복습 ' : ''}${currentCardIndex + 1} / ${studyQueue.length}
        </div>
        <div style="min-width: 55px; text-align: right; font-size: 13px; color: var(--text-secondary);" id="study-timer-display">
          ${settings.showTimer ? '⏱️ 0s' : ''}
        </div>
      </div>

      <div class="study-progress-track">
        <div class="study-progress-fill" style="width: ${progressPercent}%; ${isStarCramMode ? 'background: linear-gradient(90deg, #84cc16, #10b981);' : ''}"></div>
      </div>

      <div class="study-box" id="study-card-body">
        <button id="btn-star-card" class="card-star-btn ${isStarred ? 'starred' : ''}">
          ${isStarred ? '★' : '☆'}
        </button>

        <div class="card-reaction-badge" id="reaction-badge">
          ${lastReactionText}
        </div>

        <div class="study-question">${escapeHtml(currentCard.front)}</div>

        ${isAnswerRevealed ? `
          <div class="study-divider"></div>
          <div class="study-answer">${escapeHtml(currentCard.back)}</div>
        ` : `
          <div class="tap-guide-hint">💡 카드를 터치하면 뜻이 보입니다</div>
        `}

        <button id="btn-speak-card" class="card-speaker-btn" title="발음 듣기">🔊</button>
      </div>

      ${!isAnswerRevealed ? `
        <button id="btn-reveal" class="btn-primary" style="width: 100%; padding: 18px; font-size: 17px; border-radius: 16px;">
          정답 확인하기 ${settings.viewMode === 'pc' ? '(Space)' : ''}
        </button>
      ` : isStarCramMode ? `
        <!-- ⭐ 별표 전용 순수 플래시카드 버튼 (SM-2 스케줄링 미적용!) -->
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px;">
          <button id="btn-cram-retry" class="btn-rate btn-again" style="padding: 18px 10px;">
            <b>🔄 다시 보기 (헷갈림)</b>
            <span class="btn-due-sub">이번 세션 끝에 재출제 [1]</span>
          </button>
          <button id="btn-cram-pass" class="btn-rate btn-good" style="padding: 18px 10px;">
            <b>✅ 외웠음 (통과)</b>
            <span class="btn-due-sub">스케줄 변경 없이 통과 [3]</span>
          </button>
        </div>
      ` : `
        <!-- 👍 일반 SM-2 학습 버튼 (오른손 엄지 최적화: 우측 하단에 3. 알맞음 배치) -->
        <div class="rating-grid">
          <button class="btn-rate btn-again" data-rating="1">
            <b>1. 다시</b>
            <span class="btn-due-sub">${previewLabels[1]} 후</span>
          </button>
          <button class="btn-rate btn-hard" data-rating="2">
            <b>2. 어려움</b>
            <span class="btn-due-sub">${previewLabels[2]} 후</span>
          </button>
          <button class="btn-rate btn-easy" data-rating="4">
            <b>4. 쉬움</b>
            <span class="btn-due-sub">${previewLabels[4]} 후</span>
          </button>
          <button class="btn-rate btn-good" data-rating="3">
            <b>3. 알맞음</b>
            <span class="btn-due-sub">${previewLabels[3]} 후</span>
          </button>
        </div>
      `}
    </div>
    ${renderSettingsModalHtml()}
  `;

  if (!isAnswerRevealed) {
    startCardTimer();
  }

  document.getElementById('btn-open-settings')?.addEventListener('click', () => {
    isSettingsModalOpen = true;
    render();
  });
  attachSettingsModalEvents();

  // 학습 화면에서는 드래그(스와이프)로 실수로 나가지지 않도록 리스너 완전 해제!
  clearSwipeListener();

  // X 버튼을 누르면 바로 나가지 않고 확인 상자 오픈
  document.getElementById('btn-quit-study')?.addEventListener('click', () => {
    triggerHaptic(12);
    isQuitConfirmModalOpen = true;
    render();
  });

  // 확인 상자 바깥 빈 공간 클릭 또는 [계속 학습하기] 클릭 시 취소 및 복귀
  const cancelQuit = () => {
    isQuitConfirmModalOpen = false;
    render();
  };
  document.getElementById('quit-confirm-overlay')?.addEventListener('click', cancelQuit);
  document.getElementById('btn-cancel-quit')?.addEventListener('click', cancelQuit);

  // [종료하기] 버튼 클릭 시 실제로 학습 종료
  document.getElementById('btn-confirm-quit')?.addEventListener('click', () => {
    isQuitConfirmModalOpen = false;
    stopCardTimer();
    window.speechSynthesis?.cancel();
    studyingDeckId = null;
    isStarCramMode = false;
    render();
  });

  document.getElementById('btn-star-card')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStarCard(currentCard.id);
    render();
  });

  document.getElementById('btn-speak-card')?.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerHaptic(10);
    speakText(currentCard.front);
  });

  document.getElementById('study-card-body')?.addEventListener('click', () => {
    triggerHaptic(10);
    isAnswerRevealed = !isAnswerRevealed;
    if (isAnswerRevealed && settings.replayQuestionAudio) {
      speakText(currentCard.front);
    }
    render();
  });

  document.getElementById('btn-reveal')?.addEventListener('click', () => {
    triggerHaptic(10);
    isAnswerRevealed = true;
    if (settings.replayQuestionAudio) {
      speakText(currentCard.front);
    }
    render();
  });

  // 별표 전용 자유 복습 모드 버튼 이벤트
  if (isStarCramMode) {
    document.getElementById('btn-cram-retry')?.addEventListener('click', async () => {
      triggerHaptic(15);
      lastReactionText = 'One more time 💪';
      // 헷갈리는 카드는 현재 큐의 맨 끝에 다시 추가하여 외울 때까지 반복!
      studyQueue.push({ ...currentCard });
      currentCardIndex++;
      isAnswerRevealed = false;
      await render();
    });

    document.getElementById('btn-cram-pass')?.addEventListener('click', async () => {
      triggerHaptic(15);
      lastReactionText = 'Got it! ⭐';
      currentCardIndex++;
      isAnswerRevealed = false;
      await render();
    });
  } else {
    document.querySelectorAll('.btn-rate').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const targetBtn = e.currentTarget as HTMLButtonElement;
        const rating = Number(targetBtn.dataset.rating) as ReviewRating;
        targetBtn.classList.add('btn-pop-active');
        await handleRatingWithReaction(rating);
      });
    });
  }

  setKeyboardListener(async (e: KeyboardEvent) => {
    if (isSettingsModalOpen) return;
    if (!isAnswerRevealed && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      isAnswerRevealed = true;
      render();
    } else if (isAnswerRevealed && isStarCramMode) {
      if (e.key === '1') document.getElementById('btn-cram-retry')?.click();
      if (e.key === '3' || e.key === '2' || e.key === '4') document.getElementById('btn-cram-pass')?.click();
    } else if (isAnswerRevealed && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      await handleRatingWithReaction(Number(e.key) as ReviewRating);
    }
  });
}

async function handleRatingWithReaction(rating: ReviewRating): Promise<void> {
  const currentCard = studyQueue[currentCardIndex];
  if (!studyingDeckId || !currentCard) return;

  const durationSec = stopCardTimer();
  triggerHaptic(18);

  const reactionMap: Record<ReviewRating, string> = {
    1: 'Cheer up 💪',
    2: 'Keep going 🔥',
    3: 'Good 👍',
    4: 'Awesome 🚀'
  };
  lastReactionText = reactionMap[rating];

  const badgeEl = document.getElementById('reaction-badge');
  if (badgeEl) {
    badgeEl.textContent = lastReactionText;
    badgeEl.style.opacity = '1';
    badgeEl.style.animation = 'none';
    void badgeEl.offsetWidth;
    badgeEl.style.animation = 'reactionPop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)';
  }

  await api.reviewCard(studyingDeckId, currentCard.id, rating, settings, durationSec);

  setTimeout(async () => {
    currentCardIndex++;
    isAnswerRevealed = false;
    await render();

    if (settings.autoPlayAudio && studyQueue[currentCardIndex]) {
      speakText(studyQueue[currentCardIndex].front);
    }

    if (reactionFadeTimer) clearTimeout(reactionFadeTimer);
    reactionFadeTimer = window.setTimeout(() => {
      const badge = document.getElementById('reaction-badge');
      if (badge) {
        badge.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
        badge.style.opacity = '0';
        badge.style.transform = 'translateY(-6px)';
      }
    }, 1500);
  }, 180);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function render(): Promise<void> {
  if (studyingDeckId) {
    await renderStudyRoom();
  } else if (selectedDeckId) {
    if (currentKeyHandler) {
      window.removeEventListener('keydown', currentKeyHandler);
      currentKeyHandler = null;
    }
    await renderDeckManage(selectedDeckId);
  } else if (currentSubPage === 'today-quota') {
    await renderTodayQuotaPage();
  } else if (currentSubPage === 'starred-list') {
    await renderStarredPage();
  } else {
    if (currentKeyHandler) {
      window.removeEventListener('keydown', currentKeyHandler);
      currentKeyHandler = null;
    }
    await renderDashboard();
  }
}

render();