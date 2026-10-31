import { Deck, Card, ReviewRating, StorageSchema, AnkiSettings } from './types';

export interface IAnkiAPI {
  getStorageData(): Promise<StorageSchema>;
  createDeck(name: string, description?: string): Promise<Deck>;
  deleteDeck(deckId: string): Promise<void>;
  addCard(deckId: string, front: string, back: string, startingEase?: number): Promise<Card>;
  deleteCard(deckId: string, cardId: string): Promise<void>;
  reviewCard(
    deckId: string,
    cardId: string,
    rating: ReviewRating,
    settings?: AnkiSettings,
    durationSeconds?: number
  ): Promise<Card>;
  importStorageData(data: StorageSchema): Promise<void>;
}

declare global {
  interface Window {
    ankiAPI?: IAnkiAPI;
  }
}