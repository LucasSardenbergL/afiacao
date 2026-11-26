/**
 * Dados do placar da "Visão do CEO" na home do master. Lê o MESMO cache do Cockpit financeiro
 * (mesmas queryKey/queryFn — `consulta*Cockpit`), então o número da home é o número da tela de
 * destino do clique. Só 3 das 7 leituras do cockpit: resumo (caixa, títulos), DRE (margem) e
 * snapshots de projeção (NCG). Derivados puros em `@/lib/financeiro/ceo-placar`.
 *
 * Cobrança: a MESMA RPC `cobranca_fila` da tela /cobranca, por empresa do escopo, em chave própria
 * (o formato aqui é outro — não divide o cache da fila). Chamada pelo nome, sem importar o módulo de
 * cobrança (gate de fronteiras). Erro LANÇA: fila não lida ≠ "ninguém deve".
 */
import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { useCompany, type Company } from '@/contexts/CompanyContext';
import { useFinanceiroRegime } from '@/hooks/useFinanceiroRegime';
import {
  EMPRESAS_COCKPIT,
  ResumoComTitulosFalhos,
  consultaDreCockpit,
  consultaResumoCockpit,
  consultaSnapshotsCockpit,
} from '@/components/financeiro/cockpit/useFinanceiroCockpit';
import { consolidarCockpit } from '@/lib/financeiro/cockpit-consolida-helpers';
import { hojeSP } from '@/lib/time/sp-day';
import {
  caixaDoEscopo,
  caixaProjetadoDoEscopo,
  cobrancaDoEscopo,
  composicaoMargem,
  composicaoNcgDoEscopo,
  devedorDaFila,
  empresasDoEscopo,
  linhasPorEmpresa,
  margemUltimoMesFechado,
  ncgDoEscopo,
  vencidosDoEscopo,
  type DevedorCobranca,
  type ResumoCnpj,
} from '@/lib/financeiro/ceo-placar';

const consultaCobrancaCeo = (company: Company) => ({
  queryKey: ['financeiro-cockpit', 'cobranca-ceo', company] as const,
  queryFn: async (): Promise<DevedorCobranca[]> => {
    const linhas = await fetchAllPages(
      (de, ate) =>
        supabase.rpc('cobranca_fila', { p_company: company }).select('*').order('omie_codigo_cliente', { ascending: true }).range(de, ate),
      `cobranca_fila (${company})`,
    );
    return linhas.map((r) => devedorDaFila(r as Record<string, unknown>)).filter((d): d is DevedorCobranca => d !== null);
  },
});

export function useCeoPlacar() {
  const { selection } = useCompany();
  const { regime } = useFinanceiroRegime();
  // Mesmo relógio do tile de vendas (`useTeamKpis`): dia em São Paulo, não o fuso do browser.
  const hoje = hojeSP();
  const [ano, mesCorrente] = hoje.split('-').map(Number);

  const resumoQ = useQuery(consultaResumoCockpit());
  const dreQ = useQuery(consultaDreCockpit(ano, regime));
  const snapsQ = useQuery(consultaSnapshotsCockpit());

  // Títulos de algum CNPJ falharam: o erro carrega o resumo parcial (o saldo CC lido certo vale).
  const resumo: Record<string, ResumoCnpj> | null =
    resumoQ.data ?? (resumoQ.error instanceof ResumoComTitulosFalhos ? resumoQ.error.resumo : null);
  const dre = dreQ.data ?? null;
  const ncgFonte = useMemo(
    () => (snapsQ.data ? consolidarCockpit({ esperadas: EMPRESAS_COCKPIT, snapshots: snapsQ.data }) : null),
    [snapsQ.data],
  );

  const empresas = empresasDoEscopo(selection);
  const cobrancaQs = useQueries({ queries: empresas.map((co) => consultaCobrancaCeo(co)) });
  const filas: Partial<Record<Company, DevedorCobranca[]>> = {};
  cobrancaQs.forEach((q, i) => {
    if (q.data) filas[empresas[i]] = q.data;
  });

  return {
    regime,
    carregando: {
      resumo: resumoQ.isPending,
      dre: dreQ.isPending,
      ncg: snapsQ.isPending,
      cobranca: cobrancaQs.some((q) => q.isPending),
    },
    // Falha de leitura ≠ dado ausente: a tela diz "leitura falhou", não "sem mês fechado".
    // Resumo com títulos falhos ainda tem o saldo CC — só é erro total sem resumo nenhum.
    erro: {
      resumo: resumo === null && resumoQ.isError,
      dre: dreQ.isError,
      ncg: snapsQ.isError,
      cobranca: cobrancaQs.some((q) => q.isError),
    },
    caixa: caixaDoEscopo(resumo, empresas),
    vencidos: vencidosDoEscopo(resumo, empresas),
    margem: margemUltimoMesFechado(dre, empresas, mesCorrente),
    composicaoMargem: composicaoMargem(dre, empresas, mesCorrente),
    ncg: ncgDoEscopo(ncgFonte, empresas),
    composicaoNcg: composicaoNcgDoEscopo(snapsQ.data ?? null, empresas),
    caixaProjetado: caixaProjetadoDoEscopo(snapsQ.data ?? null, empresas, hoje),
    cobranca: cobrancaDoEscopo(filas, empresas),
    porEmpresa: selection === 'all' ? linhasPorEmpresa(resumo, dre, ncgFonte, empresas, mesCorrente) : [],
  };
}
