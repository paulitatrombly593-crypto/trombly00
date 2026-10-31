import * as fs from 'fs';
import { AppPaths } from './paths';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/**
 * 크로스 플랫폼 파일 기반 에러 및 이벤트 로거
 */
export class Logger {
  private static formatMessage(level: LogLevel, message: string, detail?: unknown): string {
    const timestamp = new Date().toISOString();
    let detailString = '';

    if (detail) {
      if (detail instanceof Error) {
        detailString = `\n  [Stack]: ${detail.stack || detail.message}`;
      } else if (typeof detail === 'object') {
        try {
          detailString = `\n  [Data]: ${JSON.stringify(detail)}`;
        } catch {
          detailString = `\n  [Data]: [Circular or Non-serializable]`;
        }
      } else {
        detailString = `\n  [Detail]: ${String(detail)}`;
      }
    }

    return `[${timestamp}] [${level}] ${message}${detailString}\n`;
  }

  /**
   * 로그 파일에 한 줄 추가 (Fail-safe)
   */
  private static appendToFile(formatted: string): void {
    try {
      const logFilePath = AppPaths.getErrorLogPath();
      fs.appendFileSync(logFilePath, formatted, 'utf-8');
    } catch (writeErr) {
      // 로거 자체의 실패로 인해 메인 앱이 뻗지 않도록 콘솔에만 출력하고 방어
      console.error('[Logger Fallback Error] 로그 파일 기록 실패:', writeErr);
    }
  }

  public static info(message: string, detail?: unknown): void {
    const formatted = this.formatMessage('INFO', message, detail);
    console.log(`%c${formatted.trim()}`, 'color: #3b82f6');
    this.appendToFile(formatted);
  }

  public static warn(message: string, detail?: unknown): void {
    const formatted = this.formatMessage('WARN', message, detail);
    console.warn(formatted.trim());
    this.appendToFile(formatted);
  }

  public static error(message: string, error?: unknown): void {
    const formatted = this.formatMessage('ERROR', message, error);
    console.error(formatted.trim());
    this.appendToFile(formatted);
  }
}