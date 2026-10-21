// Borda das views `v_caca_*`: view perde o NOT NULL (no types.ts toda coluna é `| null`) e
// `empresa`/`empresa_alvo` são texto. As colunas sem as quais a linha não faz sentido são EXIGIDAS
// (lança — ausente ≠ zero) e a empresa é guardada pelo vocabulário de `EmpresaAlvo`. Em prod
// (2026-10-20): 0 nulos nessas colunas em 1.691 compradores e 10.799 candidatos.
import type { Tables } from '@/integrations/supabase/types';
import { exigirColunas } from '@/lib/linha-view';
import type { CandidatoRow, CompradorRow, EmpresaAlvo } from './types';

const EMPRESAS: readonly string[] = ['oben', 'colacor', 'colacor_sc'] satisfies readonly EmpresaAlvo[];
const ehEmpresa = (v: string): v is EmpresaAlvo => EMPRESAS.includes(v);

type LinhaComprador = Pick<
  Tables<'v_caca_compradores'>,
  | 'documento'
  | 'empresa'
  | 'cidade_uf'
  | 'ramo'
  | 'ticket_faixa'
  | 'familias'
  | 'volume'
  | 'n_pedidos'
  | 'recencia_dias'
  | 'lucro_proxy'
  | 'lucro_cobertura'
>;

type LinhaCandidato = Pick<
  Tables<'v_caca_candidatos'>,
  | 'documento'
  | 'empresa_alvo'
  | 'cidade_uf'
  | 'ramo'
  | 'ticket_faixa'
  | 'familias'
  | 'compra_em_outra_empresa'
  | 'ultima_compra_grupo_dias'
  | 'nome'
  | 'telefone'
  | 'cliente_user_id'
>;

export function paraComprador(l: LinhaComprador): CompradorRow {
  const fonte = 'v_caca_compradores';
  exigirColunas(l, ['documento', 'empresa', 'familias', 'volume', 'n_pedidos', 'recencia_dias', 'lucro_cobertura'], fonte);
  const { empresa } = l;
  if (!ehEmpresa(empresa)) throw new Error(`${fonte}: empresa desconhecida "${empresa}"`);
  return { ...l, empresa };
}

export function paraCandidato(l: LinhaCandidato): CandidatoRow {
  const fonte = 'v_caca_candidatos';
  exigirColunas(l, ['documento', 'empresa_alvo', 'familias', 'compra_em_outra_empresa', 'cliente_user_id'], fonte);
  const { empresa_alvo } = l;
  if (!ehEmpresa(empresa_alvo)) throw new Error(`${fonte}: empresa_alvo desconhecida "${empresa_alvo}"`);
  return { ...l, empresa_alvo };
}
