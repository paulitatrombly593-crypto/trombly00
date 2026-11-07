import { Card, ReviewRating, ReviewLog, AnkiSettings } from '../shared/types';
import { ScheduleResult } from './sm2';

/**
 * 🚀 순수 FSRS-5 (Free Spaced Repetition Scheduler v5) DSR 엔진
 * - SM-2의 수동 익힘 단계(learningSteps)와 완전히 분리되어 독립 계산됩니다.
 * - 세 가지 핵심 기억 변수:
 *   D (Difficulty, 난이도 1~10)
 *   S (Stability, 기억 안정성: 암기 유지율이 90%로 떨어질 때까지 걸리는 일수)
 *   R (Retrievability, 현재 시점 예상 기억 인출 확률)
 */
export class FSRSScheduler {
  // FSRS-5 공식 글로벌 표준 파라미터 (w0 ~ w18)
  private static readonly DEFAULT_WEIGHTS: number[] = [
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

  private static readonly DECAY = -0.5;
  private static readonly FACTOR = 19 / 81;

  private static clamp(val: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, val));
  }

  /**
   * desiredRetention 값이 90(정수)이든 0.9(소수)든 0.70~0.97 사이 비율로 안전 정규화
   */
  public static normalizeRetention(rawRetention?: number): number {
    let r = rawRetention ?? 0.9;
    if (r > 100) r = 0.9;
    else if (r > 1) r = r / 100;
    return this.clamp(r, 0.70, 0.97);
  }

  /**
   * 1. 초기 안정성 S0(G) (G = 1, 2, 3, 4)
   */
  private static initStability(rating: ReviewRating, w = this.DEFAULT_WEIGHTS): number {
    return Math.max(0.1, w[rating - 1]);
  }

  /**
   * 2. 초기 난이도 D0(G) = w4 - exp(w5 * (G - 1)) + 1
   */
  private static initDifficulty(rating: ReviewRating, w = this.DEFAULT_WEIGHTS): number {
    const d0 = w[4] - Math.exp(w[5] * (rating - 1)) + 1;
    return this.clamp(d0, 1, 10);
  }

  /**
   * 3. 단기 재학습(Again 후 재시도) 시 안정성 업데이트
   */
  private static shortTermStability(s: number, rating: ReviewRating, w = this.DEFAULT_WEIGHTS): number {
    const sinc = Math.exp(w[17] * (rating - 3 + w[18]));
    return this.clamp(s * sinc, 0.1, 36500);
  }

  /**
   * 4. 복습 시 난이도 업데이트 (선형 감쇠 + 평균 회귀)
   */
  private static nextDifficulty(d: number, rating: ReviewRating, w = this.DEFAULT_WEIGHTS): number {
    const deltaD = -w[6] * (rating - 3);
    const dampedD = d + (deltaD * (10 - d)) / 9;
    const d0Easy = this.initDifficulty(4, w);
    const nextD = w[7] * d0Easy + (1 - w[7]) * dampedD;
    return this.clamp(nextD, 1, 10);
  }

  /**
   * 5. 망각 곡선 인출 확률 R(t, S)
   */
  public static forgettingCurve(elapsedDays: number, stability: number): number {
    const s = Math.max(0.1, stability);
    const t = Math.max(0, elapsedDays);
    return Math.pow(1 + (this.FACTOR * t) / s, this.DECAY);
  }

  /**
   * 6. 복습 성공(Hard/Good/Easy) 후 새로운 안정성 S'_r(D, S, R, G)
   */
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

  /**
   * 7. 복습 실패(Again) 후 새로운 안정성 S'_f(D, S, R)
   */
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

  /**
   * 8. 목표 암기 유지율(Desired Retention)에 따른 차기 복습 간격(일) 산출
   */
  public static nextInterval(
    stability: number,
    desiredRetention: number = 0.9,
    maxInterval: number = 36500
  ): number {
    const r = this.normalizeRetention(desiredRetention);
    const rawIvl = (stability / this.FACTOR) * (Math.pow(r, 1 / this.DECAY) - 1);
    return this.clamp(Math.round(rawIvl), 1, Math.max(1, maxInterval));
  }

  /**
   * 9. 기존 SM-2 카드 데이터로부터 초기 S, D 추정 (진도 이어받기 켜짐 시)
   */
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

    // FSRS 고유 상태(stability, difficulty) 보유 여부 확인
    const hasFsrsData =
      typeof card.stability === 'number' &&
      card.stability > 0 &&
      typeof card.difficulty === 'number' &&
      card.difficulty > 0;

    let s = hasFsrsData ? card.stability! : 0;
    let d = hasFsrsData ? card.difficulty! : 0;

    // 기존 SM-2 진도 이어받기가 꺼져 있고 아직 FSRS로 학습한 적이 없는 카드라면 새 카드로 취급
    const effectiveState =
      !hasFsrsData && !inheritSM2 ? 'new' : card.state;

    if (!hasFsrsData && inheritSM2 && effectiveState !== 'new') {
      const migrated = this.migrateFromSM2(card);
      s = migrated.s;
      d = migrated.d;
    }

    // 경과 일수(elapsedDays) 계산
    let elapsedDays = Math.max(1, card.interval || 1);
    if (card.lastReviewedAt && hasFsrsData) {
      const diffMs = now.getTime() - new Date(card.lastReviewedAt).getTime();
      if (diffMs > 0) {
        elapsedDays = Math.max(0.01, diffMs / (1000 * 60 * 60 * 24));
      }
    }

    // =========================================================
    // CASE A: FSRS 첫 학습 카드 (new)
    // - SM-2의 '2분 6분 10분' 단계를 쓰지 않고 FSRS 초기 안정성(S0)으로 즉시 계산!
    // =========================================================
    if (effectiveState === 'new') {
      s = this.initStability(rating);
      d = this.initDifficulty(rating);

      if (rating === 1) {
        // 1. 다시 (Again): 단기 기억 재확인 (유지율 90% 기준 5분)
        nextState = 'learning';
        nextRepetitions = 0;
        nextIntervalDays = 0;
        const retryMins = Math.max(1, Math.round(5 * (0.9 / desiredRetention)));
        nextDueDate = new Date(now.getTime() + retryMins * 60 * 1000);
        nextDueText = `${retryMins}분`;
      } else if (rating === 2) {
        // 2. 어려움 (Hard): S0(2) = 1.18일 -> 유지율 반영 일수 (기본 1일)
        nextState = 'review';
        nextRepetitions = 1;
        nextIntervalDays = this.nextInterval(s, desiredRetention, maxIvl);
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      } else if (rating === 3) {
        // 3. 알맞음 (Good): S0(3) = 3.17일 -> 유지율 반영 일수 (기본 3일, 최소 Hard+1일 보장)
        nextState = 'review';
        nextRepetitions = 1;
        const hardIvl = this.nextInterval(this.initStability(2), desiredRetention, maxIvl);
        const goodIvl = this.nextInterval(s, desiredRetention, maxIvl);
        nextIntervalDays = Math.min(maxIvl, Math.max(hardIvl + 1, goodIvl));
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      } else {
        // 4. 쉬움 (Easy): S0(4) = 15.69일 -> 유지율 반영 일수 (기본 16일, 최소 Good+2일 보장)
        nextState = 'review';
        nextRepetitions = 1;
        const hardIvl = this.nextInterval(this.initStability(2), desiredRetention, maxIvl);
        const goodIvl = Math.max(
          hardIvl + 1,
          this.nextInterval(this.initStability(3), desiredRetention, maxIvl)
        );
        const easyIvl = this.nextInterval(s, desiredRetention, maxIvl);
        nextIntervalDays = Math.min(maxIvl, Math.max(goodIvl + 2, easyIvl));
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      }
    }
    // =========================================================
    // CASE B: FSRS 단기 재확인 중인 카드 (learning / relearning)
    // =========================================================
    else if (effectiveState === 'learning' || effectiveState === 'relearning') {
      s = this.shortTermStability(s || this.initStability(1), rating);
      d = this.nextDifficulty(d || this.initDifficulty(1), rating);

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
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      } else {
        nextState = 'review';
        nextRepetitions += 1;
        const goodS = this.shortTermStability(card.stability || this.initStability(1), 3);
        const goodIvl = Math.max(1, this.nextInterval(goodS, desiredRetention, maxIvl));
        const easyIvl = this.nextInterval(Math.max(s, this.initStability(3)), desiredRetention, maxIvl);
        nextIntervalDays = Math.min(maxIvl, Math.max(goodIvl + 2, easyIvl));
        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      }
    }
    // =========================================================
    // CASE C: FSRS 정규 장기 복습 카드 (review)
    // =========================================================
    else {
      const r = this.forgettingCurve(elapsedDays, s);
      const prevS = s;
      const prevD = d;
      d = this.nextDifficulty(prevD, rating);

      if (rating === 1) {
        // 망각(Lapse) -> S'_f 계산 후 거머리 검사 및 단기 재학습 진입
        s = this.nextForgetStability(prevD, prevS, r);
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
        s = this.nextRecallStability(prevD, prevS, r, rating);
        nextState = 'review';
        nextRepetitions += 1;

        const sHard = this.nextRecallStability(prevD, prevS, r, 2);
        const sGood = this.nextRecallStability(prevD, prevS, r, 3);
        const sEasy = this.nextRecallStability(prevD, prevS, r, 4);

        const ivlHard = Math.min(maxIvl, Math.max(1, this.nextInterval(sHard, desiredRetention, maxIvl)));
        const ivlGood = Math.min(maxIvl, Math.max(ivlHard + 1, this.nextInterval(sGood, desiredRetention, maxIvl)));
        const ivlEasy = Math.min(maxIvl, Math.max(ivlGood + 1, this.nextInterval(sEasy, desiredRetention, maxIvl)));

        if (rating === 2) nextIntervalDays = ivlHard;
        else if (rating === 3) nextIntervalDays = ivlGood;
        else nextIntervalDays = ivlEasy;

        nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);
        nextDueText = `${nextIntervalDays}일`;
      }
    }

    // D(1~10)에 대응하는 표시용 easeFactor 동기화 (SM-2 모드로 전환 시 참조용)
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
      reviewDate: now.toISOString(),
      lastInterval,
      scheduledInterval: nextIntervalDays,
      easeFactor: updatedCard.easeFactor,
      durationSeconds
    };

    return { updatedCard, log, nextDueText };
  }
}