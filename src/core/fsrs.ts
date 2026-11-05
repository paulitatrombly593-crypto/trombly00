import { Card, ReviewRating, ReviewLog, AnkiSettings } from '../shared/types';

export interface FSRSResult {
  updatedCard: Card;
  log: ReviewLog;
  nextDueText: string;
}

/**
 * FSRS-5 공식 표준 가중치 (19개 파라미터)
 */
const DEFAULT_FSRS_WEIGHTS = [
  0.40255, 1.18385, 3.173, 15.69105, // w[0..3]: 등급 1~4별 초기 안정성 S0(G)
  7.1949,                            // w[4]: 초기 난이도 D0(1) 기준값
  0.5345,                            // w[5]: 초기 난이도 등급별 감소 폭
  1.4604,                            // w[6]: 복습 시 난이도 변화율
  0.0046,                            // w[7]: 난이도 평균 회귀(Mean Reversion) 가중치
  1.54575,                           // w[8]: 성공 시 안정성 증가 기본 계수
  0.1192,                            // w[9]: 안정성 감쇠 지수 (S^-w9)
  1.01925,                           // w[10]: 인출 가능성(R) 반영 계수 (Spacing Effect)
  1.9395,                            // w[11]: 실패(Again) 후 안정성 기본 계수
  0.11,                              // w[12]: 실패 후 난이도 지수
  0.29605,                           // w[13]: 실패 후 기존 안정성 반영 지수
  2.2698,                            // w[14]: 실패 후 인출 가능성 반영 계수
  0.2315,                            // w[15]: 어려움(Hard) 안정성 페널티
  2.9898,                            // w[16]: 쉬움(Easy) 안정성 보너스
  0.51655,                           // w[17]: 단기 학습 안정성 계수 1
  0.6621                             // w[18]: 단기 학습 안정성 계수 2
];

export class FSRSScheduler {
  private static readonly DECAY = -0.5;
  private static readonly FACTOR = 19 / 81;
  private static readonly w = DEFAULT_FSRS_WEIGHTS;

  private static clampDifficulty(d: number): number {
    if (!Number.isFinite(d)) return 5.0;
    return Math.min(10.0, Math.max(1.0, Number(d.toFixed(2))));
  }

  private static clampStability(s: number): number {
    if (!Number.isFinite(s) || s <= 0) return 0.1;
    return Math.min(36500, Math.max(0.1, Number(s.toFixed(2))));
  }

  public static clampRetention(retentionPercent?: number): number {
    const val = Number(retentionPercent);
    if (!Number.isFinite(val) || val <= 0) return 0.90;
    const r = val > 1 ? val / 100 : val;
    return Math.min(0.97, Math.max(0.70, r));
  }

  private static parseSafeSteps(stepsStr: string | undefined, fallback: number[]): number[] {
    if (!stepsStr || typeof stepsStr !== 'string') return fallback;
    const parsed = stepsStr
      .trim()
      .split(/\s+/)
      .map(s => parseFloat(s))
      .filter(n => Number.isFinite(n) && n > 0);
    return parsed.length > 0 ? parsed : fallback;
  }

  /**
   * 현재 시점의 실시간 기억 인출 확률 R (0.0 ~ 1.0) 계산 (Invalid Date 완벽 방어)
   */
  public static getRetrievability(card: Card, now: Date = new Date(), inheritProgress = true): number {
    if (!card || card.state === 'new') return 0;

    let stability = Number(card.stability);
    if (!Number.isFinite(stability) || stability <= 0) {
      if (inheritProgress && Number(card.interval) > 0) {
        stability = Math.max(0.5, Number(card.interval));
      } else {
        return card.state === 'review' ? 0.9 : 0.5;
      }
    }

    const rawDateStr = card.lastReviewedAt || card.updatedAt || card.createdAt;
    const parsedTime = rawDateStr ? new Date(rawDateStr).getTime() : now.getTime();
    const safeLastTime = Number.isFinite(parsedTime) ? parsedTime : now.getTime();

    const elapsedDays = Math.max(0, (now.getTime() - safeLastTime) / (1000 * 60 * 60 * 24));
    const r = Math.pow(1 + (this.FACTOR * elapsedDays) / this.clampStability(stability), this.DECAY);
    if (!Number.isFinite(r)) return 0.9;
    return Math.min(1.0, Math.max(0.0, r));
  }

  private static initStability(rating: ReviewRating): number {
    const idx = Math.min(3, Math.max(0, rating - 1));
    return this.clampStability(this.w[idx]);
  }

  private static initDifficulty(rating: ReviewRating): number {
    const d0 = this.w[4] - Math.exp(this.w[5] * (rating - 1)) + 1;
    return this.clampDifficulty(d0);
  }

  private static nextDifficulty(d: number, rating: ReviewRating): number {
    const deltaD = -this.w[6] * (rating - 3);
    const dampedD = d + (deltaD * (10 - d)) / 9;
    const d0Easy = this.initDifficulty(4);
    const nextD = this.w[7] * d0Easy + (1 - this.w[7]) * dampedD;
    return this.clampDifficulty(nextD);
  }

  private static nextRecallStability(d: number, s: number, r: number, rating: ReviewRating): number {
    const hardPenalty = rating === 2 ? this.w[15] : 1;
    const easyBonus = rating === 4 ? this.w[16] : 1;

    const growth =
      Math.exp(this.w[8]) *
      (11 - d) *
      Math.pow(this.clampStability(s), -this.w[9]) *
      (Math.exp((1 - r) * this.w[10]) - 1) *
      hardPenalty *
      easyBonus;

    return this.clampStability(s * (1 + Math.max(0, growth)));
  }

  private static nextForgetStability(d: number, s: number, r: number): number {
    const sForget =
      this.w[11] *
      Math.pow(this.clampDifficulty(d), -this.w[12]) *
      (Math.pow(this.clampStability(s) + 1, this.w[13]) - 1) *
      Math.exp((1 - r) * this.w[14]);

    return this.clampStability(Math.min(s, sForget));
  }

  private static nextIntervalDays(s: number, requestRetention?: number, maxInterval?: number): number {
    const r = this.clampRetention(requestRetention);
    const maxIvl = Math.max(1, Number(maxInterval) || 180);
    const rawInterval = (this.clampStability(s) / this.FACTOR) * (Math.pow(r, 1 / this.DECAY) - 1);
    const rounded = Number.isFinite(rawInterval) ? Math.round(rawInterval) : 1;
    return Math.min(maxIvl, Math.max(1, rounded));
  }

  private static resolveInitialDS(
    card: Card,
    rating: ReviewRating,
    inheritProgress: boolean
  ): { s: number; d: number; isFirstFSRS: boolean } {
    if (
      card.stability !== undefined &&
      card.difficulty !== undefined &&
      Number.isFinite(card.stability) &&
      card.stability > 0
    ) {
      return {
        s: this.clampStability(card.stability),
        d: this.clampDifficulty(card.difficulty),
        isFirstFSRS: false
      };
    }

    // ☑️ [기존 진도 이어받기 ON]이고 기존 SM-2 복습 간격이 있는 경우 무손실 변환
    if (inheritProgress && card.state === 'review' && Number(card.interval) > 0) {
      const inheritedS = this.clampStability(Math.max(1, Number(card.interval)));
      const ef = Number(card.easeFactor) || 2.5;
      const inheritedD = this.clampDifficulty(11 - 2.5 * ef);
      return { s: inheritedS, d: inheritedD, isFirstFSRS: false };
    }

    // [기존 진도 이어받기 OFF]이거나 신규 카드인 경우 순수 FSRS 초기값으로 출발
    return {
      s: this.initStability(rating),
      d: this.initDifficulty(rating),
      isFirstFSRS: true
    };
  }

  public static calculate(
    card: Card,
    rating: ReviewRating,
    now: Date = new Date(),
    settings?: Partial<AnkiSettings>,
    durationSeconds?: number
  ): FSRSResult {
    const steps = this.parseSafeSteps(settings?.learningSteps, [2, 10]);
    const rSteps = this.parseSafeSteps(settings?.relearningSteps, [10]);
    const inheritProgress = settings?.fsrsInheritProgress ?? true;
    const desiredRetention = settings?.desiredRetention ?? 90;
    const maxInterval = Math.max(1, Number(settings?.maxInterval) || 180);
    const minInterval = Math.max(1, Number(settings?.minInterval) || 1);
    const easyInterval = Math.max(1, Number(settings?.easyInterval) || 4);
    const leechThreshold = Math.max(3, Number(settings?.leechThreshold) || 8);

    const lastInterval = Number(card.interval) || 0;
    let nextIntervalDays = lastInterval;
    let nextDueDate = new Date(now.getTime());
    let nextDueText = '';

    let nextState = card.state;
    let nextStepIndex = card.stepIndex ?? 0;
    let nextRepetitions = Number(card.repetitions) || 0;
    let nextLapses = Number(card.lapses) || 0;
    let isLeech = Boolean(card.isLeech);
    let suspended = Boolean(card.suspended);

    const { s: currentS, d: currentD, isFirstFSRS } = this.resolveInitialDS(card, rating, inheritProgress);
    let nextS = currentS;
    let nextD = currentD;

    if (card.state === 'new' || card.state === 'learning') {
      if (isFirstFSRS) {
        nextS = this.initStability(rating);
        nextD = this.initDifficulty(rating);
      } else {
        nextD = this.nextDifficulty(currentD, rating);
        nextS = this.clampStability(currentS * Math.exp(this.w[17] * (rating - 3 + this.w[18])));
      }

      if (rating === 1) {
        nextState = 'learning';
        nextStepIndex = 0;
        nextIntervalDays = 0;
        const mins = steps[0];
        nextDueDate = new Date(now.getTime() + mins * 60 * 1000);
        nextDueText = `${mins}분`;
      } else if (rating === 2) {
        nextState = 'learning';
        nextIntervalDays = 0;
        const curMin = steps[Math.min(nextStepIndex, steps.length - 1)];
        const nxtMin = steps[Math.min(nextStepIndex + 1, steps.length - 1)];
        const hardMins = Math.max(1, Math.round((curMin + nxtMin) / 2));
        nextDueDate = new Date(now.getTime() + hardMins * 60 * 1000);
        nextDueText = `${hardMins}분`;
      } else if (rating === 3) {
        const nextIdx = card.state === 'new' ? 1 : nextStepIndex + 1;
        if (nextIdx < steps.length) {
          nextState = 'learning';
          nextStepIndex = nextIdx;
          nextIntervalDays = 0;
          const mins = steps[nextIdx];
          nextDueDate = new Date(now.getTime() + mins * 60 * 1000);
          nextDueText = `${mins}분`;
        } else {
          nextState = 'review';
          nextStepIndex = 0;
          nextRepetitions = 1;
          nextIntervalDays = this.nextIntervalDays(nextS, desiredRetention, maxInterval);
          nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
          nextDueText = `${nextIntervalDays}일`;
        }
      } else {
        nextState = 'review';
        nextStepIndex = 0;
        nextRepetitions = 1;
        nextIntervalDays = Math.max(easyInterval, this.nextIntervalDays(nextS, desiredRetention, maxInterval));
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      }
    } else if (card.state === 'relearning') {
      nextD = this.nextDifficulty(currentD, rating);
      if (rating === 1) {
        nextStepIndex = 0;
        const mins = rSteps[0];
        nextDueDate = new Date(now.getTime() + mins * 60 * 1000);
        nextDueText = `${mins}분`;
      } else if (rating === 2) {
        const mins = Math.max(1, Math.round(rSteps[0] * 1.2));
        nextDueDate = new Date(now.getTime() + mins * 60 * 1000);
        nextDueText = `${mins}분`;
      } else {
        nextState = 'review';
        nextStepIndex = 0;
        if (rating === 4) nextS = this.clampStability(currentS * 1.3);
        nextIntervalDays = Math.max(minInterval, this.nextIntervalDays(nextS, desiredRetention, maxInterval));
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      }
    } else {
      const r = this.getRetrievability(card, now, inheritProgress);
      nextD = this.nextDifficulty(currentD, rating);

      if (rating === 1) {
        nextLapses += 1;
        nextRepetitions = 0;
        nextS = this.nextForgetStability(currentD, currentS, r);

        if (nextLapses >= leechThreshold) {
          isLeech = true;
          if (settings?.leechAction === 'suspend') suspended = true;
        }

        nextIntervalDays = this.nextIntervalDays(nextS, desiredRetention, maxInterval);
        nextState = 'relearning';
        nextStepIndex = 0;
        const mins = rSteps[0];
        nextDueDate = new Date(now.getTime() + mins * 60 * 1000);
        nextDueText = `${mins}분`;
      } else {
        nextRepetitions += 1;
        nextS = this.nextRecallStability(currentD, currentS, r, rating);
        let calculatedDays = this.nextIntervalDays(nextS, desiredRetention, maxInterval);

        const baseIvl = Math.max(1, lastInterval);
        if (rating === 2) {
          calculatedDays = Math.max(baseIvl + 1, Math.min(calculatedDays, Math.round(baseIvl * 1.25)));
        } else if (rating === 3) {
          calculatedDays = Math.max(baseIvl + 1, calculatedDays);
        } else if (rating === 4) {
          const goodS = this.nextRecallStability(currentD, currentS, r, 3);
          const goodDays = Math.max(baseIvl + 1, this.nextIntervalDays(goodS, desiredRetention, maxInterval));
          calculatedDays = Math.max(goodDays + 1, calculatedDays);
        }

        nextIntervalDays = Math.min(maxInterval, calculatedDays);
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      }
    }

    const syncedEase = Number(Math.max(1.3, (11 - nextD) / 2.5).toFixed(2));

    const updatedCard: Card = {
      ...card,
      state: nextState,
      dueDate: nextDueDate.toISOString(),
      lastReviewedAt: now.toISOString(),
      interval: nextIntervalDays,
      stepIndex: nextStepIndex,
      easeFactor: syncedEase,
      stability: nextS,
      difficulty: nextD,
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
      easeFactor: syncedEase,
      stability: nextS,
      difficulty: nextD,
      durationSeconds
    };

    return { updatedCard, log, nextDueText };
  }
}