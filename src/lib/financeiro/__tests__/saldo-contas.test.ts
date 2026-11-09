import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  chaveFrescorDaLeitura,
  classificarSaldoConta,
  HORAS_TOLERANCIA_SYNC_BASE,
  MARGEM_RELOGIO_VIRADA_MS,
  msAteMudarChaveFrescor,
  msAteViradaDoFrescor,
  referenciaFrescorSaldo,
  resumirSaldoContas,
  saldoExibivelDaConta,
} from '../saldo-contas';

// Plano v3, item 2: saldo de conta corrente ausente OU velho nunca entra no caixa como número.
describe('referenciaFrescorSaldo — o sync de base roda às 03h SP', () => {
  it('a partir das 04h SP só o saldo de HOJE é fresco', () => {
    // 04:00 SP = 07:00Z
    expect(referenciaFrescorSaldo(new Date('2026-10-26T07:00:00Z'))).toEqual({ hoje: '2026-10-26', minimo: '2026-10-26' });
    // 07:00 SP — a hora do fin-cashflow-snapshot-diario: UM sync perdido já não passa
    expect(referenciaFrescorSaldo(new Date('2026-10-26T10:00:00Z'))).toEqual({ hoje: '2026-10-26', minimo: '2026-10-26' });
  });

  it('antes das 04h SP o de ontem ainda é o último possível', () => {
    expect(HORAS_TOLERANCIA_SYNC_BASE).toBe(4);
    // 03:59 SP = 06:59Z
    expect(referenciaFrescorSaldo(new Date('2026-10-26T06:59:00Z'))).toEqual({ hoje: '2026-10-26', minimo: '2026-10-25' });
    // 23:30 SP do dia 25 = 02:30Z do dia 26 (o "hoje" UTC já seria 26)
    expect(referenciaFrescorSaldo(new Date('2026-10-26T02:30:00Z'))).toEqual({ hoje: '2026-10-25', minimo: '2026-10-25' });
    // 00:30 SP
    expect(referenciaFrescorSaldo(new Date('2026-10-26T03:30:00Z'))).toEqual({ hoje: '2026-10-26', minimo: '2026-10-25' });
  });
});

// #3401: quem guarda em cache uma leitura julgada pela régua tem de descartá-la na virada.
describe('virada da régua — msAteViradaDoFrescor e a chave de cache', () => {
  it('a virada é às 04:00:00.000 SP (07:00Z), ao milissegundo', () => {
    expect(msAteViradaDoFrescor(new Date('2026-10-26T06:59:59.000Z'))).toBe(1_000);
    expect(msAteViradaDoFrescor(new Date('2026-10-26T06:59:59.999Z'))).toBe(1);
    // Logo depois da virada, a próxima é amanhã.
    expect(msAteViradaDoFrescor(new Date('2026-10-26T07:00:00.000Z'))).toBe(24 * 3_600_000);
    // 22h SP: o dia UTC já virou, a régua não.
    expect(msAteViradaDoFrescor(new Date('2026-10-27T01:00:00.000Z'))).toBe(6 * 3_600_000);
  });

  it('a chave é o minimo fora da janela de ±5 min e null dentro dela (03:55–04:05 SP)', () => {
    expect(MARGEM_RELOGIO_VIRADA_MS).toBe(5 * 60_000);
    expect(chaveFrescorDaLeitura(new Date('2026-10-26T06:54:59.999Z'))).toBe('2026-10-25');
    expect(chaveFrescorDaLeitura(new Date('2026-10-26T06:55:00.000Z'))).toBeNull();
    expect(chaveFrescorDaLeitura(new Date('2026-10-26T07:04:59.999Z'))).toBeNull();
    expect(chaveFrescorDaLeitura(new Date('2026-10-26T07:05:00.000Z'))).toBe('2026-10-26');
  });

  it('msAteMudarChaveFrescor aponta para a entrada e para a saída da janela', () => {
    expect(msAteMudarChaveFrescor(new Date('2026-10-26T06:50:00.000Z'))).toBe(5 * 60_000);
    expect(msAteMudarChaveFrescor(new Date('2026-10-26T06:58:00.000Z'))).toBe(7 * 60_000);
    expect(msAteMudarChaveFrescor(new Date('2026-10-26T07:05:00.000Z'))).toBe(24 * 3_600_000 - 10 * 60_000);
  });
});

const DIA = { hoje: '2026-10-26', minimo: '2026-10-26' };
const MADRUGADA = { hoje: '2026-10-26', minimo: '2026-10-25' };

describe('classificarSaldoConta', () => {
  it('de dia: hoje é fresco, ontem é VELHO (o sync das 03h não atualizou a conta)', () => {
    expect(classificarSaldoConta({ saldo_atual: 100, saldo_data: '2026-10-26' }, DIA)).toBe('fresca');
    expect(classificarSaldoConta({ saldo_atual: 100, saldo_data: '2026-10-25' }, DIA)).toBe('velha');
    expect(classificarSaldoConta({ saldo_atual: 100, saldo_data: '2026-09-01' }, DIA)).toBe('velha');
  });

  it('de madrugada (antes das 04h SP): ontem ainda é fresco, anteontem é velho', () => {
    expect(classificarSaldoConta({ saldo_atual: 100, saldo_data: '2026-10-25' }, MADRUGADA)).toBe('fresca');
    expect(classificarSaldoConta({ saldo_atual: 100, saldo_data: '2026-10-24' }, MADRUGADA)).toBe('velha');
  });

  it('saldo_data NULL é desconhecido mesmo com saldo_atual 0 (o DEFAULT 0 da coluna não é fato)', () => {
    expect(classificarSaldoConta({ saldo_atual: 0, saldo_data: null }, DIA)).toBe('desconhecida');
    expect(classificarSaldoConta({ saldo_atual: null, saldo_data: '2026-10-26' }, DIA)).toBe('desconhecida');
  });

  it('valor ilegível, data ilegível ou futura é desconhecido; 0 e negativo são REAIS', () => {
    expect(classificarSaldoConta({ saldo_atual: '', saldo_data: '2026-10-26' }, DIA)).toBe('desconhecida');
    expect(classificarSaldoConta({ saldo_atual: 'NaN', saldo_data: '2026-10-26' }, DIA)).toBe('desconhecida');
    expect(classificarSaldoConta({ saldo_atual: 1, saldo_data: '26/10/2026' }, DIA)).toBe('desconhecida');
    expect(classificarSaldoConta({ saldo_atual: 1, saldo_data: '2026-10-27' }, DIA)).toBe('desconhecida');
    expect(classificarSaldoConta({ saldo_atual: 0, saldo_data: '2026-10-26' }, DIA)).toBe('fresca');
    expect(classificarSaldoConta({ saldo_atual: '-250.5', saldo_data: '2026-10-26' }, DIA)).toBe('fresca');
  });
});

describe('resumirSaldoContas', () => {
  it('todas frescas → soma (string numérica do PostgREST incluída)', () => {
    expect(resumirSaldoContas([
      { saldo_atual: 100, saldo_data: '2026-10-26' },
      { saldo_atual: '50.25', saldo_data: '2026-10-25' },
      { saldo_atual: -20, saldo_data: '2026-10-26' },
    ], MADRUGADA)).toEqual({ total: 130.25, motivo: null });
  });

  it('lista vazia → indisponível (não R$ 0)', () => {
    const r = resumirSaldoContas([], DIA);
    expect(r.total).toBeNull();
    expect(r.motivo).toContain('Nenhuma conta corrente ativa');
  });

  it('UMA conta velha → indisponível com a data mais antiga no motivo', () => {
    const r = resumirSaldoContas([
      { saldo_atual: 100, saldo_data: '2026-10-26' },
      { saldo_atual: 900, saldo_data: '2026-10-20' },
      { saldo_atual: 5, saldo_data: '2026-10-25' },
    ], DIA);
    expect(r.total).toBeNull();
    expect(r.motivo).toContain('2 de 3 conta(s) com saldo de 2026-10-20 (anterior a 2026-10-26');
  });

  it('UMA conta sem saldo do extrato → indisponível (o `|| 0` a somava como zero)', () => {
    const r = resumirSaldoContas([
      { saldo_atual: 100, saldo_data: '2026-10-26' },
      { saldo_atual: 0, saldo_data: null },
    ], DIA);
    expect(r.total).toBeNull();
    expect(r.motivo).toContain('1 de 2 conta(s) sem saldo do extrato');
  });
});

// Paridade do bloco espelhado na edge (Deno não importa de src/) — money-path §"Helper espelhado".
function blocoMirror(caminho: string): string {
  const s = readFileSync(caminho, 'utf8');
  const m = s.match(/\/\/ MIRROR-START saldo-conta[^\n]*\n([\s\S]*?)\n[^\n]*\/\/ MIRROR-END/);
  if (!m) throw new Error(`bloco // MIRROR-START saldo-conta.../END não encontrado em ${caminho}`);
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .join('\n');
}

describe('saldoExibivelDaConta — a lista por conta', () => {
  it('fresca → o número (inclusive zero e negativo, e string numérica)', () => {
    expect(saldoExibivelDaConta({ saldo_atual: 0, saldo_data: '2026-10-26' }, DIA)).toEqual({ saldo: 0, motivo: null });
    expect(saldoExibivelDaConta({ saldo_atual: -50.5, saldo_data: '2026-10-26' }, DIA)).toEqual({ saldo: -50.5, motivo: null });
    expect(saldoExibivelDaConta({ saldo_atual: '12.30', saldo_data: '2026-10-26' }, DIA)).toEqual({ saldo: 12.3, motivo: null });
  });

  it('velha → null + a data do saldo em dd/mm/aaaa', () => {
    expect(saldoExibivelDaConta({ saldo_atual: 900, saldo_data: '2026-10-25' }, DIA)).toEqual({
      saldo: null,
      motivo: 'Saldo de 25/10/2026: o extrato não atualizou',
    });
  });

  it('sem saldo do extrato (nulo, DEFAULT 0 sem data, data futura) → null, nunca 0', () => {
    for (const conta of [
      { saldo_atual: null, saldo_data: '2026-10-26' },
      { saldo_atual: 0, saldo_data: null },
      { saldo_atual: 10, saldo_data: '2026-10-27' },
    ]) {
      expect(saldoExibivelDaConta(conta, DIA)).toEqual({ saldo: null, motivo: 'Sem saldo do extrato' });
    }
  });
});

describe('paridade TS ↔ edge (fin-cashflow-engine/saldo-contas.ts)', () => {
  it('a classificação por conta é a MESMA nos dois leitores', () => {
    const ts = blocoMirror('src/lib/financeiro/saldo-contas.ts');
    const edge = blocoMirror('supabase/functions/fin-cashflow-engine/saldo-contas.ts');
    expect(ts).toContain('export function classificarSaldoConta');
    expect(edge).toBe(ts);
  });
});
