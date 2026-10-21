import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { Json } from '@/integrations/supabase/types';

// `type`, não `interface`: o array vai direto no `p_itens` (Json), que exige assinatura de índice.
export type ItemCockpitInput = {
  empresa: string; codigo: number; preco: number; tint_formula_id?: string | null;
  // Tier-aware (Fase A preço por tier): o cockpit resolve o tier SERVER-SIDE por este
  // customer (jamais confia num tier vindo do payload). Ausente → cascata-produto (vigente).
  customer_user_id?: string | null;
};
export interface LinhaCockpit {
  codigo: number; empresa: string;
  faixa: 'vermelho' | 'amarelo' | 'verde' | 'neutro';
  motivo: string; tem_custo: boolean; tem_politica: boolean; calculated_at: string;
  tier: 'A' | 'B' | 'C' | null;
  cmc: number | null; markup_perc: number | null; folga_reais: number | null;
  piso_markup: number | null; meta_markup: number | null;
  proveniencia: string | null; frescor: string | null;
}

const FAIXAS: readonly LinhaCockpit['faixa'][] = ['vermelho', 'amarelo', 'verde', 'neutro'];
const TIERS: readonly NonNullable<LinhaCockpit['tier']>[] = ['A', 'B', 'C'];

type ObjetoJson = { [chave: string]: Json | undefined };

function campo<T extends Json | undefined>(o: ObjetoJson, chave: string, ok: (v: Json | undefined) => v is T, forma: string): T {
  const v = o[chave];
  if (!ok(v)) throw new Error(`get_preco_cockpit: "${chave}" fora da forma (${forma})`);
  return v;
}
const ehTexto = (v: Json | undefined): v is string => typeof v === 'string';
const ehNumero = (v: Json | undefined): v is number => typeof v === 'number';
const ehBool = (v: Json | undefined): v is boolean => typeof v === 'boolean';
const ehNumeroOuNulo = (v: Json | undefined): v is number | null => v === null || typeof v === 'number';
const ehTextoOuNulo = (v: Json | undefined): v is string | null => v === null || typeof v === 'string';

/**
 * O jsonb da RPC lido por forma. A função monta as 15 chaves com `jsonb_build_object`: número sem
 * custo (ou sem permissão `pode_num`) vem NULL explícito e continua NULL aqui — ausente ≠ zero.
 * Chave ausente ou tipo trocado LANÇA: a query falha e o wizard segue sem cockpit (é informativo).
 */
function linhasCockpitDoJson(data: Json): LinhaCockpit[] {
  if (!Array.isArray(data)) throw new Error('get_preco_cockpit: retorno não é array');
  return data.map((bruta) => {
    if (typeof bruta !== 'object' || bruta === null || Array.isArray(bruta)) {
      throw new Error('get_preco_cockpit: linha não é objeto');
    }
    const faixaTexto = campo(bruta, 'faixa', ehTexto, 'texto');
    const faixa = FAIXAS.find((f) => f === faixaTexto);
    if (!faixa) throw new Error(`get_preco_cockpit: faixa desconhecida (${faixaTexto})`);
    const tierTexto = campo(bruta, 'tier', ehTextoOuNulo, 'texto ou null');
    const tier = tierTexto === null ? null : TIERS.find((t) => t === tierTexto);
    if (tier === undefined) throw new Error(`get_preco_cockpit: tier desconhecido (${tierTexto})`);
    return {
      codigo: campo(bruta, 'codigo', ehNumero, 'número'),
      empresa: campo(bruta, 'empresa', ehTexto, 'texto'),
      faixa,
      motivo: campo(bruta, 'motivo', ehTexto, 'texto'),
      tem_custo: campo(bruta, 'tem_custo', ehBool, 'booleano'),
      tem_politica: campo(bruta, 'tem_politica', ehBool, 'booleano'),
      calculated_at: campo(bruta, 'calculated_at', ehTexto, 'texto'),
      tier,
      cmc: campo(bruta, 'cmc', ehNumeroOuNulo, 'número ou null'),
      markup_perc: campo(bruta, 'markup_perc', ehNumeroOuNulo, 'número ou null'),
      folga_reais: campo(bruta, 'folga_reais', ehNumeroOuNulo, 'número ou null'),
      piso_markup: campo(bruta, 'piso_markup', ehNumeroOuNulo, 'número ou null'),
      meta_markup: campo(bruta, 'meta_markup', ehNumeroOuNulo, 'número ou null'),
      proveniencia: campo(bruta, 'proveniencia', ehTextoOuNulo, 'texto ou null'),
      frescor: campo(bruta, 'frescor', ehTextoOuNulo, 'texto ou null'),
    };
  });
}

/** Mapa codigo→linha. Falha do cockpit NÃO derruba o wizard (cockpit é informativo). */
export function usePrecoCockpit(itens: ItemCockpitInput[]) {
  // #3 (Codex P1): o uid real entra no queryKey pra o cache de markup/folga NÃO
  // vazar entre usuários no mesmo browser (logout do gestor → login de vendedora).
  // useAuth() é SEMPRE o usuário real (identidade), nunca a lente "Ver como".
  const { user } = useAuth();
  return useQuery({
    queryKey: ['preco-cockpit', user?.id ?? 'anon', itens],
    enabled: itens.length > 0,
    staleTime: 60_000,
    // Retorna o array NA ORDEM do input (1 linha por item). Quem chama casa por
    // índice/chave — o tint repete o mesmo codigo com formulas diferentes, então
    // um Map por codigo colapsaria (por isso não mapeamos aqui).
    queryFn: async (): Promise<LinhaCockpit[]> => {
      const { data, error } = await supabase.rpc('get_preco_cockpit', { p_itens: itens });
      if (error) throw error;
      return linhasCockpitDoJson(data);
    },
  });
}

/** Chave estável p/ casar uma linha do cockpit (tint repete codigo por cor). */
export function chaveCockpit(empresa: string, codigo: number, tintFormulaId?: string | null): string {
  return `${empresa}:${codigo}:${tintFormulaId ?? ''}`;
}
