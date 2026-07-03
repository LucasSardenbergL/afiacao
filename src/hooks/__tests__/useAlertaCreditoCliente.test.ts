import { describe, expect, it } from 'vitest';
import { computeAlertaCredito, paresDoCliente, ALERTA_CREDITO } from '../useAlertaCreditoCliente';

const AGORA = new Date('2026-07-02T12:00:00Z');

describe('paresDoCliente', () => {
  it('monta o par de cada conta que o cliente tem (oben/colacor/colacor_sc)', () => {
    expect(
      paresDoCliente({ codigo_cliente: 111, codigo_cliente_colacor: 222, codigo_cliente_afiacao: 333 }),
    ).toEqual([
      { company: 'oben', codigo: 111 },
      { company: 'colacor', codigo: 222 },
      { company: 'colacor_sc', codigo: 333 },
    ]);
  });

  it('conta sem código não gera par (parcial é normal)', () => {
    expect(paresDoCliente({ codigo_cliente: 111 })).toEqual([{ company: 'oben', codigo: 111 }]);
    expect(paresDoCliente({ codigo_cliente_colacor: 222 })).toEqual([
      { company: 'colacor', codigo: 222 },
    ]);
  });

  it('código 0 (cliente sintético do autoatendimento) e null são ignorados', () => {
    expect(paresDoCliente({ codigo_cliente: 0, codigo_cliente_colacor: null })).toEqual([]);
  });

  it('cliente ausente → sem pares (sem query, sem alerta)', () => {
    expect(paresDoCliente(null)).toEqual([]);
    expect(paresDoCliente(undefined)).toEqual([]);
  });
});

describe('computeAlertaCredito', () => {
  it('sem títulos → null (silêncio, não "cliente OK")', () => {
    expect(computeAlertaCredito([], '2026-07-02T10:00:00Z', AGORA)).toBeNull();
  });

  it('soma saldos, conta títulos e acha o vencimento mais antigo', () => {
    const alerta = computeAlertaCredito(
      [
        { saldo: 100, data_vencimento: '2026-04-10' },
        { saldo: 250.5, data_vencimento: '2026-03-01' },
        { saldo: 50, data_vencimento: null },
      ],
      '2026-07-02T10:00:00Z',
      AGORA,
    );
    expect(alerta).not.toBeNull();
    expect(alerta!.vencido).toBeCloseTo(400.5);
    expect(alerta!.titulos).toBe(3);
    expect(alerta!.vencimentoMaisAntigo).toBe('2026-03-01');
    expect(alerta!.dadoDefasado).toBe(false);
  });

  it('saldo null não fabrica número (ausente ≠ zero: soma ignora, não inventa)', () => {
    // Só títulos com saldo null/0 → total 0 → null (sem evidência positiva, sem alerta)
    expect(computeAlertaCredito([{ saldo: null, data_vencimento: '2026-01-01' }], null, AGORA)).toBeNull();
  });

  it('sync a mais de 24h marca dadoDefasado', () => {
    const alerta = computeAlertaCredito(
      [{ saldo: 100, data_vencimento: '2026-01-01' }],
      '2026-06-30T10:00:00Z',
      AGORA,
    );
    expect(alerta!.dadoDefasado).toBe(true);
  });

  it('sem registro de sync marca dadoDefasado (não assume frescor)', () => {
    const alerta = computeAlertaCredito([{ saldo: 100, data_vencimento: '2026-01-01' }], null, AGORA);
    expect(alerta!.dadoDefasado).toBe(true);
    expect(alerta!.syncAt).toBeNull();
  });

  it('sync dentro da janela de 24h não marca defasagem', () => {
    const dentroDaJanela = new Date(AGORA.getTime() - (ALERTA_CREDITO.defasagemMaxHoras - 1) * 3_600_000).toISOString();
    const alerta = computeAlertaCredito([{ saldo: 100, data_vencimento: '2026-01-01' }], dentroDaJanela, AGORA);
    expect(alerta!.dadoDefasado).toBe(false);
  });
});
