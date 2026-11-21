// O gestor REMOTO (SalesOrderDetailSheet → ExcecaoCreditoDialog) só tem o log: a dívida por empresa do
// grupo precisa voltar do `detalhe` gravado pela edge (gate-credito.ts) — review Codex P2 2026-11-20.
import { describe, expect, it } from 'vitest';
import { excecaoAindaVale, paresDoDetalheLog } from '../useExcecaoCredito';

describe('paresDoDetalheLog', () => {
  it('lê os pares no formato da edge', () => {
    expect(paresDoDetalheLog('pares: colacor_sc/202=500, oben/100=150.5')).toEqual([
      { company: 'colacor_sc', vencido: 500 },
      { company: 'oben', vencido: 150.5 },
    ]);
  });
  it('item ilegível ou empresa desconhecida é descartado (nunca R$ 0)', () => {
    expect(paresDoDetalheLog('pares: xpto/1=10, oben/100=abc, colacor/3=0, colacor/4=70')).toEqual([
      { company: 'colacor', vencido: 70 },
    ]);
  });
  it('"=null" (PAGTO PARCIAL / saldo ausente) é par LEGÍVEL de valor indeterminado — não some, não vira R$ 0', () => {
    expect(paresDoDetalheLog('pares: colacor_sc/202=null, oben/100=150')).toEqual([
      { company: 'colacor_sc', vencido: null },
      { company: 'oben', vencido: 150 },
    ]);
    expect(paresDoDetalheLog('pares: oben/100=NULL, oben/101=nulo')).toBeUndefined();
  });
  it('sem detalhe ou formato antigo → undefined (UI mostra só o total)', () => {
    expect(paresDoDetalheLog(null)).toBeUndefined();
    expect(paresDoDetalheLog('criacao: timeout')).toBeUndefined();
    expect(paresDoDetalheLog('pares: lixo')).toBeUndefined();
  });
});

// O gate pode RECUSAR uma exceção vigente (aprovada vendo o log antigo, sem o PAGTO PARCIAL — 20261121200000):
// a tela não pode esconder o formulário e mandar reenviar para sempre.
describe('excecaoAindaVale', () => {
  const exc = { created_at: '2026-11-22T10:00:00Z' };
  it('bloqueio DEPOIS da exceção → o gate a recusou: não vale (mostra o formulário)', () => {
    expect(excecaoAindaVale(exc, { created_at: '2026-11-22T10:05:00Z' })).toBe(false);
  });
  it('bloqueio antes (ou no mesmo instante) da exceção → vale (instrui o reenvio)', () => {
    expect(excecaoAindaVale(exc, { created_at: '2026-11-22T09:00:00Z' })).toBe(true);
    expect(excecaoAindaVale(exc, { created_at: '2026-11-22T10:00:00Z' })).toBe(true);
  });
  it('sem exceção → false; sem log ou data ilegível → mantém a exceção', () => {
    expect(excecaoAindaVale(null, { created_at: '2026-11-22T10:05:00Z' })).toBe(false);
    expect(excecaoAindaVale(exc, null)).toBe(true);
    expect(excecaoAindaVale({ created_at: 'lixo' }, { created_at: '2026-11-22T10:05:00Z' })).toBe(true);
  });
});
