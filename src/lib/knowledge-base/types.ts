export type KbDocumentStatus = 'processing' | 'ready' | 'error' | 'draft';

export type KbDocumentType =
  | 'boletim_tecnico'
  | 'case'
  | 'comparativo'
  | 'tutorial'
  | 'msds'
  | 'outro';

export interface KbDocument {
  id: string;
  title: string;
  type: KbDocumentType;
  supplier: string | null;
  product_code: string | null;
  file_url: string;
  file_size_bytes: number | null;
  content_extracted: string | null;
  tags: string[];
  status: KbDocumentStatus;
  status_error: string | null;
  version: number;
  parent_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export const KB_DOCUMENT_TYPE_LABEL: Record<KbDocumentType, string> = {
  boletim_tecnico: 'Boletim técnico',
  case: 'Case',
  comparativo: 'Comparativo',
  tutorial: 'Tutorial',
  msds: 'MSDS / FISPQ',
  outro: 'Outro',
};
