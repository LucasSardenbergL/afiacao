// Borda das views de reposição. O idioma genérico (exigir as colunas-chave de uma view, que perde o
// NOT NULL no `types.ts`) vive em `@/lib/linha-view`; aqui fica só o que é do domínio (enum empresa).
import type { Database } from '@/integrations/supabase/types';

export { exigirColunas, linhasCom } from '@/lib/linha-view';
export type { ComColunas } from '@/lib/linha-view';

export type EmpresaReposicao = Database['public']['Enums']['empresa_reposicao'];

/** Guarda do enum `empresa_reposicao` (as views de reposição tipam `empresa` por ele; a UI carrega string). */
function ehEmpresaReposicao(s: string | null | undefined): s is EmpresaReposicao {
  return s === 'OBEN' || s === 'COLACOR';
}

export function exigirEmpresaReposicao(s: string | null | undefined, fonte: string): EmpresaReposicao {
  if (!ehEmpresaReposicao(s)) throw new Error(`${fonte}: empresa "${String(s)}" fora de OBEN/COLACOR`);
  return s;
}
