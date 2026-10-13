import { describe, it, expect } from 'vitest';
import {
  aplicarDescontoNasCores,
  mesmoDesconto,
  precoDePartida,
  renegociarPorDesconto,
  renegociarPorPreco,
  type LinhaTintNegociavel,
} from '../renegociar';

/** Réplica da régua do `tint_gate_revalida` para fonte calculado|tabela|cliente
 *  (migration 20261012150000): d ∈ [0,100), esperado = floor(base·(1−d/100)·100 + 0,5)/100,
 *  bloqueia se |preço − esperado| > 0,005. A paridade float8×JS é provada no G18. */
function gateAceita(item: { unit_price: number; tint_discount_pct?: number; tint_price_source?: string; tint_formula_id?: string }, baseServidor: number): boolean {
  if (!item.tint_formula_id) return false;
  if (!['calculado', 'tabela', 'cliente'].includes(item.tint_price_source ?? '')) return false;
  const d = item.tint_discount_pct ?? 0;
  if (!(d >= 0 && d < 100)) return false;
  const esperado = Math.floor(baseServidor * (1 - d / 100) * 100 + 0.5) / 100;
  return Math.abs(item.unit_price - esperado) <= 0.005 && item.unit_price > 0;
}

const linha = (over: Partial<LinhaTintNegociavel> = {}): LinhaTintNegociavel => ({
  unit_price: 120,
  tint_formula_id: 'f-1',
  tint_price_source: 'calculado',
  tint_discount_pct: 0,
  tint_preco_sem_desconto: 120,
  ...over,
});

describe('precoDePartida', () => {
  it('usa o preço de partida gravado', () => {
    expect(precoDePartida(linha({ unit_price: 108, tint_discount_pct: 10 }))).toBe(120);
  });
  it('sem partida gravada, deduz SÓ quando o desconto é 0', () => {
    expect(precoDePartida(linha({ tint_preco_sem_desconto: undefined }))).toBe(120);
    expect(precoDePartida(linha({ tint_preco_sem_desconto: undefined, unit_price: 108, tint_discount_pct: 10 }))).toBeNull();
  });
  it('fonte fora do seletor, sem fonte ou sem fórmula ⇒ não negociável (fail-closed)', () => {
    expect(precoDePartida(linha({ tint_price_source: 'manual' }))).toBeNull();
    expect(precoDePartida(linha({ tint_price_source: undefined }))).toBeNull();
    expect(precoDePartida(linha({ tint_formula_id: undefined }))).toBeNull();
  });
  it('partida gravada ≤ 0 ⇒ não negociável (nunca cai para o preço atual)', () => {
    expect(precoDePartida(linha({ tint_preco_sem_desconto: 0 }))).toBeNull();
  });
});

describe('renegociarPorPreco', () => {
  it('preço abaixo da partida vira o desconto equivalente, mesma fonte', () => {
    const r = renegociarPorPreco(linha(), 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.decisao.unit_price).toBe(100);
    expect(r.decisao.tint_preco_sem_desconto).toBe(120);
    expect(r.decisao.tint_discount_pct).toBe(16.67); // desconto limpo que reproduz o centavo
    expect(gateAceita({ ...linha(), ...r.decisao }, 120)).toBe(true);
  });
  it('Codex P2: R$ 120 → R$ 108 grava 10 (não 9,999…), e casa com os 10% do seletor', () => {
    const r = renegociarPorPreco(linha(), 108);
    expect(r.ok && r.decisao.tint_discount_pct).toBe(10);
    expect(mesmoDesconto(9.999999999999998, 10)).toBe(true);
    expect(mesmoDesconto(10.01, 10)).toBe(false);
    expect(mesmoDesconto(undefined, 0)).toBe(false);
  });
  it('voltar ao preço de partida zera o desconto', () => {
    const r = renegociarPorPreco(linha({ unit_price: 100, tint_discount_pct: 16.67 }), 120);
    expect(r).toEqual({ ok: true, decisao: { unit_price: 120, tint_discount_pct: 0, tint_preco_sem_desconto: 120 } });
  });
  it('arredonda ao centavo antes de derivar (o gate compara ao centavo)', () => {
    const r = renegociarPorPreco(linha(), 99.996);
    expect(r.ok && r.decisao.unit_price).toBe(100);
  });
  it('acima da partida é RECUSADO na hora (sem desconto negativo, sem virar manual)', () => {
    const r = renegociarPorPreco(linha(), 130);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('não para subir');
  });
  it('R$ 0 (ou menos de meio centavo) é recusado', () => {
    expect(renegociarPorPreco(linha(), 0).ok).toBe(false);
    expect(renegociarPorPreco(linha(), 0.004).ok).toBe(false);
    expect(renegociarPorPreco(linha(), -5).ok).toBe(false);
  });
  it('sem partida confiável é recusado', () => {
    expect(renegociarPorPreco(linha({ tint_price_source: undefined }), 100).ok).toBe(false);
  });
  it('propriedade: todo preço aceito passa a régua do gate (fontes, partidas e preços variados)', () => {
    let aceitos = 0;
    for (const fonte of ['calculado', 'tabela', 'cliente']) {
      for (const partida of [0.1, 1.3, 9.9, 37.4, 102.2, 160.7, 611.9, 1234.5, 9999.9]) {
        for (let k = 1; k <= 400; k++) {
          const preco = Math.round(((partida * k) / 400) * 100) / 100;
          const base = linha({ tint_price_source: fonte, unit_price: partida, tint_preco_sem_desconto: partida });
          const r = renegociarPorPreco(base, preco);
          if (!r.ok) {
            expect(precoVendavelLocal(preco)).toBe(false);
            continue;
          }
          aceitos++;
          expect(r.decisao.unit_price).toBe(preco);
          expect(gateAceita({ ...base, ...r.decisao }, partida)).toBe(true);
        }
      }
    }
    expect(aceitos).toBeGreaterThan(10_000);
  });
});

function precoVendavelLocal(v: number) {
  return v > 0;
}

describe('renegociarPorDesconto', () => {
  it('recalcula preço e grava a partida', () => {
    const r = renegociarPorDesconto(linha({ unit_price: 100, tint_discount_pct: 16.67 }), 10);
    expect(r).toEqual({ ok: true, decisao: { unit_price: 108, tint_discount_pct: 10, tint_preco_sem_desconto: 120 } });
  });
  it('sem teto comercial: 95% passa; fora de [0,100) não', () => {
    expect(renegociarPorDesconto(linha(), 95).ok).toBe(true);
    expect(renegociarPorDesconto(linha(), 100).ok).toBe(false);
    expect(renegociarPorDesconto(linha(), -1).ok).toBe(false);
    expect(renegociarPorDesconto(linha(), Number.NaN).ok).toBe(false);
  });
  it('desconto que arredonda a R$ 0,00 é recusado', () => {
    const r = renegociarPorDesconto(linha({ unit_price: 20, tint_preco_sem_desconto: 20 }), 99.99);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('R$ 0,00');
  });
  it('propriedade: todo desconto aceito passa a régua do gate', () => {
    for (const partida of [0.1, 9.9, 102.2, 611.9]) {
      for (let d = 0; d < 100; d += 0.37) {
        const base = linha({ unit_price: partida, tint_preco_sem_desconto: partida });
        const r = renegociarPorDesconto(base, d);
        if (!r.ok) continue;
        expect(gateAceita({ ...base, ...r.decisao }, partida)).toBe(true);
      }
    }
  });
});

describe('aplicarDescontoNasCores (desconto do pedido)', () => {
  const semCor = { unit_price: 50 } as LinhaTintNegociavel & { tint_cor_id?: string };
  it('aplica o mesmo % em N cores e deixa as linhas sem cor intactas', () => {
    const linhas = [
      { ...linha(), tint_cor_id: 'H109' },
      semCor,
      { ...linha({ tint_formula_id: 'f-2', unit_price: 611.9, tint_preco_sem_desconto: 611.9 }), tint_cor_id: 'RAL5005' },
      { ...linha({ tint_formula_id: 'f-3', tint_price_source: 'cliente', unit_price: 150, tint_discount_pct: 20, tint_preco_sem_desconto: 187.5 }), tint_cor_id: 'X1' },
    ];
    const r = aplicarDescontoNasCores(linhas, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.aplicadas).toBe(3);
    expect(r.linhas[1]).toBe(semCor);
    expect(r.linhas.map((l) => l.unit_price)).toEqual([108, 50, 550.71, 168.75]);
    expect(r.linhas[3].tint_price_source).toBe('cliente');
    for (const [i, base] of [[0, 120], [2, 611.9], [3, 187.5]] as const) {
      expect(gateAceita(r.linhas[i], base)).toBe(true);
    }
  });
  it('tudo-ou-nada: uma cor sem partida recusa o lote e diz qual', () => {
    const linhas = [
      { ...linha(), tint_cor_id: 'H109' },
      { ...linha({ tint_price_source: undefined }), tint_cor_id: 'LEGADO' },
    ];
    const r = aplicarDescontoNasCores(linhas, 10);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.falhas.map((f) => f.cor)).toEqual(['LEGADO']);
  });
  it('R$ 0 numa cor barata recusa o lote inteiro', () => {
    const linhas = [
      { ...linha(), tint_cor_id: 'CARA' },
      { ...linha({ tint_formula_id: 'f-9', unit_price: 0.5, tint_preco_sem_desconto: 0.5 }), tint_cor_id: 'BARATA' },
    ];
    const r = aplicarDescontoNasCores(linhas, 99.5);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.falhas.map((f) => f.cor)).toEqual(['BARATA']);
  });
});
