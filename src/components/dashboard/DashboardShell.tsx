import { useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DashboardPersonaProvider, useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';
import { DashboardEditModeProvider } from '@/contexts/DashboardEditModeContext';
import { useRegisterShortcuts } from '@/components/shell/ShortcutsRegistry';
import { useNavigate } from 'react-router-dom';
import { track } from '@/lib/analytics';
import { useRegistrarVisitaDashboard, useTrackDashboardViewed } from '@/hooks/useLastVisit';
import { useCompany } from '@/contexts/CompanyContext';
import { BriefZone } from './BriefZone';
import { CockpitGrid } from './CockpitGrid';
import { DashboardFooter } from './DashboardFooter';
import { useVendasZone } from '@/hooks/dashboard/useVendasZone';
import { useEstoqueZone } from '@/hooks/dashboard/useEstoqueZone';
import { useReposicaoZone } from '@/hooks/dashboard/useReposicaoZone';
import { useFinanceiroZone } from '@/hooks/dashboard/useFinanceiroZone';
import { useTintometricoZone } from '@/hooks/dashboard/useTintometricoZone';
import { useSistemaZone } from '@/hooks/dashboard/useSistemaZone';
import { pickWinner } from '@/lib/dashboard/priority-rules';
import { PERSONA_CONFIG, type ZoneId } from '@/lib/dashboard/persona-config';
import type { PriorityCandidate } from '@/lib/dashboard/priority-rules';

export function DashboardShell() {
  return (
    <DashboardPersonaProvider>
      <DashboardEditModeProvider>
        <DashboardBody />
      </DashboardEditModeProvider>
    </DashboardPersonaProvider>
  );
}

function DashboardBody() {
  const { persona, source } = useDashboardPersonaContext();
  const { selection } = useCompany();
  // ESCRITOR ÚNICO de dashboard_visits (useLastVisit é só leitura e monta 3× aqui)
  useRegistrarVisitaDashboard({
    persona,
    companySelection: selection === 'all' ? 'all' : String(selection),
  });

  // dashboard.viewed — espera a leitura da visita anterior resolver antes de
  // emitir, senão `time_since_last_visit_min` sai nulo (era o caso em 39 de 46).
  useTrackDashboardViewed({
    persona,
    personaSource: source,
    companyMode: selection === 'all' ? 'all' : 'single',
    companyId: selection,
  });

  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Coleta priorities das 6 zonas — todos os hooks rodam sempre (ordem fixa hook react)
  const vendas = useVendasZone();
  const estoque = useEstoqueZone();
  const reposicao = useReposicaoZone();
  const financeiro = useFinanceiroZone();
  const tint = useTintometricoZone();
  const sistema = useSistemaZone();

  const zonesByPersona = PERSONA_CONFIG[persona].priorityZones;
  const winner = useMemo<PriorityCandidate | null>(() => {
    const candidates: PriorityCandidate[] = [];
    const byZone: Record<ZoneId, PriorityCandidate | null> = {
      vendas: vendas.priority,
      estoque: estoque.priority,
      reposicao: reposicao.priority,
      financeiro: financeiro.priority,
      tintometrico: tint.priority,
      sistema: sistema.priority,
    };
    for (const z of zonesByPersona) {
      const c = byZone[z];
      if (c) candidates.push(c);
    }
    const w = pickWinner(candidates, PERSONA_CONFIG[persona].zoneOrder);
    if (w) {
      track('dashboard.brief.priority_shown', {
        zone: w.zone,
        variant: w.item.variant,
        score: w.score,
        item_id: w.item.id,
      });
    }
    return w;
  }, [
    persona,
    vendas.priority,
    estoque.priority,
    reposicao.priority,
    financeiro.priority,
    tint.priority,
    sistema.priority,
    zonesByPersona,
  ]);

  // Atalhos: g d, r
  const gPressedAtRef = useRef<number>(0);
  useRegisterShortcuts(useMemo(() => [
    {
      keys: 'g',
      label: 'Início de combo (g d = dashboard)',
      group: 'Dashboard',
      handler: () => { gPressedAtRef.current = Date.now(); },
    },
    {
      keys: 'd',
      label: 'Ir pra dashboard (combo g d)',
      group: 'Dashboard',
      handler: () => {
        if (Date.now() - gPressedAtRef.current < 800) navigate('/');
      },
    },
    {
      keys: 'r',
      label: 'Recarregar dashboard',
      group: 'Dashboard',
      handler: () => { queryClient.invalidateQueries({ queryKey: ['dashboard'] }); },
    },
  ], [navigate, queryClient]));

  return (
    <div className="min-h-screen flex flex-col">
      <a
        href="#cockpit-grid"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 bg-foreground text-background px-3 py-1.5 rounded text-xs"
      >
        Pular pro cockpit
      </a>
      <BriefZone winner={winner} />
      <main className="flex-1">
        <CockpitGrid />
      </main>
      <DashboardFooter />
    </div>
  );
}
