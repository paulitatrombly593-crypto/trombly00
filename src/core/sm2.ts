import { Card, ReviewRating, ReviewLog, AnkiSettings } from '../shared/types';

export interface ScheduleResult {
  updatedCard: Card;
  log: ReviewLog;
  nextDueText: string; // 버튼 밑에 표시될 주기 텍스트 (예: "10분", "1일", "4일")
}

/**
 * 인터넷 커뮤니티 및 정통 Anki 사용자들이 가장 추천하는 '국밥 기본 세팅'
 */
export const DEFAULT_ANKI_SETTINGS: AnkiSettings = {
  // 1. 새 카드 탭
  learningSteps: '2 10',
  newCardOrder: 'sequential',
  newCardsPerDay: 20,
  graduatingInterval: 1,
  easyInterval: 4,
  startingEase: 250,
  buryRelatedNew: false,

  // 2. 복습 탭
  maxReviewsPerDay: 9999,
  easyBonus: 130,
  intervalModifier: 100,
  maxInterval: 180,
  hardInterval: 120,
  buryRelatedReviews: false,

  // 3. 실패 탭
  relearningSteps: '10',
  newIntervalPercent: 0,
  minInterval: 1,
  leechThreshold: 8,
  leechAction: 'tag',

  // 4. 일반 탭
  maxAnswerSeconds: 60,
  showTimer: true,
  autoPlayAudio: false,
  replayQuestionAudio: false,

  // 5. 화면 설정
  viewMode: typeof window !== 'undefined' && window.innerWidth <= 640 ? 'mobile' : 'pc',
  themeMode: 'dark'
};

export class SM2Scheduler {
  private static readonly MIN_EASE_FACTOR = 1.3;

  /**
   * "2 10" 같은 분 단위 문자열을 숫자 배열 [2, 10]으로 변환
   */
  public static parseSteps(stepsStr: string, fallback: number[] = [2, 10]): number[] {
    const parsed = stepsStr
      .trim()
      .split(/\s+/)
      .map(s => parseFloat(s))
      .filter(n => !isNaN(n) && n > 0);
    return parsed.length > 0 ? parsed : fallback;
  }

  /**
   * Anki 설정값을 반영하여 카드를 스케줄링합니다.
   */
  public static calculate(
    card: Card,
    rating: ReviewRating,
    now: Date = new Date(),
    settings: AnkiSettings = DEFAULT_ANKI_SETTINGS,
    durationSeconds?: number
  ): ScheduleResult {
    const learnSteps = this.parseSteps(settings.learningSteps, [2, 10]);
    const relearnSteps = this.parseSteps(settings.relearningSteps, [10]);

    const lastInterval = card.interval;
    let nextIntervalDays = card.interval;
    let nextDueDate = new Date(now.getTime());
    let nextDueText = '';

    let nextEaseFactor = card.easeFactor || settings.startingEase / 100;
    let nextRepetitions = card.repetitions;
    let nextLapses = card.lapses;
    let nextState = card.state;
    let nextStepIndex = card.stepIndex ?? 0;
    let isLeech = card.isLeech ?? false;
    let suspended = card.suspended ?? false;

    const hardMult = settings.hardInterval / 100;
    const easyMult = settings.easyBonus / 100;
    const ivlMod = settings.intervalModifier / 100;
    const maxIvl = Math.max(1, settings.maxInterval);

    // ---------------------------------------------------------
    // CASE A: 새 카드(new) 또는 익힘 중인 카드(learning)
    // ---------------------------------------------------------
    if (card.state === 'new' || card.state === 'learning') {
      if (rating === 1) {
        // 1. 다시 (Again) -> 첫 번째 익힘 단계(예: 2분)로 이동
        nextState = 'learning';
        nextStepIndex = 0;
        nextRepetitions = 0;
        nextIntervalDays = 0;
        const mins = learnSteps[0];
        nextDueDate = new Date(now.getTime() + mins * 60 * 1000);
        nextDueText = `${mins}분`;
      } else if (rating === 2) {
        // 2. 어려움 (Hard) -> 첫 단계와 다음 단계의 평균 분
        nextState = 'learning';
        nextIntervalDays = 0;
        const currentStepMin = learnSteps[Math.min(nextStepIndex, learnSteps.length - 1)];
        const nextStepMin = learnSteps[Math.min(nextStepIndex + 1, learnSteps.length - 1)];
        const hardMins = Math.max(1, Math.round((currentStepMin + nextStepMin) / 2));
        nextDueDate = new Date(now.getTime() + hardMins * 60 * 1000);
        nextDueText = `${hardMins}분`;
      } else if (rating === 3) {
        // 3. 알맞음 (Good) -> 다음 익힘 단계로 진급하거나 졸업!
        const nextIdx = card.state === 'new' ? 1 : nextStepIndex + 1;
        if (nextIdx < learnSteps.length) {
          nextState = 'learning';
          nextStepIndex = nextIdx;
          nextIntervalDays = 0;
          const mins = learnSteps[nextIdx];
          nextDueDate = new Date(now.getTime() + mins * 60 * 1000);
          nextDueText = `${mins}분`;
        } else {
          // 모든 분 단위 단계를 마치고 장기 복습(Review)으로 졸업!
          nextState = 'review';
          nextStepIndex = 0;
          nextRepetitions = 1;
          nextIntervalDays = Math.min(maxIvl, Math.max(1, settings.graduatingInterval));
          nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
          nextDueText = `${nextIntervalDays}일`;
        }
      } else {
        // 4. 쉬움 (Easy) -> 즉시 장기 복습(Review)으로 조기 졸업!
        nextState = 'review';
        nextStepIndex = 0;
        nextRepetitions = 1;
        nextIntervalDays = Math.min(maxIvl, Math.max(1, settings.easyInterval));
        nextEaseFactor += 0.15;
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      }
    }
    // ---------------------------------------------------------
    // CASE B: 실패 후 재학습 중인 카드(relearning)
    // ---------------------------------------------------------
    else if (card.state === 'relearning') {
      if (rating === 1) {
        nextStepIndex = 0;
        const mins = relearnSteps[0];
        nextDueDate = new Date(now.getTime() + mins * 60 * 1000);
        nextDueText = `${mins}분`;
      } else if (rating === 2) {
        const mins = Math.max(1, Math.round(relearnSteps[Math.min(nextStepIndex, relearnSteps.length - 1)] * 1.2));
        nextDueDate = new Date(now.getTime() + mins * 60 * 1000);
        nextDueText = `${mins}분`;
      } else if (rating === 3) {
        const nextIdx = nextStepIndex + 1;
        if (nextIdx < relearnSteps.length) {
          nextStepIndex = nextIdx;
          const mins = relearnSteps[nextIdx];
          nextDueDate = new Date(now.getTime() + mins * 60 * 1000);
          nextDueText = `${mins}분`;
        } else {
          nextState = 'review';
          nextStepIndex = 0;
          nextIntervalDays = Math.max(settings.minInterval, card.interval || 1);
          nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
          nextDueText = `${nextIntervalDays}일`;
        }
      } else {
        nextState = 'review';
        nextStepIndex = 0;
        nextIntervalDays = Math.max(settings.minInterval + 1, Math.round((card.interval || 1) * easyMult));
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      }
    }
    // ---------------------------------------------------------
    // CASE C: 정규 복습 카드(review)
    // ---------------------------------------------------------
    else {
      const baseIvl = Math.max(1, card.interval);

      if (rating === 1) {
        // 실패(Again) -> 거머리(Leech) 검사 및 재학습 진입
        nextLapses += 1;
        nextRepetitions = 0;
        nextEaseFactor = Math.max(this.MIN_EASE_FACTOR, nextEaseFactor - 0.2);

        if (nextLapses >= settings.leechThreshold) {
          isLeech = true;
          if (settings.leechAction === 'suspend') {
            suspended = true;
          }
        }

        const reducedIvl = Math.max(
          settings.minInterval,
          Math.round(baseIvl * (settings.newIntervalPercent / 100))
        );
        nextIntervalDays = reducedIvl;

        if (relearnSteps.length > 0) {
          nextState = 'relearning';
          nextStepIndex = 0;
          const mins = relearnSteps[0];
          nextDueDate = new Date(now.getTime() + mins * 60 * 1000);
          nextDueText = `${mins}분`;
        } else {
          nextState = 'review';
          nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
          nextDueText = `${nextIntervalDays}일`;
        }
      } else if (rating === 2) {
        // 어려움(Hard)
        nextRepetitions += 1;
        nextEaseFactor = Math.max(this.MIN_EASE_FACTOR, nextEaseFactor - 0.15);
        nextIntervalDays = Math.min(maxIvl, Math.max(baseIvl + 1, Math.round(baseIvl * hardMult * ivlMod)));
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      } else if (rating === 3) {
        // 알맞음(Good)
        nextRepetitions += 1;
        nextIntervalDays = Math.min(maxIvl, Math.max(baseIvl + 1, Math.round(baseIvl * nextEaseFactor * ivlMod)));
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      } else {
        // 쉬움(Easy)
        nextRepetitions += 1;
        nextEaseFactor += 0.15;
        nextIntervalDays = Math.min(
          maxIvl,
          Math.max(baseIvl + 2, Math.round(baseIvl * nextEaseFactor * easyMult * ivlMod))
        );
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      }
    }

    const updatedCard: Card = {
      ...card,
      state: nextState,
      dueDate: nextDueDate.toISOString(),
      lastReviewedAt: now.toISOString(),
      interval: nextIntervalDays,
      stepIndex: nextStepIndex,
      easeFactor: Number(nextEaseFactor.toFixed(2)),
      repetitions: nextRepetitions,
      lapses: nextLapses,
      isLeech,
      suspended,
      updatedAt: now.toISOString()
    };

    const log: ReviewLog = {
      id: `log_${now.getTime()}_${Math.random().toString(36).substring(2, 7)}`,
      cardId: card.id,
      deckId: card.deckId,
      rating,
      reviewDate: now.toISOString(),
      lastInterval,
      scheduledInterval: nextIntervalDays,
      easeFactor: updatedCard.easeFactor,
      durationSeconds
    };

    return { updatedCard, log, nextDueText };
  }

  /**
   * 4개 평가 버튼 밑에 표시할 예상 복습 주기를 미리 시뮬레이션하여 반환합니다.
   */
  public static getPreviewLabels(
    card: Card,
    settings: AnkiSettings = DEFAULT_ANKI_SETTINGS
  ): Record<ReviewRating, string> {
    const now = new Date();
    return {
      1: this.calculate(card, 1, now, settings).nextDueText,
      2: this.calculate(card, 2, now, settings).nextDueText,
      3: this.calculate(card, 3, now, settings).nextDueText,
      4: this.calculate(card, 4, now, settings).nextDueText
    };
  }

  /**
   * 현재 복습 대상인지 확인 (보류된 카드는 제외)
   */
  public static isDue(card: Card, today: Date = new Date()): boolean {
    if (card.suspended) return false;
    const cardDueDate = new Date(card.dueDate);
    return cardDueDate.getTime() <= today.getTime();
  }

  /**
   * 카드 목록에 표시할 '다음 복습 예정' 스마트 라벨 생성
   */
  public static formatDueBadge(card: Card, now: Date = new Date()): string {
    if (card.suspended) return '⏸️ 보류됨(거머리)';
    if (card.state === 'new') return '🌱 새 카드 (대기중)';

    const due = new Date(card.dueDate);
    const diffMs = due.getTime() - now.getTime();

    if (diffMs <= 0) {
      return '🔥 지금 복습 대상';
    }

    const diffMins = Math.ceil(diffMs / (1000 * 60));
    if (diffMins < 60) {
      return `⏳ ${diffMins}분 후 복습`;
    }

    const diffHours = Math.ceil(diffMins / 60);
    if (diffHours < 24) {
      return `⏳ 약 ${diffHours}시간 후`;
    }

    const diffDays = Math.ceil(diffHours / 24);
    const dateStr = `${due.getMonth() + 1}/${due.getDate()}`;
    return `📅 ${diffDays}일 후 (${dateStr})`;
  }

  /**
   * 카드 목록에 표시할 '마지막 학습 일시' 스마트 라벨 생성
   */
  public static formatLastReviewed(card: Card): string {
    if (!card.lastReviewedAt) return '학습 기록 없음';
    const d = new Date(card.lastReviewedAt);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}.${mm}.${dd} ${hh}:${min}`;
  }
}