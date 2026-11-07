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
// ⚙️ Anki 전문 설정 로드 및 소프트 코딩 상태 관리
// =========================================================
const ANKI_SETTINGS_KEY = 'MY_ANKI_PRO_SETTINGS_V2';
const STARRED_CARDS_KEY = 'MY_ANKI_STARRED_CARDS';

type SettingsTab = 'new' | 'review' | 'lapse' | 'general' | 'display';
type SubPageMode = 'none' | 'today-quota' | 'starred-list';
type StudyDirection = 'front-to-back' | 'back-to-front' | 'random';

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
let isAllCardsModalOpen = false;
let isQuitConfirmModalOpen = false;
let isEditCardModalOpen = false;
let saveProgressOnQuit = true;
let studySessionSnapshot: StorageSchema | null = null;
let currentSubPage: SubPageMode = 'none';

// ✨ 신규 8대 기능용 소프트 상태 변수
let isAddCardAccordionOpen = false; // UI/UX 1: 단어 관리장 추가 폼 아코디언 접기/펼치기
let zoomedImageUrl: string | null = null; // UI/UX 2: 학습 사진 클릭 시 전체화면 Lightbox 줌
let studyDirection: StudyDirection = 'front-to-back'; // 제안 1: 양방향 학습 (단어->뜻 / 뜻->단어 / 랜덤)
let currentCardReversed = false; // 현재 카드가 역방향(뜻->단어) 상태인지 여부
let isTypingMode = false; // 제안 2: 스펠링 직접 타이핑 모드
let lastTypedAttempt = ''; // 사용자가 타이핑한 스펠링 답안
let isAutoPlayMode = false; // 제안 4: 핸즈프리 깜빡이 자동 재생 모드
let autoPlayTimerId: number | null = null;

// ↩️ 방금 넘긴 카드 되돌리기(Undo) 히스토리 스택
interface UndoSnapshot {
  cardIndex: number;
  storageSnapshot: StorageSchema;
  queueSnapshot: Card[];
}
let undoHistoryStack: UndoSnapshot[] = [];

// 📊 현재 학습 세션의 카드별 정답('correct') / 오답('wrong') 기록 맵
let sessionResultsMap: Map<string, 'correct' | 'wrong'> = new Map();
let resultFilterTab: 'all' | 'wrong' | 'correct' = 'all';
let editingCardTarget: Card | null = null;

// 🔍 단어 관리장 실시간 검색어 상태
let manageSearchQuery = '';

let starredCardIds: Set<string> = new Set(JSON.parse(localStorage.getItem(STARRED_CARDS_KEY) || '[]'));

// 스크롤할 때만 스크롤바를 보여주고 1초 뒤 숨기는 글로벌 감지기
let scrollHideTimer: number | null = null;
window.addEventListener('scroll', () => {
  document.body.classList.add('is-scrolling');
  if (scrollHideTimer) clearTimeout(scrollHideTimer);
  scrollHideTimer = window.setTimeout(() => {
    document.body.classList.remove('is-scrolling');
  }, 1000);
}, true);

function saveSettings(newSettings: AnkiSettings): void {
  settings = { ...newSettings };
  localStorage.setItem(ANKI_SETTINGS_KEY, JSON.stringify(settings));
  applyDisplayClasses();
}

const DARK_DEFAULT_COLORS = {
  colorOuterBg: '#252526',
  colorCardBg: '#1e1e1e',
  colorBaseText: '#d4d4d4',
  colorWordText: '#9cdcfe',
  colorMeaningText: '#4fc1ff',
  colorHighlightText: '#dcdcaa',
};

const LIGHT_DEFAULT_COLORS = {
  colorOuterBg: '#f3f4f6',
  colorCardBg: '#ffffff',
  colorBaseText: '#1e293b',
  colorWordText: '#0f172a',
  colorMeaningText: '#2563eb',
  colorHighlightText: '#d97706',
};

function getDefaultColorsForTheme(theme: 'dark' | 'light') {
  return theme === 'light' ? { ...LIGHT_DEFAULT_COLORS } : { ...DARK_DEFAULT_COLORS };
}

function applyDisplayClasses(): void {
  document.body.classList.remove('mode-pc', 'mode-mobile', 'theme-dark', 'theme-light');
  document.body.classList.add(`mode-${settings.viewMode}`, `theme-${settings.themeMode}`);

  const defaults = getDefaultColorsForTheme(settings.themeMode);
  const root = document.documentElement;
  root.style.setProperty('--bg-main', settings.colorOuterBg || defaults.colorOuterBg);
  root.style.setProperty('--bg-card', settings.colorCardBg || defaults.colorCardBg);
  root.style.setProperty('--text-primary', settings.colorBaseText || defaults.colorBaseText);
  root.style.setProperty('--word-text-color', settings.colorWordText || defaults.colorWordText);
  root.style.setProperty('--meaning-text-color', settings.colorMeaningText || defaults.colorMeaningText);
  root.style.setProperty('--highlight-text-color', settings.colorHighlightText || defaults.colorHighlightText);
}

applyDisplayClasses();

// =========================================================
// 🌱 [신규] Anki 84일 잔디밭(Heatmap) & 📅 향후 7일 복습 예보 계산기
// =========================================================
function buildHeatmapAndForecastHtml(data: StorageSchema): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 1) 날짜별 복습 로그 카운트 집계 (YYYY-MM-DD -> count)
  const logCountByDate = new Map<string, number>();
  data.logs.forEach(log => {
    const dateKey = log.reviewDate.slice(0, 10);
    logCountByDate.set(dateKey, (logCountByDate.get(dateKey) || 0) + 1);
  });

  // 연속 학습 스트릭(Streak) 일수 계산
  let streakDays = 0;
  for (let d = 0; d < 365; d++) {
    const checkDate = new Date(today.getTime() - d * 86400000);
    const key = checkDate.toISOString().slice(0, 10);
    const count = logCountByDate.get(key) || 0;
    if (count > 0) {
      streakDays++;
    } else if (d > 0) {
      break;
    }
  }

  // 최근 84일(12주) 잔디 셀 생성
  const heatmapCells: string[] = [];
  for (let i = 83; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const count = logCountByDate.get(key) || 0;
    let levelClass = '';
    if (count >= 30) levelClass = 'heat-lv4';
    else if (count >= 15) levelClass = 'heat-lv3';
    else if (count >= 5) levelClass = 'heat-lv2';
    else if (count >= 1) levelClass = 'heat-lv1';

    heatmapCells.push(`<div class="heatmap-cell ${levelClass}" title="${key}: ${count}회 학습"></div>`);
  }

  // 2) 향후 7일(오늘 ~ +6일) 복습 예정 카드 수 집계
  const forecastCounts: { label: string; count: number; dateStr: string }[] = [];
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

  for (let offset = 0; offset < 7; offset++) {
    const targetDay = new Date(today.getTime() + offset * 86400000);
    const nextDay = new Date(today.getTime() + (offset + 1) * 86400000);
    let dueCount = 0;

    data.decks.forEach(deck => {
      deck.cards.forEach(card => {
        if (card.suspended) return;
        const dueTime = new Date(card.dueDate).getTime();
        if (offset === 0) {
          if (dueTime <= nextDay.getTime()) dueCount++;
        } else {
          if (dueTime > targetDay.getTime() && dueTime <= nextDay.getTime()) dueCount++;
        }
      });
    });

    const label = offset === 0 ? '오늘' : offset === 1 ? '내일' : `${dayNames[targetDay.getDay()]}`;
    forecastCounts.push({ label, count: dueCount, dateStr: `${targetDay.getMonth() + 1}/${targetDay.getDate()}` });
  }

  const maxForecast = Math.max(10, ...forecastCounts.map(f => f.count));
  const forecastBarsHtml = forecastCounts
    .map(f => {
      const heightPct = Math.min(100, Math.round((f.count / maxForecast) * 100));
      return `
        <div class="forecast-col" title="${f.dateStr}: ${f.count}장 예정">
          <span class="forecast-count">${f.count}</span>
          <div class="forecast-bar-track">
            <div class="forecast-bar-fill" style="height: ${heightPct}%; ${f.count > 0 ? '' : 'opacity:0.2;'}"></div>
          </div>
          <span class="forecast-day-label">${f.label}</span>
        </div>
      `;
    })
    .join('');

  return `
    <div class="analytics-grid">
      <div class="card-box" style="margin-bottom: 0;">
        <div class="heatmap-header">
          <div>
            <strong style="font-size: 14px;">🌱 학습 잔디밭 (최근 12주)</strong>
            <div style="font-size: 11px; color: var(--text-secondary);">매일 단어를 학습하고 초록 잔디를 채워보세요</div>
          </div>
          <span class="streak-pill">🔥 ${streakDays}일 연속 학습</span>
        </div>
        <div class="heatmap-grid">
          ${heatmapCells.join('')}
        </div>
      </div>

      <div class="card-box" style="margin-bottom: 0;">
        <div class="heatmap-header">
          <div>
            <strong style="font-size: 14px;">📅 향후 7일 복습 예보 달력</strong>
            <div style="font-size: 11px; color: var(--text-secondary);">날짜별 돌아올 복습 카드 예측량</div>
          </div>
        </div>
        <div class="forecast-bars">
          ${forecastBarsHtml}
        </div>
      </div>
    </div>
  `;
}

// =========================================================
// 📊 단어 진척도(Mastery) 산출 헬퍼
// =========================================================
function getCardMasteryInfo(card: Card): {
  levelText: string;
  levelClass: string;
  progressPct: number;
  barColor: string;
} {
  if (card.state === 'new') {
    return { levelText: '🌱 미학습 (Lv.0)', levelClass: 'level-lv0', progressPct: 5, barColor: '#94a3b8' };
  }
  if (card.state === 'learning' || card.state === 'relearning' || card.interval < 3) {
    return { levelText: '🔥 단기암기 (Lv.1)', levelClass: 'level-lv1', progressPct: 30, barColor: '#f97316' };
  }
  if (card.interval < 21) {
    const pct = Math.min(85, 35 + Math.round((card.interval / 21) * 50));
    return { levelText: '⚡ 장기기억 진입 (Lv.2)', levelClass: 'level-lv2', progressPct: pct, barColor: '#06b6d4' };
  }
  return { levelText: '👑 완전 마스터 (Lv.3)', levelClass: 'level-lv3', progressPct: 100, barColor: '#10b981' };
}

// =========================================================
// 🔊 TTS 오디오, 햅틱, 스와이프, 답변 타이머, 오토플레이 관리
// =========================================================
function speakText(text: string): void {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();

  const cleanText = text.replace(/\*\*/g, '').replace(/\{\{|\}\}/g, '');
  const utterance = new SpeechSynthesisUtterance(cleanText);
  const hasKorean = /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(cleanText);
  utterance.lang = hasKorean ? 'ko-KR' : 'en-US';
  utterance.rate = 0.95;

  const speakerBtn = document.getElementById('btn-speak-card');
  speakerBtn?.classList.add('speaking');
  utterance.onend = () => speakerBtn?.classList.remove('speaking');
  utterance.onerror = () => speakerBtn?.classList.remove('speaking');

  window.speechSynthesis.speak(utterance);
}

function stopAutoPlay(): void {
  isAutoPlayMode = false;
  if (autoPlayTimerId) {
    clearTimeout(autoPlayTimerId);
    autoPlayTimerId = null;
  }
}

function scheduleNextAutoPlayStep(): void {
  if (!isAutoPlayMode || !studyingDeckId || currentCardIndex >= studyQueue.length) {
    stopAutoPlay();
    return;
  }
  if (autoPlayTimerId) clearTimeout(autoPlayTimerId);

  const currentCard = studyQueue[currentCardIndex];
  if (!isAnswerRevealed) {
    // 앞면일 때: 발음 읽고 2.4초 뒤 자동으로 뜻 공개
    speakText(currentCardReversed ? currentCard.back : currentCard.front);
    autoPlayTimerId = window.setTimeout(() => {
      if (!isAutoPlayMode) return;
      isAnswerRevealed = true;
      render();
    }, 2400);
  } else {
    // 뒷면일 때: 2.6초 보여준 뒤 다음 카드로 이동 (SM-2는 Good(3) 또는 패스 처리)
    autoPlayTimerId = window.setTimeout(async () => {
      if (!isAutoPlayMode) return;
      if (isStarCramMode) {
        currentCardIndex++;
        isAnswerRevealed = false;
        determineCardDirection();
        await render();
      } else {
        await handleRatingWithReaction(3);
      }
    }, 2600);
  }
}

function determineCardDirection(): void {
  if (studyDirection === 'front-to-back') currentCardReversed = false;
  else if (studyDirection === 'back-to-front') currentCardReversed = true;
  else currentCardReversed = Math.random() < 0.5;
  lastTypedAttempt = '';
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
    if (isSettingsModalOpen || isAllCardsModalOpen || isEditCardModalOpen || zoomedImageUrl) return;
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

let selectedDeckId: string | null = null;
let studyingDeckId: string | null = null;
let isStarCramMode = false;
let studyQueue: Card[] = [];
let currentCardIndex = 0;
let isAnswerRevealed = false;
let isProcessingRating = false;
let lastKeyActionTime = 0;
let lastReactionText: string = '';
let reactionFadeTimer: number | null = null;

function triggerReactionBadge(text: string): void {
  lastReactionText = text;
  if (reactionFadeTimer) clearTimeout(reactionFadeTimer);
  reactionFadeTimer = window.setTimeout(() => {
    lastReactionText = '';
    const badge = document.getElementById('reaction-badge');
    if (badge) {
      badge.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
      badge.style.opacity = '0';
      badge.style.transform = 'translateY(-6px)';
    }
  }, 1500);
}

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

let pendingCardImageData: string | undefined = undefined;
let draftFrontText = '';
let draftBackText = '';
let draftExampleText = '';
let selectedCardIds: Set<string> = new Set();

function compressImageToDataUrl(fileOrBlob: File | Blob, maxSize = 600, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxSize) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          }
        } else {
          if (height > maxSize) {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas context 생성 실패'));

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('이미지 로드 실패'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('파일 읽기 실패'));
    reader.readAsDataURL(fileOrBlob);
  });
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
// 📚 '전체 카드' 모달
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
            <span class="badge-deck-category">📁 ${escapeHtml(deckName)}</span>
            <span class="ez-badge ${m.levelClass}">${m.levelText}</span>
          </div>
          <button class="btn-modal-star" data-card-id="${card.id}" style="background:transparent; font-size:20px; padding:2px 6px; color:${isStar ? '#84cc16' : 'var(--text-secondary)'};">
            ${isStar ? '★' : '☆'}
          </button>
        </div>
        <div style="font-size: 15px; word-break: break-all;">
          <strong>Q:</strong> ${formatRichText(card.front, true)} <span style="color:var(--sector-meaning-color); margin-left:6px;"><strong>A:</strong> ${formatRichText(card.back, true)}</span>
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
              모든 단어장의 카드 암기 수준(Lv.0~Lv.3)과 진척도를 스크롤로 확인하세요.
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
// 🔥 '오늘 할당량' 전용 페이지
// =========================================================
async function renderTodayQuotaPage(): Promise<void> {
  const data = await api.getStorageData();
  const todayStr = new Date().toISOString().slice(0, 10);
  const now = new Date();

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
          <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
            ${typeBadge}
            <span class="ez-badge ${m.levelClass}">${m.levelText}</span>
          </div>
          <span style="font-size: 11px; color: var(--text-secondary);">🕒 완료 시각: ${timeStr}</span>
        </div>
        <div style="font-size: 15px;">
          <strong>Q:</strong> ${formatRichText(card.front, true)} <span style="color:var(--sector-meaning-color); margin-left:6px;"><strong>A:</strong> ${formatRichText(card.back, true)}</span>
        </div>
        <div class="deck-stats">
          📁 [${escapeHtml(deck.name)}] · 선택한 평가: <b>${log.rating}번</b> · 진척도(다음 복습): <b>${nextDue}</b>
        </div>
      </div>
    `;
  }).join('');

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
          <div style="margin-bottom: 4px; display: flex; gap: 6px; flex-wrap: wrap;">
            <span class="badge-deck-category">📁 ${escapeHtml(deckName)}</span>
            <span class="tag-badge ${isNew ? 'tag-new' : 'tag-due-now'}">${isNew ? '🌱 신규 배정' : '🔥 복습 대기'}</span>
            <span class="ez-badge ${m.levelClass}">${m.levelText}</span>
          </div>
          <div style="font-size: 15px; word-break: break-all;">
            <strong>Q:</strong> ${formatRichText(card.front, true)} <span style="color:var(--sector-meaning-color); margin-left:6px;"><strong>A:</strong> ${formatRichText(card.back, true)}</span>
          </div>
          <div class="deck-stats">현재 간격: ${card.interval}일</div>
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

      <div class="card-box">
        <h4 style="margin: 0 0 12px 0; font-size: 15px; color: #10b981;">
          ✅ 오늘 학습 및 복습 완료한 단어 (${todayLogs.length}건)
        </h4>
        <div style="max-height: 320px; overflow-y: auto;">
          ${completedItemsHtml || '<p style="color: var(--text-secondary); font-size: 13.5px;">오늘 아직 학습을 완료한 단어가 없습니다.</p>'}
        </div>
      </div>

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
// ⭐ '중요 표시(별표)' 전용 페이지
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
          <div style="margin-bottom: 4px; display: flex; gap: 6px; flex-wrap: wrap;">
            <span class="badge-deck-category">📁 ${escapeHtml(deckName)}</span>
            <span class="ez-badge ${m.levelClass}">${m.levelText}</span>
          </div>
          <div style="font-size: 15.5px; word-break: break-all;">
            ⭐ <strong>Q:</strong> ${formatRichText(card.front, true)}
          </div>
          <div style="color: var(--sector-meaning-color); margin-top: 3px; font-size: 14px; word-break: break-all;">
            <strong>A:</strong> ${formatRichText(card.back, true)}
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

      <div class="card-box" style="flex: 1;">
        <h4 style="margin: 0 0 12px 0; font-size: 15px;">🗂️ 중요 표시된 단어 목록 (${starredCards.length}개)</h4>
        <div style="max-height: 60dvh; overflow-y: auto;">
          ${listHtml || '<p style="color: var(--text-secondary); font-size: 14px;">아직 별표(★) 표시한 단어가 없습니다.</p>'}
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

  document.querySelectorAll<HTMLButtonElement>('.btn-unstar-card').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleStarCard(btn.dataset.cardId!);
      render();
    });
  });

  document.getElementById('btn-start-star-cram')?.addEventListener('click', async () => {
    if (starredCards.length === 0) return;
    isStarCramMode = true;
    undoHistoryStack = [];
    sessionResultsMap.clear();
    resultFilterTab = 'all';
    studyingDeckId = 'STAR_CRAM_MODE';
    studyQueue = starredCards.map(item => ({ ...item.card }));
    currentCardIndex = 0;
    isAnswerRevealed = false;
    determineCardDirection();
    triggerReactionBadge('Star Cram ⭐');
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

  const isFsrs = settings.schedulerEngine === 'fsrs';
  const sm2DisabledClass = isFsrs ? 'setting-row-disabled' : '';
  const sm2DisabledAttr = isFsrs ? 'disabled' : '';
  const sm2Badge = isFsrs ? '<span class="sm2-only-badge">SM-2 전용</span>' : '';
  const fsrsLockNotice = isFsrs
    ? `<div class="fsrs-lock-banner">🤖 <b>FSRS-5 엔진 사용 중:</b> FSRS가 기억 안정성(S)과 난이도(D)를 자동 계산하므로, SM-2 전용 수동 가중치 항목은 자동으로 비활성화되었습니다.</div>`
    : '';

  const themeDefaults = getDefaultColorsForTheme(settings.themeMode);
  const curOuterBg = settings.colorOuterBg || themeDefaults.colorOuterBg;
  const curCardBg = settings.colorCardBg || themeDefaults.colorCardBg;
  const curBaseText = settings.colorBaseText || themeDefaults.colorBaseText;
  const curWordText = settings.colorWordText || themeDefaults.colorWordText;
  const curMeaningText = settings.colorMeaningText || themeDefaults.colorMeaningText;
  const curHighlightText = settings.colorHighlightText || themeDefaults.colorHighlightText;

  let rightPanelHtml = '';

  if (activeSettingsTab === 'new') {
    rightPanelHtml = `
      <h4 style="margin: 0 0 12px 0; color: var(--accent-blue);">🌱 새 카드 학습 옵션</h4>
      ${fsrsLockNotice}
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
          <div class="setting-desc">하루에 새로 외울 최대 단어 수 (기본: 20)</div>
        </div>
        <input type="number" id="set-newCardsPerDay" class="setting-input" min="0" max="9999" value="${settings.newCardsPerDay}" />
      </div>
      <div class="setting-row ${sm2DisabledClass}">
        <div>
          <div class="setting-label">익힘 단계 (분 단위) ${sm2Badge}</div>
          <div class="setting-desc">띄어쓰기로 구분 (기본: 2 10)</div>
        </div>
        <input type="text" id="set-learningSteps" class="setting-input" value="${escapeHtml(settings.learningSteps)}" ${sm2DisabledAttr} />
      </div>
      <div class="setting-row ${sm2DisabledClass}">
        <div>
          <div class="setting-label">졸업 간격 (일) ${sm2Badge}</div>
          <div class="setting-desc">익힘 단계를 모두 통과한 후 첫 복습일 (기본: 1일)</div>
        </div>
        <input type="number" id="set-graduatingInterval" class="setting-input" min="1" max="365" value="${settings.graduatingInterval}" ${sm2DisabledAttr} />
      </div>
      <div class="setting-row ${sm2DisabledClass}">
        <div>
          <div class="setting-label">쉬움(Easy) 즉시 복습 주기 (일) ${sm2Badge}</div>
          <div class="setting-desc">새 카드에서 '쉬움' 선택 시 부여할 간격 (기본: 4일)</div>
        </div>
        <input type="number" id="set-easyInterval" class="setting-input" min="1" max="365" value="${settings.easyInterval}" ${sm2DisabledAttr} />
      </div>
      <div class="setting-row ${sm2DisabledClass}">
        <div>
          <div class="setting-label">초기 수월함 (%) ${sm2Badge}</div>
          <div class="setting-desc">기본 난이도 가중치 (기본: 250%)</div>
        </div>
        <input type="number" id="set-startingEase" class="setting-input" min="130" max="500" value="${settings.startingEase}" ${sm2DisabledAttr} />
      </div>
    `;
  } else if (activeSettingsTab === 'review') {
    rightPanelHtml = `
      <h4 style="margin: 0 0 12px 0; color: var(--accent-blue);">🔄 복습 스케줄링 옵션</h4>
      <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 12px; padding: 12px; margin-bottom: 14px;">
        <div class="setting-row" style="border-bottom: none; padding: 4px 0;">
          <div>
            <div class="setting-label" style="color: var(--accent-blue);">🧠 학습 스케줄러 알고리즘 엔진</div>
            <div class="setting-desc">차세대 FSRS-5 (DSR 기억 모델) vs 클래식 SM-2</div>
          </div>
          <select id="set-schedulerEngine" class="setting-select">
            <option value="fsrs" ${settings.schedulerEngine === 'fsrs' ? 'selected' : ''}>🚀 FSRS-5 (권장)</option>
            <option value="sm2" ${settings.schedulerEngine === 'sm2' ? 'selected' : ''}>⚙️ 클래식 SM-2</option>
          </select>
        </div>
        <div class="setting-row ${!isFsrs ? 'setting-row-disabled' : ''}" style="border-bottom: none; padding: 8px 0 4px 0;">
          <div>
            <div class="setting-label">🎯 FSRS 목표 암기 유지율 (Desired Retention)</div>
            <div class="setting-desc">권장 90% (85%~95% 조절 가능, 높을수록 자주 복습)</div>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <input type="number" id="set-desiredRetention" class="setting-input" min="70" max="97" step="1" value="${Math.round((settings.desiredRetention || 0.9) * 100)}" ${!isFsrs ? 'disabled' : ''} style="width: 72px;" />
            <span style="font-size: 13px; font-weight: 700;">%</span>
          </div>
        </div>
        <div class="setting-row ${!isFsrs ? 'setting-row-disabled' : ''}" style="border-bottom: none; padding: 6px 0 2px 0;">
          <div>
            <div class="setting-label">🔄 기존 SM-2 학습 진도 이어받기</div>
            <div class="setting-desc">체크 시 기존 카드의 간격·난이도를 FSRS 초기값으로 변환</div>
          </div>
          <input type="checkbox" id="set-fsrsInheritProgress" ${settings.fsrsInheritProgress !== false ? 'checked' : ''} ${!isFsrs ? 'disabled' : ''} style="width: 18px; height: 18px;" />
        </div>
      </div>
      ${fsrsLockNotice}
      <div class="setting-row">
        <div>
          <div class="setting-label">최대 복습량 / 일 (일일 복습 목표)</div>
          <div class="setting-desc">하루 최대 복습 카드 수 (기본: 9999)</div>
        </div>
        <input type="number" id="set-maxReviewsPerDay" class="setting-input" min="1" max="9999" value="${settings.maxReviewsPerDay}" />
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">최대 복습 주기 (일)</div>
          <div class="setting-desc">복습 간격 상한선 (기본: 180일)</div>
        </div>
        <input type="number" id="set-maxInterval" class="setting-input" min="7" max="36500" value="${settings.maxInterval}" />
      </div>
      <div class="setting-row ${sm2DisabledClass}">
        <div>
          <div class="setting-label">쉬움 버튼 보너스 (%) ${sm2Badge}</div>
          <div class="setting-desc">쉬움 선택 시 추가 배율 (기본: 130%)</div>
        </div>
        <input type="number" id="set-easyBonus" class="setting-input" min="100" max="300" value="${settings.easyBonus}" ${sm2DisabledAttr} />
      </div>
      <div class="setting-row ${sm2DisabledClass}">
        <div>
          <div class="setting-label">복습 주기 조정값 (%) ${sm2Badge}</div>
          <div class="setting-desc">전체 복습 간격에 곱할 배율 (기본: 100%)</div>
        </div>
        <input type="number" id="set-intervalModifier" class="setting-input" min="50" max="250" value="${settings.intervalModifier}" ${sm2DisabledAttr} />
      </div>
      <div class="setting-row ${sm2DisabledClass}">
        <div>
          <div class="setting-label">어려움(Hard) 난이도 구간 (%) ${sm2Badge}</div>
          <div class="setting-desc">어려움 선택 시 간격 증가율 (기본: 120%)</div>
        </div>
        <input type="number" id="set-hardInterval" class="setting-input" min="100" max="200" value="${settings.hardInterval}" ${sm2DisabledAttr} />
      </div>
    `;
  } else if (activeSettingsTab === 'lapse') {
    rightPanelHtml = `
      <h4 style="margin: 0 0 12px 0; color: var(--accent-blue);">⚠️ 실패 (망각 및 거머리) 관리</h4>
      ${fsrsLockNotice}
      <div class="setting-row">
        <div>
          <div class="setting-label">거머리(Leech) 기준 실패 횟수</div>
          <div class="setting-desc">계속 틀리는 단어 감지 기준 (기본: 8회)</div>
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
      <div class="setting-row ${sm2DisabledClass}">
        <div>
          <div class="setting-label">실패 시 익힘 단계 (분 단위) ${sm2Badge}</div>
          <div class="setting-desc">복습 카드를 틀렸을 때 재학습 단계 (기본: 10)</div>
        </div>
        <input type="text" id="set-relearningSteps" class="setting-input" value="${escapeHtml(settings.relearningSteps)}" ${sm2DisabledAttr} />
      </div>
      <div class="setting-row ${sm2DisabledClass}">
        <div>
          <div class="setting-label">새 복습 주기 비율 (%) ${sm2Badge}</div>
          <div class="setting-desc">틀린 후 기존 간격 대비 유지 비율 (기본: 0%)</div>
        </div>
        <input type="number" id="set-newIntervalPercent" class="setting-input" min="0" max="100" value="${settings.newIntervalPercent}" ${sm2DisabledAttr} />
      </div>
      <div class="setting-row ${sm2DisabledClass}">
        <div>
          <div class="setting-label">최소 복습 주기 (일) ${sm2Badge}</div>
          <div class="setting-desc">재학습 졸업 후 최소 보장 일수 (기본: 1일)</div>
        </div>
        <input type="number" id="set-minInterval" class="setting-input" min="1" max="30" value="${settings.minInterval}" ${sm2DisabledAttr} />
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
  } else if (activeSettingsTab === 'display') {
    rightPanelHtml = `
      <h4 style="margin: 0 0 12px 0; color: var(--accent-blue);">🎨 화면 레이아웃 · 색상 커스텀 · 백업</h4>
      <div class="setting-row">
        <div>
          <div class="setting-label">화면 레이아웃 크기</div>
          <div class="setting-desc">사용 중인 기기에 맞춰 여백과 버튼 크기 최적화</div>
        </div>
        <select id="set-viewMode" class="setting-select">
          <option value="pc" ${settings.viewMode === 'pc' ? 'selected' : ''}>🖥️ PC 버전</option>
          <option value="mobile" ${settings.viewMode === 'mobile' ? 'selected' : ''}>📱 모바일 버전</option>
        </select>
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">배경 테마 모드</div>
          <div class="setting-desc">모드 변경 시 해당 모드의 기본 색상 팔레트가 적용됩니다</div>
        </div>
        <select id="set-themeMode" class="setting-select">
          <option value="dark" ${settings.themeMode === 'dark' ? 'selected' : ''}>🌙 다크 모드</option>
          <option value="light" ${settings.themeMode === 'light' ? 'selected' : ''}>☀️ 라이트 모드</option>
        </select>
      </div>

      <div style="margin-top: 14px; padding: 12px; border-radius: 12px; background: rgba(128,128,128,0.06); border: 1px solid var(--border-color);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <strong style="font-size: 13px;">🎨 배경 및 섹터별 글자색 지정 (${settings.themeMode === 'dark' ? '다크' : '라이트'} 모드)</strong>
        </div>
        <div class="setting-row" style="padding: 8px 0;">
          <div>
            <div class="setting-label">1. 바깥 배경색 (사이드 여백)</div>
            <div class="setting-desc">카드 바깥쪽 배경 (다크 기본: #252526)</div>
          </div>
          <input type="color" id="set-colorOuterBg" value="${curOuterBg}" style="width: 44px; height: 32px; border: none; background: transparent; cursor: pointer;" />
        </div>
        <div class="setting-row" style="padding: 8px 0;">
          <div>
            <div class="setting-label">2. 플래시카드 · 박스 내부 배경색</div>
            <div class="setting-desc">집중도를 높이는 중앙 카드 배경 (다크 기본: #1e1e1e)</div>
          </div>
          <input type="color" id="set-colorCardBg" value="${curCardBg}" style="width: 44px; height: 32px; border: none; background: transparent; cursor: pointer;" />
        </div>
        <div class="setting-row" style="padding: 8px 0;">
          <div>
            <div class="setting-label">3. 기본 UI 글자색</div>
            <div class="setting-desc">홈 화면, 설정, 일반 안내 텍스트 (다크 기본: #d4d4d4)</div>
          </div>
          <input type="color" id="set-colorBaseText" value="${curBaseText}" style="width: 44px; height: 32px; border: none; background: transparent; cursor: pointer;" />
        </div>
        <div class="setting-row" style="padding: 8px 0;">
          <div>
            <div class="setting-label">4. 학습 시 앞면(단어) 글자색</div>
            <div class="setting-desc">플래시카드 문제 단어 색상 (다크 기본: #9cdcfe)</div>
          </div>
          <input type="color" id="set-colorWordText" value="${curWordText}" style="width: 44px; height: 32px; border: none; background: transparent; cursor: pointer;" />
        </div>
        <div class="setting-row" style="padding: 8px 0;">
          <div>
            <div class="setting-label">5. 학습 시 뒷면(뜻) 글자색</div>
            <div class="setting-desc">정답 확인 시 뜻 텍스트 색상 (다크 기본: #4fc1ff)</div>
          </div>
          <input type="color" id="set-colorMeaningText" value="${curMeaningText}" style="width: 44px; height: 32px; border: none; background: transparent; cursor: pointer;" />
        </div>
        <div class="setting-row" style="padding: 8px 0; border-bottom: none;">
          <div>
            <div class="setting-label">6. 핵심 강조(**강조** · 빈칸) 글자색</div>
            <div class="setting-desc">예문 타겟 단어 및 강조 구문 색상 (다크 기본: #dcdcaa)</div>
          </div>
          <input type="color" id="set-colorHighlightText" value="${curHighlightText}" style="width: 44px; height: 32px; border: none; background: transparent; cursor: pointer;" />
        </div>
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
          <h3 style="margin: 0; font-size: 17px;">⚙️ 상세 학습 설정</h3>
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
            기본값 복원
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

  const isFsrs = settings.schedulerEngine === 'fsrs';

  if (activeSettingsTab === 'new') {
    settings.newCardOrder = (getVal('set-newCardOrder') as AnkiSettings['newCardOrder']) || 'sequential';
    settings.newCardsPerDay = getNum('set-newCardsPerDay', 20);
    if (!isFsrs) {
      settings.learningSteps = getVal('set-learningSteps') || '2 10';
      settings.graduatingInterval = getNum('set-graduatingInterval', 1);
      settings.easyInterval = getNum('set-easyInterval', 4);
      settings.startingEase = getNum('set-startingEase', 250);
    }
  } else if (activeSettingsTab === 'review') {
    const selectedEngine = (getVal('set-schedulerEngine') as 'fsrs' | 'sm2') || settings.schedulerEngine;
    settings.schedulerEngine = selectedEngine;
    if (selectedEngine === 'fsrs') {
      const retentionPct = getNum('set-desiredRetention', 90);
      settings.desiredRetention = Math.min(0.97, Math.max(0.70, retentionPct / 100));
      settings.fsrsInheritProgress = getChk('set-fsrsInheritProgress', true);
    } else {
      settings.easyBonus = getNum('set-easyBonus', 130);
      settings.intervalModifier = getNum('set-intervalModifier', 100);
      settings.hardInterval = getNum('set-hardInterval', 120);
    }
    settings.maxReviewsPerDay = getNum('set-maxReviewsPerDay', 9999);
    settings.maxInterval = getNum('set-maxInterval', 180);
  } else if (activeSettingsTab === 'lapse') {
    settings.leechThreshold = getNum('set-leechThreshold', 8);
    settings.leechAction = (getVal('set-leechAction') as AnkiSettings['leechAction']) || 'tag';
    if (!isFsrs) {
      settings.relearningSteps = getVal('set-relearningSteps') || '10';
      settings.newIntervalPercent = getNum('set-newIntervalPercent', 0);
      settings.minInterval = getNum('set-minInterval', 1);
    }
  } else if (activeSettingsTab === 'general') {
    settings.maxAnswerSeconds = getNum('set-maxAnswerSeconds', 60);
    settings.showTimer = getChk('set-showTimer', true);
    settings.autoPlayAudio = getChk('set-autoPlayAudio', false);
    settings.replayQuestionAudio = getChk('set-replayQuestionAudio', false);
  } else if (activeSettingsTab === 'display') {
    settings.viewMode = (getVal('set-viewMode') as AnkiSettings['viewMode']) || settings.viewMode;
    settings.themeMode = (getVal('set-themeMode') as AnkiSettings['themeMode']) || settings.themeMode;
    const defaults = getDefaultColorsForTheme(settings.themeMode);
    settings.colorOuterBg = getVal('set-colorOuterBg') || defaults.colorOuterBg;
    settings.colorCardBg = getVal('set-colorCardBg') || defaults.colorCardBg;
    settings.colorBaseText = getVal('set-colorBaseText') || defaults.colorBaseText;
    settings.colorWordText = getVal('set-colorWordText') || defaults.colorWordText;
    settings.colorMeaningText = getVal('set-colorMeaningText') || defaults.colorMeaningText;
    settings.colorHighlightText = getVal('set-colorHighlightText') || defaults.colorHighlightText;
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

  // 🔄 FSRS <-> SM-2 엔진 변경 시 즉시 SM-2 전용 설정 잠금/해제 반영
  document.getElementById('set-schedulerEngine')?.addEventListener('change', (e) => {
    const newEngine = (e.target as HTMLSelectElement).value as 'fsrs' | 'sm2';
    collectCurrentTabInputs();
    settings.schedulerEngine = newEngine;
    saveSettings(settings);
    render();
  });

  // 🎨 다크 <-> 라이트 테마 변경 시 해당 모드의 기본 색상 팔레트로 자동 세팅
  document.getElementById('set-themeMode')?.addEventListener('change', (e) => {
    const newTheme = (e.target as HTMLSelectElement).value as 'dark' | 'light';
    const modeColors = getDefaultColorsForTheme(newTheme);
    settings.themeMode = newTheme;
    settings.colorOuterBg = modeColors.colorOuterBg;
    settings.colorCardBg = modeColors.colorCardBg;
    settings.colorBaseText = modeColors.colorBaseText;
    settings.colorWordText = modeColors.colorWordText;
    settings.colorMeaningText = modeColors.colorMeaningText;
    settings.colorHighlightText = modeColors.colorHighlightText;
    saveSettings(settings);
    render();
  });

  const closeAndSave = () => {
    collectCurrentTabInputs();
    isSettingsModalOpen = false;
    render();
  };

  document.getElementById('settings-modal-overlay')?.addEventListener('click', closeAndSave);
  document.getElementById('btn-close-modal-x')?.addEventListener('click', closeAndSave);
  document.getElementById('btn-save-settings')?.addEventListener('click', closeAndSave);

  // 🔄 기본값 복원: 현재 모드(다크/라이트) 및 화면 크기(PC/모바일)는 유지하면서 해당 모드의 기본 색상 + 학습 가중치 복원
  document.getElementById('btn-restore-defaults')?.addEventListener('click', () => {
    const themeSelect = document.getElementById('set-themeMode') as HTMLSelectElement | null;
    const viewSelect = document.getElementById('set-viewMode') as HTMLSelectElement | null;
    const currentTheme = (themeSelect?.value as 'dark' | 'light') || settings.themeMode;
    const currentView = (viewSelect?.value as 'pc' | 'mobile') || settings.viewMode;

    if (confirm(`현재 모드(${currentTheme === 'dark' ? '다크 모드' : '라이트 모드'})를 유지한 상태로 모든 색상과 학습 설정을 기본값으로 복원하시겠습니까?`)) {
      const modeColors = getDefaultColorsForTheme(currentTheme);
      saveSettings({
        ...DEFAULT_ANKI_SETTINGS,
        viewMode: currentView,
        themeMode: currentTheme,
        ...modeColors,
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
// 1. 메인 대시보드 화면 (잔디밭 + 7일 달력 + 덱 이름 수정/상단 고정 포함)
// =========================================================
async function renderDashboard(): Promise<void> {
  clearSwipeListener();
  stopAutoPlay();
  const data = await api.getStorageData();

  let totalCardsCount = 0;
  let totalDueTodayCount = 0;

  const deckListHtml = data.decks
    .map((deck: Deck, idx: number) => {
      const totalCards = deck.cards.length;
      const { queue, dueNewCount, dueRevCount } = buildDailyStudyQueue(deck, data.logs);
      const dueTotal = queue.length;

      totalCardsCount += totalCards;
      totalDueTodayCount += dueTotal;

      return `
        <div class="deck-item">
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <strong style="font-size: 16px; word-break: break-all;">📁 ${escapeHtml(deck.name)}</strong>
              <button type="button" class="btn-rename-deck" data-id="${deck.id}" style="background:transparent; padding:2px 5px; font-size:12px; opacity:0.65;" title="단어장 이름 수정">✏️</button>
              ${idx > 0 ? `<button type="button" class="btn-pin-deck" data-id="${deck.id}" style="background:transparent; padding:2px 5px; font-size:12px; opacity:0.65;" title="맨 위로 올리기">📌</button>` : ''}
            </div>
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
        <div style="display: flex; align-items: center; gap: 10px;">
          <img src="./charmander.svg" alt="단어 해결사" style="width: 38px; height: 38px; image-rendering: pixelated; object-fit: contain;" />
          <div>
            <h2 style="margin: 0; font-size: 20px; font-weight: 800; letter-spacing: -0.5px;">단어 해결사</h2>
            <div style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">
              일일 목표: 새 카드 ${settings.newCardsPerDay}장 / 복습 ${settings.maxReviewsPerDay}장
            </div>
          </div>
        </div>
        <button id="btn-open-settings" class="icon-circle-btn" title="상세 설정">⚙️</button>
      </div>

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
          <div class="stat-action-hint">오늘 학습·대기 리스트 ➔</div>
        </div>
        <div class="stat-card stat-card-interactive" id="btn-stat-starred">
          <div class="stat-label">⭐ 중요 표시</div>
          <div class="stat-value" style="color: #84cc16;">${starredCardIds.size}</div>
          <div class="stat-action-hint">별표 단어장·집중 복습 ➔</div>
        </div>
      </div>

      <!-- 🌱 Anki 잔디밭(12주) & 📅 향후 7일 복습 예보 달력 -->
      ${buildHeatmapAndForecastHtml(data)}

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

  document.getElementById('btn-stat-all-cards')?.addEventListener('click', () => {
    triggerHaptic(12);
    isAllCardsModalOpen = true;
    render();
  });

  document.getElementById('btn-stat-today-quota')?.addEventListener('click', () => {
    triggerHaptic(12);
    currentSubPage = 'today-quota';
    render();
  });

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

  // ✏️ 단어장 이름 즉시 변경
  document.querySelectorAll<HTMLButtonElement>('.btn-rename-deck').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id!;
      const target = data.decks.find(d => d.id === id);
      if (!target) return;
      const newName = prompt('새 단어장 이름을 입력하세요:', target.name)?.trim();
      if (newName && newName !== target.name) {
        target.name = newName;
        await api.importStorageData(data);
        await render();
      }
    });
  });

  // 📌 단어장 맨 위로 고정(순서 올리기)
  document.querySelectorAll<HTMLButtonElement>('.btn-pin-deck').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id!;
      const idx = data.decks.findIndex(d => d.id === id);
      if (idx > 0) {
        const [moved] = data.decks.splice(idx, 1);
        data.decks.unshift(moved);
        await api.importStorageData(data);
        triggerHaptic(12);
        await render();
      }
    });
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
      manageSearchQuery = '';
      isAddCardAccordionOpen = false;
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

      studySessionSnapshot = JSON.parse(JSON.stringify(freshData));
      saveProgressOnQuit = true;
      undoHistoryStack = [];
      sessionResultsMap.clear();
      resultFilterTab = 'all';

      isStarCramMode = false;
      studyingDeckId = id;
      studyQueue = queue;
      currentCardIndex = 0;
      isAnswerRevealed = false;
      determineCardDirection();
      triggerReactionBadge('Let’s go 🔥');
      await render();
      if (settings.autoPlayAudio && studyQueue[0]) {
        speakText(currentCardReversed ? studyQueue[0].back : studyQueue[0].front);
      }
    });
  });
}

// =========================================================
// 2. 단어 관리 화면 (UI/UX 개선 1: 새 단어 추가 폼 아코디언 접기/펼치기 탑재)
// =========================================================
async function renderDeckManage(deckId: string): Promise<void> {
  const data = await api.getStorageData();
  const deck = data.decks.find(d => d.id === deckId);
  if (!deck) { selectedDeckId = null; await renderDashboard(); return; }

  // 카드가 0개일 때는 자동으로 추가 폼을 열어둠
  if (deck.cards.length === 0) isAddCardAccordionOpen = true;

  const validIds = new Set(deck.cards.map(c => c.id));
  selectedCardIds.forEach(id => { if (!validIds.has(id)) selectedCardIds.delete(id); });

  const now = new Date();
  const q = manageSearchQuery.trim().toLowerCase();
  const filteredCards = q
    ? deck.cards.filter(c =>
        c.front.toLowerCase().includes(q) ||
        c.back.toLowerCase().includes(q) ||
        (c.example && c.example.toLowerCase().includes(q))
      )
    : deck.cards;

  const cardRowsHtml = filteredCards
    .map((card, idx) => {
      const dueBadgeText = SM2Scheduler.formatDueBadge(card, now);
      const isDueNow = SM2Scheduler.isDue(card, now) && card.state !== 'new';
      const badgeClass = card.state === 'new' ? 'tag-new' : (isDueNow ? 'tag-due-now' : 'tag-due-later');
      const lastReviewedStr = SM2Scheduler.formatLastReviewed(card);
      const m = getCardMasteryInfo(card);
      const isStar = starredCardIds.has(card.id);
      const isSelected = selectedCardIds.has(card.id);

      return `
        <div class="deck-item selectable-card-item ${isSelected ? 'selected-row' : ''}" data-card-id="${card.id}" data-idx="${idx}">
          <input type="checkbox" class="card-checkbox" data-card-id="${card.id}" ${isSelected ? 'checked' : ''} />
          ${card.imageData ? `<img src="${card.imageData}" class="manage-card-thumb" alt="card image" onerror="this.style.display='none'" />` : ''}
          <div style="flex: 1; min-width: 0;">
            <div style="margin-bottom: 5px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center;">
              <span class="tag-badge ${badgeClass}">${dueBadgeText}</span>
              <span class="ez-badge ${m.levelClass}">${m.levelText}</span>
              ${card.isLeech ? `<span class="tag-badge tag-leech">🩸 거머리(${card.lapses}회 실패)</span>` : ''}
            </div>
            <div style="word-break: break-all; font-size: 15px;">
              <strong>Q:</strong> ${formatRichText(card.front, true)}
            </div>
            <div style="color: var(--sector-meaning-color); margin-top: 3px; word-break: break-all; font-size: 14px;">
              <strong>A:</strong> ${formatRichText(card.back, true)}
            </div>
            ${card.example ? `
              <div style="color: var(--text-secondary); font-size: 12.5px; margin-top: 4px; font-style: italic; word-break: break-all;">
                💬 "${formatRichText(card.example, true, card.front)}"
              </div>
            ` : ''}
            <div class="deck-stats" style="margin-top: 6px;">
              🕒 최근 학습: <b>${lastReviewedStr}</b> · 간격: <b>${card.interval}일</b>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;" onclick="event.stopPropagation();">
            <label class="btn-secondary" style="padding: 6px 9px; font-size: 12px; cursor: pointer; border-radius: 8px;" title="이 단어에 사진 넣기/변경">
              📷
              <input type="file" class="input-single-card-img" data-card-id="${card.id}" accept="image/*" style="display: none;" />
            </label>
            <button class="btn-manage-star" data-card-id="${card.id}" title="중요 단어 별표" style="background: transparent; font-size: 23px; padding: 2px 6px; color: ${isStar ? '#84cc16' : 'var(--text-secondary)'};">
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

      <!-- 📂 아코디언(접기/펼치기) 새 단어 추가 박스 -->
      <div class="card-box">
        <div class="accordion-toggle-bar" id="btn-toggle-add-accordion">
          <div>
            <h4 style="margin: 0; font-size: 15px;">
              ${isAddCardAccordionOpen ? '🔼 새 단어 추가 폼 접기' : '➕ 새 단어·예문·사진 추가하기 (클릭하여 펼치기 ▼)'}
            </h4>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;" onclick="event.stopPropagation();">
            <label class="btn-secondary" style="font-size: 12px; padding: 7px 12px; cursor: pointer; border-radius: 10px;">
              📂 CSV 대량 등록
              <input type="file" id="input-csv-file" accept=".csv, .tsv, .txt" style="display: none;" />
            </label>
          </div>
        </div>

        ${isAddCardAccordionOpen ? `
          <div style="margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border-color);">
            <div style="font-size: 11.5px; color: var(--text-secondary); margin-bottom: 10px;">
              💡 <b>**중요**</b>는 강조체, <b>{{정답}}</b>은 빈칸 문제, 예문 속 영단어는 자동으로 하이라이트됩니다.
            </div>
            <div class="form-row">
              <input type="text" id="input-card-front" placeholder="앞면: 단어 또는 {{빈칸}} 문장 (예: tow)" value="${escapeHtml(draftFrontText)}" />
              <input type="text" id="input-card-back" placeholder="뒷면: 뜻 (예: **견인**하다)" value="${escapeHtml(draftBackText)}" />
            </div>

            <div style="margin-bottom: 10px;">
              <input type="text" id="input-card-example" placeholder="💬 예문 (선택, 예: The car needed a tow.)" value="${escapeHtml(draftExampleText)}" />
            </div>

            <div class="image-upload-zone" id="image-drop-zone" tabindex="0" style="outline: none;">
              <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                ${pendingCardImageData ? `
                  <img src="${pendingCardImageData}" class="image-preview-thumb" style="width: 64px; height: 64px;" alt="preview" />
                  <div>
                    <div style="color: #10b981; font-weight: 700; font-size: 13.5px;">✅ 이미지 준비 완료!</div>
                    <div style="font-size: 11.5px; color: var(--text-secondary);">새 카드로 등록하거나 아래 체크된 단어에 바로 적용할 수 있습니다.</div>
                  </div>
                ` : `
                  <span>🖼️ <b>사진 첨부:</b> 화면 어디서든 <b>Ctrl + V</b>를 누르면 클립보드 이미지가 즉시 들어갑니다!</span>
                `}
              </div>
              <div style="display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap;">
                ${pendingCardImageData && selectedCardIds.size > 0 ? `
                  <button type="button" id="btn-apply-img-selected" class="btn-primary" style="background: #10b981; padding: 7px 12px; font-size: 12px;">
                    🎯 선택된 ${selectedCardIds.size}개 단어에 이 사진 적용
                  </button>
                ` : ''}
                ${pendingCardImageData ? `
                  <button type="button" id="btn-clear-img" class="btn-danger" style="padding: 6px 10px; font-size: 12px;">사진 비우기</button>
                ` : ''}
                <label class="btn-secondary" style="padding: 7px 12px; font-size: 12px; cursor: pointer; border-radius: 8px;">
                  📷 파일 선택
                  <input type="file" id="input-card-image" accept="image/*" style="display: none;" />
                </label>
              </div>
            </div>

            <button id="btn-add-card" class="btn-primary" style="width: 100%; padding: 13px;">➕ 새 단어로 카드 등록</button>
          </div>
        ` : ''}
      </div>

      <div class="card-box" style="flex: 1;">
        <div class="search-input-wrap">
          <span class="search-icon-prefix">🔍</span>
          <input type="text" id="input-manage-search" placeholder="등록된 단어, 뜻, 예문 실시간 검색..." value="${escapeHtml(manageSearchQuery)}" />
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" id="chk-select-all-master" class="card-checkbox" ${deck.cards.length > 0 && selectedCardIds.size === deck.cards.length ? 'checked' : ''} />
            <div>
              <h4 style="margin: 0; font-size: 15px;">🗂️ 전체 선택 / 등록된 카드 (${filteredCards.length} / ${deck.cards.length}개)</h4>
              <div style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">
                💡 클릭하여 개별 선택하거나, <b>0.3초 이상 꾹 누른 채 드래그</b>하면 범위가 선택됩니다.
              </div>
            </div>
          </label>
          ${deck.cards.length > 0 ? `
            <button id="btn-select-all-cards" class="btn-secondary" style="font-size: 11.5px; padding: 6px 12px;">
              ${selectedCardIds.size === deck.cards.length ? '전체 해제' : '전체 선택'}
            </button>
          ` : ''}
        </div>

        ${selectedCardIds.size > 0 ? `
          <div class="bulk-action-bar">
            <div style="font-size: 13.5px; font-weight: 700; color: var(--accent-blue);">
              ☑️ ${selectedCardIds.size}개 단어 선택됨
            </div>
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
              <label class="btn-primary" style="padding: 7px 12px; font-size: 12px; cursor: pointer; border-radius: 8px;">
                🖼️ 선택 단어에 사진 파일 넣기
                <input type="file" id="input-bulk-image" accept="image/*" style="display: none;" />
              </label>
              <button id="btn-bulk-delete" class="btn-danger" style="padding: 7px 12px; font-size: 12px;">
                🗑️ 선택 삭제 (${selectedCardIds.size}개)
              </button>
            </div>
          </div>
        ` : ''}

        <div id="manage-card-list-container">
          ${cardRowsHtml || '<p style="color: var(--text-secondary); font-size: 14px;">일치하거나 등록된 카드가 없습니다.</p>'}
        </div>
      </div>
    </div>
    ${renderSettingsModalHtml()}
  `;

  document.getElementById('btn-toggle-add-accordion')?.addEventListener('click', () => {
    isAddCardAccordionOpen = !isAddCardAccordionOpen;
    render();
  });

  const searchEl = document.getElementById('input-manage-search') as HTMLInputElement | null;
  searchEl?.addEventListener('input', () => {
    const cursorPos = searchEl.selectionStart || 0;
    manageSearchQuery = searchEl.value;
    render().then(() => {
      const reFocused = document.getElementById('input-manage-search') as HTMLInputElement | null;
      if (reFocused) {
        reFocused.focus();
        reFocused.setSelectionRange(cursorPos, cursorPos);
      }
    });
  });

  const frontEl = document.getElementById('input-card-front') as HTMLInputElement | null;
  const backEl = document.getElementById('input-card-back') as HTMLInputElement | null;
  const exEl = document.getElementById('input-card-example') as HTMLInputElement | null;
  frontEl?.addEventListener('input', () => { draftFrontText = frontEl.value; });
  backEl?.addEventListener('input', () => { draftBackText = backEl.value; });
  exEl?.addEventListener('input', () => { draftExampleText = exEl.value; });

  document.getElementById('btn-open-settings')?.addEventListener('click', () => {
    isSettingsModalOpen = true;
    render();
  });
  attachSettingsModalEvents();

  const goBackToDashboard = () => {
    clearSwipeListener();
    document.onpaste = null;
    pendingCardImageData = undefined;
    selectedCardIds.clear();
    selectedDeckId = null;
    render();
  };

  document.getElementById('btn-back')?.addEventListener('click', goBackToDashboard);
  attachSwipeBackListener(goBackToDashboard);

  // Ctrl+V 이미지 붙여넣기 시 아코디언이 닫혀 있어도 자동으로 열어주며 첨부!
  document.onpaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.indexOf('image') !== -1) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          isAddCardAccordionOpen = true;
          pendingCardImageData = await compressImageToDataUrl(blob);
          triggerHaptic(15);
          await render();
          break;
        }
      }
    }
  };

  const imgInput = document.getElementById('input-card-image') as HTMLInputElement | null;
  imgInput?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    pendingCardImageData = await compressImageToDataUrl(file);
    await render();
  });

  document.getElementById('btn-clear-img')?.addEventListener('click', () => {
    pendingCardImageData = undefined;
    render();
  });

  document.getElementById('btn-apply-img-selected')?.addEventListener('click', async () => {
    if (!pendingCardImageData || selectedCardIds.size === 0) return;
    for (const cardId of selectedCardIds) {
      await api.updateCard(deck.id, cardId, { imageData: pendingCardImageData });
    }
    alert(`🎉 선택된 ${selectedCardIds.size}개 단어에 사진이 적용되었습니다!`);
    pendingCardImageData = undefined;
    selectedCardIds.clear();
    await render();
  });

  const bulkImgInput = document.getElementById('input-bulk-image') as HTMLInputElement | null;
  bulkImgInput?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file || selectedCardIds.size === 0) return;
    const compressed = await compressImageToDataUrl(file);
    for (const cardId of selectedCardIds) {
      await api.updateCard(deck.id, cardId, { imageData: compressed });
    }
    alert(`🎉 선택된 ${selectedCardIds.size}개 단어에 사진이 적용되었습니다!`);
    selectedCardIds.clear();
    await render();
  });

  document.querySelectorAll<HTMLInputElement>('.input-single-card-img').forEach(input => {
    input.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      const cardId = input.dataset.cardId!;
      if (!file || !cardId) return;
      const compressed = await compressImageToDataUrl(file);
      await api.updateCard(deck.id, cardId, { imageData: compressed });
      await render();
    });
  });

  const toggleSelectAll = () => {
    if (selectedCardIds.size === deck.cards.length) {
      selectedCardIds.clear();
    } else {
      deck.cards.forEach(c => selectedCardIds.add(c.id));
    }
    render();
  };
  document.getElementById('btn-select-all-cards')?.addEventListener('click', toggleSelectAll);
  document.getElementById('chk-select-all-master')?.addEventListener('change', toggleSelectAll);

  document.getElementById('btn-bulk-delete')?.addEventListener('click', async () => {
    if (selectedCardIds.size === 0) return;
    if (confirm(`선택한 ${selectedCardIds.size}개의 단어를 삭제하시겠습니까?`)) {
      for (const cardId of [...selectedCardIds]) {
        await api.deleteCard(deck.id, cardId);
      }
      selectedCardIds.clear();
      await render();
    }
  });

  const rowElements = Array.from(document.querySelectorAll<HTMLElement>('.selectable-card-item'));
  let isLongPressDragActive = false;
  let dragStartIndex = -1;
  let dragTargetSelectState = true;
  let holdTimer: number | null = null;

  const applyRangeSelectionUI = (currentIndex: number) => {
    if (!isLongPressDragActive || dragStartIndex === -1) return;
    const start = Math.min(dragStartIndex, currentIndex);
    const end = Math.max(dragStartIndex, currentIndex);
    for (let i = start; i <= end; i++) {
      const row = rowElements[i];
      const id = row?.dataset.cardId;
      if (!id) continue;
      if (dragTargetSelectState) selectedCardIds.add(id);
      else selectedCardIds.delete(id);
      row.classList.toggle('selected-row', dragTargetSelectState);
      const chk = row.querySelector<HTMLInputElement>('.card-checkbox');
      if (chk) chk.checked = dragTargetSelectState;
    }
  };

  const stopHoldAndDrag = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (isLongPressDragActive) {
      isLongPressDragActive = false;
      dragStartIndex = -1;
      render();
    }
  };

  rowElements.forEach((row, idx) => {
    const cardId = row.dataset.cardId!;
    const checkbox = row.querySelector<HTMLInputElement>('.card-checkbox');

    checkbox?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (checkbox.checked) selectedCardIds.add(cardId);
      else selectedCardIds.delete(cardId);
      render();
    });

    row.addEventListener('click', (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'BUTTON' || tag === 'LABEL' || tag === 'INPUT') return;
      if (isLongPressDragActive) return;

      if (selectedCardIds.has(cardId)) selectedCardIds.delete(cardId);
      else selectedCardIds.add(cardId);
      render();
    });

    row.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'BUTTON' || tag === 'LABEL' || tag === 'INPUT') return;

      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = window.setTimeout(() => {
        isLongPressDragActive = true;
        dragStartIndex = idx;
        dragTargetSelectState = !selectedCardIds.has(cardId);
        triggerHaptic(20);
        applyRangeSelectionUI(idx);
      }, 300);
    });

    row.addEventListener('mouseenter', () => {
      if (isLongPressDragActive) {
        applyRangeSelectionUI(idx);
      }
    });

    row.addEventListener('touchstart', () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = window.setTimeout(() => {
        isLongPressDragActive = true;
        dragStartIndex = idx;
        dragTargetSelectState = !selectedCardIds.has(cardId);
        triggerHaptic(25);
        applyRangeSelectionUI(idx);
      }, 300);
    }, { passive: true });

    row.addEventListener('touchmove', (e: TouchEvent) => {
      if (!isLongPressDragActive) {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        return;
      }
      e.preventDefault();
      const touch = e.touches[0];
      const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
      const targetRow = targetEl?.closest<HTMLElement>('.selectable-card-item');
      if (targetRow && targetRow.dataset.idx !== undefined) {
        applyRangeSelectionUI(Number(targetRow.dataset.idx));
      }
    }, { passive: false });
  });

  window.onmouseup = stopHoldAndDrag;
  window.ontouchend = stopHoldAndDrag;

  document.getElementById('btn-add-card')?.addEventListener('click', async () => {
    const front = (document.getElementById('input-card-front') as HTMLInputElement).value.trim();
    const back = (document.getElementById('input-card-back') as HTMLInputElement).value.trim();
    const example = (document.getElementById('input-card-example') as HTMLInputElement).value.trim();
    if (!front || !back) return alert('앞면(단어)과 뒷면(뜻)을 입력해주세요!');

    await api.addCard(deck.id, front, back, settings.startingEase, example || undefined, pendingCardImageData);
    draftFrontText = '';
    draftBackText = '';
    draftExampleText = '';
    pendingCardImageData = undefined;
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
        await api.addCard(deck.id, item.front, item.back, settings.startingEase, item.example);
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
      selectedCardIds.delete(cardId);
      await api.deleteCard(deck.id, cardId);
      await render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.btn-manage-star').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleStarCard(btn.dataset.cardId!);
      render();
    });
  });
}

// =========================================================
// 3. 플래시카드 학습룸 (양방향 + 스펠링 타이핑 + 오토플레이 + 사진 줌 + 예문 자동하이라이트)
// =========================================================
async function renderStudyRoom(): Promise<void> {
  if (currentCardIndex >= studyQueue.length) {
    stopCardTimer();
    stopAutoPlay();
    clearSwipeListener();

    const freshData = await api.getStorageData();
    const uniqueCardMap = new Map<string, Card>();
    studyQueue.forEach(qCard => {
      for (const d of freshData.decks) {
        const found = d.cards.find(c => c.id === qCard.id);
        if (found) {
          uniqueCardMap.set(found.id, found);
          break;
        }
      }
      if (!uniqueCardMap.has(qCard.id)) uniqueCardMap.set(qCard.id, qCard);
    });

    const allStudiedCards = [...uniqueCardMap.values()];
    const wrongCards = allStudiedCards.filter(c => sessionResultsMap.get(c.id) === 'wrong');
    const correctCards = allStudiedCards.filter(c => sessionResultsMap.get(c.id) !== 'wrong');
    const accuracyPct = allStudiedCards.length > 0
      ? Math.round((correctCards.length / allStudiedCards.length) * 100)
      : 100;

    const displayedCards =
      resultFilterTab === 'wrong'
        ? wrongCards
        : resultFilterTab === 'correct'
        ? correctCards
        : allStudiedCards;

    const resultRowsHtml = displayedCards
      .map(card => {
        const isWrong = sessionResultsMap.get(card.id) === 'wrong';
        const isStar = starredCardIds.has(card.id);

        return `
          <div class="deck-item" style="align-items: center;">
            ${card.imageData ? `<img src="${card.imageData}" class="manage-card-thumb" alt="thumb" onerror="this.style.display='none'" />` : ''}
            <div style="flex: 1; min-width: 0; text-align: left;">
              <div style="margin-bottom: 4px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
                <span class="tag-badge ${isWrong ? 'tag-due-now' : 'tag-new'}">
                  ${isWrong ? '❌ 오답 (다시 봄)' : '⭕ 정답 (암기 통과)'}
                </span>
                <span style="font-size: 11px; color: var(--text-secondary);">다음 스케줄: ${SM2Scheduler.formatDueBadge(card)}</span>
              </div>
              <div style="font-size: 15px; word-break: break-all;">
                <strong>Q:</strong> ${formatRichText(card.front, true)}
              </div>
              <div style="color: var(--sector-meaning-color); font-size: 14px; margin-top: 2px; word-break: break-all;">
                <strong>A:</strong> ${formatRichText(card.back, true)}
              </div>
              ${card.example ? `
                <div style="font-size: 12px; color: var(--text-secondary); margin-top: 3px; font-style: italic;">
                  💬 "${formatRichText(card.example, true, card.front)}"
                </div>
              ` : ''}
            </div>

            <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
              <label class="btn-secondary" style="padding: 6px 9px; font-size: 12px; cursor: pointer; border-radius: 8px;" title="이 단어에 사진 등록/변경">
                📷
                <input type="file" class="result-card-img-input" data-deck-id="${card.deckId}" data-card-id="${card.id}" accept="image/*" style="display: none;" />
              </label>
              <button type="button" class="btn-secondary btn-result-edit" data-card-id="${card.id}" style="padding: 6px 10px; font-size: 12px; border-radius: 8px;">
                ✏️ 수정
              </button>
              <button type="button" class="btn-result-star" data-card-id="${card.id}" style="background: transparent; font-size: 22px; padding: 2px 6px; color: ${isStar ? '#84cc16' : 'var(--text-secondary)'};">
                ${isStar ? '★' : '☆'}
              </button>
            </div>
          </div>
        `;
      })
      .join('');

    const targetEdit = editingCardTarget || allStudiedCards[0];

    appElement!.innerHTML = `
      <div class="container">
        <div class="header">
          <div>
            <h2 style="margin: 0; font-size: 20px;">📊 학습 결과 리포트</h2>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
              오늘 학습한 단어의 정답·오답 내역을 확인하고, 부족한 단어만 바로 자유 복습하거나 사진·뜻을 수정하세요!
            </div>
          </div>
          <button id="btn-finish-study" class="btn-primary" style="padding: 10px 18px;">🏠 대시보드로 완료</button>
        </div>

        <div class="stats-grid">
          <div class="stat-card stat-card-interactive" id="tab-filter-all" style="${resultFilterTab === 'all' ? 'border-color: var(--accent-blue);' : ''}">
            <div class="stat-label">🎯 전체 학습 (정답률 ${accuracyPct}%)</div>
            <div class="stat-value">${allStudiedCards.length}장</div>
            <div class="stat-action-hint">클릭하여 전체 보기</div>
          </div>
          <div class="stat-card stat-card-interactive" id="tab-filter-correct" style="${resultFilterTab === 'correct' ? 'border-color: #10b981;' : ''}">
            <div class="stat-label">⭕ 맞힌 단어 (정답)</div>
            <div class="stat-value" style="color: #10b981;">${correctCards.length}장</div>
            <div class="stat-action-hint">클릭하여 정답만 보기</div>
          </div>
          <div class="stat-card stat-card-interactive" id="tab-filter-wrong" style="${resultFilterTab === 'wrong' ? 'border-color: #f43f5e;' : ''}">
            <div class="stat-label">❌ 틀린 단어 (오답)</div>
            <div class="stat-value" style="color: #f43f5e;">${wrongCards.length}장</div>
            <div class="stat-action-hint">클릭하여 오답만 보기</div>
          </div>
        </div>

        <div class="card-box" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div>
            <h4 style="margin: 0; font-size: 15px;">⚡ SM-2 제외 순수 플래시카드 바로 복습</h4>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
              기존 복습 주기를 건드리지 않고, 틀린 단어나 맞힌 단어만 카드 형태로 가볍게 다시 테스트합니다.
            </div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button type="button" id="btn-cram-wrong-only" class="btn-danger" style="padding: 10px 16px; font-size: 13.5px;" ${wrongCards.length === 0 ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''}>
              🔥 오답만 바로 복습 (${wrongCards.length}장)
            </button>
            <button type="button" id="btn-cram-correct-only" class="btn-primary" style="background: #10b981; padding: 10px 16px; font-size: 13.5px;" ${correctCards.length === 0 ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''}>
              ✅ 정답만 다시 복습 (${correctCards.length}장)
            </button>
            ${wrongCards.length > 0 ? `
              <button type="button" id="btn-star-all-wrong" class="btn-secondary" style="padding: 10px 14px; font-size: 12.5px;">
                ⭐ 오답 전체 별표 찍기
              </button>
            ` : ''}
          </div>
        </div>

        <div class="card-box" style="flex: 1;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <h4 style="margin: 0; font-size: 15px;">
              🗂️ ${resultFilterTab === 'wrong' ? '❌ 오답 단어 리스트' : resultFilterTab === 'correct' ? '⭕ 정답 단어 리스트' : '📋 전체 학습 단어 리스트'} (${displayedCards.length}개)
            </h4>
            <span style="font-size: 11.5px; color: var(--text-secondary);">💡 우측 📷 버튼으로 사진 추가, ✏️ 버튼으로 즉시 수정 가능</span>
          </div>
          <div style="max-height: 52dvh; overflow-y: auto;">
            ${resultRowsHtml || '<p style="color: var(--text-secondary); font-size: 14px; text-align: center; padding: 20px 0;">해당하는 단어가 없습니다.</p>'}
          </div>
        </div>
      </div>

      ${isEditCardModalOpen && targetEdit ? `
        <div class="modal-overlay" id="result-edit-overlay">
          <div class="modal-content" style="max-width: 460px;" onclick="event.stopPropagation();">
            <h3 style="margin: 0 0 12px 0; font-size: 17px;">✏️ 단어 및 사진 즉시 수정</h3>
            <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px;">
              <div>
                <label style="font-size: 12px; color: var(--text-secondary);">앞면 (단어 또는 {{빈칸}} 문장)</label>
                <input type="text" id="res-edit-front" value="${escapeHtml(targetEdit.front)}" style="margin-top: 4px;" />
              </div>
              <div>
                <label style="font-size: 12px; color: var(--text-secondary);">뒷면 (뜻, **강조** 가능)</label>
                <input type="text" id="res-edit-back" value="${escapeHtml(targetEdit.back)}" style="margin-top: 4px;" />
              </div>
              <div>
                <label style="font-size: 12px; color: var(--text-secondary);">예문 (선택)</label>
                <input type="text" id="res-edit-example" value="${escapeHtml(targetEdit.example || '')}" style="margin-top: 4px;" />
              </div>
            </div>
            <div style="display: flex; gap: 8px;">
              <button type="button" id="btn-res-edit-cancel" class="btn-secondary" style="flex: 1;">취소</button>
              <button type="button" id="btn-res-edit-save" class="btn-primary" style="flex: 1;">저장하기</button>
            </div>
          </div>
        </div>
      ` : ''}
    `;

    document.getElementById('tab-filter-all')?.addEventListener('click', () => { resultFilterTab = 'all'; render(); });
    document.getElementById('tab-filter-correct')?.addEventListener('click', () => { resultFilterTab = 'correct'; render(); });
    document.getElementById('tab-filter-wrong')?.addEventListener('click', () => { resultFilterTab = 'wrong'; render(); });

    document.getElementById('btn-finish-study')?.addEventListener('click', () => {
      studyingDeckId = null;
      isStarCramMode = false;
      sessionResultsMap.clear();
      resultFilterTab = 'all';
      render();
    });

    document.getElementById('btn-cram-wrong-only')?.addEventListener('click', async () => {
      if (wrongCards.length === 0) return;
      isStarCramMode = true;
      sessionResultsMap.clear();
      resultFilterTab = 'all';
      studyQueue = [...wrongCards].sort(() => Math.random() - 0.5);
      currentCardIndex = 0;
      isAnswerRevealed = false;
      determineCardDirection();
      triggerReactionBadge('오답 집중 복습 🔥');
      await render();
    });

    document.getElementById('btn-cram-correct-only')?.addEventListener('click', async () => {
      if (correctCards.length === 0) return;
      isStarCramMode = true;
      sessionResultsMap.clear();
      resultFilterTab = 'all';
      studyQueue = [...correctCards].sort(() => Math.random() - 0.5);
      currentCardIndex = 0;
      isAnswerRevealed = false;
      determineCardDirection();
      triggerReactionBadge('정답 확인 복습 ✅');
      await render();
    });

    document.getElementById('btn-star-all-wrong')?.addEventListener('click', () => {
      wrongCards.forEach(c => starredCardIds.add(c.id));
      localStorage.setItem(STARRED_CARDS_KEY, JSON.stringify([...starredCardIds]));
      triggerHaptic(18);
      alert(`오답 ${wrongCards.length}개 단어에 모두 ⭐ 별표가 표시되었습니다!`);
      render();
    });

    document.querySelectorAll<HTMLButtonElement>('.btn-result-star').forEach(btn => {
      btn.addEventListener('click', () => {
        toggleStarCard(btn.dataset.cardId!);
        render();
      });
    });

    document.querySelectorAll<HTMLInputElement>('.result-card-img-input').forEach(input => {
      input.addEventListener('change', async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        const cardId = input.dataset.cardId!;
        const deckId = input.dataset.deckId!;
        if (!file || !cardId || !deckId) return;
        const compressed = await compressImageToDataUrl(file);
        await api.updateCard(deckId, cardId, { imageData: compressed });
        const qTarget = studyQueue.find(c => c.id === cardId);
        if (qTarget) qTarget.imageData = compressed;
        await render();
      });
    });

    document.querySelectorAll<HTMLButtonElement>('.btn-result-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const cardId = btn.dataset.cardId!;
        editingCardTarget = allStudiedCards.find(c => c.id === cardId) || null;
        isEditCardModalOpen = true;
        render();
      });
    });

    const closeResEdit = () => {
      isEditCardModalOpen = false;
      editingCardTarget = null;
      render();
    };
    document.getElementById('result-edit-overlay')?.addEventListener('click', closeResEdit);
    document.getElementById('btn-res-edit-cancel')?.addEventListener('click', closeResEdit);
    document.getElementById('btn-res-edit-save')?.addEventListener('click', async () => {
      if (!targetEdit) return;
      const newFront = (document.getElementById('res-edit-front') as HTMLInputElement).value.trim();
      const newBack = (document.getElementById('res-edit-back') as HTMLInputElement).value.trim();
      const newEx = (document.getElementById('res-edit-example') as HTMLInputElement).value.trim();
      if (!newFront || !newBack) return alert('앞면과 뒷면을 모두 입력해주세요!');

      await api.updateCard(targetEdit.deckId, targetEdit.id, {
        front: newFront,
        back: newBack,
        example: newEx
      });
      const qTarget = studyQueue.find(c => c.id === targetEdit.id);
      if (qTarget) {
        qTarget.front = newFront;
        qTarget.back = newBack;
        qTarget.example = newEx || undefined;
      }
      isEditCardModalOpen = false;
      editingCardTarget = null;
      await render();
    });

    return;
  }

  const currentCard = studyQueue[currentCardIndex];
  const progressPercent = Math.round(((currentCardIndex + 1) / studyQueue.length) * 100);
  const isStarred = starredCardIds.has(currentCard.id);
  const previewLabels = SM2Scheduler.getPreviewLabels(currentCard, settings);

  // 🔄 양방향 학습 적용: currentCardReversed가 true이면 뜻을 먼저 보여주고 영단어를 맞힘!
  const questionText = currentCardReversed ? currentCard.back : currentCard.front;
  const answerText = currentCardReversed ? currentCard.front : currentCard.back;

  const ratingButtonsOrder: { rating: ReviewRating; label: string; isGood?: boolean }[] =
    settings.viewMode === 'pc'
      ? [
          { rating: 1, label: '다시' },
          { rating: 2, label: '어려움' },
          { rating: 3, label: '알맞음', isGood: true },
          { rating: 4, label: '쉬움' }
        ]
      : [
          { rating: 1, label: '다시' },
          { rating: 2, label: '어려움' },
          { rating: 4, label: '쉬움' },
          { rating: 3, label: '알맞음', isGood: true }
        ];

  const ratingButtonsHtml = ratingButtonsOrder
    .map(
      btn => `
        <div class="glass-btn-wrap">
          <span class="due-above-label">${previewLabels[btn.rating]}</span>
          <button class="btn-rate glass-pill-btn ${btn.isGood ? 'glass-good-accent' : ''}" data-rating="${btn.rating}">
            ${btn.label}
          </button>
        </div>
      `
    )
    .join('');

  // ⌨️ 타이핑 모드 정오답 글자 비교 렌더링
  let typingResultHtml = '';
  if (isTypingMode && isAnswerRevealed && lastTypedAttempt) {
    const cleanTarget = answerText.replace(/\*\*/g, '').replace(/\{\{|\}\}/g, '').trim();
    const isExactMatch = lastTypedAttempt.toLowerCase() === cleanTarget.toLowerCase();
    if (isExactMatch) {
      typingResultHtml = `<div class="typing-feedback char-correct">🎯 완벽합니다! (${escapeHtml(lastTypedAttempt)})</div>`;
    } else {
      const charsHtml = cleanTarget
        .split('')
        .map((ch, i) => {
          const typedCh = lastTypedAttempt[i] || '';
          const match = typedCh.toLowerCase() === ch.toLowerCase();
          return `<span class="${match ? 'char-correct' : 'char-wrong'}">${escapeHtml(ch)}</span>`;
        })
        .join('');
      typingResultHtml = `
        <div class="typing-feedback">
          <span style="font-size:12px; color:var(--text-secondary);">내 입력: ${escapeHtml(lastTypedAttempt)} ➔ 정답 비교: </span>
          ${charsHtml}
        </div>
      `;
    }
  }

  appElement!.innerHTML = `
    <div class="container">
      <div class="study-topbar">
        <div style="display: flex; gap: 8px;">
          <button id="btn-quit-study" class="icon-circle-btn" title="나가기">✕</button>
          <button id="btn-open-settings" class="icon-circle-btn" title="설정">⚙️</button>
          ${undoHistoryStack.length > 0 ? `
            <button id="btn-undo-card" class="icon-circle-btn" title="방금 카드 되돌리기 (Ctrl+Z)" style="font-size: 15px;">↩️</button>
          ` : ''}
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

      <!-- 🎛️ 학습 모드 컨트롤 칩 바 (양방향 전환 / 스펠링 타이핑 / 핸즈프리 자동재생) -->
      <div class="study-mode-toolbar">
        <button type="button" id="btn-cycle-direction" class="mode-chip-btn ${studyDirection !== 'front-to-back' ? 'active' : ''}">
          🔄 ${studyDirection === 'front-to-back' ? '단어 ➔ 뜻' : studyDirection === 'back-to-front' ? '뜻 ➔ 단어' : '앞·뒤 랜덤'}
        </button>
        <button type="button" id="btn-toggle-typing" class="mode-chip-btn ${isTypingMode ? 'active' : ''}">
          ⌨️ 스펠링 타이핑 ${isTypingMode ? 'ON' : 'OFF'}
        </button>
        <button type="button" id="btn-toggle-autoplay" class="mode-chip-btn ${isAutoPlayMode ? 'active' : ''}">
          ${isAutoPlayMode ? '⏸️ 자동재생 중' : '▶️ 자동재생'}
        </button>
      </div>

      <div class="study-box" id="study-card-body">
        <button id="btn-star-card" class="card-star-btn ${isStarred ? 'starred' : ''}">
          ${isStarred ? '★' : '☆'}
        </button>

        ${lastReactionText ? `
          <div class="card-reaction-badge" id="reaction-badge">
            ${lastReactionText}
          </div>
        ` : ''}

        <!-- 1. 정답 확인 시 상단 큰 사진 (클릭 시 전체화면 Lightbox 확대!) -->
        ${isAnswerRevealed && currentCard.imageData ? `
          <div class="study-top-image-wrap">
            <img src="${currentCard.imageData}" id="study-zoomable-img" class="study-top-image" title="클릭하여 크게 보기" alt="visual memory aid" onerror="this.parentElement.style.display='none'" />
          </div>
        ` : ''}

        <!-- 2. 중간: 질문 텍스트 -->
        <div class="study-question">${formatRichText(questionText, isAnswerRevealed)}</div>

        <!-- ⌨️ 타이핑 모드일 때 앞면에서 직접 입력하는 칸 -->
        ${isTypingMode && !isAnswerRevealed ? `
          <div class="typing-quiz-box" onclick="event.stopPropagation();">
            <input type="text" id="input-typing-answer" placeholder="정답을 타이핑 후 Enter..." autocomplete="off" />
            <button type="button" id="btn-submit-typing" class="btn-primary" style="padding: 10px 16px;">체크</button>
          </div>
        ` : ''}

        <!-- 3. 그 밑에 정답 & 4. 맨 밑에 예문 (예문 속 타겟 단어 자동 하이라이트 적용!) -->
        ${isAnswerRevealed ? `
          <div class="study-divider"></div>
          <div class="study-back-container">
            ${typingResultHtml}
            <div class="study-answer">${formatRichText(answerText, true)}</div>

            ${currentCard.example ? `
              <div class="study-divider" style="width: 55%; margin: 10px auto;"></div>
              <div class="study-example-box">
                <div class="study-example-text">💬 "${formatRichText(currentCard.example, true, currentCard.front)}"</div>
                <button type="button" id="btn-speak-example" class="icon-circle-btn" style="width: 32px; height: 32px; font-size: 14px; flex-shrink: 0;" title="예문 발음 듣기">🔉</button>
              </div>
            ` : ''}
          </div>
        ` : `
          <div class="tap-guide-hint">💡 카드를 클릭하거나 Space를 누르면 답이 보입니다</div>
        `}

        <button id="btn-speak-card" class="card-speaker-btn" title="발음 듣기">🔊</button>
      </div>

      <div class="study-footer-bar" style="justify-content: center;">
        ${!isAnswerRevealed ? `
          <div class="calm-bottom-bar" style="width: 100%;">
            <button id="btn-reveal" class="glass-pill-btn glass-reveal-btn">
              정답 확인 ${settings.viewMode === 'pc' ? '(Space)' : ''}
            </button>
          </div>
        ` : isStarCramMode ? `
          <div class="calm-bottom-bar" style="width: 100%;">
            <div class="glass-btn-wrap">
              <span class="due-above-label">세션 끝 재출제</span>
              <button id="btn-cram-retry" class="glass-pill-btn">🔄 다시 보기</button>
            </div>
            <div class="glass-btn-wrap">
              <span class="due-above-label">통과</span>
              <button id="btn-cram-pass" class="glass-pill-btn glass-good-accent">✅ 외웠음</button>
            </div>
          </div>
        ` : `
          <div class="calm-bottom-bar" style="width: 100%;">
            ${ratingButtonsHtml}
          </div>
        `}
      </div>
    </div>
    ${renderSettingsModalHtml()}

    <!-- 🔍 사진 전체화면 확대 Lightbox 모달 -->
    ${zoomedImageUrl ? `
      <div class="modal-overlay" id="lightbox-overlay" style="background: rgba(0,0,0,0.82); backdrop-filter: blur(6px);">
        <img src="${zoomedImageUrl}" class="lightbox-img" alt="zoomed" />
      </div>
    ` : ''}

    <!-- ✏️ 학습 중 즉시 카드 수정(Edit) 모달 -->
    ${isEditCardModalOpen ? `
      <div class="modal-overlay" id="edit-card-overlay">
        <div class="modal-content" style="max-width: 460px;" onclick="event.stopPropagation();">
          <h3 style="margin: 0 0 12px 0; font-size: 17px;">✏️ 현재 카드 즉시 수정 (Edit)</h3>
          <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px;">
            <div>
              <label style="font-size: 12px; color: var(--text-secondary);">앞면 (단어 또는 {{빈칸}} 문장)</label>
              <input type="text" id="edit-modal-front" value="${escapeHtml(currentCard.front)}" style="margin-top: 4px;" />
            </div>
            <div>
              <label style="font-size: 12px; color: var(--text-secondary);">뒷면 (뜻, **강조** 가능)</label>
              <input type="text" id="edit-modal-back" value="${escapeHtml(currentCard.back)}" style="margin-top: 4px;" />
            </div>
            <div>
              <label style="font-size: 12px; color: var(--text-secondary);">예문 (선택)</label>
              <input type="text" id="edit-modal-example" value="${escapeHtml(currentCard.example || '')}" style="margin-top: 4px;" />
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button type="button" id="btn-cancel-edit" class="btn-secondary" style="flex: 1;">취소</button>
            <button type="button" id="btn-save-edit" class="btn-primary" style="flex: 1;">저장 및 반영</button>
          </div>
        </div>
      </div>
    ` : ''}

    <!-- 🛑 ✕ 버튼 종료 확인 상자 -->
    ${isQuitConfirmModalOpen ? `
      <div class="modal-overlay" id="quit-confirm-overlay">
        <div class="modal-content" style="max-width: 380px; text-align: center;" onclick="event.stopPropagation();">
          <div style="font-size: 38px; margin-bottom: 8px;">⏸️</div>
          <h3 style="margin: 0 0 8px 0; font-size: 18px;">학습을 종료하시겠습니까?</h3>
          <p style="font-size: 13px; color: var(--text-secondary); margin: 0 0 16px 0;">
            창 바깥의 빈 공간을 클릭하면 다시 학습으로 돌아갑니다.
          </p>

          <label class="radio-option" style="justify-content: center; margin-bottom: 20px; background: var(--bg-main);">
            <input type="checkbox" id="chk-save-progress-quit" ${saveProgressOnQuit ? 'checked' : ''} />
            <span style="font-size: 13.5px; font-weight: 600;">현재까지의 학습 진도 저장하기</span>
          </label>

          <div style="display: flex; gap: 10px;">
            <button type="button" id="btn-cancel-quit" class="btn-secondary" style="flex: 1; padding: 13px;">취소 (계속 학습)</button>
            <button type="button" id="btn-confirm-quit" class="btn-danger" style="flex: 1; padding: 13px; font-size: 14px;">Yes (학습 종료)</button>
          </div>
        </div>
      </div>
    ` : ''}
  `;

  if (!isAnswerRevealed) {
    startCardTimer();
  }

  if (isAutoPlayMode) {
    scheduleNextAutoPlayStep();
  }

  // 타이핑 모드 입력창 자동 포커스 및 엔터 제출
  const typingInput = document.getElementById('input-typing-answer') as HTMLInputElement | null;
  if (typingInput && !isAnswerRevealed) {
    typingInput.focus();
    const submitTyping = () => {
      lastTypedAttempt = typingInput.value.trim();
      isAnswerRevealed = true;
      render();
    };
    typingInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        submitTyping();
      }
    });
    document.getElementById('btn-submit-typing')?.addEventListener('click', submitTyping);
  }

  // 상단 3대 모드 칩 이벤트
  document.getElementById('btn-cycle-direction')?.addEventListener('click', () => {
    if (studyDirection === 'front-to-back') studyDirection = 'back-to-front';
    else if (studyDirection === 'back-to-front') studyDirection = 'random';
    else studyDirection = 'front-to-back';
    determineCardDirection();
    isAnswerRevealed = false;
    render();
  });

  document.getElementById('btn-toggle-typing')?.addEventListener('click', () => {
    isTypingMode = !isTypingMode;
    lastTypedAttempt = '';
    render();
  });

  document.getElementById('btn-toggle-autoplay')?.addEventListener('click', () => {
    isAutoPlayMode = !isAutoPlayMode;
    if (!isAutoPlayMode) stopAutoPlay();
    render();
  });

  // 사진 클릭 시 전체화면 Lightbox 확대
  document.getElementById('study-zoomable-img')?.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomedImageUrl = currentCard.imageData || null;
    render();
  });
  document.getElementById('lightbox-overlay')?.addEventListener('click', () => {
    zoomedImageUrl = null;
    render();
  });

  document.getElementById('btn-open-settings')?.addEventListener('click', () => {
    stopAutoPlay();
    isSettingsModalOpen = true;
    render();
  });
  attachSettingsModalEvents();

  clearSwipeListener();

  document.getElementById('btn-edit-current-card')?.addEventListener('click', () => {
    stopAutoPlay();
    isEditCardModalOpen = true;
    render();
  });
  const closeEditModal = () => {
    isEditCardModalOpen = false;
    render();
  };
  document.getElementById('edit-card-overlay')?.addEventListener('click', closeEditModal);
  document.getElementById('btn-cancel-edit')?.addEventListener('click', closeEditModal);
  document.getElementById('btn-save-edit')?.addEventListener('click', async () => {
    const newFront = (document.getElementById('edit-modal-front') as HTMLInputElement).value.trim();
    const newBack = (document.getElementById('edit-modal-back') as HTMLInputElement).value.trim();
    const newEx = (document.getElementById('edit-modal-example') as HTMLInputElement).value.trim();
    if (!newFront || !newBack) return alert('앞면과 뒷면을 모두 입력해주세요!');

    currentCard.front = newFront;
    currentCard.back = newBack;
    currentCard.example = newEx || undefined;
    await api.updateCard(currentCard.deckId, currentCard.id, {
      front: newFront,
      back: newBack,
      example: newEx
    });
    isEditCardModalOpen = false;
    await render();
  });

  const performUndo = async () => {
    const lastSnap = undoHistoryStack.pop();
    if (!lastSnap) return;
    stopAutoPlay();
    triggerHaptic(15);
    await api.importStorageData(lastSnap.storageSnapshot);
    studyQueue = lastSnap.queueSnapshot;
    currentCardIndex = lastSnap.cardIndex;
    isAnswerRevealed = false;
    determineCardDirection();
    triggerReactionBadge('되돌리기 완료 ↩️');
    await render();
  };
  document.getElementById('btn-undo-card')?.addEventListener('click', performUndo);
  document.getElementById('btn-undo-bottom')?.addEventListener('click', performUndo);

  document.getElementById('btn-quit-study')?.addEventListener('click', (e) => {
    e.stopPropagation();
    stopAutoPlay();
    triggerHaptic(12);
    saveProgressOnQuit = true;
    isQuitConfirmModalOpen = true;
    render();
  });

  document.getElementById('chk-save-progress-quit')?.addEventListener('change', (e) => {
    saveProgressOnQuit = (e.target as HTMLInputElement).checked;
  });

  const cancelQuit = () => {
    isQuitConfirmModalOpen = false;
    render();
  };
  document.getElementById('quit-confirm-overlay')?.addEventListener('click', cancelQuit);
  document.getElementById('btn-cancel-quit')?.addEventListener('click', cancelQuit);

  document.getElementById('btn-confirm-quit')?.addEventListener('click', async () => {
    if (!saveProgressOnQuit && studySessionSnapshot) {
      await api.importStorageData(studySessionSnapshot);
    }
    isQuitConfirmModalOpen = false;
    studySessionSnapshot = null;
    undoHistoryStack = [];
    stopCardTimer();
    stopAutoPlay();
    window.speechSynthesis?.cancel();
    studyingDeckId = null;
    isStarCramMode = false;
    await render();
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

  document.getElementById('btn-speak-example')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentCard.example) {
      triggerHaptic(10);
      speakText(currentCard.example);
    }
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

  if (isStarCramMode) {
    document.getElementById('btn-cram-retry')?.addEventListener('click', async () => {
      triggerHaptic(15);
      triggerReactionBadge('One more time 💪');
      sessionResultsMap.set(currentCard.id, 'wrong');
      studyQueue.push({ ...currentCard });
      currentCardIndex++;
      isAnswerRevealed = false;
      determineCardDirection();
      await render();
    });

    document.getElementById('btn-cram-pass')?.addEventListener('click', async () => {
      triggerHaptic(15);
      triggerReactionBadge('Got it! ⭐');
      if (!sessionResultsMap.has(currentCard.id)) {
        sessionResultsMap.set(currentCard.id, 'correct');
      }
      currentCardIndex++;
      isAnswerRevealed = false;
      determineCardDirection();
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
    if (isSettingsModalOpen || isQuitConfirmModalOpen || isEditCardModalOpen || zoomedImageUrl) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;

    if (e.repeat) {
      e.preventDefault();
      return;
    }

    const now = Date.now();
    if (isProcessingRating || now - lastKeyActionTime < 120) {
      e.preventDefault();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      lastKeyActionTime = now;
      await performUndo();
      return;
    }

    if (!isAnswerRevealed && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      lastKeyActionTime = now;
      isAnswerRevealed = true;
      render();
    } else if (isAnswerRevealed && isStarCramMode) {
      lastKeyActionTime = now;
      if (e.key === '1') document.getElementById('btn-cram-retry')?.click();
      if (e.key === '3' || e.key === '2' || e.key === '4' || e.code === 'Space') document.getElementById('btn-cram-pass')?.click();
    } else if (isAnswerRevealed && (e.code === 'Space' || e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      lastKeyActionTime = now;
      await handleRatingWithReaction(3);
    } else if (isAnswerRevealed && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      lastKeyActionTime = now;
      await handleRatingWithReaction(Number(e.key) as ReviewRating);
    }
  });
}

async function handleRatingWithReaction(rating: ReviewRating): Promise<void> {
  if (isProcessingRating) return;
  const currentCard = studyQueue[currentCardIndex];
  if (!studyingDeckId || !currentCard) return;

  isProcessingRating = true;
  const durationSec = stopCardTimer();
  triggerHaptic(18);

  const preStorage = await api.getStorageData();
  undoHistoryStack.push({
    cardIndex: currentCardIndex,
    storageSnapshot: JSON.parse(JSON.stringify(preStorage)),
    queueSnapshot: JSON.parse(JSON.stringify(studyQueue))
  });

  if (rating === 1) {
    sessionResultsMap.set(currentCard.id, 'wrong');
  } else if (!sessionResultsMap.has(currentCard.id)) {
    sessionResultsMap.set(currentCard.id, 'correct');
  }

  const reactionMap: Record<ReviewRating, string> = {
    1: 'Cheer up 💪',
    2: 'Keep going 🔥',
    3: 'Good 👍',
    4: 'Awesome 🚀'
  };
  triggerReactionBadge(reactionMap[rating]);

  await api.reviewCard(studyingDeckId, currentCard.id, rating, settings, durationSec);

  setTimeout(async () => {
    currentCardIndex++;
    isAnswerRevealed = false;
    isProcessingRating = false;
    determineCardDirection();
    await render();

    if (settings.autoPlayAudio && studyQueue[currentCardIndex]) {
      speakText(currentCardReversed ? studyQueue[currentCardIndex].back : studyQueue[currentCardIndex].front);
    }
  }, 160);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * **강조**, {{빈칸}}, 그리고 예문 속 타겟 단어(targetWord) 자동 하이라이트를 처리하는 스마트 포매터
 */
function formatRichText(text: string, revealCloze = true, targetWord?: string): string {
  let formatted = escapeHtml(text);

  // 1. **강조** -> 섹터 4 포인트 색상 하이라이트
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong class="text-highlight">$1</strong>');

  // 2. {{빈칸}} -> 앞면에서는 [ ... ], 뒷면에서는 초록색 정답 하이라이트
  formatted = formatted.replace(/\{\{(.+?)\}\}/g, (_, answer) => {
    return revealCloze
      ? `<span class="cloze-revealed">${answer}</span>`
      : `<span class="cloze-blank">[ &nbsp;...&nbsp; ]</span>`;
  });

  // 3. 예문 내 타겟 단어(앞면 단어) 자동 감지 하이라이트
  if (targetWord) {
    const cleanTarget = targetWord.replace(/\*\*/g, '').replace(/\{\{|\}\}/g, '').trim();
    if (cleanTarget.length >= 2 && !formatted.includes('text-highlight')) {
      const escapedTarget = cleanTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escapedTarget})`, 'gi');
      formatted = formatted.replace(regex, '<strong class="text-highlight">$1</strong>');
    }
  }

  return formatted;
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