export interface ParsedCardItem {
  front: string;
  back: string;
  example?: string;
  lineNumber: number;
}

export interface CsvParseResult {
  validCards: ParsedCardItem[];
  skippedCount: number;
  errors: string[];
  headerError?: string;
}

/**
 * Q, A, E 헤더 강제 검증 및 멀티라인(Alt+Enter)·따옴표 완벽 지원 CSV/TSV 파서
 */
export class CsvParser {
  public static parse(rawText: string): CsvParseResult {
    const validCards: ParsedCardItem[] = [];
    const errors: string[] = [];
    let skippedCount = 0;

    // UTF-8 BOM(\uFEFF) 제거 및 줄바꿈 표준화
    const cleanText = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    if (!cleanText.trim()) {
      return {
        validCards: [],
        skippedCount: 0,
        errors: ['파일 내용이 비어 있습니다.'],
        headerError: '파일 내용이 비어 있습니다.'
      };
    }

    // 1. 첫 줄(헤더 영역)에서 구분자(탭 vs 쉼표) 자동 판별
    const firstNewlineIdx = cleanText.indexOf('\n');
    const firstLineSample = firstNewlineIdx === -1 ? cleanText : cleanText.slice(0, firstNewlineIdx);
    const delimiter = firstLineSample.includes('\t') ? '\t' : ',';

    // 2. 큰따옴표("...") 내부의 줄바꿈(Alt+Enter)과 쉼표를 보존하며 행(Row) 단위 파싱
    const rows = this.parseFullCsvRows(cleanText, delimiter);

    if (rows.length === 0) {
      return {
        validCards: [],
        skippedCount: 0,
        errors: ['유효한 데이터가 없습니다.'],
        headerError: '유효한 데이터가 없습니다.'
      };
    }

    // 3. 첫 번째 행(1행) 대문자 Q, A, E 필수 선언 검증
    const headerRow = rows[0].columns.map(col => col.trim());
    const isValidHeader =
      headerRow.length >= 3 &&
      headerRow[0] === 'Q' &&
      headerRow[1] === 'A' &&
      headerRow[2] === 'E';

    if (!isValidHeader) {
      const headerErrorMsg =
        '엑셀(CSV) 첫 번째 줄(1행)의 1~3열은 반드시 대문자 Q, A, E 순서로 선언되어야 합니다.\n\n' +
        '• A1칸: Q (단어/문제 - 필수)\n' +
        '• B1칸: A (뜻/정답 - 필수)\n' +
        '• C1칸: E (예문/보충설명 - 선택)\n\n' +
        `현재 감지된 1행: [${headerRow.slice(0, 3).join(', ') || '비어 있음'}]`;
      return {
        validCards: [],
        skippedCount: rows.length,
        errors: [headerErrorMsg],
        headerError: headerErrorMsg
      };
    }

    // 4. 2행부터 데이터 검증 (Q, A 필수 / E 선택)
    for (let i = 1; i < rows.length; i++) {
      const { columns, rowNumber } = rows[i];

      const qText = (columns[0] ?? '').trim();
      const aText = (columns[1] ?? '').trim();
      const eText = (columns[2] ?? '').trim();

      // 모든 열이 완전히 비어있는 공백 행(엑셀 하단 빈 줄)은 조용히 건너뜀
      const isCompletelyEmpty = columns.every(col => col.trim() === '');
      if (isCompletelyEmpty) {
        continue;
      }

      // Q(단어) 또는 A(뜻) 중 하나라도 비어 있으면 오류 행으로 간주하고 업로드에서 삭제(제외)
      if (!qText || !aText) {
        skippedCount++;
        const preview = qText || aText || eText || '빈 행';
        errors.push(`[${rowNumber}행 삭제됨] Q 또는 A 칸이 비어 있어 제외됨 ("${preview.slice(0, 20)}")`);
        continue;
      }

      validCards.push({
        front: qText,
        back: aText,
        example: eText ? eText : undefined,
        lineNumber: rowNumber
      });
    }

    return { validCards, skippedCount, errors };
  }

  /**
   * RFC 4180 상태 머신:
   * 큰따옴표("...") 내부의 줄바꿈(\n)과 구분자(, 또는 \t)를 쪼개지 않고 하나의 셀로 묶어냅니다.
   */
  private static parseFullCsvRows(
    text: string,
    delimiter: string
  ): { columns: string[]; rowNumber: number }[] {
    const rows: { columns: string[]; rowNumber: number }[] = [];
    let currentColumns: string[] = [];
    let currentCell = '';
    let inQuotes = false;
    let currentLineNumber = 1;
    let rowStartLineNumber = 1;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (char === '"') {
        if (inQuotes && text[i + 1] === '"') {
          // 엑셀의 이스케이프된 쌍따옴표("") -> 실제 따옴표(") 1개로 복원
          currentCell += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === delimiter && !inQuotes) {
        currentColumns.push(currentCell);
        currentCell = '';
      } else if (char === '\n' && !inQuotes) {
        currentColumns.push(currentCell);
        rows.push({ columns: currentColumns, rowNumber: rowStartLineNumber });
        currentColumns = [];
        currentCell = '';
        currentLineNumber++;
        rowStartLineNumber = currentLineNumber;
      } else {
        if (char === '\n') {
          currentLineNumber++;
        }
        currentCell += char;
      }
    }

    // 마지막 줄 처리
    if (currentCell.length > 0 || currentColumns.length > 0) {
      currentColumns.push(currentCell);
      rows.push({ columns: currentColumns, rowNumber: rowStartLineNumber });
    }

    return rows;
  }
}