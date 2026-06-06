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
