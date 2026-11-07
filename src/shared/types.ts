export type CardState = 'new' | 'learning' | 'relearning' | 'review';

export type ReviewRating = 1 | 2 | 3 | 4;

export type SchedulerEngineType = 'fsrs' | 'sm2';

/**
 * 안키(Anki) 정통 옵션 그룹 및 FSRS 차세대 스케줄러 설정 스키마
 */
export interface AnkiSettings {
  // 🚀 [FSRS 차세대 엔진] 설정
  schedulerEngine: SchedulerEngineType; // 'fsrs' (추천) | 'sm2' (고전)
  desiredRetention: number;             // FSRS 목표 기억 유지율 (%, 안전 범위: 70 ~ 97, 기본: 90)
  fsrsInheritProgress: boolean;         // 기존 SM-2 학습 진도(간격/난이도)를 이어받을지 여부 (체크박스)

  // 1. [새 카드] 탭 설정
  learningSteps: string;        // 익힘 단계(분 단위), 예: "2 10"
  newCardOrder: 'sequential' | 'random';
  newCardsPerDay: number;       // 새 카드/일 (일일 새 단어 목표량)
  graduatingInterval: number;   // 졸업 간격 (일)
  easyInterval: number;         // 쉬움(즉시 졸업) 복습 주기 (일)
  startingEase: number;         // 초기 수월함 (%, 기본 250)
  buryRelatedNew: boolean;

  // 2. [복습] 탭 설정
  maxReviewsPerDay: number;     // 최대 복습량/일 (일일 복습 목표량)
  easyBonus: number;            // 쉬움 버튼 보너스 (%, 예: 130~200)
  intervalModifier: number;     // 복습 주기 조정값 (%, 예: 100~150)
  maxInterval: number;          // 최대 복습 주기 (일, 예: 30~365)
  hardInterval: number;         // 어려움 반복 난이도 구간 (%, 기본 120)
  buryRelatedReviews: boolean;

  // 3. [실패] 탭 설정
  relearningSteps: string;      // 실패 시 익힘 단계(분 단위), 예: "10"
  newIntervalPercent: number;
  minInterval: number;
  leechThreshold: number;       // 거머리 기준 실패 횟수 (예: 8)
  leechAction: 'tag' | 'suspend';

  // 4. [일반] 탭 설정
  maxAnswerSeconds: number;
  showTimer: boolean;
  autoPlayAudio: boolean;
  replayQuestionAudio: boolean;

  // 5. [화면 레이아웃 및 섹터별 글자색] 설정
  viewMode: 'pc' | 'mobile';
  themeMode: 'dark' | 'light';
  colorOuterBg?: string;      // 바깥쪽 여백 배경색 (VS Code 사이드바 회색 #252526)
  colorCardBg?: string;       // 플래시카드/박스 안쪽 배경색 (VS Code 에디터 블랙 #1e1e1e)
  colorBaseText?: string;
  colorWordText?: string;
  colorMeaningText?: string;
  colorHighlightText?: string;
}

/**
 * 단어 카드(Flashcard) 데이터 모델 (SM-2 및 FSRS DSR 모델 겸용)
 */
export interface Card {
  id: string;
  deckId: string;
  front: string;
  back: string;
  example?: string;
  imageData?: string;
  state: CardState;
  dueDate: string;          // 다음 복습 예정 일시 (ISO 8601)
  lastReviewedAt?: string;  // 마지막으로 학습한 일시 (ISO 8601)
  interval: number;         // 일 단위 복습 간격
  stepIndex?: number;       // 분 단위 익힘 단계 인덱스
  easeFactor: number;       // SM-2 수월함 배수 (기본 2.5)
  stability?: number;       // 🧠 FSRS 기억 안정성 S (기억률이 90%로 떨어지기까지 걸리는 일수)
  difficulty?: number;      // 🧠 FSRS 고유 난이도 D (1.0 ~ 10.0)
  repetitions: number;
  lapses: number;
  isLeech?: boolean;
  suspended?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Deck {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  cards: Card[];
}

export interface ReviewLog {
  id: string;
  cardId: string;
  deckId: string;
  rating: ReviewRating;
  reviewDate: string;
  lastInterval: number;
  scheduledInterval: number;
  easeFactor: number;
  stability?: number;
  difficulty?: number;
  durationSeconds?: number;
}

export interface StorageSchema {
  version: number;
  decks: Deck[];
  logs: ReviewLog[];
}