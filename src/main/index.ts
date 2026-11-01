import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { AppPaths } from './paths';
import { StorageManager } from './storage';
import { Logger } from './logger';
import { SM2Scheduler } from '../core/sm2';
import { StorageSchema, Deck, Card, ReviewRating } from '../shared/types';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: 'My Anki App',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // 빌드된 HTML 파일 로드
  const indexPath = path.join(__dirname, '../../dist/index.html');
  mainWindow.loadFile(indexPath).catch(err => {
    Logger.error('HTML 로드 실패:', err);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC 통신 핸들러 등록
function registerIpcHandlers(): void {
  ipcMain.handle('storage:get-data', async (): Promise<StorageSchema> => {
    return StorageManager.load();
  });

  ipcMain.handle('storage:create-deck', async (_, name: string, description?: string): Promise<Deck> => {
    const data = StorageManager.load();
    const newDeck: Deck = {
      id: `deck_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name,
      description,
      createdAt: new Date().toISOString(),
      cards: []
    };
    data.decks.push(newDeck);
    StorageManager.save(data);
    Logger.info(`[Deck Created] ${name} (ID: ${newDeck.id})`);
    return newDeck;
  });

  ipcMain.handle('storage:delete-deck', async (_, deckId: string): Promise<void> => {
    const data = StorageManager.load();
    data.decks = data.decks.filter(d => d.id !== deckId);
    data.logs = data.logs.filter(l => l.deckId !== deckId);
    StorageManager.save(data);
    Logger.info(`[Deck Deleted] ID: ${deckId}`);
  });

  ipcMain.handle(
    'storage:add-card',
    async (
      _,
      deckId: string,
      front: string,
      back: string,
      startingEase = 250,
      example?: string,
      imageData?: string
    ): Promise<Card> => {
      const data = StorageManager.load();
      const deck = data.decks.find(d => d.id === deckId);
      if (!deck) throw new Error(`Deck not found: ${deckId}`);

      const newCard: Card = {
        id: `card_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        deckId,
        front,
        back,
        example: example || undefined,
        imageData: imageData || undefined,
        state: 'new',
        dueDate: new Date().toISOString(),
        interval: 0,
        easeFactor: Number((startingEase / 100).toFixed(2)),
        repetitions: 0,
        lapses: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      deck.cards.push(newCard);
      StorageManager.save(data);
      Logger.info(`[Card Added] ${front} to deck ${deck.name}`);
      return newCard;
    }
  );

  ipcMain.handle('storage:delete-card', async (_, deckId: string, cardId: string): Promise<void> => {
    const data = StorageManager.load();
    const deck = data.decks.find(d => d.id === deckId);
    if (deck) {
      deck.cards = deck.cards.filter(c => c.id !== cardId);
      data.logs = data.logs.filter(l => l.cardId !== cardId);
      StorageManager.save(data);
      Logger.info(`[Card Deleted] ID: ${cardId}`);
    }
  });

  ipcMain.handle('storage:review-card', async (_, deckId: string, cardId: string, rating: ReviewRating): Promise<Card> => {
    const data = StorageManager.load();
    const deck = data.decks.find(d => d.id === deckId);
    if (!deck) throw new Error(`Deck not found: ${deckId}`);

    const cardIndex = deck.cards.findIndex(c => c.id === cardId);
    if (cardIndex === -1) throw new Error(`Card not found: ${cardId}`);

    const target = deck.cards[cardIndex];
    const { updatedCard, log } = SM2Scheduler.calculate(target, rating);

    deck.cards[cardIndex] = updatedCard;
    data.logs.push(log);
    StorageManager.save(data);
    Logger.info(`[Card Reviewed] Rating ${rating} -> Next interval ${updatedCard.interval} days`);
    return updatedCard;
  });

  ipcMain.handle('storage:import-data', async (_, importedData: StorageSchema): Promise<void> => {
    StorageManager.save(importedData);
    Logger.info(`[Data Imported] ${importedData.decks.length} decks loaded`);
  });
}

// 앱 라이프사이클
app.whenReady().then(() => {
  AppPaths.init();
  Logger.info(`App started. UserData: ${AppPaths.getUserDataDir()}`);
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});