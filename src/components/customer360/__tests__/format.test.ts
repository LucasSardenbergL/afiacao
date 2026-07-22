import { describe, it, expect } from 'vitest';
import { formatPctMaybe } from '../format';

/**
 * `formatPctMaybe` adivinha a unidade (`v > 1 ? v : v * 100`) porque atende chamadores cuja
 * origem é FRAÇÃO — ex.: `MinhasVisitasResultadoCard`, que usa o mesmo `pct` para a largura da
 * barra (`pct * 100`).
 *
 * Estes testes fixam onde a heurística ACERTA e onde ela ERRA. O erro não é bug a corrigir aqui:
 * é a razão de margem ter formatador próprio (`formatMargemPct`, em `@/lib/format`). Mudar a
 * heurística para consertar o caso da margem quebraria os chamadores de fração.
 */
describe('formatPctMaybe', () => {
  it('trata valor ≤ 1 como fração', () => {
    expect(formatPctMaybe(0.3)).toBe('30%');
    expect(formatPctMaybe(0.155)).toBe('15.5%');
  });

  it('trata valor > 1 como percentual já pronto', () => {
    expect(formatPctMaybe(53.47)).toBe('53.5%');
  });

  it('devolve travessão para ausente', () => {
    expect(formatPctMaybe(null)).toBe('—');
    expect(formatPctMaybe(undefined)).toBe('—');
    expect(formatPctMaybe(NaN)).toBe('—');
  });

  it('ERRA com percentual NEGATIVO — por isso margem não usa este formatador', () => {
    // −143,22% é o mínimo real medido em farmer_client_scores. Como não passa no `> 1`, a
    // heurística o multiplica por 100. Fixado como comportamento CONHECIDO, não como desejado:
    // quem formata margem deve usar formatMargemPct (@/lib/format), que não adivinha.
    expect(formatPctMaybe(-143.22)).toBe('-14322%');
  });

  it('ERRA com percentual menor que 1 — mesma raiz', () => {
    // Margem real de 0,5% vira "50%".
    expect(formatPctMaybe(0.5)).toBe('50%');
  });
});
