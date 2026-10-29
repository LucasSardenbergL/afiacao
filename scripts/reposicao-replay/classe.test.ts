import { describe, expect, it } from 'vitest';
import { classeEfetiva, classeProposta, passoHisterese, validarClasse, type DadosClasse } from './classe';
import type { Classe, LinhaVenda, Sku } from './tipos';

const REGRAS: Record<string, string> = {
  abc_base_valor: 'valor_total_90d', abc_corte_a_acumulado: '0.80', abc_corte_b_acumulado: '0.95', meses_descer: '3', meses_subir: '2',
  ordem_prioridade: 'AX AY AZ BX BY BZ CX CY CZ', xyz_corte_x_cv: '0.4', xyz_corte_y_cv: '0.8', xyz_min_ordens: '2',
};
const sku = (codigo: string, extra: Partial<Sku> = {}): Sku => ({
  sku: codigo, descricao: 'D', grupo: null, classeAbcHoje: null, classeForcada: null, minimoForcado: null, minimoOperacional: null,
  multiplo: null, cmc: 1, saldoHoje: 1, ativo: true, habilitado: true, unidadeNf: 'UN', unidadeEstoque: 'UN', fatorConversao: null,
  grupoEmbalagemId: null, f0: { custoPedido: 3, custoCapitalPerc: 25 }, hoje: { es: null, pp: null, max: null }, ...extra,
});
let seq = 0;
const venda = (s: string, data: string, valor: number, quantidade = 1): LinhaVenda => ({ linhaId: `L${seq++}`, sku: s, data, quantidade, valor, cmcLinha: null, noEscopo: true });
function dados(skus: Sku[], vendas: LinhaVenda[], regras = REGRAS, extracao = '2026-10-21'): DadosClasse {
  return { vendas, skus: new Map(skus.map((s) => [s.sku, s])), recebimentos: [], dataExtracao: extracao, classificacaoHist: { regras, porSku: new Map() } };
}
const UM = { ticksPorDia: 1 } as const;

describe('proposta (Pareto por empresa sobre todo o universo)', () => {
  it('proposta não usa o próprio dia nem o futuro', () => {
    const base = [venda('X', '2025-10-21', 50), venda('Y', '2025-10-21', 30), venda('Z', '2025-10-21', 20)];
    const sem = classeProposta(dados([], base), '2025-10-22');
    expect([...sem]).toEqual([['X', 'A'], ['Y', 'A'], ['Z', 'C']]); // 0,5 e 0,8 (inclusive) = A; 1,0 = C
    const comRuido = [...base, venda('Z', '2025-10-22', 100), venda('W', '2025-10-23', 5), venda('Z', '2025-11-30', 999)];
    expect([...classeProposta(dados([], comRuido), '2025-10-22')]).toEqual([...sem]); // o dia d e o futuro não entram
    expect(classeProposta(dados([], comRuido), '2025-10-22').has('W')).toBe(false);
    expect(classeProposta(dados([], comRuido), '2025-10-23').get('Z')).toBe('A'); // no dia seguinte o 22 já entra (Z=120 de 200 => 60%)
  });

  it('janela de 90 dias: venda com 91 dias de idade não conta; com exatamente 90 conta', () => {
    const d = '2026-02-01';
    const v = [venda('Velho', '2025-10-31', 1000), venda('Limite', '2025-11-03', 10), venda('Novo', '2026-01-30', 10)];
    const m = classeProposta(dados([], v), d);
    expect(m.has('Velho')).toBe(false); // 2025-10-31 = d - 93
    expect(m.has('Limite')).toBe(true); // 2025-11-03 = d - 90 (>= hoje - 90 dias)
  });

  it('total zero => tudo C', () => {
    const m = classeProposta(dados([], [venda('X', '2025-10-21', 0), venda('Y', '2025-10-21', 0)]), '2025-10-22');
    expect([...m.values()]).toEqual(['C', 'C']);
  });
});

describe('histerese (atualizar_classificacao_skus)', () => {
  const R = { subir: 2, descer: 3, ordem: REGRAS.ordem_prioridade.split(' ') };
  it('passo: SKU novo entra direto; mesma classe zera o pendente; subir exige 2, descer exige 3 propostas seguidas', () => {
    let e = passoHisterese(undefined, 'CZ', R);
    expect(e).toMatchObject({ atual: 'CZ', pendente: null, meses: 1 });
    e = passoHisterese(e, 'AZ', R);
    expect(e).toMatchObject({ atual: 'CZ', pendente: 'AZ', meses: 1 });
    e = passoHisterese(e, 'AZ', R);
    expect(e).toMatchObject({ atual: 'AZ', pendente: null, meses: 0 }); // subindo: 2o mês consecutivo aplica
    e = passoHisterese(e, 'BZ', R);
    e = passoHisterese(e, 'BZ', R);
    expect(e).toMatchObject({ atual: 'AZ', pendente: 'BZ', meses: 2 }); // descendo: 2 não basta
    e = passoHisterese(e, 'AZ', R);
    expect(e).toMatchObject({ atual: 'AZ', pendente: null, meses: 0 }); // voltou: zera
    e = passoHisterese(e, 'BZ', R);
    e = passoHisterese(e, 'CZ', R); // proposta muda de novo: reinicia (CASO 4)
    expect(e).toMatchObject({ atual: 'AZ', pendente: 'CZ', meses: 1 });
  });

  it('histerese segura a promoção até N meses consecutivos (N lido da regra)', () => {
    const v = [venda('X', '2025-10-21', 50), venda('Y', '2025-10-21', 30), venda('Z', '2025-10-21', 20), venda('Z', '2025-10-22', 100)];
    const d = dados([], v);
    // Z entra como C (2025-10-22). Em 10-23 a proposta vira A (1o mês): segura. Em 10-24 (2o): aplica.
    expect(classeEfetiva(d, '2025-10-22', UM).get('Z')).toBe('C');
    expect(classeProposta(d, '2025-10-23').get('Z')).toBe('A');
    expect(classeEfetiva(d, '2025-10-23', UM).get('Z')).toBe('C');
    expect(classeEfetiva(d, '2025-10-24', UM).get('Z')).toBe('A');
    // X cai de A para B: rebaixar exige 3 propostas seguidas => só vale em 10-25
    expect(classeEfetiva(d, '2025-10-24', UM).get('X')).toBe('A');
    expect(classeEfetiva(d, '2025-10-25', UM).get('X')).toBe('B');
    // N vem da regra: com meses_subir=3 a promoção do Z atrasa um passo
    const d3 = dados([], v, { ...REGRAS, meses_subir: '3' });
    expect(classeEfetiva(d3, '2025-10-24', UM).get('Z')).toBe('C');
    expect(classeEfetiva(d3, '2025-10-25', UM).get('Z')).toBe('A');
  });

  it('cadência de produção (12 ticks por dia) aplica no mesmo dia a proposta estável', () => {
    const v = [venda('X', '2025-10-21', 50), venda('Y', '2025-10-21', 30), venda('Z', '2025-10-21', 20), venda('Z', '2025-10-22', 100)];
    expect(classeEfetiva(dados([], v), '2025-10-23').get('Z')).toBe('A'); // default = produção
  });

  it('classe forçada prevalece sobre a calculada', () => {
    const v = [venda('X', '2025-10-21', 50), venda('Y', '2025-10-21', 30), venda('Z', '2025-10-21', 20)];
    const d = dados([sku('Z', { classeForcada: 'A' }), sku('X', { classeForcada: 'C' })], v);
    const m = classeEfetiva(d, '2025-10-22', UM);
    expect(m.get('Z')).toBe('A'); // calculada seria C
    expect(m.get('X')).toBe('C'); // calculada seria A
    expect(m.get('Y')).toBe('A');
  });

  it('não usa o futuro: alterar vendas posteriores a d não muda a efetiva de d', () => {
    const v = [venda('X', '2025-10-21', 50), venda('Y', '2025-10-21', 30), venda('Z', '2025-10-21', 20)];
    const a = classeEfetiva(dados([], v), '2025-10-30');
    const b = classeEfetiva(dados([], [...v, venda('Z', '2025-10-30', 1e6), venda('Q', '2025-11-05', 9)]), '2025-10-30');
    expect([...b]).toEqual([...a]);
  });
});

describe('validarClasse (efetiva recalculada hoje contra classe_abc_hoje)', () => {
  it('concordância total => 0% de divergência; discordância no A aparece em %', () => {
    const v = [venda('X', '2025-10-21', 50), venda('Y', '2025-10-21', 30), venda('Z', '2025-10-21', 20)];
    const hoje: Record<string, Classe> = { X: 'A', Y: 'A', Z: 'C' };
    const ok = validarClasse(dados(Object.entries(hoje).map(([s, c]) => sku(s, { classeAbcHoje: c })), v, REGRAS, '2025-10-22'));
    expect(ok.valorADivergente).toBe(0);
    expect(ok.porClasse).toEqual({ A: 0, B: null, C: 0 }); // sem B hoje: não mensurável (null), nunca 0% fabricado
    // hoje diz que Y é B (valor 30 de 80 no A de hoje = X): peso divergente 30 / peso A-hoje 50
    const dv = validarClasse(dados([sku('X', { classeAbcHoje: 'A' }), sku('Y', { classeAbcHoje: 'B' }), sku('Z', { classeAbcHoje: 'C' })], v, REGRAS, '2025-10-22'));
    expect(dv.valorADivergente).toBeCloseTo(100 * 30 / 50, 6);
    expect(dv.porClasse.B).toBeCloseTo(100, 6);
    expect(dv.porClasse.A).toBe(0);
  });
});
