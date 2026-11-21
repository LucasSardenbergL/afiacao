import { describe, expect, it } from 'vitest';
import { vesperaDoPendenteSemSaldo } from '../formatar';
import type { ArquivoExtrato } from '@/services/financeiroExtratoBancario';

const base: ArquivoExtrato = {
  id: 'x', status: 'aceito', motivo: null, periodoInicio: '2026-11-10', periodoFim: '2026-11-15',
  qtdLinhasNovas: 1, enviadoEm: '2026-11-20T10:00:00Z', conferidoEm: null,
};
const pend = (o: Partial<ArquivoExtrato>): ArquivoExtrato => ({ ...base, status: 'pendente_revisao', motivo: 'sem_saldo_inicial', ...o });

describe('vesperaDoPendenteSemSaldo', () => {
  it('sem pendente → null', () => {
    expect(vesperaDoPendenteSemSaldo([base])).toBeNull();
    expect(vesperaDoPendenteSemSaldo([])).toBeNull();
  });
  it('pendente por outro motivo não conta', () => {
    expect(vesperaDoPendenteSemSaldo([pend({ motivo: 'outro' })])).toBeNull();
  });
  it('véspera do início, sem fuso (vira o mês e o ano)', () => {
    expect(vesperaDoPendenteSemSaldo([pend({ periodoInicio: '2026-11-10' })])).toBe('2026-11-09');
    expect(vesperaDoPendenteSemSaldo([pend({ periodoInicio: '2026-03-01' })])).toBe('2026-02-28');
    expect(vesperaDoPendenteSemSaldo([pend({ periodoInicio: '2027-01-01' })])).toBe('2026-12-31');
  });
  it('usa o pendente mais recente (enviadoEm)', () => {
    const r = vesperaDoPendenteSemSaldo([
      pend({ id: 'a', periodoInicio: '2026-10-01', enviadoEm: '2026-11-01T00:00:00Z' }),
      pend({ id: 'b', periodoInicio: '2026-11-10', enviadoEm: '2026-11-20T00:00:00Z' }),
    ]);
    expect(r).toBe('2026-11-09');
  });
});
