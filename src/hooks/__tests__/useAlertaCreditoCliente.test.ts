import { describe, expect, it } from 'vitest';
import {
  computeAlertaCredito, classificarFrescor, paresDoCliente, paresDasContas, ALERTA_CREDITO,
} from '../useAlertaCreditoCliente';

const AGORA = new Date('2026-07-02T12:00:00Z');
/** Frescor da Oben com o último sync concluído em `syncAt` (null = nunca sincronizou). */
const f = (syncAt: string | null) =>
  [classificarFrescor('oben', syncAt ? { started_at: syncAt, completed_at: syncAt } : null, null, AGORA)];

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
    expect(computeAlertaCredito([], f('2026-07-02T10:00:00Z'))).toBeNull();
  });

  it('soma saldos, conta títulos e acha o vencimento mais antigo', () => {
    const alerta = computeAlertaCredito(
      [
        { saldo: 100, data_vencimento: '2026-04-10' },
        { saldo: 250.5, data_vencimento: '2026-03-01' },
        { saldo: 50, data_vencimento: null },
      ], f('2026-07-02T10:00:00Z'));
    expect(alerta).not.toBeNull();
    expect(alerta!.vencido).toBeCloseTo(400.5);
    expect(alerta!.titulos).toBe(3);
    expect(alerta!.vencimentoMaisAntigo).toBe('2026-03-01');
    expect(alerta!.dadoDefasado).toBe(false);
  });

  it('saldo null não fabrica número (ausente ≠ zero: soma ignora, não inventa)', () => {
    // Só títulos com saldo null/0 → total 0 → null (sem evidência positiva, sem alerta)
    expect(computeAlertaCredito([{ saldo: null, data_vencimento: '2026-01-01' }], f(null))).toBeNull();
  });

  it('sync a mais de 24h marca dadoDefasado', () => {
    const alerta = computeAlertaCredito(
      [{ saldo: 100, data_vencimento: '2026-01-01' }], f('2026-06-30T10:00:00Z'));
    expect(alerta!.dadoDefasado).toBe(true);
  });

  it('sem registro de sync marca dadoDefasado (não assume frescor)', () => {
    const alerta = computeAlertaCredito([{ saldo: 100, data_vencimento: '2026-01-01' }], f(null));
    expect(alerta!.dadoDefasado).toBe(true);
    expect(alerta!.syncAt).toBeNull();
  });

  it('sync dentro da janela de 24h não marca defasagem', () => {
    const dentroDaJanela = new Date(AGORA.getTime() - (ALERTA_CREDITO.defasagemMaxHoras - 1) * 3_600_000).toISOString();
    const alerta = computeAlertaCredito([{ saldo: 100, data_vencimento: '2026-01-01' }], f(dentroDaJanela));
    expect(alerta!.dadoDefasado).toBe(false);
  });
});

describe('paresDasContas — ficha 360 (cliente + aliases do grupo)', () => {
  it('junta as 3 empresas do contas a receber, sem duplicar e em ordem estável', () => {
    const pares = paresDasContas([
      { user_id: 'canon', account: 'oben', omie_codigo_cliente: 10 },
      { user_id: 'alias', account: 'colacor_sc', omie_codigo_cliente: 30 },
      { user_id: 'canon', account: 'colacor', omie_codigo_cliente: 20 },
      { user_id: 'canon', account: 'oben', omie_codigo_cliente: 10 },
    ]);
    expect(pares).toEqual([
      { company: 'colacor', codigo: 20 },
      { company: 'colacor_sc', codigo: 30 },
      { company: 'oben', codigo: 10 },
    ]);
  });

  it('conta fora do contas a receber e código 0/null ficam fora', () => {
    expect(paresDasContas([
      { user_id: 'x', account: 'servicos', omie_codigo_cliente: 99 },
      { user_id: 'x', account: 'oben', omie_codigo_cliente: 0 },
      { user_id: 'x', account: 'colacor', omie_codigo_cliente: null },
    ])).toEqual([]);
  });
});

describe('classificarFrescor — por empresa (onda B)', () => {
  const ha = (h: number) => new Date(AGORA.getTime() - h * 3_600_000).toISOString();
  const log = (iso: string) => ({ started_at: iso, completed_at: iso });

  it('concluído há ≤ 24h e sem falha depois → ok', () => {
    expect(classificarFrescor('oben', log(ha(2)), log(ha(30)), AGORA).estado).toBe('ok');
  });
  it('concluído há mais de 24h → defasado (com a data)', () => {
    expect(classificarFrescor('colacor', log(ha(25)), null, AGORA)).toEqual({ company: 'colacor', syncAt: ha(25), estado: 'defasado' });
  });
  it('falha DEPOIS do último concluído → erro (mesmo com concluído recente)', () => {
    expect(classificarFrescor('oben', log(ha(3)), log(ha(1)), AGORA).estado).toBe('erro');
  });
  it('só falhas, nenhum concluído → erro, syncAt null', () => {
    expect(classificarFrescor('colacor_sc', null, log(ha(1)), AGORA)).toEqual({ company: 'colacor_sc', syncAt: null, estado: 'erro' });
  });
  it('nenhum registro → nunca', () => {
    expect(classificarFrescor('oben', null, null, AGORA).estado).toBe('nunca');
  });
  it('alerta resume pelo PIOR: uma empresa defasada marca dadoDefasado e syncAt = a mais antiga', () => {
    const frescor = [
      classificarFrescor('oben', log(ha(1)), null, AGORA),
      classificarFrescor('colacor', log(ha(40)), null, AGORA),
    ];
    const a = computeAlertaCredito([{ saldo: 10, data_vencimento: '2026-01-01' }], frescor)!;
    expect(a.dadoDefasado).toBe(true);
    expect(a.syncAt).toBe(ha(40));
  });
});
