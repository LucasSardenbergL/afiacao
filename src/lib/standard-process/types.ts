import type { ProcessEtapa } from '@/lib/customer-process/types';

/** Etapa do processo padrão estende ProcessEtapa do PR-P1 + vincula produtos do KB */
export interface StandardProcessEtapa extends ProcessEtapa {
  /** Códigos de kb_product_specs.product_code recomendados pra essa etapa */
  produtos_kb: string[];
  /** Texto livre adicional explicando por que esse produto/abordagem */
  rationale?: string;
}

export type StandardProcessStatus = 'draft' | 'in_review' | 'published' | 'archived';

export interface StandardProcess {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  segmento: string;
  porte_alvo: string[];
  tags: string[];
  etapas: StandardProcessEtapa[];
  expected_outcomes: string[];
  target_audience: string | null;
  prerequisites: string[];
  status: StandardProcessStatus;
  status_notes: string | null;
  version: number;
  parent_id: string | null;
  created_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export const STANDARD_PROCESS_STATUS_LABEL: Record<StandardProcessStatus, string> = {
  draft: 'Rascunho',
  in_review: 'Em revisão',
  published: 'Publicado',
  archived: 'Arquivado',
};

/** Slug helper: "Sayerlack PU 2K Alto Padrão" → "sayerlack-pu-2k-alto-padrao" */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}
