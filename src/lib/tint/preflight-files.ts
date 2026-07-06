import Papa from 'papaparse';
import { preflightFormulaRows, summarizePreflight, type PreflightResult } from './preflight-formulas';

// Roda o PREFLIGHT money-path sobre os arquivos CSV selecionados, ANTES de qualquer
// escrita — a fronteira ÚNICA client-side que cobre as 4 vias de import (hook direto,
// hook RPC, edge file-mode, edge chunk-mode). O edge processa em chunks e nunca vê o
// arquivo inteiro, então a validação do arquivo completo tem de morar aqui [Codex P1#3].
// Só se aplica a fórmulas (é onde vivem qtd de corante + preço); os tipos auxiliares
// não têm receita/preço money-crítico.

export interface FilePreflightOffense {
  fileName: string;
  result: PreflightResult;
  /** Mensagem pronta para toast/relatório (dry-run). */
  message: string;
}

const isFormulaType = (tipo: string) =>
  tipo === 'formulas_padrao' || tipo === 'formulas_personalizadas';

export function preflightImportFiles(
  files: Array<{ name: string; rawText: string }>,
  tipo: string,
): FilePreflightOffense[] {
  if (!isFormulaType(tipo)) return [];
  const personalizada = tipo === 'formulas_personalizadas';
  const offenders: FilePreflightOffense[] = [];
  for (const f of files) {
    const parsed = Papa.parse<string[]>(f.rawText, { delimiter: ';', skipEmptyLines: true });
    const dataRows = (parsed.data ?? []).slice(1); // descarta o cabeçalho
    const result = preflightFormulaRows(dataRows, personalizada);
    if (!result.ok) {
      offenders.push({ fileName: f.name, result, message: summarizePreflight(result) });
    }
  }
  return offenders;
}
