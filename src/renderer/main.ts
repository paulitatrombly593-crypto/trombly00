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
    if (isSettingsModalOpen) return;
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

/**
 * 오늘 날짜 기준으로 이미 공부한 새 카드 수와 복습 수를 계산 (일일 목표 할당량 반영)
 */
function buildDailyStudyQueue(deck: Deck, logs: StorageSchema['logs']): { queue: Card[]; dueNewCount: number; dueRevCount: number } {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayLogs = logs.filter(l => l.deckId === deck.id && l.reviewDate.startsWith(todayStr));

  // 오늘 이미 학습한 고유 카드 수 파악
  const reviewedCardIdsToday = new Set(todayLogs.map(l => l.cardId));

  const remainingNewQuota = Math.max(0, settings.newCardsPerDay - [...reviewedCardIdsToday].filter(id => {
    const c = deck.cards.find(card => card.id === id);
    return c && c.repetitions <= 1;
  }).length);

  const remainingReviewQuota = Math.max(0, settings.maxReviewsPerDay - todayLogs.length);

  // 1순위: 현재 분 단위 학습/재학습 중이며 시간이 도래한 카드 (목표량 제한 없이 우선 출제)
  const learningDue = deck.cards.filter(
    c => !c.suspended && (c.state === 'learning' || c.state === 'relearning') && SM2Scheduler.isDue(c)
  );

  // 2순위: 장기 복습(review) 중 오늘 날짜가 도래한 카드
  const reviewDue = deck.cards
    .filter(c => !c.suspended && c.state === 'review' && SM2Scheduler.isDue(c))
    .slice(0, remainingReviewQuota);

  // 3순위: 새 카드(new)
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
// 🎛️ 전문가용 5대 카테고리 사이드바 설정 모달 (사진 2~5번 구현)
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
          <!-- 좌측 사이드바 카테고리 -->
          <div class="pro-sidebar">
            <button class="pro-tab-btn ${activeSettingsTab === 'new' ? 'active' : ''}" data-tab="new">🌱 새 카드</button>
            <button class="pro-tab-btn ${activeSettingsTab === 'review' ? 'active' : ''}" data-tab="review">🔄 복습</button>
            <button class="pro-tab-btn ${activeSettingsTab === 'lapse' ? 'active' : ''}" data-tab="lapse">⚠️ 실패</button>
            <button class="pro-tab-btn ${activeSettingsTab === 'general' ? 'active' : ''}" data-tab="general">⏱️ 일반</button>
            <button class="pro-tab-btn ${activeSettingsTab === 'display' ? 'active' : ''}" data-tab="display">🎨 화면·백업</button>
          </div>

          <!-- 우측 세부 설정 폼 -->
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

/**
 * 현재 열려 있는 탭의 입력값들을 읽어서 settings 객체에 반영
 */
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

  // 좌측 사이드바 탭 전환 (현재 탭 값 자동 저장 후 전환)
  document.querySelectorAll<HTMLButtonElement>('.pro-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      collectCurrentTabInputs();
      activeSettingsTab = btn.dataset.tab as SettingsTab;
      render();
    });
  });

  // 닫기 / 확인 저장
  const closeAndSave = () => {
    collectCurrentTabInputs();
    isSettingsModalOpen = false;
    render();
  };

  document.getElementById('settings-modal-overlay')?.addEventListener('click', closeAndSave);
  document.getElementById('btn-close-modal-x')?.addEventListener('click', closeAndSave);
  document.getElementById('btn-save-settings')?.addEventListener('click', closeAndSave);

  // 국밥 기본값 복원 버튼
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

  // 백업 다운로드 (설정창 내부)
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

  // 백업 복원 (설정창 내부)
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
// 1. 메인 대시보드 화면 (잡다한 버튼 제거 & 깔끔한 목표 중심 UI)
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

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">📚 전체 카드</div>
          <div class="stat-value">${totalCardsCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">🔥 오늘 할당량</div>
          <div class="stat-value" style="color: ${totalDueTodayCount > 0 ? '#f43f5e' : '#10b981'};">
            ${totalDueTodayCount}
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">⭐ 중요 표시</div>
          <div class="stat-value" style="color: #84cc16;">${starredCardIds.size}</div>
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
  `;

  document.getElementById('btn-open-settings')?.addEventListener('click', () => {
    isSettingsModalOpen = true;
    render();
  });
  attachSettingsModalEvents();

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
// 2. 단어 관리 화면 (정밀 날짜/시간 라벨링 & 복습 예정 배지)
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

      return `
        <div class="deck-item">
          <div style="flex: 1; min-width: 0;">
            <div style="margin-bottom: 5px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center;">
              <span class="tag-badge ${badgeClass}">${dueBadgeText}</span>
              ${card.isLeech ? `<span class="tag-badge tag-leech">🩸 거머리(${card.lapses}회 실패)</span>` : ''}
            </div>
            <div style="word-break: break-all; font-size: 15px;">
              ${starredCardIds.has(card.id) ? '⭐ ' : ''}<strong>Q:</strong> ${escapeHtml(card.front)}
            </div>
            <div style="color: #60a5fa; margin-top: 3px; word-break: break-all; font-size: 14px;">
              <strong>A:</strong> ${escapeHtml(card.back)}
            </div>
            <div class="deck-stats" style="margin-top: 6px;">
              🕒 최근 학습: <b>${lastReviewedStr}</b> · 간격: <b>${card.interval}일</b> · 수월함: <b>${Math.round(card.easeFactor * 100)}%</b>
            </div>
          </div>
          <button class="btn-danger btn-delete-card" data-card-id="${card.id}" style="flex-shrink: 0;">삭제</button>
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

// =========================================================
// 3. 플래시카드 학습룸 (오른손 엄지용 3/4번 교체 & 버튼 밑 복습 주기 표시)
// =========================================================
async function renderStudyRoom(): Promise<void> {
  const data = await api.getStorageData();
  const deck = data.decks.find(d => d.id === studyingDeckId);

  if (!deck || currentCardIndex >= studyQueue.length) {
    stopCardTimer();
    clearSwipeListener();
    appElement!.innerHTML = `
      <div class="container" style="justify-content: center; text-align: center;">
        <div class="card-box" style="padding: 48px 20px;">
          <h1 style="font-size: 54px; margin: 0 0 12px 0;">🎉</h1>
          <h2 style="font-size: 22px; margin-bottom: 8px;">오늘의 학습 목표 달성!</h2>
          <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 28px;">
            할당된 <b>${studyQueue.length}개</b>의 카드를 모두 마쳤습니다.<br>Anki 스케줄러에 따라 다음 복습 주기가 정확히 기록되었습니다.
          </p>
          <button id="btn-finish-study" class="btn-primary" style="width: 100%; padding: 16px; font-size: 16px;">
            대시보드로 돌아가기
          </button>
        </div>
      </div>
    `;
    document.getElementById('btn-finish-study')?.addEventListener('click', () => {
      studyingDeckId = null;
      render();
    });
    return;
  }

  const currentCard = studyQueue[currentCardIndex];
  const progressPercent = Math.round(((currentCardIndex + 1) / studyQueue.length) * 100);
  const isStarred = starredCardIds.has(currentCard.id);

  // 각 버튼(1~4)을 눌렀을 때 언제 다시 복습하게 되는지 미리 계산!
  const previewLabels = SM2Scheduler.getPreviewLabels(currentCard, settings);

  appElement!.innerHTML = `
    <div class="container">
      <!-- 상단 바: 좌측에 종료(X)와 설정(⚙️) 배치 -->
      <div class="study-topbar">
        <div style="display: flex; gap: 8px;">
          <button id="btn-quit-study" class="icon-circle-btn" title="목록으로">✕</button>
          <button id="btn-open-settings" class="icon-circle-btn" title="설정">⚙️</button>
        </div>
        <div class="study-counter">${currentCardIndex + 1} / ${studyQueue.length}</div>
        <div style="min-width: 55px; text-align: right; font-size: 13px; color: var(--text-secondary);" id="study-timer-display">
          ${settings.showTimer ? '⏱️ 0s' : ''}
        </div>
      </div>

      <div class="study-progress-track">
        <div class="study-progress-fill" style="width: ${progressPercent}%;"></div>
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
      ` : `
        <!-- 👍 오른손 엄지 최적화 배치: 아랫줄 오른쪽에 가장 많이 누르는 [3. 알맞음] 배치! -->
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

  const quitStudy = () => {
    stopCardTimer();
    clearSwipeListener();
    window.speechSynthesis?.cancel();
    studyingDeckId = null;
    render();
  };

  document.getElementById('btn-quit-study')?.addEventListener('click', quitStudy);
  attachSwipeBackListener(quitStudy);

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

  // 카드 터치 시 앞면 ↔ 뒷면 자유롭게 토글
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

  document.querySelectorAll('.btn-rate').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const targetBtn = e.currentTarget as HTMLButtonElement;
      const rating = Number(targetBtn.dataset.rating) as ReviewRating;
      targetBtn.classList.add('btn-pop-active');
      await handleRatingWithReaction(rating);
    });
  });

  setKeyboardListener(async (e: KeyboardEvent) => {
    if (isSettingsModalOpen) return;
    if (!isAnswerRevealed && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      isAnswerRevealed = true;
      render();
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
  } else {
    if (currentKeyHandler) {
      window.removeEventListener('keydown', currentKeyHandler);
      currentKeyHandler = null;
    }
    await renderDashboard();
  }
}

render();