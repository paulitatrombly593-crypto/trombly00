import { IAnkiAPI } from '../shared/api';
import { StorageSchema, Deck, Card, ReviewRating } from '../shared/types';
import { SM2Scheduler } from '../core/sm2';

const WEB_STORAGE_KEY = 'MY_ANKI_APP_DATA_V1';

/**
 * 초기 샘플 데이터 (웹 모드 최초 실행 시)
 */
const DEFAULT_STORAGE: StorageSchema = {
  version: 1,
  decks: [
    {
      id: 'deck_starter',
      name: '기본 단어장 (스타터)',
      description: '망각곡선 학습을 체험해볼 수 있는 기본 샘플 단어장입니다.',
      createdAt: new Date().toISOString(),
      cards: [
        {
          id: 'card_sample_1',
          deckId: 'deck_starter',
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
          deckId: 'deck_starter',
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
 * Codespaces 웹 브라우저 환경용 로컬 스토리지 구현체
 */
class WebAnkiAPI implements IAnkiAPI {
  private getLocalData(): StorageSchema {
    try {
      const raw = localStorage.getItem(WEB_STORAGE_KEY);
      if (!raw) {
        this.setLocalData(DEFAULT_STORAGE);
        return DEFAULT_STORAGE;
      }
      return JSON.parse(raw) as StorageSchema;
    } catch {
      return DEFAULT_STORAGE;
    }
  }

  private setLocalData(data: StorageSchema): void {
    localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(data));
  }

  public async getStorageData(): Promise<StorageSchema> {
    return this.getLocalData();
  }

  public async createDeck(name: string, description?: string): Promise<Deck> {
    const data = this.getLocalData();
    const newDeck: Deck = {
      id: `deck_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name,
      description,
      createdAt: new Date().toISOString(),
      cards: []
    };
    data.decks.push(newDeck);
    this.setLocalData(data);
    return newDeck;
  }

  public async deleteDeck(deckId: string): Promise<void> {
    const data = this.getLocalData();
    data.decks = data.decks.filter(d => d.id !== deckId);
    data.logs = data.logs.filter(l => l.deckId !== deckId);
    this.setLocalData(data);
  }

  public async addCard(deckId: string, front: string, back: string): Promise<Card> {
    const data = this.getLocalData();
    const deck = data.decks.find(d => d.id === deckId);
    if (!deck) {
      throw new Error(`[Error] 덱을 찾을 수 없습니다: ${deckId}`);
    }

    const newCard: Card = {
      id: `card_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      deckId,
      front,
      back,
      state: 'new',
      dueDate: new Date().toISOString(),
      interval: 0,
      easeFactor: 2.5,
      repetitions: 0,
      lapses: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    deck.cards.push(newCard);
    this.setLocalData(data);
    return newCard;
  }

  public async deleteCard(deckId: string, cardId: string): Promise<void> {
    const data = this.getLocalData();
    const deck = data.decks.find(d => d.id === deckId);
    if (!deck) return;

    deck.cards = deck.cards.filter(c => c.id !== cardId);
    data.logs = data.logs.filter(l => l.cardId !== cardId);
    this.setLocalData(data);
  }

  public async reviewCard(deckId: string, cardId: string, rating: ReviewRating): Promise<Card> {
    const data = this.getLocalData();
    const deck = data.decks.find(d => d.id === deckId);
    if (!deck) {
      throw new Error(`[Error] 덱을 찾을 수 없습니다: ${deckId}`);
    }

    const cardIndex = deck.cards.findIndex(c => c.id === cardId);
    if (cardIndex === -1) {
      throw new Error(`[Error] 카드를 찾을 수 없습니다: ${cardId}`);
    }

    const targetCard = deck.cards[cardIndex];
    // SM-2 알고리즘으로 다음 주기 계산
    const { updatedCard, log } = SM2Scheduler.calculate(targetCard, rating);

    deck.cards[cardIndex] = updatedCard;
    data.logs.push(log);
    this.setLocalData(data);

    return updatedCard;
  }

  public async importStorageData(data: StorageSchema): Promise<void> {
    this.setLocalData(data);
  }
}

/**
 * 런타임 환경에 따라 알맞은 API를 반환하는 싱글톤 팩토리
 */
export function getAnkiAPI(): IAnkiAPI {
  // 실제 Electron 데스크톱 앱 내부인 경우
  if (typeof window !== 'undefined' && window.ankiAPI) {
    return window.ankiAPI;
  }
  // Codespaces 웹 브라우저 환경인 경우
  return new WebAnkiAPI();
}