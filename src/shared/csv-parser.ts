export interface ParsedCardItem {
  front: string;
  back: string;
  lineNumber: number;
}

export interface CsvParseResult {
  validCards: ParsedCardItem[];
  skippedCount: number;
  errors: string[];
}

/**
 * RFC 4180 호환 및 에러 방어형 CSV/TSV 파서
 */
export class CsvParser {
  /**
   * CSV 또는 TSV 텍스트를 파싱하여 유효한 카드 목록을 추출합니다.
   * @param rawText 업로드된 파일의 원본 텍스트
   */
  public static parse(rawText: string): CsvParseResult {
    const validCards: ParsedCardItem[] = [];
    const errors: string[] = [];
    let skippedCount = 0;

    // 윈도우(CRLF)와 맥/리눅스(LF) 줄바꿈 통일
    const lines = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNumber = i + 1;

      // 1. 완전 빈 줄 건너뛰기
      if (!line) {
        skippedCount++;
        continue;
      }

      // 2. 구분자 판별 (탭 우선, 없으면 쉼표)
      const delimiter = line.includes('\t') ? '\t' : ',';
      const columns = this.parseCsvLine(line, delimiter);

      // 3. 열 개수 검증 (최소 앞면, 뒷면 2개 필요)
      if (columns.length < 2) {
        skippedCount++;
        errors.push(`[${lineNumber}행] 앞면과 뒷면 구분이 올바르지 않아 건너뜀: "${line.slice(0, 30)}..."`);
        continue;
      }

      const front = columns[0].trim();
      const back = columns[1].trim();

      // 4. 헤더 행(제목) 자동 감지 및 스킵
      if (i === 0 && this.isHeaderRow(front, back)) {
        skippedCount++;
        continue;
      }

      // 5. 공백 칸 검증
      if (!front || !back) {
        skippedCount++;
        errors.push(`[${lineNumber}행] 문제 또는 정답 칸이 비어있음`);
        continue;
      }

      validCards.push({ front, back, lineNumber });
    }

    return { validCards, skippedCount, errors };
  }

  /**
   * 따옴표(")로 감싸진 쉼표를 보존하는 단일 행 파서
   */
  private static parseCsvLine(line: string, delimiter: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        // 따옴표 이스케이프 ("") 처리
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === delimiter && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  }

  /**
   * 헤더(제목 행) 판별
   */
  private static isHeaderRow(front: string, back: string): boolean {
    const f = front.toLowerCase();
    const b = back.toLowerCase();
    const headerKeywords = ['front', 'back', 'question', 'answer', '단어', '뜻', '앞면', '뒷면', '문제', '정답', 'word', 'meaning'];
    return headerKeywords.includes(f) && headerKeywords.includes(b);
  }
}