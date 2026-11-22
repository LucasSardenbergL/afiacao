/**
 * Dados do placar da "Visão do CEO" na home do master. Lê o MESMO cache do Cockpit financeiro
 * (mesmas queryKey/queryFn — `consulta*Cockpit`), então o número da home é o número da tela de
 * destino do clique. Só 3 das 7 leituras do cockpit: resumo (caixa, títulos), DRE (margem) e
 * snapshots de projeção (NCG). Derivados puros em `@/lib/financeiro/ceo-placar`.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCompany } from '@/contexts/CompanyContext';
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
  empresasDoEscopo,
  linhasPorEmpresa,
  margemUltimoMesFechado,
  ncgDoEscopo,
  vencidosDoEscopo,
  type ResumoCnpj,
} from '@/lib/financeiro/ceo-placar';

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

  return {
    regime,
    carregando: { resumo: resumoQ.isPending, dre: dreQ.isPending, ncg: snapsQ.isPending },
    // Falha de leitura ≠ dado ausente: a tela diz "leitura falhou", não "sem mês fechado".
    // Resumo com títulos falhos ainda tem o saldo CC — só é erro total sem resumo nenhum.
    erro: { resumo: resumo === null && resumoQ.isError, dre: dreQ.isError, ncg: snapsQ.isError },
    caixa: caixaDoEscopo(resumo, empresas),
    vencidos: vencidosDoEscopo(resumo, empresas),
    margem: margemUltimoMesFechado(dre, empresas, mesCorrente),
    ncg: ncgDoEscopo(ncgFonte, empresas),
    caixaProjetado: caixaProjetadoDoEscopo(snapsQ.data ?? null, empresas, hoje),
    porEmpresa: selection === 'all' ? linhasPorEmpresa(resumo, dre, ncgFonte, empresas, mesCorrente) : [],
  };
}
