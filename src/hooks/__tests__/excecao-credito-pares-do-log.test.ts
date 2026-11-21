// O gestor REMOTO (SalesOrderDetailSheet → ExcecaoCreditoDialog) só tem o log: a dívida por empresa do
// grupo precisa voltar do `detalhe` gravado pela edge (gate-credito.ts) — review Codex P2 2026-11-20.
import { describe, expect, it } from 'vitest';
import { paresDoDetalheLog } from '../useExcecaoCredito';

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
  it('sem detalhe ou formato antigo → undefined (UI mostra só o total)', () => {
    expect(paresDoDetalheLog(null)).toBeUndefined();
    expect(paresDoDetalheLog('criacao: timeout')).toBeUndefined();
    expect(paresDoDetalheLog('pares: lixo')).toBeUndefined();
  });
});
