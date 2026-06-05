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
