import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import fg from 'fast-glob';

const CWD = resolve(__dirname, '../../../../..'); // repo root (src/../..)

const ALLOWED = new Set([
  'src/contexts/ImpersonationContext.tsx',
  'src/lib/impersonation/effective-user.ts',
  'src/hooks/useMyPositivacao.ts',
  'src/hooks/useMyMixGap.ts',
  'src/hooks/useMyVisitSuggestions.ts',
  'src/hooks/useMyCarteiraScores.ts',
  'src/hooks/useImpersonatedAccessProfile.ts',
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

    const offenders = normalized.filter(
      (f) => !ALLOWED.has(f) && readFileSync(resolve(CWD, f), 'utf8').includes('effectiveUserId')
    );

    expect(
      offenders,
      `effectiveUserId vazou pra: ${offenders.join(', ')}`
    ).toEqual([]);
  });
});
