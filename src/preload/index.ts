import { contextBridge, ipcRenderer } from 'electron';
import { IAnkiAPI } from '../shared/api';
import { StorageSchema, Deck, Card, ReviewRating } from '../shared/types';

/**
 * Electron 메인 프로세스와 안전하게 통신하는 Preload 브릿지
 */
const ankiAPI: IAnkiAPI = {
  getStorageData: (): Promise<StorageSchema> => ipcRenderer.invoke('storage:get-data'),
  createDeck: (name: string, description?: string): Promise<Deck> => 
    ipcRenderer.invoke('storage:create-deck', name, description),
  deleteDeck: (deckId: string): Promise<void> => 
    ipcRenderer.invoke('storage:delete-deck', deckId),
  addCard: (deckId: string, front: string, back: string): Promise<Card> => 
    ipcRenderer.invoke('storage:add-card', deckId, front, back),
  deleteCard: (deckId: string, cardId: string): Promise<void> => 
    ipcRenderer.invoke('storage:delete-card', deckId, cardId),
  reviewCard: (deckId: string, cardId: string, rating: ReviewRating): Promise<Card> => 
    ipcRenderer.invoke('storage:review-card', deckId, cardId, rating),
  importStorageData: (data: StorageSchema): Promise<void> => 
    ipcRenderer.invoke('storage:import-data', data)
};

// 렌더러의 window.ankiAPI로 안전하게 노출
contextBridge.exposeInMainWorld('ankiAPI', ankiAPI);