export type CardState = 'new' | 'learning' | 'relearning' | 'review';

export type ReviewRating = 1 | 2 | 3 | 4;

/**
 * 안키(Anki) 정통 옵션 그룹 설정 스키마 (사진 2~5번 완벽 대응)
 */
export interface AnkiSettings {
  // 1. [새 카드] 탭 설정
  learningSteps: string;        // 익힘 단계(분 단위), 예: "2 10"
  newCardOrder: 'sequential' | 'random'; // 추가한 순서대로 vs 무작위
  newCardsPerDay: number;       // 새 카드/일 (일일 새 단어 목표량)
  graduatingInterval: number;   // 졸업 간격 (일)
  easyInterval: number;         // 쉬움(즉시 졸업) 복습 주기 (일)
  startingEase: number;         // 초기 수월함 (%, 기본 250)
  buryRelatedNew: boolean;      // 연관된 새 카드를 다음날까지 덮어두기

  // 2. [복습] 탭 설정
  maxReviewsPerDay: number;     // 최대 복습량/일 (일일 복습 목표량)
  easyBonus: number;            // 쉬움 버튼 보너스 (%, 예: 130~200)
  intervalModifier: number;     // 복습 주기 조정값 (%, 예: 100~150)
  maxInterval: number;          // 최대 복습 주기 (일, 예: 30~365)
  hardInterval: number;         // 어려움 반복 난이도 구간 (%, 기본 120)
  buryRelatedReviews: boolean;  // 연관된 복습 카드를 다음날까지 덮어두기

  // 3. [실패] 탭 설정
  relearningSteps: string;      // 실패 시 익힘 단계(분 단위), 예: "10" 또는 "2 10"
  newIntervalPercent: number;   // 실패 후 새 복습 주기 비율 (%, 기본 0%)
  minInterval: number;          // 최소 복습 주기 (일, 기본 1)
  leechThreshold: number;       // 거머리 기준 실패 횟수 (예: 8 또는 15)
  leechAction: 'tag' | 'suspend'; // 거머리 처리: 태그만 달기 vs 카드 보류(유예)

  // 4. [일반] 탭 설정
  maxAnswerSeconds: number;     // 답변 시간이 너무 길 경우 무시할 기준 (초, 기본 60)
  showTimer: boolean;           // 학습 화면에 답변 시간 타이머 표시
  autoPlayAudio: boolean;       // 자동으로 오디오(TTS) 재생
  replayQuestionAudio: boolean; // 정답 확인 시 질문 오디오도 함께 재생

  // 5. [화면 레이아웃] 설정
  viewMode: 'pc' | 'mobile';
  themeMode: 'dark' | 'light';
}

/**
 * 단어 카드(Flashcard) 데이터 모델
 */
export interface Card {
  id: string;
  deckId: string;
  front: string;
  back: string;
  example?: string;         // 예문 (선택)
  imageData?: string;       // 자체 축소/압축된 Base64 이미지 데이터 (선택)
  state: CardState;
  dueDate: string;          // 다음 복습 예정 일시 (ISO 8601)
  lastReviewedAt?: string;  // 마지막으로 학습한 정확한 일시 (ISO 8601)
  interval: number;         // 일 단위 간격 (분 단위 학습 중일 때는 0)
  stepIndex?: number;       // 현재 분 단위 익힘 단계 인덱스 (0, 1, ...)
  easeFactor: number;       // 수월함 배수 (2.5 = 250%)
  repetitions: number;      // 연속 성공 횟수
  lapses: number;           // 누적 실패(Again) 횟수
  isLeech?: boolean;        // 거머리(자주 틀리는 단어) 태그 여부
  suspended?: boolean;      // 거머리 처리로 인해 학습 보류된 카드 여부
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
  durationSeconds?: number; // 답변에 걸린 시간(초)
}

export interface StorageSchema {
  version: number;
  decks: Deck[];
  logs: ReviewLog[];
}