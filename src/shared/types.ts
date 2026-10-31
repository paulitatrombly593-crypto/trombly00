/**
 * 카드의 현재 학습 상태
 * - new: 아직 한 번도 학습하지 않은 새 카드
 * - learning: 틀려서 다시 외우는 중인 카드
 * - review: 장기 기억 주기로 복습 중인 카드
 */
export type CardState = 'new' | 'learning' | 'review';

/**
 * 사용자가 정답을 확인한 후 누르는 4가지 기억 평가 등급
 * 1: Again (완전 잊어버림)
 * 2: Hard (간신히 기억남)
 * 3: Good (알맞게 기억남)
 * 4: Easy (매우 쉬움)
 */
export type ReviewRating = 1 | 2 | 3 | 4;

/**
 * 단어 카드(Flashcard) 데이터 모델
 */
export interface Card {
  id: string;              // 고유 식별자 (예: card_1730378400000_abc)
  deckId: string;          // 소속 덱 ID
  front: string;           // 문제 (단어, 질문)
  back: string;            // 정답 (뜻, 예문, 해설)
  state: CardState;        // 현재 학습 상태
  dueDate: string;         // 다음 복습 예정 일시 (ISO 8601 문자열: YYYY-MM-DDTHH:mm:ss.sssZ)
  interval: number;        // 복습 간격 (일 단위)
  easeFactor: number;      // 난이도 계수 (기본값: 2.5, 최솟값: 1.3)
  repetitions: number;     // 연속 정답 횟수
  lapses: number;          // 잊어버린 횟수 (Again을 누른 횟수)
  createdAt: string;       // 생성 일시
  updatedAt: string;       // 최종 수정 일시
}

/**
 * 덱(단어장) 데이터 모델
 */
export interface Deck {
  id: string;              // 고유 식별자 (예: deck_default)
  name: string;            // 단어장 이름 (예: "TOEIC 보카", "CS 기본 용어")
  description?: string;    // 단어장 설명
  createdAt: string;       // 생성 일시
  cards: Card[];           // 덱에 포함된 카드 목록
}

/**
 * 학습 및 복습 이력 로그 (통계 및 에러 복구용)
 */
export interface ReviewLog {
  id: string;              // 로그 고유 ID
  cardId: string;          // 복습한 카드 ID
  deckId: string;          // 소속 덱 ID
  rating: ReviewRating;    // 선택한 평가 (1~4)
  reviewDate: string;      // 복습 일시
  lastInterval: number;    // 복습 전 간격
  scheduledInterval: number; // 새로 계산된 간격
  easeFactor: number;      // 계산 후 난이도 계수
}

/**
 * 전체 저장소 데이터 루트 구조
 */
export interface StorageSchema {
  version: number;         // 데이터 스키마 버전 (향후 마이그레이션 대비)
  decks: Deck[];           // 단어장 목록
  logs: ReviewLog[];       // 전체 복습 로그
}