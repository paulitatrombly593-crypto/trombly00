import { Deck, Card, ReviewRating, StorageSchema } from './types';

/**
 * 화면(Renderer)과 두뇌(Main/Storage)가 통신하는 공통 API 규격
 */
export interface IAnkiAPI {
  /**
   * 전체 데이터(단어장 + 복습 로그) 불러오기
   */
  getStorageData(): Promise<StorageSchema>;

  /**
   * 새 단어장(Deck) 만들기
   */
  createDeck(name: string, description?: string): Promise<Deck>;

  /**
   * 단어장(Deck) 삭제하기
   */
  deleteDeck(deckId: string): Promise<void>;

  /**
   * 특정 단어장에 새 단어 카드(Card) 추가하기
   */
  addCard(deckId: string, front: string, back: string): Promise<Card>;

  /**
   * 특정 단어 카드(Card) 삭제하기
   */
  deleteCard(deckId: string, cardId: string): Promise<void>;

  /**
   * 단어 카드 복습 결과(Again/Hard/Good/Easy) 기록 및 다음 복습일 스케줄링
   */
  reviewCard(deckId: string, cardId: string, rating: ReviewRating): Promise<Card>;

  /**
   * 백업/내보내기용 전체 JSON 데이터 덮어쓰기 (가져오기 기능)
   */
  importStorageData(data: StorageSchema): Promise<void>;
}

/**
 * 브라우저 window 객체에 안전하게 노출될 전역 타입 선언
 */
declare global {
  interface Window {
    ankiAPI?: IAnkiAPI;
  }
}