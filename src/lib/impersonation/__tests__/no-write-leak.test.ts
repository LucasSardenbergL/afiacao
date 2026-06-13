import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import fg from 'fast-glob';

// repo root: __tests__ → impersonation → lib → src → repo (4 níveis).
// (era '../../../../..' = 5 níveis = PAI do repo → fast-glob não achava nada e o guard passava vazio.)
const CWD = resolve(__dirname, '../../../..');

const ALLOWED = new Set([
  'src/contexts/ImpersonationContext.tsx',
  'src/lib/impersonation/effective-user.ts',
  'src/hooks/useMyPositivacao.ts',
  'src/hooks/useMyMixGap.ts',
  'src/hooks/useMyVisitSuggestions.ts',
  'src/hooks/useMyCarteiraScores.ts',
  'src/hooks/useImpersonatedAccessProfile.ts',
  // useMarkMixGapFeedback usa effectiveUserId SÓ na queryKey de leitura/cache;
  // o write (mark_mixgap_feedback) é seller=auth.uid() server-side, sem effectiveUserId.
  'src/hooks/useMarkMixGapFeedback.ts',
  // useTarefas: effectiveUserId SÓ em useMinhasTarefas (filtra a LEITURA pro alvo no "Ver como");
  // as mutations (criar/concluir/resolverSugestao/adiar/cancelar) usam user.id (o master real), nunca effectiveUserId.
  'src/hooks/useTarefas.ts',
  // useTarefasFase2: effectiveUserId SÓ em useMinhasRecorrentesHoje (filtro + queryKey de LEITURA, espelha useMinhasTarefas);
  // writes (criar/editar/toggle template) usam created_by=user.id e as RPCs (concluir_com_comprovacao/auditar_tarefa) usam auth.uid() server-side.
  'src/hooks/useTarefasFase2.ts',
  // useCriticaFila: effectiveUserId SÓ como filtro de LEITURA (owner_user_id === donoEfetivo no slaQ.data);
  // sem mutation alguma neste hook — é read-only (crítica da fila).
  'src/hooks/useCriticaFila.ts',
  // useRouteContactList: effectiveUserId SÓ escopa a LEITURA da fila de ligação à carteira do ALVO no
  // "Ver como" (.eq('farmer_id', …) em customer_visit_scores, no servidor) — conserta a fidelidade da
  // lente E corta o volume que estourava. Hook 100% read-only (só SELECTs), sem mutation alguma.
  'src/queries/useRouteContactList.ts',
  // Telefonia: effectiveUserId SÓ alimenta o filtro de LEITURA do histórico de chamadas
  // (useCallLog via CallHistoryTabs) pro "Ver como" mostrar as ligações do ALVO. A ligação
  // em si (call.makeCall) é bloqueada na FONTE (WebRTCCallContext) na lente; nenhum write usa effectiveUserId.
  'src/pages/Telefonia.tsx',
  // AppShell: effectiveUserId SÓ no badge de perdidas não-lidas (useMissedCount = count/LEITURA)
  // pro "Ver como" refletir o alvo; nenhuma mutation no shell usa effectiveUserId.
  'src/components/AppShell.tsx',
  // Cards de "minha atividade" do dashboard (Meu Dia): leitura escopada pelo id efetivo
  // da lente (KPIs do dia, KPIs/follow-ups/resultado de visitas). Read-only, sem mutation.
  'src/hooks/useMyKpis.ts',
  'src/hooks/useKpisVisita.ts',
  'src/hooks/useFollowupsVisita.ts',
  'src/hooks/useMinhasVisitasResultado.ts',
  // FarmerCalls: effectiveUserId SÓ na leitura da lista de ligações (loadCallLogs); a escrita
  // (handleSaveCall, farmer_id=user.id) é write-identity e o botão "Nova ligação" é disabled na lente.
  'src/pages/FarmerCalls.tsx',
  // useFarmerScoring: effectiveUserId na leitura/cálculo da agenda do alvo; o upsert de scores
  // é PULADO na lente (skip por isImpersonating) — o master não recalcula a carteira do alvo.
  'src/hooks/useFarmerScoring.ts',
  // useCrossSellEngine: effectiveUserId escopa a LEITURA/recálculo das recomendações ao
  // alvo na lente (lê os scores DELE pra inspeção) e NÃO cai no fallback super-admin
  // ("todos os scores"). A PERSISTÊNCIA (upsert de farmer_recommendations) é PULADA na
  // lente — o master inspeciona, não regrava a carteira do alvo (igual useFarmerScoring).
  'src/hooks/useCrossSellEngine.ts',
  // useFarmerExperiments: effectiveUserId SÓ em loadExperiments (filtra a LISTA exibida
  // pro alvo na lente). As mutations (criar/iniciar/medir/cancelar) usam user.id (write
  // identity = master real) e são bloqueadas na lente pelo write-guard + botões disabled.
  'src/hooks/useFarmerExperiments.ts',
  // useDiagnosticQuestions: effectiveUserId SÓ em getEffectivenessStats (estatísticas
  // exibidas seguem o alvo). A geração (edge) e o save (insert farmer_id=user.id) são
  // bloqueados na lente pelo write-guard.
  'src/hooks/useDiagnosticQuestions.ts',
  // FarmerCallsPendingLink: effectiveUserId SÓ na LEITURA da lista de chamadas pendentes
  // de vínculo (query react-query) pro "Ver como" mostrar as do alvo. O vínculo
  // (useLinkCallToCustomer) é write — bloqueado na lente + botão "Vincular" disabled.
  'src/pages/FarmerCallsPendingLink.tsx',
  // useTacticalPlan: effectiveUserId nas leituras de EXIBIÇÃO (loadPlans / getActivePlan /
  // getEffectivenessStats — planos/efetividade do alvo). A geração (generatePlan/
  // checkEfficiency) e o recordResult usam user.id (write identity) e são bloqueados na
  // lente pelo write-guard + botões disabled.
  'src/hooks/useTacticalPlan.ts',
  // useFarmerTacticalPlan: effectiveUserId SÓ em loadCustomers (dropdown da carteira do
  // alvo) + na dep do effect (recarrega ao entrar/sair da lente). Geração = disabled.
  'src/components/farmer/tacticalPlan/useFarmerTacticalPlan.ts',
  // useFarmerCopilot: effectiveUserId SÓ no "load customers" (dropdown da carteira do
  // alvo). Iniciar a sessão (startSession persiste + invoca edge) é write — bloqueado na
  // lente pelo write-guard + botão "Iniciar" disabled (isImpersonating exposto pro card).
  'src/components/farmer/copilot/useFarmerCopilot.ts',
  // Clientes (/admin/customers): useClientesScope escopa a LEITURA da lista pro alvo da lente
  // (effectiveUserId só filtra carteira_assignments/scores — read-only, é o hook que importa
  // useDisplayAccess e NÃO tem mutação). useAdminCustomers recebe effectiveUserId do scope
  // SÓ pra resetar o detalhe ao trocar de lente; a escrita (handleDeleteTool) usa toolId +
  // sessão real, nunca effectiveUserId. escopo-clientes usa effectiveUserId como filtro de
  // leitura (.eq owner_user_id na lente), sem mutação.
  'src/components/adminCustomers/useClientesScope.ts',
  'src/components/adminCustomers/useAdminCustomers.ts',
  'src/lib/carteira/escopo-clientes.ts',
]);

describe('anti write-leak: effectiveUserId só em leitura', () => {
  it('nenhum arquivo fora da allowlist referencia effectiveUserId', () => {
    const files = fg.sync('src/**/*.{ts,tsx}', {
      cwd: CWD,
      ignore: ['src/**/__tests__/**', 'src/**/*.test.*', 'src/**/*.spec.*'],
    });

    // normalize to repo-relative posix (fast-glob already returns posix, but ensure strip of CWD prefix if absolute)
    const normalized = files.map((f) =>
      f.startsWith('/') ? relative(CWD, f).replace(/\\/g, '/') : f
    );

    // Sentinela: prova que o glob varreu o src REAL (pega CWD errado que passaria vazio).
    expect(normalized).toContain('src/contexts/ImpersonationContext.tsx');

    const offenders = normalized.filter(
      (f) => !ALLOWED.has(f) && readFileSync(resolve(CWD, f), 'utf8').includes('effectiveUserId')
    );

    expect(
      offenders,
      `effectiveUserId vazou pra: ${offenders.join(', ')}`
    ).toEqual([]);
  });
});
