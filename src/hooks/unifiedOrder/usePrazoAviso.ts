import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';

/**
 * Aviso de prazo no pedido (Frente B do plano Oben PME/PMR, PR1): vencido em aberto do par
 * (conta, código Omie) lido pela RPC `venda_prazo_aviso` — SECURITY DEFINER com gate staff,
 * 0,5 ms por cliente, espelhando a regra `vencida_aberta` da view do Ciclo.
 *
 * Money-path (precisão > recall, ausente ≠ zero): a RPC responde `disponivel:false` sem código;
 * payload que não casa o contrato vira `null` (indisponível), nunca "vencido 0". `vencido: 0`
 * só chega quando a RPC LEU as linhas e a soma deu zero.
 */

export type ContaPedido = 'oben' | 'colacor';

export interface AvisoPrazo {
  vencido: number;
  nTitulos: number;
  diasVencidoMax: number | null;
  vencimentoMaisAntigo: string | null;
  /** Atraso médio ponderado por saldo SÓ do vencido em aberto (não é o atraso histórico da view). */
  atrasoMedioVencidoDias: number | null;
  nAmbiguos: number;
  nInvalidos: number;
  syncEm: string | null;
  qualidade: 'ok' | 'defasado' | 'sem_sync';
}

function numOuNull(x: unknown): number | null {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Parser fail-closed do jsonb da RPC. Contrato quebrado ⇒ `null` (indisponível). */
export function parseAvisoPrazo(j: Json | null | undefined): AvisoPrazo | null {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, Json | undefined>;
  if (o.disponivel !== true) return null;
  const vencido = numOuNull(o.vencido);
  const nTitulos = numOuNull(o.n_titulos);
  const nAmbiguos = numOuNull(o.n_ambiguos);
  const nInvalidos = numOuNull(o.n_invalidos);
  const dias = o.dias_vencido_max === null || o.dias_vencido_max === undefined ? null : numOuNull(o.dias_vencido_max);
  const inteiroNaoNegativo = (n: number | null) => n !== null && Number.isInteger(n) && n >= 0;
  // Contrato: contagens inteiras ≥ 0; dias ausente só com vencido 0; saldo > 0 exige títulos > 0 e dias.
  if (vencido === null || vencido < 0 || !inteiroNaoNegativo(nTitulos) || !inteiroNaoNegativo(nAmbiguos) || !inteiroNaoNegativo(nInvalidos)) return null;
  if (o.dias_vencido_max !== null && o.dias_vencido_max !== undefined && !inteiroNaoNegativo(dias)) return null;
  if ((vencido > 0) !== (nTitulos! > 0)) return null;
  if (vencido > 0 && dias === null) return null;
  const qualidade = o.qualidade;
  return {
    vencido,
    nTitulos: nTitulos!,
    diasVencidoMax: dias,
    vencimentoMaisAntigo: typeof o.vencimento_mais_antigo === 'string' ? o.vencimento_mais_antigo : null,
    atrasoMedioVencidoDias: numOuNull(o.atraso_medio_vencido_dias),
    nAmbiguos: nAmbiguos!,
    nInvalidos: nInvalidos!,
    syncEm: typeof o.sync_em === 'string' ? o.sync_em : null,
    qualidade: qualidade === 'ok' || qualidade === 'defasado' || qualidade === 'sem_sync' ? qualidade : 'sem_sync',
  };
}

export function usePrazoAviso(company: ContaPedido, codigo: number | null | undefined) {
  const ativo = typeof codigo === 'number' && Number.isFinite(codigo) && codigo > 0;
  return useQuery({
    queryKey: ['venda-prazo-aviso', company, ativo ? codigo : null],
    enabled: ativo,
    staleTime: 60_000,
    queryFn: async (): Promise<AvisoPrazo | null> => {
      const { data, error } = await supabase.rpc('venda_prazo_aviso', { p_company: company, p_codigo: codigo as number });
      if (error) throw new Error(error.message);
      return parseAvisoPrazo(data);
    },
  });
}
