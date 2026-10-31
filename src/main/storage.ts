import * as fs from 'fs';
import { StorageSchema, Deck } from '../shared/types';
import { AppPaths } from './paths';

/**
 * 기본 초기 데이터 (최초 실행 시 자동 생성)
 */
const DEFAULT_INITIAL_STORAGE: StorageSchema = {
  version: 1,
  decks: [
    {
      id: 'deck_default_starter',
      name: '기본 단어장 (스타터)',
      description: '망각곡선 학습을 체험해볼 수 있는 기본 샘플 단어장입니다.',
      createdAt: new Date().toISOString(),
      cards: [
        {
          id: 'card_sample_1',
          deckId: 'deck_default_starter',
          front: 'Spaced Repetition',
          back: '간격 반복 (망각곡선에 따라 점진적으로 복습 주기를 늘려가는 학습법)',
          state: 'new',
          dueDate: new Date().toISOString(),
          interval: 0,
          easeFactor: 2.5,
          repetitions: 0,
          lapses: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        {
          id: 'card_sample_2',
          deckId: 'deck_default_starter',
          front: 'Cross Platform',
          back: '크로스 플랫폼 (하나의 코드로 Windows, Mac 등 여러 OS에서 구동되는 소프트웨어)',
          state: 'new',
          dueDate: new Date().toISOString(),
          interval: 0,
          easeFactor: 2.5,
          repetitions: 0,
          lapses: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    }
  ],
  logs: []
};

/**
 * 원자적(Atomic) 파일 안전 저장소 매니저
 */
export class StorageManager {
  private static cachedData: StorageSchema | null = null;

  /**
   * 데이터를 메모리에 로드합니다. 파일이 없으면 초기 데이터를 생성하고,
   * 손상되었을 경우 백업본으로부터 자동 복구를 시도합니다.
   */
  public static load(): StorageSchema {
    if (this.cachedData) {
      return this.cachedData;
    }

    const dbPath = AppPaths.getDatabaseFilePath();
    const backupPath = AppPaths.getBackupFilePath();

    // 1. 파일이 없으면 기본 초기 데이터로 새로 생성
    if (!fs.existsSync(dbPath)) {
      this.save(DEFAULT_INITIAL_STORAGE);
      this.cachedData = DEFAULT_INITIAL_STORAGE;
      return this.cachedData;
    }

    // 2. 파일 읽기 및 무결성 파싱
    try {
      const rawContent = fs.readFileSync(dbPath, 'utf-8');
      const parsed = JSON.parse(rawContent) as StorageSchema;

      if (!parsed || !Array.isArray(parsed.decks)) {
        throw new Error('데이터 구조가 올바르지 않습니다.');
      }

      this.cachedData = parsed;
      return this.cachedData;
    } catch (readError) {
      console.error('[Storage Error] 원본 데이터 파손 감지. 백업본 복구 시도 중...', readError);

      // 3. 원본 파손 시 백업본 복구
      if (fs.existsSync(backupPath)) {
        try {
          const backupContent = fs.readFileSync(backupPath, 'utf-8');
          const recovered = JSON.parse(backupContent) as StorageSchema;
          this.cachedData = recovered;
          // 복구된 데이터로 원본 재작성
          this.save(recovered);
          return this.cachedData;
        } catch {
          console.error('[Storage Error] 백업본도 손상되었습니다. 기본값으로 초기화합니다.');
        }
      }

      // 백업본도 없으면 기본값으로 복원
      this.save(DEFAULT_INITIAL_STORAGE);
      this.cachedData = DEFAULT_INITIAL_STORAGE;
      return this.cachedData;
    }
  }

  /**
   * 데이터를 디스크에 안전하게 원자적(Atomic)으로 저장합니다.
   */
  public static save(data: StorageSchema): void {
    const dbPath = AppPaths.getDatabaseFilePath();
    const tempPath = AppPaths.getTempFilePath();
    const backupPath = AppPaths.getBackupFilePath();

    const jsonString = JSON.stringify(data, null, 2);

    try {
      // Step 1: 임시 파일(.tmp)에 먼저 완벽히 쓰기
      fs.writeFileSync(tempPath, jsonString, 'utf-8');

      // Step 2: 기존 원본이 있다면 백업본으로 복사 보관
      if (fs.existsSync(dbPath)) {
        try {
          fs.copyFileSync(dbPath, backupPath);
        } catch (copyErr) {
          console.warn('[Storage Warning] 백업 복사 실패 (저장 작업은 계속 진행)', copyErr);
        }
      }

      // Step 3: 원자적 교체 (임시 파일 이름을 원본 이름으로 순간 덮어쓰기)
      fs.renameSync(tempPath, dbPath);

      // 메모리 캐시 갱신
      this.cachedData = data;
    } catch (saveError) {
      // 실패 시 임시 파일 찌꺼기 정리
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // ignore
        }
      }
      throw new Error(`[Storage Fatal] 데이터 저장 실패: ${(saveError as Error).message}`);
    }
  }

  /**
   * 덱 목록만 간편하게 조회
   */
  public static getDecks(): Deck[] {
    return this.load().decks;
  }
}