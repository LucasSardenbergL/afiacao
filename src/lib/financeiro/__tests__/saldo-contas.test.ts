import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { classificarSaldoConta, resumirSaldoContas, SALDO_IDADE_MAX_DIAS } from '../saldo-contas';

// Plano v3, item 2: saldo de conta corrente ausente OU velho nunca entra no caixa como número.
const HOJE = '2026-10-26';

describe('classificarSaldoConta', () => {
  it('saldo de hoje e de ontem é fresco (o sync de base roda às 03h SP)', () => {
    expect(SALDO_IDADE_MAX_DIAS).toBe(1);
    expect(classificarSaldoConta({ saldo_atual: 100, saldo_data: '2026-10-26' }, HOJE)).toBe('fresca');
    expect(classificarSaldoConta({ saldo_atual: 100, saldo_data: '2026-10-25' }, HOJE)).toBe('fresca');
  });

  it('anteontem ou antes é velho (≥1 sync diário perdido)', () => {
    expect(classificarSaldoConta({ saldo_atual: 100, saldo_data: '2026-10-24' }, HOJE)).toBe('velha');
    expect(classificarSaldoConta({ saldo_atual: 100, saldo_data: '2026-09-01' }, HOJE)).toBe('velha');
  });

  it('virada de mês e de ano contam dias-calendário, não string', () => {
    expect(classificarSaldoConta({ saldo_atual: 1, saldo_data: '2026-09-30' }, '2026-10-01')).toBe('fresca');
    expect(classificarSaldoConta({ saldo_atual: 1, saldo_data: '2025-12-31' }, '2026-01-02')).toBe('velha');
  });

  it('saldo_data NULL é desconhecido mesmo com saldo_atual 0 (o DEFAULT 0 da coluna não é fato)', () => {
    expect(classificarSaldoConta({ saldo_atual: 0, saldo_data: null }, HOJE)).toBe('desconhecida');
    expect(classificarSaldoConta({ saldo_atual: null, saldo_data: HOJE }, HOJE)).toBe('desconhecida');
  });

  it('valor ilegível, data ilegível ou futura é desconhecido; 0 e negativo são REAIS', () => {
    expect(classificarSaldoConta({ saldo_atual: '', saldo_data: HOJE }, HOJE)).toBe('desconhecida');
    expect(classificarSaldoConta({ saldo_atual: 'NaN', saldo_data: HOJE }, HOJE)).toBe('desconhecida');
    expect(classificarSaldoConta({ saldo_atual: 1, saldo_data: '26/10/2026' }, HOJE)).toBe('desconhecida');
    expect(classificarSaldoConta({ saldo_atual: 1, saldo_data: '2026-10-27' }, HOJE)).toBe('desconhecida');
    expect(classificarSaldoConta({ saldo_atual: 0, saldo_data: HOJE }, HOJE)).toBe('fresca');
    expect(classificarSaldoConta({ saldo_atual: '-250.5', saldo_data: HOJE }, HOJE)).toBe('fresca');
  });
});

describe('resumirSaldoContas', () => {
  it('todas frescas → soma (string numérica do PostgREST incluída)', () => {
    expect(resumirSaldoContas([
      { saldo_atual: 100, saldo_data: HOJE },
      { saldo_atual: '50.25', saldo_data: '2026-10-25' },
      { saldo_atual: -20, saldo_data: HOJE },
    ], HOJE)).toEqual({ total: 130.25, motivo: null });
  });

  it('lista vazia → indisponível (não R$ 0)', () => {
    const r = resumirSaldoContas([], HOJE);
    expect(r.total).toBeNull();
    expect(r.motivo).toContain('Nenhuma conta corrente ativa');
  });

  it('UMA conta velha → indisponível com a data mais antiga no motivo', () => {
    const r = resumirSaldoContas([
      { saldo_atual: 100, saldo_data: HOJE },
      { saldo_atual: 900, saldo_data: '2026-10-20' },
      { saldo_atual: 5, saldo_data: '2026-10-22' },
    ], HOJE);
    expect(r.total).toBeNull();
    expect(r.motivo).toContain('2 de 3 conta(s) com saldo de 2026-10-20 (mais velho que ontem)');
  });

  it('UMA conta sem saldo do extrato → indisponível (o `|| 0` a somava como zero)', () => {
    const r = resumirSaldoContas([
      { saldo_atual: 100, saldo_data: HOJE },
      { saldo_atual: 0, saldo_data: null },
    ], HOJE);
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

describe('paridade TS ↔ edge (fin-cashflow-engine/saldo-contas.ts)', () => {
  it('a classificação por conta é a MESMA nos dois leitores', () => {
    const ts = blocoMirror('src/lib/financeiro/saldo-contas.ts');
    const edge = blocoMirror('supabase/functions/fin-cashflow-engine/saldo-contas.ts');
    expect(ts).toContain('export function classificarSaldoConta');
    expect(edge).toBe(ts);
  });
});
