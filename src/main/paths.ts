import * as path from 'path';
import * as fs from 'fs';

/**
 * 앱 데이터 저장소 경로 관리자
 * Windows, Mac, Linux 및 Codespaces 개발 환경을 감지하여 적절한 폴더 경로를 반환합니다.
 */
export class AppPaths {
  private static userDataPath: string = '';

  /**
   * 사용자 데이터 루트 경로를 초기화합니다.
   * Electron 환경에서는 app.getPath('userData')를 사용하고,
   * 일반 Node/웹 개발 환경에서는 프로젝트 루트의 .data 폴더를 사용합니다.
   */
  public static init(customPath?: string): void {
    if (customPath) {
      this.userDataPath = customPath;
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const electron = require('electron');
        if (electron && electron.app) {
          this.userDataPath = electron.app.getPath('userData');
        } else {
          this.userDataPath = path.resolve(process.cwd(), '.data');
        }
      } catch {
        // Codespaces 또는 웹 브라우저 개발 환경 fallback
        this.userDataPath = path.resolve(process.cwd(), '.data');
      }
    }

    this.ensureDirectories();
  }

  public static getUserDataDir(): string {
    if (!this.userDataPath) {
      this.init();
    }
    return this.userDataPath;
  }

  public static getDataDir(): string {
    return path.join(this.getUserDataDir(), 'data');
  }

  public static getLogsDir(): string {
    return path.join(this.getUserDataDir(), 'logs');
  }

  public static getDatabaseFilePath(): string {
    return path.join(this.getDataDir(), 'decks.json');
  }

  public static getBackupFilePath(): string {
    return path.join(this.getDataDir(), 'decks.backup.json');
  }

  public static getTempFilePath(): string {
    return path.join(this.getDataDir(), 'decks.json.tmp');
  }

  public static getErrorLogPath(): string {
    return path.join(this.getLogsDir(), 'error.log');
  }

  private static ensureDirectories(): void {
    const dataDir = path.join(this.userDataPath, 'data');
    const logsDir = path.join(this.userDataPath, 'logs');

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
  }
}