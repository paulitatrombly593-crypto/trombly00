import { Card, ReviewRating, ReviewLog, AnkiSettings } from '../shared/types';
import { SM2Scheduler, ScheduleResult } from './sm2';

export interface FsrsOptimizeResult {
  improved: boolean;
  sampleCount: number;
  baselineLoss: number;
  optimizedLoss: number;
  weights: number[];
  mode: 'pretrain' | 'full';
}

/**
 * 🚀 순수 FSRS-5 (Free Spaced Repetition Scheduler v5) DSR 엔진 + 개인화 최적화기
 */
export class FSRSScheduler {
  // FSRS-5 공식 글로벌 표준 파라미터 (w0 ~ w18)
  public static readonly DEFAULT_WEIGHTS: number[] = [
    0.40255,  // w0: 초기 안정성 S0(1: 다시)
    1.18385,  // w1: 초기 안정성 S0(2: 어려움) -> 약 1일
    3.17300,  // w2: 초기 안정성 S0(3: 알맞음) -> 약 3일
    15.69105, // w3: 초기 안정성 S0(4: 쉬움)   -> 약 16일
    7.1949,   // w4: 초기 난이도 D0 기준값
    0.5345,   // w5: 초기 난이도 지수 감소율
    1.4604,   // w6: 복습 시 난이도 변화 계수
    0.0046,   // w7: 난이도 평균 회귀(Mean Reversion) 가중치
    1.54575,  // w8: 복습 성공 시 안정성 증가 기본 계수
    0.1192,   // w9: 안정성 포화 감쇠 지수 (S^-w9)
    1.01925,  // w10: 인출 확률 R에 따른 기억 강화 계수
    1.9395,   // w11: 망각(실패) 후 안정성 기본 계수
    0.11,     // w12: 망각 후 난이도 패널티 지수
    0.29605,  // w13: 망각 후 기존 안정성 반영 지수
    2.2698,   // w14: 망각 시점 R 반영 계수
    0.2315,   // w15: 어려움(Hard) 안정성 페널티
    2.9898,   // w16: 쉬움(Easy) 안정성 보너스
    0.51655,  // w17: 단기 재학습 안정성 계수
    0.6621    // w18: 단기 재학습 오프셋
  ];

  // 파라미터별 공식 안전 상·하한선 (폭주 방지)
  private static readonly PARAM_BOUNDS: [number, number][] = [
    [0.1, 100],   // w0
    [0.1, 100],   // w1
    [0.1, 100],   // w2
    [0.1, 100],   // w3
    [1.0, 10.0],  // w4
    [0.01, 4.0],  // w5
    [0.01, 4.0],  // w6
    [0.001, 0.75],// w7
    [0.01, 4.5],  // w8
    [0.01, 0.8],  // w9
    [0.01, 3.5],  // w10
    [0.1, 5.0],   // w11
    [0.01, 0.5],  // w12
    [0.01, 0.9],  // w13
    [0.01, 4.0],  // w14
    [0.01, 1.0],  // w15
    [1.0, 6.0],   // w16
    [0.01, 2.0],  // w17
    [0.01, 2.0]   // w18
  ];

  private static readonly DECAY = -0.5;
  private static readonly FACTOR = 19 / 81;

  private static clamp(val: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, val));
  }

  public static getActiveWeights(settings?: AnkiSettings): number[] {
    if (settings?.fsrsWeights && settings.fsrsWeights.length === 19) {
      return settings.fsrsWeights;
    }
    return this.DEFAULT_WEIGHTS;
  }

  public static normalizeRetention(rawRetention?: number): number {
    let r = rawRetention ?? 0.9;
    if (r > 100) r = 0.9;
    else if (r > 1) r = r / 100;
    return this.clamp(r, 0.70, 0.97);
  }

  private static initStability(rating: ReviewRating, w = this.DEFAULT_WEIGHTS): number {
    return Math.max(0.1, w[rating - 1]);
  }

  private static initDifficulty(rating: ReviewRating, w = this.DEFAULT_WEIGHTS): number {
    const d0 = w[4] - Math.exp(w[5] * (rating - 1)) + 1;
    return this.clamp(d0, 1, 10);
  }

  private static shortTermStability(s: number, rating: ReviewRating, w = this.DEFAULT_WEIGHTS): number {
    const sinc = Math.exp(w[17] * (rating - 3 + w[18]));
    return this.clamp(s * sinc, 0.1, 36500);
  }

  private static nextDifficulty(d: number, rating: ReviewRating, w = this.DEFAULT_WEIGHTS): number {
    const deltaD = -w[6] * (rating - 3);
    const dampedD = d + (deltaD * (10 - d)) / 9;
    const d0Easy = this.initDifficulty(4, w);
    const nextD = w[7] * d0Easy + (1 - w[7]) * dampedD;
    return this.clamp(nextD, 1, 10);
  }

  public static forgettingCurve(elapsedDays: number, stability: number): number {
    const s = Math.max(0.1, stability);
    const t = Math.max(0, elapsedDays);
    return Math.pow(1 + (this.FACTOR * t) / s, this.DECAY);
  }

  private static nextRecallStability(
    d: number,
    s: number,
    r: number,
    rating: ReviewRating,
    w = this.DEFAULT_WEIGHTS
  ): number {
    const hardPenalty = rating === 2 ? w[15] : 1;
    const easyBonus = rating === 4 ? w[16] : 1;
    const sinc =
      1 +
      Math.exp(w[8]) *
        (11 - d) *
        Math.pow(s, -w[9]) *
        (Math.exp((1 - r) * w[10]) - 1) *
        hardPenalty *
        easyBonus;
    return this.clamp(s * sinc, 0.1, 36500);
  }

  private static nextForgetStability(
    d: number,
    s: number,
    r: number,
    w = this.DEFAULT_WEIGHTS
  ): number {
    const sf =
      w[11] *
      Math.pow(d, -w[12]) *
      (Math.pow(s + 1, w[13]) - 1) *
      Math.exp((1 - r) * w[14]);
    return this.clamp(Math.min(sf, s), 0.1, 36500);
  }

  public static nextInterval(
    stability: number,
    desiredRetention: number = 0.9,
    maxInterval: number = 36500
  ): number {
    const r = this.normalizeRetention(desiredRetention);
    const rawIvl = (stability / this.FACTOR) * (Math.pow(r, 1 / this.DECAY) - 1);
    return this.clamp(Math.round(rawIvl), 1, Math.max(1, maxInterval));
  }

  private static migrateFromSM2(card: Card): { s: number; d: number } {
    const s = Math.max(0.4, card.interval || 1);
    const ef = card.easeFactor || 2.5;
    const mappedD = 11 - (ef - 1.3) * 5.0;
    const d = this.clamp(mappedD, 1, 10);
    return { s, d };
  }

  /**
   * 10. 순수 FSRS-5 카드 스케줄링 실행
   */
  public static calculate(
    card: Card,
    rating: ReviewRating,
    now: Date = new Date(),
    settings: AnkiSettings,
    durationSeconds?: number
  ): ScheduleResult {
    const w = this.getActiveWeights(settings);
    const desiredRetention = this.normalizeRetention(settings.desiredRetention);
    const maxIvl = Math.max(7, settings.maxInterval || 180);
    const inheritSM2 = settings.fsrsInheritProgress !== false;

    const lastInterval = card.interval;
    let nextIntervalDays = 0;
    let nextDueDate = new Date(now.getTime());
    let nextDueText = '';

    let nextState = card.state;
    let nextStepIndex = 0;
    let nextRepetitions = card.repetitions;
    let nextLapses = card.lapses;
    let isLeech = card.isLeech ?? false;
    let suspended = card.suspended ?? false;

    const hasFsrsData =
      typeof card.stability === 'number' &&
      card.stability > 0 &&
      typeof card.difficulty === 'number' &&
      card.difficulty > 0;

    let s = hasFsrsData ? card.stability! : 0;
    let d = hasFsrsData ? card.difficulty! : 0;

    const effectiveState = !hasFsrsData && !inheritSM2 ? 'new' : card.state;

    if (!hasFsrsData && inheritSM2 && effectiveState !== 'new') {
      const migrated = this.migrateFromSM2(card);
      s = migrated.s;
      d = migrated.d;
    }

    let elapsedDays = Math.max(1, card.interval || 1);
    if (card.lastReviewedAt && hasFsrsData) {
      const diffMs = now.getTime() - new Date(card.lastReviewedAt).getTime();
      if (diffMs > 0) {
        elapsedDays = Math.max(0.01, diffMs / (1000 * 60 * 60 * 24));
      }
    }

    // CASE A: FSRS 첫 학습 카드 (new)
    if (effectiveState === 'new') {
      s = this.initStability(rating, w);
      d = this.initDifficulty(rating, w);

      if (rating === 1) {
        nextState = 'learning';
        nextRepetitions = 0;
        nextIntervalDays = 0;
        const retryMins = Math.max(1, Math.round(5 * (0.9 / desiredRetention)));
        nextDueDate = new Date(now.getTime() + retryMins * 60 * 1000);
        nextDueText = `${retryMins}분`;
      } else if (rating === 2) {
        nextState = 'review';
        nextRepetitions = 1;
        nextIntervalDays = this.nextInterval(s, desiredRetention, maxIvl);
        nextDueDate = SM2Scheduler.addStudyDays(now, nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      } else if (rating === 3) {
        nextState = 'review';
        nextRepetitions = 1;
        const hardIvl = this.nextInterval(this.initStability(2, w), desiredRetention, maxIvl);
        const goodIvl = this.nextInterval(s, desiredRetention, maxIvl);
        nextIntervalDays = Math.min(maxIvl, Math.max(hardIvl + 1, goodIvl));
        nextDueDate = SM2Scheduler.addStudyDays(now, nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      } else {
        nextState = 'review';
        nextRepetitions = 1;
        const hardIvl = this.nextInterval(this.initStability(2, w), desiredRetention, maxIvl);
        const goodIvl = Math.max(
          hardIvl + 1,
          this.nextInterval(this.initStability(3, w), desiredRetention, maxIvl)
        );
        const easyIvl = this.nextInterval(s, desiredRetention, maxIvl);
        nextIntervalDays = Math.min(maxIvl, Math.max(goodIvl + 2, easyIvl));
        nextDueDate = SM2Scheduler.addStudyDays(now, nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      }
    }
    // CASE B: 단기 재확인 (learning / relearning)
    else if (effectiveState === 'learning' || effectiveState === 'relearning') {
      s = this.shortTermStability(s || this.initStability(1, w), rating, w);
      d = this.nextDifficulty(d || this.initDifficulty(1, w), rating, w);

      if (rating === 1) {
        nextState = effectiveState;
        nextIntervalDays = 0;
        const retryMins = Math.max(1, Math.round(5 * (0.9 / desiredRetention)));
        nextDueDate = new Date(now.getTime() + retryMins * 60 * 1000);
        nextDueText = `${retryMins}분`;
      } else if (rating === 2) {
        nextState = effectiveState;
        nextIntervalDays = 0;
        const hardMins = Math.max(2, Math.round(10 * (0.9 / desiredRetention)));
        nextDueDate = new Date(now.getTime() + hardMins * 60 * 1000);
        nextDueText = `${hardMins}분`;
      } else if (rating === 3) {
        nextState = 'review';
        nextRepetitions += 1;
        nextIntervalDays = Math.max(1, this.nextInterval(s, desiredRetention, maxIvl));
        nextDueDate = SM2Scheduler.addStudyDays(now, nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      } else {
        nextState = 'review';
        nextRepetitions += 1;
        const goodS = this.shortTermStability(card.stability || this.initStability(1, w), 3, w);
        const goodIvl = Math.max(1, this.nextInterval(goodS, desiredRetention, maxIvl));
        const easyIvl = this.nextInterval(Math.max(s, this.initStability(3, w)), desiredRetention, maxIvl);
        nextIntervalDays = Math.min(maxIvl, Math.max(goodIvl + 2, easyIvl));
        nextDueDate = SM2Scheduler.addStudyDays(now, nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      }
    }
    // CASE C: 정규 장기 복습 (review)
    else {
      const r = this.forgettingCurve(elapsedDays, s);
      const prevS = s;
      const prevD = d;
      d = this.nextDifficulty(prevD, rating, w);

      if (rating === 1) {
        s = this.nextForgetStability(prevD, prevS, r, w);
        nextLapses += 1;
        nextRepetitions = 0;

        if (nextLapses >= settings.leechThreshold) {
          isLeech = true;
          if (settings.leechAction === 'suspend') {
            suspended = true;
          }
        }

        nextState = 'relearning';
        nextIntervalDays = Math.max(1, this.nextInterval(s, desiredRetention, maxIvl));
        const relearnMins = Math.max(2, Math.round(10 * (0.9 / desiredRetention)));
        nextDueDate = new Date(now.getTime() + relearnMins * 60 * 1000);
        nextDueText = `${relearnMins}분`;
      } else {
        s = this.nextRecallStability(prevD, prevS, r, rating, w);
        nextState = 'review';
        nextRepetitions += 1;

        const sHard = this.nextRecallStability(prevD, prevS, r, 2, w);
        const sGood = this.nextRecallStability(prevD, prevS, r, 3, w);
        const sEasy = this.nextRecallStability(prevD, prevS, r, 4, w);

        const ivlHard = Math.min(maxIvl, Math.max(1, this.nextInterval(sHard, desiredRetention, maxIvl)));
        const ivlGood = Math.min(maxIvl, Math.max(ivlHard + 1, this.nextInterval(sGood, desiredRetention, maxIvl)));
        const ivlEasy = Math.min(maxIvl, Math.max(ivlGood + 1, this.nextInterval(sEasy, desiredRetention, maxIvl)));

        if (rating === 2) nextIntervalDays = ivlHard;
        else if (rating === 3) nextIntervalDays = ivlGood;
        else nextIntervalDays = ivlEasy;

        nextDueDate = SM2Scheduler.addStudyDays(now, nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      }
    }

    const syncedEase = Number(this.clamp(2.5 - (d - 5) * 0.15, 1.3, 3.0).toFixed(2));

    const updatedCard: Card = {
      ...card,
      state: nextState,
      dueDate: nextDueDate.toISOString(),
      lastReviewedAt: now.toISOString(),
      interval: nextIntervalDays,
      stepIndex: nextStepIndex,
      easeFactor: card.easeFactor || syncedEase,
      stability: Number(s.toFixed(4)),
      difficulty: Number(d.toFixed(4)),
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
      prevState: card.state,
      reviewDate: now.toISOString(),
      lastInterval,
      scheduledInterval: nextIntervalDays,
      easeFactor: updatedCard.easeFactor,
      durationSeconds
    };

    return { updatedCard, log, nextDueText };
  }

  // =========================================================================
  // 🧠 FSRS 개인화 최적화기 (Log Loss 최소화 + 과적합 방지 + 개선 시에만 저장)
  // =========================================================================

  /**
   * 카드별 학습 시퀀스 추출 (같은 KST 학습일 내 단기 반복은 제외하고 일 단위 복습만 추출)
   */
  private static buildCardSequences(
    logs: ReviewLog[]
  ): { firstRating: ReviewRating; steps: { elapsedDays: number; rating: ReviewRating }[] }[] {
    const byCard = new Map<string, ReviewLog[]>();
    for (const log of logs) {
      if (!byCard.has(log.cardId)) byCard.set(log.cardId, []);
      byCard.get(log.cardId)!.push(log);
    }

    const sequences: { firstRating: ReviewRating; steps: { elapsedDays: number; rating: ReviewRating }[] }[] = [];

    for (const cardLogs of byCard.values()) {
      const sorted = [...cardLogs].sort(
        (a, b) => new Date(a.reviewDate).getTime() - new Date(b.reviewDate).getTime()
      );
      if (sorted.length < 2) continue;

      const firstRating = sorted[0].rating;
      let prevDayStart = SM2Scheduler.getKstStudyDayStart(new Date(sorted[0].reviewDate)).getTime();
      const steps: { elapsedDays: number; rating: ReviewRating }[] = [];

      for (let i = 1; i < sorted.length; i++) {
        const currDayStart = SM2Scheduler.getKstStudyDayStart(new Date(sorted[i].reviewDate)).getTime();
        const elapsedDays = Math.round((currDayStart - prevDayStart) / (24 * 60 * 60 * 1000));
        if (elapsedDays >= 1) {
          steps.push({ elapsedDays, rating: sorted[i].rating });
          prevDayStart = currDayStart;
        }
      }

      if (steps.length > 0) {
        sequences.push({ firstRating, steps });
      }
    }

    return sequences;
  }

  /**
   * 최적화에 사용 가능한 유효 정규 복습 샘플 수 계산
   */
  public static countValidReviewSamples(logs: ReviewLog[]): number {
    const seqs = this.buildCardSequences(logs);
    return seqs.reduce((acc, seq) => acc + seq.steps.length, 0);
  }

  /**
   * 순수 Log Loss(Binary Cross-Entropy) 계산
   */
  private static evaluateLogLoss(
    sequences: { firstRating: ReviewRating; steps: { elapsedDays: number; rating: ReviewRating }[] }[],
    w: number[]
  ): { loss: number; count: number } {
    let totalLoss = 0;
    let count = 0;

    for (const seq of sequences) {
      let s = this.initStability(seq.firstRating, w);
      let d = this.initDifficulty(seq.firstRating, w);

      for (const step of seq.steps) {
        const rawR = this.forgettingCurve(step.elapsedDays, s);
        const r = this.clamp(rawR, 1e-6, 1 - 1e-6);
        const y = step.rating === 1 ? 0 : 1;

        totalLoss += -(y * Math.log(r) + (1 - y) * Math.log(1 - r));
        count++;

        d = this.nextDifficulty(d, step.rating, w);
        s =
          step.rating === 1
            ? this.nextForgetStability(d, s, rawR, w)
            : this.nextRecallStability(d, s, rawR, step.rating, w);
      }
    }

    return {
      loss: count > 0 ? totalLoss / count : Infinity,
      count
    };
  }

  /**
   * 내 복습 로그 기반 FSRS 파라미터 최적화 실행
   * - Log Loss가 기존 가중치보다 실제로 줄어들었을 때만 improved = true 반환
   */
  public static optimizeParameters(
    logs: ReviewLog[],
    currentWeights?: number[]
  ): FsrsOptimizeResult {
    const baselineWeights =
      currentWeights && currentWeights.length === 19 ? [...currentWeights] : [...this.DEFAULT_WEIGHTS];
    const sequences = this.buildCardSequences(logs);
    const { loss: baselineLoss, count: sampleCount } = this.evaluateLogLoss(sequences, baselineWeights);

    if (sampleCount === 0 || !Number.isFinite(baselineLoss)) {
      return {
        improved: false,
        sampleCount: 0,
        baselineLoss: 0,
        optimizedLoss: 0,
        weights: baselineWeights,
        mode: 'pretrain'
      };
    }

    // 100개 미만: 초기 안정성(w0~w3)만 안전하게 조정 (Pretrain)
    // 100개 이상: 주요 장기 기억 가중치(w0~w16) 전체 최적화
    const mode: 'pretrain' | 'full' = sampleCount < 100 ? 'pretrain' : 'full';
    const activeIndices =
      mode === 'pretrain' ? [0, 1, 2, 3] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

    // 데이터가 적을수록 기본 가중치에서 너무 멀어지지 않도록 L2 정규화 강도 조절
    const l2Penalty = sampleCount < 100 ? 0.01 : sampleCount < 500 ? 0.002 : 0.0005;

    const w = [...baselineWeights];
    const m = new Array(19).fill(0);
    const v = new Array(19).fill(0);
    const lr = 0.025;
    const beta1 = 0.9;
    const beta2 = 0.999;
    const eps = 1e-8;
    const fdEps = 1e-4;
    const epochs = 60;

    let bestWeights = [...w];
    let bestPureLoss = baselineLoss;

    const regularizedLoss = (weights: number[]): number => {
      const { loss } = this.evaluateLogLoss(sequences, weights);
      let reg = 0;
      for (const idx of activeIndices) {
        const diff = weights[idx] - this.DEFAULT_WEIGHTS[idx];
        reg += diff * diff;
      }
      return loss + l2Penalty * reg;
    };

    for (let step = 1; step <= epochs; step++) {
      const baseRegLoss = regularizedLoss(w);

      for (const idx of activeIndices) {
        const orig = w[idx];
        w[idx] = orig + fdEps;
        const lossPlus = regularizedLoss(w);
        w[idx] = orig;

        const grad = (lossPlus - baseRegLoss) / fdEps;
        m[idx] = beta1 * m[idx] + (1 - beta1) * grad;
        v[idx] = beta2 * v[idx] + (1 - beta2) * grad * grad;

        const mHat = m[idx] / (1 - Math.pow(beta1, step));
        const vHat = v[idx] / (1 - Math.pow(beta2, step));

        const updated = orig - (lr * mHat) / (Math.sqrt(vHat) + eps);
        const [minB, maxB] = this.PARAM_BOUNDS[idx];
        w[idx] = this.clamp(updated, minB, maxB);
      }

      // 단조 증가 제약 보장: S0(Again) <= S0(Hard) <= S0(Good) <= S0(Easy)
      w[1] = Math.max(w[0], w[1]);
      w[2] = Math.max(w[1], w[2]);
      w[3] = Math.max(w[2], w[3]);

      const { loss: pureLoss } = this.evaluateLogLoss(sequences, w);
      if (Number.isFinite(pureLoss) && pureLoss < bestPureLoss) {
        bestPureLoss = pureLoss;
        bestWeights = w.map(val => Number(val.toFixed(5)));
      }
    }

    // 🔒 안전장치: 기존 가중치보다 Log Loss가 의미 있게 줄어들었을 때만 채택!
    const improved = Number.isFinite(bestPureLoss) && bestPureLoss < baselineLoss - 1e-4;

    return {
      improved,
      sampleCount,
      baselineLoss: Number(baselineLoss.toFixed(4)),
      optimizedLoss: Number((improved ? bestPureLoss : baselineLoss).toFixed(4)),
      weights: improved ? bestWeights : baselineWeights,
      mode
    };
  }
}