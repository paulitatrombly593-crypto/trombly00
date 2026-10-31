import './styles.css';
import { getAnkiAPI } from './api-adapter';
import { Deck, Card, ReviewRating, StorageSchema } from '../shared/types';
import { SM2Scheduler } from '../core/sm2';
import { CsvParser } from '../shared/csv-parser';

const api = getAnkiAPI();
const appElement = document.querySelector<HTMLDivElement>('#app');

if (!appElement) {
  throw new Error('[Critical Error] #app 엘리먼트를 찾을 수 없습니다.');
}

// =========================================================
// ⚙️ 사용자 환경 설정 (모드, 다크테마, 자동발음, 별표 단어)
// =========================================================
type ViewMode = 'pc' | 'mobile';
type ThemeMode = 'dark' | 'light';

const VIEW_MODE_KEY = 'MY_ANKI_VIEW_MODE';
const THEME_MODE_KEY = 'MY_ANKI_THEME_MODE';
const AUTO_SPEAK_KEY = 'MY_ANKI_AUTO_SPEAK';
const STARRED_CARDS_KEY = 'MY_ANKI_STARRED_CARDS';

let currentViewMode: ViewMode = (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || (window.innerWidth <= 640 ? 'mobile' : 'pc');
let currentTheme: ThemeMode = (localStorage.getItem(THEME_MODE_KEY) as ThemeMode) || 'dark'; // 1,2번 사진처럼 다크 테마 기본
let isAutoSpeak: boolean = localStorage.getItem(AUTO_SPEAK_KEY) === 'true';
let starredCardIds: Set<string> = new Set(JSON.parse(localStorage.getItem(STARRED_CARDS_KEY) || '[]'));

let isSettingsModalOpen = false;

function applyPreferences(): void {
  localStorage.setItem(VIEW_MODE_KEY, currentViewMode);
  localStorage.setItem(THEME_MODE_KEY, currentTheme);
  localStorage.setItem(AUTO_SPEAK_KEY, String(isAutoSpeak));

  document.body.classList.remove('mode-pc', 'mode-mobile', 'theme-dark', 'theme-light');
  document.body.classList.add(`mode-${currentViewMode}`, `theme-${currentTheme}`);
}

function toggleStarCard(cardId: string): boolean {
  if (starredCardIds.has(cardId)) {
    starredCardIds.delete(cardId);
  } else {
    starredCardIds.add(cardId);
  }
  localStorage.setItem(STARRED_CARDS_KEY, JSON.stringify([...starredCardIds]));
  triggerHaptic(15);
  return starredCardIds.has(cardId);
}

// 🔊 원어민 발음 읽어주기 (Web Speech API)
function speakText(text: string): void {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  // 한글이 포함되어 있으면 한국어, 아니면 영어 원어민 발음으로 자동 선택
  const hasKorean = /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(text);
  utterance.lang = hasKorean ? 'ko-KR' : 'en-US';
  utterance.rate = 0.95;

  const speakerBtn = document.getElementById('btn-speak-card');
  speakerBtn?.classList.add('speaking');
  utterance.onend = () => speakerBtn?.classList.remove('speaking');
  utterance.onerror = () => speakerBtn?.classList.remove('speaking');

  window.speechSynthesis.speak(utterance);
}

// 📳 모바일 햅틱 진동 피드백
function triggerHaptic(ms = 10): void {
  if ('vibrate' in navigator) {
    try { navigator.vibrate(ms); } catch { /* ignore */ }
  }
}

// 초기 테마 및 뷰 모드 적용
applyPreferences();

// 화면 상태 변수
let selectedDeckId: string | null = null;
let studyingDeckId: string | null = null;
let studyQueue: Card[] = [];
let currentCardIndex = 0;
let isAnswerRevealed = false;
let lastReactionText: string = 'Let’s go 🔥'; // 상단 리액션 문구 상태
let reactionFadeTimer: number | null = null; // 1.5초 자동 소멸용 타이머

let currentKeyHandler: ((e: KeyboardEvent) => void) | null = null;

function setKeyboardListener(handler: (e: KeyboardEvent) => void): void {
  if (currentKeyHandler) {
    window.removeEventListener('keydown', currentKeyHandler);
  }
  currentKeyHandler = handler;
  window.addEventListener('keydown', currentKeyHandler);
}

/**
 * EUC-KR 및 UTF-8 자동 판별 리더
 */
async function readFileWithAutoEncoding(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (utf8Text.includes('\uFFFD')) {
    try {
      return new TextDecoder('euc-kr').decode(buffer);
    } catch {
      return utf8Text;
    }
  }
  return utf8Text;
}

/**
 * ⚙️ 설정 모달 HTML
 */
function renderSettingsModalHtml(): string {
  if (!isSettingsModalOpen) return '';

  return `
    <div class="modal-overlay" id="settings-modal-overlay">
      <div class="modal-content" onclick="event.stopPropagation();">
        <h3 style="margin-top: 0; font-size: 18px;">⚙️ 환경 및 인터랙션 설정</h3>

        <div style="font-size: 13px; font-weight: 700; margin-top: 12px;">1. 화면 레이아웃 모드 (택 1)</div>
        <div class="radio-group">
          <label class="radio-option">
            <input type="radio" name="view-mode" value="pc" ${currentViewMode === 'pc' ? 'checked' : ''} />
            <div>
              <strong style="font-size: 14px;">💻 PC 모드 (데스크톱)</strong>
              <div style="font-size: 12px; color: var(--text-secondary);">넓은 화면, 가로 4열 버튼 및 단축키 표시</div>
            </div>
          </label>
          <label class="radio-option">
            <input type="radio" name="view-mode" value="mobile" ${currentViewMode === 'mobile' ? 'checked' : ''} />
            <div>
              <strong style="font-size: 14px;">📱 모바일 모드 (아이폰 최적화)</strong>
              <div style="font-size: 12px; color: var(--text-secondary);">꽉 찬 카드 화면, 큼직한 2x2 터치 버튼</div>
            </div>
          </label>
        </div>

        <div style="font-size: 13px; font-weight: 700;">2. 컬러 테마 및 음성 설정</div>
        <div class="radio-group">
          <label class="radio-option">
            <input type="radio" name="theme-mode" value="dark" ${currentTheme === 'dark' ? 'checked' : ''} />
            <div><strong style="font-size: 14px;">🌙 다크 모드 (몰입형 블랙 테마)</strong></div>
          </label>
          <label class="radio-option">
            <input type="radio" name="theme-mode" value="light" ${currentTheme === 'light' ? 'checked' : ''} />
            <div><strong style="font-size: 14px;">☀️ 라이트 모드 (화이트 테마)</strong></div>
          </label>
          <label class="radio-option">
            <input type="checkbox" id="chk-auto-speak" ${isAutoSpeak ? 'checked' : ''} />
            <div>
              <strong style="font-size: 14px;">🔊 새 카드 등장 시 자동 발음 듣기</strong>
            </div>
          </label>
        </div>

        <div style="display: flex; justify-content: flex-end;">
          <button id="btn-close-settings" class="btn-primary" style="width: 100%; padding: 14px;">적용 및 닫기</button>
        </div>
      </div>
    </div>
  `;
}

function attachSettingsModalEvents(): void {
  const overlay = document.getElementById('settings-modal-overlay');
  const closeBtn = document.getElementById('btn-close-settings');

  const closeModal = () => {
    isSettingsModalOpen = false;
    render();
  };

  overlay?.addEventListener('click', closeModal);
  closeBtn?.addEventListener('click', closeModal);

  document.querySelectorAll<HTMLInputElement>('input[name="view-mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.checked) {
        currentViewMode = target.value as ViewMode;
        applyPreferences();
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('input[name="theme-mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.checked) {
        currentTheme = target.value as ThemeMode;
        applyPreferences();
      }
    });
  });

  document.getElementById('chk-auto-speak')?.addEventListener('change', (e) => {
    isAutoSpeak = (e.target as HTMLInputElement).checked;
    applyPreferences();
  });
}

/**
 * 1. 메인 대시보드 화면
 */
async function renderDashboard(): Promise<void> {
  const data = await api.getStorageData();

  let totalCardsCount = 0;
  let totalDueTodayCount = 0;
  data.decks.forEach(d => {
    totalCardsCount += d.cards.length;
    totalDueTodayCount += d.cards.filter(c => SM2Scheduler.isDue(c)).length;
  });
  const totalReviewedCount = data.logs.length;

  const deckListHtml = data.decks
    .map((deck: Deck) => {
      const totalCards = deck.cards.length;
      const dueCards = deck.cards.filter(c => SM2Scheduler.isDue(c)).length;

      return `
        <div class="deck-item">
          <div style="flex: 1; min-width: 0;">
            <strong style="font-size: 16px; word-break: break-all;">📁 ${escapeHtml(deck.name)}</strong>
            <div class="deck-stats">
              전체: <b>${totalCards}</b>개 | 복습대기: <span class="due-count">${dueCards}개</span>
            </div>
          </div>
          <div style="display: flex; gap: 6px; flex-shrink: 0;">
            <button class="btn-primary btn-start-study" data-id="${deck.id}" ${dueCards === 0 ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''}>
              📖 학습 (${dueCards})
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
          <h2 style="margin: 0; font-size: 20px;">🧠 My Anki 단어장</h2>
          <div style="margin-top: 6px; display: flex; gap: 6px;">
            <span class="badge" style="cursor: pointer;" id="badge-toggle-mode">
              ${currentViewMode === 'pc' ? '💻 PC 모드' : '📱 모바일 모드'} · ${currentTheme === 'dark' ? '🌙 다크' : '☀️ 라이트'}
            </span>
          </div>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button id="btn-open-settings" class="icon-circle-btn" title="설정">⚙️</button>
          <button id="btn-export-json" class="btn-secondary" style="font-size: 12px; padding: 8px 10px;">📥 백업</button>
          <label class="btn-secondary" style="font-size: 12px; padding: 8px 10px; cursor: pointer; display: inline-flex; align-items: center;">
            📤 복원
            <input type="file" id="input-import-json" accept=".json" style="display: none;" />
          </label>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">📚 보유 단어</div>
          <div class="stat-value">${totalCardsCount}개</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">🔥 오늘 복습</div>
          <div class="stat-value" style="color: ${totalDueTodayCount > 0 ? '#f43f5e' : '#10b981'};">
            ${totalDueTodayCount}개
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">⭐ 중요 단어</div>
          <div class="stat-value" style="color: #84cc16;">${starredCardIds.size}개</div>
        </div>
      </div>

      <div class="card-box">
        <h3 style="margin-top: 0; font-size: 16px;">➕ 새 단어장 만들기</h3>
        <div class="form-row">
          <input type="text" id="input-deck-name" placeholder="단어장 이름 (예: 토익 필수 영단어)" />
          <button id="btn-create-deck" class="btn-primary">단어장 생성</button>
        </div>
      </div>

      <div class="card-box" style="flex: 1;">
        <h3 style="margin-top: 0; font-size: 16px;">📚 내 단어장 목록 (${data.decks.length})</h3>
        ${deckListHtml || '<p style="color: var(--text-secondary); font-size: 14px;">아직 단어장이 없습니다.</p>'}
      </div>
    </div>
    ${renderSettingsModalHtml()}
  `;

  const openModal = () => { isSettingsModalOpen = true; render(); };
  document.getElementById('btn-open-settings')?.addEventListener('click', openModal);
  document.getElementById('badge-toggle-mode')?.addEventListener('click', openModal);
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
      if (confirm('정말 삭제하시겠습니까? 안의 단어도 모두 삭제됩니다.')) {
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

      studyQueue = targetDeck.cards.filter(c => SM2Scheduler.isDue(c));
      if (studyQueue.length === 0) return alert('오늘 학습할 카드가 없습니다!');

      studyingDeckId = id;
      currentCardIndex = 0;
      isAnswerRevealed = false;
      lastReactionText = 'Let’s go 🔥';
      await render();
      if (isAutoSpeak && studyQueue[0]) {
        speakText(studyQueue[0].front);
      }
    });
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

  const fileInput = document.getElementById('input-import-json') as HTMLInputElement;
  fileInput?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    try {
      const text = await readFileWithAutoEncoding(file);
      const parsed = JSON.parse(text) as StorageSchema;
      if (!parsed || !Array.isArray(parsed.decks)) {
        throw new Error('유효한 Anki 백업 파일 규격이 아닙니다.');
      }
      if (confirm(`'${file.name}' 파일로부터 총 ${parsed.decks.length}개의 단어장을 복원하시겠습니까?`)) {
        await api.importStorageData(parsed);
        alert('성공적으로 단어장이 복원되었습니다!');
        await render();
      }
    } catch (err) {
      alert(`파일 복원 실패: ${(err as Error).message}`);
    } finally {
      fileInput.value = '';
    }
  });
}

/**
 * 2. 단어 관리 화면
 */
async function renderDeckManage(deckId: string): Promise<void> {
  const data = await api.getStorageData();
  const deck = data.decks.find(d => d.id === deckId);
  if (!deck) { selectedDeckId = null; await renderDashboard(); return; }

  const cardRowsHtml = deck.cards
    .map(card => `
      <div class="deck-item">
        <div style="flex: 1; min-width: 0;">
          <div style="word-break: break-all;">
            ${starredCardIds.has(card.id) ? '⭐ ' : ''}<strong>Q:</strong> ${escapeHtml(card.front)}
          </div>
          <div style="color: #60a5fa; margin-top: 4px; word-break: break-all;"><strong>A:</strong> ${escapeHtml(card.back)}</div>
          <div class="deck-stats">
            상태: ${card.state} | 간격: ${card.interval}일 | 복습: ${new Date(card.dueDate).toLocaleDateString()}
          </div>
        </div>
        <button class="btn-danger btn-delete-card" data-card-id="${card.id}" style="flex-shrink: 0;">삭제</button>
      </div>
    `)
    .join('');

  appElement!.innerHTML = `
    <div class="container">
      <div class="header">
        <h3 style="margin: 0; font-size: 18px; word-break: break-all;">📁 [${escapeHtml(deck.name)}]</h3>
        <div style="display: flex; gap: 6px; flex-shrink: 0;">
          <button id="btn-open-settings" class="icon-circle-btn">⚙️</button>
          <button id="btn-back" class="btn-secondary" style="font-size: 13px; padding: 8px 12px;">⬅ 목록</button>
        </div>
      </div>

      <div class="card-box">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
          <h4 style="margin: 0; font-size: 16px;">✏️ 새 단어 추가</h4>
          <label class="btn-secondary" style="font-size: 12px; padding: 8px 12px; cursor: pointer; border-radius: 10px;">
            📂 CSV 대량 등록
            <input type="file" id="input-csv-file" accept=".csv, .tsv, .txt" style="display: none;" />
          </label>
        </div>
        <div class="form-row">
          <input type="text" id="input-card-front" placeholder="앞면: 단어/질문 (예: responsibility)" />
          <input type="text" id="input-card-back" placeholder="뒷면: 뜻/정답 (예: 책임, 의무)" />
          <button id="btn-add-card" class="btn-primary">단어 추가</button>
        </div>
      </div>

      <div class="card-box" style="flex: 1;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h4 style="margin: 0; font-size: 16px;">🗂️ 등록된 카드 (${deck.cards.length}개)</h4>
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

  document.getElementById('btn-back')?.addEventListener('click', () => {
    selectedDeckId = null;
    render();
  });

  document.getElementById('btn-clear-deck-cards')?.addEventListener('click', async () => {
    if (confirm('이 단어장의 모든 카드를 삭제하고 다시 등록하시겠습니까?')) {
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
    await api.addCard(deck.id, front, back);
    await render();
  });

  const csvInput = document.getElementById('input-csv-file') as HTMLInputElement;
  csvInput?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    try {
      const text = await readFileWithAutoEncoding(file);
      const parseResult = CsvParser.parse(text);

      if (parseResult.validCards.length === 0) {
        alert('추가할 수 있는 유효한 단어가 없습니다. 파일 형식을 확인해주세요.');
        return;
      }

      const confirmMsg = `'${file.name}' 파일 분석 완료!\n\n유효 단어: ${parseResult.validCards.length}개\n건너뛴 행: ${parseResult.skippedCount}개\n\n지금 등록하시겠습니까?`;
      if (!confirm(confirmMsg)) return;

      for (const item of parseResult.validCards) {
        await api.addCard(deck.id, item.front, item.back);
      }

      alert(`🎉 ${parseResult.validCards.length}개의 단어가 등록되었습니다!`);
      await render();
    } catch (err) {
      alert(`CSV 처리 오류: ${(err as Error).message}`);
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

/**
 * 3. 🔥 1, 2번 레퍼런스 사진 스타일 인터랙티브 학습룸
 */
async function renderStudyRoom(): Promise<void> {
  const data = await api.getStorageData();
  const deck = data.decks.find(d => d.id === studyingDeckId);

  if (!deck || currentCardIndex >= studyQueue.length) {
    appElement!.innerHTML = `
      <div class="container" style="justify-content: center; text-align: center;">
        <div class="card-box" style="padding: 48px 20px;">
          <h1 style="font-size: 54px; margin: 0 0 12px 0;">🎉</h1>
          <h2 style="font-size: 22px; margin-bottom: 8px;">오늘의 목표 달성 완료!</h2>
          <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 28px;">
            총 <b>${studyQueue.length}개</b>의 단어를 완벽하게 학습했습니다.<br>망각곡선에 따라 다음 복습일이 예약되었습니다.
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

  appElement!.innerHTML = `
    <div class="container">
      <!-- 1, 2번 사진과 동일한 상단 네비게이션 바 -->
      <div class="study-topbar">
        <button id="btn-quit-study" class="icon-circle-btn" title="학습 종료">✕</button>
        <div class="study-counter">${currentCardIndex + 1} / ${studyQueue.length}</div>
        <button id="btn-open-settings" class="icon-circle-btn" title="설정">⚙️</button>
      </div>

      <!-- 상단 진행률 프로그레스 바 -->
      <div class="study-progress-track">
        <div class="study-progress-fill" style="width: ${progressPercent}%;"></div>
      </div>

      <!-- 화면을 꽉 채우는 메인 플래시카드 -->
      <div class="study-box" id="study-card-body">
        <!-- 좌측 상단 별표 버튼 -->
        <button id="btn-star-card" class="card-star-btn ${isStarred ? 'starred' : ''}" title="중요 단어 별표">
          ${isStarred ? '★' : '☆'}
        </button>

        <!-- 우측 상단 실시간 리액션 배지 (Good 👍, Cheer up 💪 등) -->
        <div class="card-reaction-badge" id="reaction-badge">
          ${lastReactionText}
        </div>

        <!-- 중앙 단어/질문 -->
        <div class="study-question">${escapeHtml(currentCard.front)}</div>

        <!-- 정답 공개 영역 -->
        ${isAnswerRevealed ? `
          <div class="study-divider"></div>
          <div class="study-answer">${escapeHtml(currentCard.back)}</div>
        ` : `
          <div class="tap-guide-hint">💡 카드를 터치하면 뜻이 보입니다</div>
        `}

        <!-- 우측 하단 원어민 발음 스피커 버튼 -->
        <button id="btn-speak-card" class="card-speaker-btn" title="발음 듣기">🔊</button>
      </div>

      <!-- 하단 액션 / 평가 버튼 영역 -->
      ${!isAnswerRevealed ? `
        <button id="btn-reveal" class="btn-primary" style="width: 100%; padding: 18px; font-size: 17px; border-radius: 16px;">
          정답 확인하기 ${currentViewMode === 'pc' ? '(Space)' : ''}
        </button>
      ` : `
        <div class="rating-grid">
          <button class="btn-rate btn-again" data-rating="1">
            <b>1. 다시</b>
            <span class="key-hint">Cheer up 💪 [1]</span>
          </button>
          <button class="btn-rate btn-hard" data-rating="2">
            <b>2. 어려움</b>
            <span class="key-hint">Keep going 🔥 [2]</span>
          </button>
          <button class="btn-rate btn-good" data-rating="3">
            <b>3. 알맞음</b>
            <span class="key-hint">Good 👍 [3]</span>
          </button>
          <button class="btn-rate btn-easy" data-rating="4">
            <b>4. 쉬움</b>
            <span class="key-hint">Awesome 🚀 [4]</span>
          </button>
        </div>
      `}
    </div>
    ${renderSettingsModalHtml()}
  `;

  // 설정 모달 열기
  document.getElementById('btn-open-settings')?.addEventListener('click', () => {
    isSettingsModalOpen = true;
    render();
  });
  attachSettingsModalEvents();

  // 학습 종료 (X 버튼)
  document.getElementById('btn-quit-study')?.addEventListener('click', () => {
    window.speechSynthesis?.cancel();
    studyingDeckId = null;
    render();
  });

  // 별표(즐겨찾기) 토글 이벤트
  document.getElementById('btn-star-card')?.addEventListener('click', (e) => {
    e.stopPropagation(); // 카드 뒤집기 방지
    toggleStarCard(currentCard.id);
    render();
  });

  // 원어민 발음 스피커 버튼 이벤트
  document.getElementById('btn-speak-card')?.addEventListener('click', (e) => {
    e.stopPropagation(); // 카드 뒤집기 방지
    triggerHaptic(10);
    speakText(currentCard.front);
  });

  // 카드 본체 터치 시 앞면 ↔ 뒷면 자유롭게 토글 뒤집기
  document.getElementById('study-card-body')?.addEventListener('click', () => {
    triggerHaptic(10);
    isAnswerRevealed = !isAnswerRevealed; // 정답 본 후 다시 누르면 앞면으로 복귀!
    render();
  });

  // 하단 정답 확인 버튼
  document.getElementById('btn-reveal')?.addEventListener('click', () => {
    triggerHaptic(10);
    isAnswerRevealed = true;
    render();
  });

  // 4개 평가 버튼 클릭 시: 버튼 팝 애니메이션 + 상단 리액션 즉시 변경
  document.querySelectorAll('.btn-rate').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const targetBtn = e.currentTarget as HTMLButtonElement;
      const rating = Number(targetBtn.dataset.rating) as ReviewRating;
      targetBtn.classList.add('btn-pop-active');
      await handleRatingWithReaction(rating);
    });
  });

  // 키보드 단축키
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

/**
 * 선택한 버튼에 맞춰 상단 리액션 문구를 바꾸고 다음 카드로 전환
 */
async function handleRatingWithReaction(rating: ReviewRating): Promise<void> {
  const currentCard = studyQueue[currentCardIndex];
  if (!studyingDeckId || !currentCard) return;

  triggerHaptic(18);

  // 1, 2번 레퍼런스 사진처럼 평가 등급별 맞춤 리액션 배지 설정
  const reactionMap: Record<ReviewRating, string> = {
    1: 'Cheer up 💪',
    2: 'Keep going 🔥',
    3: 'Good 👍',
    4: 'Awesome 🚀'
  };
  lastReactionText = reactionMap[rating];

  // 현재 카드 우측 상단 배지도 즉시 업데이트하여 시각적 피드백 제공
  const badgeEl = document.getElementById('reaction-badge');
  if (badgeEl) {
    badgeEl.textContent = lastReactionText;
    badgeEl.style.animation = 'none';
    // 리플로우 강제 후 팝 애니메이션 재실행
    void badgeEl.offsetWidth;
    badgeEl.style.animation = 'reactionPop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)';
  }

  // SM-2 스케줄링 저장
  await api.reviewCard(studyingDeckId, currentCard.id, rating);

  // 버튼이 커지는 애니메이션을 눈으로 즐길 수 있도록 0.18초 후 다음 카드로 전환
  setTimeout(async () => {
    currentCardIndex++;
    isAnswerRevealed = false;
    await render();

    // 자동 발음 켜져 있으면 다음 카드 발음 즉시 재생
    if (isAutoSpeak && studyQueue[currentCardIndex]) {
      speakText(studyQueue[currentCardIndex].front);
    }

    // 1.5초 뒤 상단 리액션 배지를 서서히 사라지게 처리
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