// Constantes, tipos e helpers puros da Importação Tintométrica (TintImport).
// Extraídos de src/pages/TintImport.tsx (god-component split).
import { invokeFunction } from '@/lib/invoke-function';

export const ACCOUNT = 'oben';
export const CHUNK_SIZE_DEFAULT = 200;
export const CHUNK_SIZE_FORMULAS = 50; // Formulas are heavy (~10 DB ops per row)
export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 2000;

export function getChunkSize(tipo: string): number {
  if (tipo === 'formulas_padrao' || tipo === 'formulas_personalizadas') return CHUNK_SIZE_FORMULAS;
  return CHUNK_SIZE_DEFAULT;
}

export interface TintImportChunkResult {
  registros_importados?: number;
  registros_atualizados?: number;
  registros_erro?: number;
  status?: string;
  message?: string;
  importacao_id?: string;
  erros?: Array<{ linha: number | string; motivo: string }>;
  [k: string]: unknown;
}

export interface TintSyncResult {
  total_sincronizado?: number;
  totalSynced?: number;
  [k: string]: unknown;
}

export interface TintImportacaoRow {
  id: string;
  tipo: string;
  arquivo_nome: string;
  status: string;
  total_registros: number | null;
  registros_importados: number | null;
  registros_atualizados: number | null;
  registros_erro: number | null;
  created_at: string;
  [k: string]: unknown;
}

export interface TintImportFileResult extends TintImportChunkResult {
  name: string;
  imported?: number;
  updated?: number;
  errors?: number;
  total_registros?: number;
  failed_chunks?: number;
  error?: string | null;
}

export interface FileWithPreview {
  file: File;
  preview: string[][];
  name: string;
  rawText: string;
}

export const TIPO_OPTIONS = [
  { value: 'dados_corantes', label: 'Dados auxiliares — Corantes' },
  { value: 'dados_produto_base_embalagem', label: 'Dados auxiliares — Produto/Base/Embalagem' },
  { value: 'formulas_padrao', label: 'Fórmulas — Cores Padrões' },
  { value: 'formulas_personalizadas', label: 'Fórmulas — Personalizadas' },
];

export const statusColor: Record<string, string> = {
  concluido: 'bg-status-success-bg text-status-success',
  concluido_parcial: 'bg-status-warning-bg text-status-warning',
  parcial: 'bg-status-warning-bg text-status-warning',
  erro: 'bg-status-error-bg text-status-error',
  processando: 'bg-status-info-bg text-status-info',
  duplicado: 'bg-muted text-muted-foreground',
};

export async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function sendChunkWithRetry(
  body: Record<string, unknown>,
  chunkIndex: number,
  totalChunks: number,
): Promise<TintImportChunkResult> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`Chunk ${chunkIndex + 1}/${totalChunks}: enviando... (tentativa ${attempt}/${MAX_RETRIES})`);
      const res = await invokeFunction<TintImportChunkResult>('tint-import', body);
      console.log(`Chunk ${chunkIndex + 1}/${totalChunks}: sucesso, ${res.registros_importados ?? 0} importados, ${res.registros_atualizados ?? 0} atualizados`);
      return res;
    } catch (err) {
      console.error(`Chunk ${chunkIndex + 1}/${totalChunks}: falhou tentativa ${attempt}/${MAX_RETRIES}`, err);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      } else {
        throw err;
      }
    }
  }
  throw new Error(`sendChunkWithRetry exhausted retries for chunk ${chunkIndex + 1}`);
}
