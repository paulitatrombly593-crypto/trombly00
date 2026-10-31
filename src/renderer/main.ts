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

// 뷰 모드 관리 (PC vs Mobile)
type ViewMode = 'pc' | 'mobile';
const VIEW_MODE_STORAGE_KEY = 'MY_ANKI_VIEW_MODE';

function getSavedViewMode(): ViewMode {
  const saved = localStorage.getItem(VIEW_MODE_STORAGE_KEY) as ViewMode;
  if (saved === 'pc' || saved === 'mobile') {
    return saved;
  }
  // 초기 접속 시 화면 너비로 스마트 감지 (640px 이하면 모바일 모드 기본)
  return window.innerWidth <= 640 ? 'mobile' : 'pc';
}

let currentViewMode: ViewMode = getSavedViewMode();
let isSettingsModalOpen = false;

function applyViewMode(mode: ViewMode): void {
  currentViewMode = mode;
  localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  document.body.classList.remove('mode-pc', 'mode-mobile');
  document.body.classList.add(`mode-${mode}`);
}

// 초기 모드 적용
applyViewMode(currentViewMode);

let selectedDeckId: string | null = null;
let studyingDeckId: string | null = null;
let studyQueue: Card[] = [];
let currentCardIndex = 0;
let isAnswerRevealed = false;

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
      const euckrDecoder = new TextDecoder('euc-kr');
      return euckrDecoder.decode(buffer);
    } catch {
      return utf8Text;
    }
  }
  return utf8Text;
}

/**
 * ⚙️ 설정 모달 렌더링 헬퍼
 */
function renderSettingsModalHtml(): string {
  if (!isSettingsModalOpen) return '';

  return `
    <div class="modal-overlay" id="settings-modal-overlay">
      <div class="modal-content" onclick="event.stopPropagation();">
        <h3 style="margin-top: 0; font-size: 18px; display: flex; align-items: center; gap: 8px;">
          ⚙️ 환경 설정
        </h3>
        <p style="font-size: 13px; color: #64748b; margin-bottom: 16px;">
          원하시는 디스플레이 환경을 선택하세요. 선택 즉시 최적화된 레이아웃으로 변경됩니다.
        </p>

        <div class="radio-group">
          <label class="radio-option">
            <input type="radio" name="view-mode" value="pc" ${currentViewMode === 'pc' ? 'checked' : ''} />
            <div>
              <strong style="font-size: 14px;">💻 PC 모드 (데스크톱 최적화)</strong>
              <div style="font-size: 12px; color: #64748b; margin-top: 2px;">
                넓은 화면, 가로 배치 폼, 키보드 단축키 안내 표시
              </div>
            </div>
          </label>

          <label class="radio-option">
            <input type="radio" name="view-mode" value="mobile" ${currentViewMode === 'mobile' ? 'checked' : ''} />
            <div>
              <strong style="font-size: 14px;">📱 모바일 모드 (스마트폰 최적화)</strong>
              <div style="font-size: 12px; color: #64748b; margin-top: 2px;">
                컴팩트 폭, 세로 스택 입력폼, 큼직한 터치 2x2 버튼
              </div>
            </div>
          </label>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px;">
          <button id="btn-close-settings" class="btn-primary" style="padding: 10px 18px;">확인 및 닫기</button>
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

  // 라디오 버튼 변경 이벤트 (둘 중 하나만 선택)
  document.querySelectorAll<HTMLInputElement>('input[name="view-mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.checked) {
        applyViewMode(target.value as ViewMode);
      }
    });
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
            <button class="btn-primary btn-start-study" data-id="${deck.id}" ${dueCards === 0 ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''}>
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
          <div style="margin-top: 4px; display: flex; align-items: center; gap: 6px;">
            <span class="badge" style="cursor: pointer;" id="badge-toggle-mode">
              ${currentViewMode === 'pc' ? '💻 PC 모드' : '📱 모바일 모드'} (클릭하여 변경)
            </span>
          </div>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button id="btn-open-settings" class="btn-secondary" style="font-size: 13px; padding: 8px 12px;">⚙️ 설정</button>
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
          <div class="stat-value" style="color: ${totalDueTodayCount > 0 ? '#dc2626' : '#10b981'};">
            ${totalDueTodayCount}개
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">✨ 누적 복습</div>
          <div class="stat-value" style="color: #059669;">${totalReviewedCount}회</div>
        </div>
      </div>

      <div class="card-box">
        <h3 style="margin-top: 0; font-size: 16px;">➕ 새 단어장 만들기</h3>
        <div class="form-row">
          <input type="text" id="input-deck-name" placeholder="단어장 이름 (예: 토익 필수 영단어)" />
          <button id="btn-create-deck" class="btn-primary">단어장 생성</button>
        </div>
      </div>

      <div class="card-box">
        <h3 style="margin-top: 0; font-size: 16px;">📚 내 단어장 목록 (${data.decks.length})</h3>
        ${deckListHtml || '<p style="color: #94a3b8; font-size: 14px;">아직 단어장이 없습니다.</p>'}
      </div>
    </div>
    ${renderSettingsModalHtml()}
  `;

  // 설정 모달 열기
  const openModal = () => {
    isSettingsModalOpen = true;
    render();
  };
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
      render();
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
 * 2. 특정 단어장의 단어 관리 화면
 */
async function renderDeckManage(deckId: string): Promise<void> {
  const data = await api.getStorageData();
  const deck = data.decks.find(d => d.id === deckId);
  if (!deck) { selectedDeckId = null; await renderDashboard(); return; }

  const cardRowsHtml = deck.cards
    .map(card => `
      <div class="deck-item">
        <div style="flex: 1; min-width: 0;">
          <div style="word-break: break-all;"><strong>Q:</strong> ${escapeHtml(card.front)}</div>
          <div style="color: #2563eb; margin-top: 4px; word-break: break-all;"><strong>A:</strong> ${escapeHtml(card.back)}</div>
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
          <button id="btn-open-settings" class="btn-secondary" style="font-size: 13px; padding: 8px 10px;">⚙️ 설정</button>
          <button id="btn-back" class="btn-secondary" style="font-size: 13px; padding: 8px 12px;">⬅ 목록</button>
        </div>
      </div>

      <div class="card-box">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
          <h4 style="margin: 0; font-size: 16px;">✏️ 새 단어 추가</h4>
          <label class="btn-secondary" style="font-size: 12px; padding: 6px 10px; cursor: pointer;">
            📂 CSV 대량 등록
            <input type="file" id="input-csv-file" accept=".csv, .tsv, .txt" style="display: none;" />
          </label>
        </div>
        <div class="form-row">
          <input type="text" id="input-card-front" placeholder="앞면: 단어/질문 (예: Persistent)" />
          <input type="text" id="input-card-back" placeholder="뒷면: 뜻/정답 (예: 끈질긴, 지속되는)" />
          <button id="btn-add-card" class="btn-primary">단어 추가</button>
        </div>
      </div>

      <div class="card-box">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h4 style="margin: 0; font-size: 16px;">🗂️ 등록된 카드 (${deck.cards.length}개)</h4>
          ${deck.cards.length > 0 ? `<button id="btn-clear-deck-cards" class="btn-danger" style="font-size: 11px; padding: 4px 8px;">전체 삭제</button>` : ''}
        </div>
        ${cardRowsHtml || '<p style="color: #94a3b8; font-size: 14px;">등록된 카드가 없습니다.</p>'}
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
        alert('추가할 수 있는 유효한 단어가 없습니다. 파일 형식(앞면, 뒷면)을 확인해주세요.');
        return;
      }

      const confirmMsg = `'${file.name}' 파일에서 한글 정상 복원 완료!\n\n유효 단어: ${parseResult.validCards.length}개\n건너뛴 행: ${parseResult.skippedCount}개\n\n지금 등록하시겠습니까?`;
      if (!confirm(confirmMsg)) return;

      for (const item of parseResult.validCards) {
        await api.addCard(deck.id, item.front, item.back);
      }

      alert(`🎉 ${parseResult.validCards.length}개의 단어가 정상 등록되었습니다!`);
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
 * 3. 플래시카드 학습룸 화면
 */
async function renderStudyRoom(): Promise<void> {
  const data = await api.getStorageData();
  const deck = data.decks.find(d => d.id === studyingDeckId);

  if (!deck || currentCardIndex >= studyQueue.length) {
    appElement!.innerHTML = `
      <div class="container" style="text-align: center; margin-top: 40px;">
        <div class="card-box" style="padding: 36px 16px;">
          <h1 style="font-size: 40px; margin: 0 0 12px 0;">🎉</h1>
          <h2 style="color: #1e293b; font-size: 20px;">오늘의 학습을 모두 완료했습니다!</h2>
          <p style="color: #64748b; font-size: 14px; margin-bottom: 20px;">망각곡선 알고리즘에 따라 다음 복습 일정이 예약되었습니다.</p>
          <button id="btn-finish-study" class="btn-primary" style="padding: 12px 20px; font-size: 15px;">대시보드로 돌아가기</button>
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
  const remainingCount = studyQueue.length - currentCardIndex;

  appElement!.innerHTML = `
    <div class="container">
      <div class="header">
        <div>
          <h3 style="margin: 0; font-size: 17px; word-break: break-all;">📖 [${escapeHtml(deck.name)}]</h3>
          <div style="font-size: 12px; color: #64748b; margin-top: 2px;">
            남은 카드: <b>${remainingCount}</b>개 (${currentCardIndex + 1}/${studyQueue.length})
          </div>
        </div>
        <button id="btn-quit-study" class="btn-secondary" style="font-size: 12px; padding: 6px 10px;">중단</button>
      </div>

      <div class="study-box">
        <div class="study-question">${escapeHtml(currentCard.front)}</div>
        ${isAnswerRevealed ? `
          <div class="study-divider"></div>
          <div class="study-answer">${escapeHtml(currentCard.back)}</div>
        ` : ''}
      </div>

      ${!isAnswerRevealed ? `
        <button id="btn-reveal" class="btn-primary" style="width: 100%; padding: 16px; font-size: 16px;">
          정답 확인하기 (단축키: Space)
        </button>
      ` : `
        <div class="rating-grid">
          <button class="btn-rate btn-again" data-rating="1">
            <b>1. 다시</b>
            <span class="key-hint">내일 복습 [1]</span>
          </button>
          <button class="btn-rate btn-hard" data-rating="2">
            <b>2. 어려움</b>
            <span class="key-hint">소폭 연장 [2]</span>
          </button>
          <button class="btn-rate btn-good" data-rating="3">
            <b>3. 알맞음</b>
            <span class="key-hint">표준 간격 [3]</span>
          </button>
          <button class="btn-rate btn-easy" data-rating="4">
            <b>4. 쉬움</b>
            <span class="key-hint">장기 기억 [4]</span>
          </button>
        </div>
      `}
    </div>
  `;

  document.getElementById('btn-quit-study')?.addEventListener('click', () => {
    studyingDeckId = null;
    render();
  });

  document.getElementById('btn-reveal')?.addEventListener('click', () => {
    isAnswerRevealed = true;
    render();
  });

  document.querySelectorAll('.btn-rate').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const rating = Number((e.currentTarget as HTMLButtonElement).dataset.rating) as ReviewRating;
      await handleRating(rating);
    });
  });

  setKeyboardListener(async (e: KeyboardEvent) => {
    if (!isAnswerRevealed && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      isAnswerRevealed = true;
      render();
    } else if (isAnswerRevealed) {
      if (['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        await handleRating(Number(e.key) as ReviewRating);
      }
    }
  });
}

async function handleRating(rating: ReviewRating): Promise<void> {
  const currentCard = studyQueue[currentCardIndex];
  if (!studyingDeckId || !currentCard) return;

  await api.reviewCard(studyingDeckId, currentCard.id, rating);
  currentCardIndex++;
  isAnswerRevealed = false;
  await render();
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