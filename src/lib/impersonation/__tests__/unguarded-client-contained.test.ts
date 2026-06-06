import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import fg from 'fast-glob';

// repo root: __tests__ → impersonation → lib → src → repo (4 níveis).
const CWD = resolve(__dirname, '../../../..');

// supabaseUnguarded contorna o write-guard da lente "ver como pessoa" DE PROPÓSITO.
// Só pode ser usado no bookkeeping da PRÓPRIA lente (log_impersonation_start /
// end_impersonation — RPCs do master que precisam rodar mesmo com a lente ativa).
// Qualquer outro uso reabre o buraco de escrita-como-master na lente. Allowlist fechada:
const ALLOWED = new Set([
  'src/integrations/supabase/client.ts',   // define o export
  'src/contexts/ImpersonationContext.tsx', // log_impersonation_start / end_impersonation
]);

// O vetor de vazamento é IMPORTAR o símbolo (não dá pra usá-lo sem importar).
// Casar o import (não substring) evita falso-positivo de menção em comentário/doc.
const IMPORTS_UNGUARDED = /import\s*\{[^}]*\bsupabaseUnguarded\b[^}]*\}\s*from/;

describe('guardrail: supabaseUnguarded fica contido (bypass do write-guard da lente)', () => {
  it('nenhum arquivo fora da allowlist IMPORTA supabaseUnguarded', () => {
    const files = fg.sync('src/**/*.{ts,tsx}', {
      cwd: CWD,
      ignore: ['src/**/__tests__/**', 'src/**/*.test.*', 'src/**/*.spec.*'],
    });
    const normalized = files.map((f) =>
      f.startsWith('/') ? relative(CWD, f).replace(/\\/g, '/') : f
    );
    // Sentinela: prova que o glob varreu o src REAL (pega CWD errado que passaria vazio).
    expect(normalized).toContain('src/integrations/supabase/client.ts');
    // Sentinela 2: o único importador legítimo de fato importa (o regex funciona).
    expect(
      IMPORTS_UNGUARDED.test(readFileSync(resolve(CWD, 'src/contexts/ImpersonationContext.tsx'), 'utf8'))
    ).toBe(true);

    const offenders = normalized.filter(
      (f) => !ALLOWED.has(f) && IMPORTS_UNGUARDED.test(readFileSync(resolve(CWD, f), 'utf8'))
    );

    expect(
      offenders,
      `supabaseUnguarded importado fora da allowlist em: ${offenders.join(', ')}`
    ).toEqual([]);
  });
});
