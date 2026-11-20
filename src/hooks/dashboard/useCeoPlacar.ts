/**
 * Dados do placar da "Visão do CEO" na home do master. Lê o MESMO cache do Cockpit financeiro
 * (mesmas queryKey/queryFn — `consulta*Cockpit`), então o número da home é o número da tela de
 * destino do clique. Só 3 das 7 leituras do cockpit: resumo (caixa, títulos), DRE (margem) e
 * snapshots de projeção (NCG). Derivados puros em `@/lib/dashboard/ceo-placar`.
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
import {
  caixaDoEscopo,
  empresasDoEscopo,
  linhasPorEmpresa,
  margemUltimoMesFechado,
  ncgDoEscopo,
  vencidosDoEscopo,
  type ResumoCnpj,
} from '@/lib/dashboard/ceo-placar';

export function useCeoPlacar() {
  const { selection } = useCompany();
  const { regime } = useFinanceiroRegime();
  const agora = new Date();
  const ano = agora.getFullYear();
  const mesCorrente = agora.getMonth() + 1;

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
    caixa: caixaDoEscopo(resumo, empresas),
    vencidos: vencidosDoEscopo(resumo, empresas),
    margem: margemUltimoMesFechado(dre, empresas, mesCorrente),
    ncg: ncgDoEscopo(ncgFonte, empresas),
    porEmpresa: selection === 'all' ? linhasPorEmpresa(resumo, dre, ncgFonte, empresas, mesCorrente) : [],
  };
}
