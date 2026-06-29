import { describe, it, expect } from 'vitest';
import { montarSelosVendaAssistida, descreverSelo } from '../selos';
import { resolverOpcaoVenda } from '../resolver-opcao';
import type { ProdutoLinhaOmie } from '../montar-embalagens';
import { keyDeSku, type CurrentSpec } from '@/lib/knowledge-base/spec-link';

// ── factories ────────────────────────────────────────────────────────────────
const spec = (
  p: Partial<CurrentSpec> &
    Pick<CurrentSpec, 'account' | 'omie_codigo_produto' | 'kb_product_spec_id'>,
): CurrentSpec => ({
  product_code: null,
  product_name: null,
  supplier: null,
  product_category: null,
  rendimento_m2_por_litro: null,
  demaos_recomendadas: null,
  pot_life_horas: null,
  validade_dias: null,
  catalisador_codigo: null,
  catalisador_proporcao_pct: null,
  diluente_codigo: null,
  substrato: null,
  equipamentos_aplicacao: null,
  diferenciais_chave: null,
  uso_recomendado: null,
  ...p,
});

const row = (
  omie_codigo_produto: number,
  descricao: string,
  valor_unitario: number,
  estoque: number,
): ProdutoLinhaOmie => ({ omie_codigo_produto, descricao, valor_unitario, estoque });

const catalog = (
  ...entries: { account: string; row: ProdutoLinhaOmie }[]
): Map<string, ProdutoLinhaOmie> => {
  const m = new Map<string, ProdutoLinhaOmie>();
  for (const { account, row: r } of entries) {
    m.set(keyDeSku(account, r.omie_codigo_produto), r);
  }
  return m;
};

// ── montarSelosVendaAssistida ────────────────────────────────────────────────
describe('montarSelosVendaAssistida', () => {
  it('boletim base-only em estoque → SELLABLE_NOW + preço ok, espalhado pra cada SKU', () => {
    const specs = [
      spec({ account: 'colacor', omie_codigo_produto: 1, kb_product_spec_id: 'B1' }),
      spec({ account: 'colacor', omie_codigo_produto: 2, kb_product_spec_id: 'B1' }),
    ];
    const cat = catalog(
      { account: 'colacor', row: row(1, 'PRIMER PU FL.6269.02GL', 360, 5) }, // GL 3,6 L → 100/L
      { account: 'colacor', row: row(2, 'PRIMER PU FL.6269.02QT', 100, 5) }, // QT 0,9 L
    );

    const selos = montarSelosVendaAssistida(specs, cat, {});
    const s1 = selos.get(keyDeSku('colacor', 1));
    expect(s1?.estado).toBe('SELLABLE_NOW');
    expect(s1?.preco.status).toBe('ok');
    // fan-out: o SKU 2 do MESMO boletim referencia a MESMA opção
    expect(selos.get(keyDeSku('colacor', 2))).toBe(s1);
  });

  it('boletim base-only sem estoque → ORDERABLE (encomenda)', () => {
    const specs = [spec({ account: 'colacor', omie_codigo_produto: 1, kb_product_spec_id: 'B1' })];
    const cat = catalog({ account: 'colacor', row: row(1, 'PRIMER PU FL.6269.02GL', 360, 0) });
    const s = montarSelosVendaAssistida(specs, cat, {}).get(keyDeSku('colacor', 1));
    expect(s?.estado).toBe('ORDERABLE');
  });

  it('boletim COM catalisador (v1 sem casamento) → ORDERABLE + "sob consulta"', () => {
    const specs = [
      spec({
        account: 'colacor',
        omie_codigo_produto: 1,
        kb_product_spec_id: 'B2',
        catalisador_codigo: 'FC.1',
        catalisador_proporcao_pct: 10,
      }),
    ];
    const cat = catalog({ account: 'colacor', row: row(1, 'PRIMER PU FL.6269.02GL', 360, 5) });
    const s = montarSelosVendaAssistida(specs, cat, {}).get(keyDeSku('colacor', 1));
    expect(s?.estado).toBe('ORDERABLE');
    expect(s?.preco.status).toBe('incomplete'); // catalisador obrigatório sem casamento
  });

  it('catalisador_codigo vazio/whitespace → tratado como base-only', () => {
    const specs = [
      spec({
        account: 'colacor',
        omie_codigo_produto: 1,
        kb_product_spec_id: 'B3',
        catalisador_codigo: '   ',
      }),
    ];
    const cat = catalog({ account: 'colacor', row: row(1, 'PRIMER PU FL.6269.02GL', 360, 5) });
    const s = montarSelosVendaAssistida(specs, cat, {}).get(keyDeSku('colacor', 1));
    expect(s?.estado).toBe('SELLABLE_NOW');
    expect(s?.preco.status).toBe('ok');
  });

  it('preço-do-cliente (último praticado) vence a tabela no selo', () => {
    const specs = [spec({ account: 'colacor', omie_codigo_produto: 1, kb_product_spec_id: 'B1' })];
    const cat = catalog({ account: 'colacor', row: row(1, 'PRIMER PU FL.6269.02GL', 360, 5) });
    const s = montarSelosVendaAssistida(specs, cat, { 1: 180 }).get(keyDeSku('colacor', 1));
    // 180 / 3,6 L = 50/L (cliente) em vez de 360/3,6 = 100/L (tabela)
    if (s?.preco.status === 'ok') expect(s.preco.precoLitroBase).toBe(50);
  });

  it('boletim sem NENHUMA embalagem no catálogo → não emite selo', () => {
    const specs = [spec({ account: 'colacor', omie_codigo_produto: 99, kb_product_spec_id: 'B9' })];
    const selos = montarSelosVendaAssistida(specs, catalog(), {});
    expect(selos.has(keyDeSku('colacor', 99))).toBe(false);
  });

  it('lista vazia → Map vazio', () => {
    expect(montarSelosVendaAssistida([], catalog(), {}).size).toBe(0);
  });
});

// ── descreverSelo ────────────────────────────────────────────────────────────
describe('descreverSelo', () => {
  it('SELLABLE_NOW + ok → "Em estoque", tone success, com preço', () => {
    const opcao = resolverOpcaoVenda({
      temSkuConfirmado: true,
      temCatalisador: false,
      proporcaoPct: null,
      baseEmbalagens: [{ valor: 360, litros: 3.6, estoque: 5 }],
      catalisadorEmbalagens: [],
    });
    const d = descreverSelo(opcao);
    expect(d.estadoLabel).toBe('Em estoque');
    expect(d.estadoTone).toBe('success');
    expect(d.temPreco).toBe(true);
    expect(d.valorLitro).toBe(100);
  });

  it('ORDERABLE + ok → "Encomenda", tone warning', () => {
    const opcao = resolverOpcaoVenda({
      temSkuConfirmado: true,
      temCatalisador: false,
      proporcaoPct: null,
      baseEmbalagens: [{ valor: 360, litros: 3.6, estoque: 0 }],
      catalisadorEmbalagens: [],
    });
    const d = descreverSelo(opcao);
    expect(d.estadoLabel).toBe('Encomenda');
    expect(d.estadoTone).toBe('warning');
    expect(d.temPreco).toBe(true);
  });

  it('preço incomplete → temPreco false, valorLitro null ("sob consulta")', () => {
    const opcao = resolverOpcaoVenda({
      temSkuConfirmado: true,
      temCatalisador: true,
      proporcaoPct: 10,
      baseEmbalagens: [{ valor: 360, litros: 3.6, estoque: 5 }],
      catalisadorEmbalagens: [], // catalisador obrigatório sem casamento
    });
    const d = descreverSelo(opcao);
    expect(d.temPreco).toBe(false);
    expect(d.valorLitro).toBeNull();
  });
});
