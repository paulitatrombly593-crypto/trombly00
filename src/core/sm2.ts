import { Card, ReviewRating, ReviewLog } from '../shared/types';

/**
 * SM-2 알고리즘 계산 결과 인터페이스
 */
export interface ScheduleResult {
  updatedCard: Card;
  log: ReviewLog;
}

/**
 * SuperMemo-2 (SM-2) 망각곡선 스케줄러
 */
export class SM2Scheduler {
  private static readonly MIN_EASE_FACTOR = 1.3;
  private static readonly DEFAULT_EASE_FACTOR = 2.5;

  /**
   * 카드를 복습 평가하고 다음 일정과 로그를 반환합니다.
   * @param card 대상 카드
   * @param rating 사용자 평가 (1: Again, 2: Hard, 3: Good, 4: Easy)
   * @param now 현재 기준 시각 (기본값: 현재 시간)
   */
  public static calculate(
    card: Card,
    rating: ReviewRating,
    now: Date = new Date()
  ): ScheduleResult {
    const lastInterval = card.interval;
    let nextInterval = 0;
    let nextEaseFactor = card.easeFactor || this.DEFAULT_EASE_FACTOR;
    let nextRepetitions = card.repetitions;
    let nextLapses = card.lapses;
    let nextState = card.state;

    switch (rating) {
      case 1: { // Again (완전 잊어버림)
        nextRepetitions = 0;
        nextInterval = 1; // 내일 다시 복습
        nextEaseFactor = Math.max(this.MIN_EASE_FACTOR, nextEaseFactor - 0.2);
        nextLapses += 1;
        nextState = 'learning';
        break;
      }

      case 2: { // Hard (간신히 기억남)
        nextRepetitions += 1;
        // 기존 간격의 1.2배로 소폭 증가 (최소 1일 보장)
        nextInterval = Math.max(1, Math.round(lastInterval * 1.2));
        nextEaseFactor = Math.max(this.MIN_EASE_FACTOR, nextEaseFactor - 0.15);
        nextState = 'review';
        break;
      }

      case 3: { // Good (적당히 기억남 - 표준 SM-2)
        if (nextRepetitions === 0) {
          nextInterval = 1;
        } else if (nextRepetitions === 1) {
          nextInterval = 6;
        } else {
          nextInterval = Math.round(lastInterval * nextEaseFactor);
        }
        nextRepetitions += 1;
        // Ease Factor 유지
        nextState = 'review';
        break;
      }

      case 4: { // Easy (매우 쉬움)
        if (nextRepetitions === 0) {
          nextInterval = 4;
        } else if (nextRepetitions === 1) {
          nextInterval = 10;
        } else {
          // 보너스 배수 1.3배 추가 적용
          nextInterval = Math.round(lastInterval * nextEaseFactor * 1.3);
        }
        nextRepetitions += 1;
        nextEaseFactor += 0.15;
        nextState = 'review';
        break;
      }
    }

    // 다음 복습 예정 일시 = 오늘(now) + 계산된 간격(nextInterval 일)
    const nextDueDate = new Date(now.getTime());
    nextDueDate.setDate(nextDueDate.getDate() + nextInterval);

    const updatedCard: Card = {
      ...card,
      state: nextState,
      dueDate: nextDueDate.toISOString(),
      interval: nextInterval,
      easeFactor: Number(nextEaseFactor.toFixed(2)),
      repetitions: nextRepetitions,
      lapses: nextLapses,
      updatedAt: now.toISOString()
    };

    const log: ReviewLog = {
      id: `log_${now.getTime()}_${Math.random().toString(36).substring(2, 7)}`,
      cardId: card.id,
      deckId: card.deckId,
      rating,
      reviewDate: now.toISOString(),
      lastInterval,
      scheduledInterval: nextInterval,
      easeFactor: updatedCard.easeFactor
    };

    return { updatedCard, log };
  }

  /**
   * 오늘 기준으로 복습해야 할 카드인지 판별
   * @param card 카드
   * @param today 오늘 날짜
   */
  public static isDue(card: Card, today: Date = new Date()): boolean {
    const cardDueDate = new Date(card.dueDate);
    return cardDueDate.getTime() <= today.getTime();
  }
}