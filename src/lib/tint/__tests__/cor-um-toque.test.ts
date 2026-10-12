// Fase 2A — "Cores do cliente" em 1 toque. O que estes testes travam é o FAIL-CLOSED do
// atalho: ele só existe com fórmula inequívoca E preço vendável do MOTOR; qualquer dúvida
// devolve null (o card cai no diálogo). E o preço é o MESMO das outras embalagens.
import { describe, it, expect } from 'vitest';
import { decidirUmToque, escolherFormulaUmToque, ehCodigoDeCor, nomeCompativel, type CandidataUmToque } from '../cor-um-toque';
import { selectAltPrice, type TintPriceBreakdownLite } from '../select-price';
import { aplicarDesconto, podeAdicionarCor, precoVendavel } from '../pode-adicionar';

const cand = (over: Partial<CandidataUmToque>): CandidataUmToque => ({
  id: 'f1', sku_id: 'sku-A', cor_id: '346J', nome_cor: 'PLATINA BIANCO', preco_csv_legado: null, ...over,
});

const motor = (precoFinal: number | null): TintPriceBreakdownLite =>
  ({ precoFinal, custoCorantes: 3.2 } as unknown as TintPriceBreakdownLite);

describe('escolherFormulaUmToque — fórmula inequívoca ou nada', () => {
  it('código exato na MESMA base → a fórmula (caixa do histórico não importa)', () => {
    const f = escolherFormulaUmToque('sku-A', '346j', [cand({}), cand({ id: 'f2', sku_id: 'sku-B' })], null);
    expect(f?.id).toBe('f1');
  });

  it('cor só por NOME (sem dígito) nunca vira 1 toque', () => {
    expect(ehCodigoDeCor('PLATINA')).toBe(false);
    // rótulo livre do Omie sem código → nunca atalho (o código extraído seria uma palavra qualquer)
    expect(escolherFormulaUmToque('sku-A', 'PLATINA', [cand({ cor_id: 'PLATINA' })], 'PLATINA BIANCO')).toBeNull();
  });

  it('código de OUTRA base não serve (a base é a da compra)', () => {
    expect(escolherFormulaUmToque('sku-A', '346J', [cand({ sku_id: 'sku-B' })], null)).toBeNull();
  });

  it('2 fórmulas para o mesmo (base, código) → ambíguo → null', () => {
    expect(escolherFormulaUmToque('sku-A', '346J', [cand({}), cand({ id: 'f2' })], null)).toBeNull();
  });

  it('do rótulo livre: nome do catálogo precisa dividir uma palavra de cor com o rótulo', () => {
    expect(escolherFormulaUmToque('sku-A', '346J', [cand({})], '346J - PLATINA BIANCA 900ML')?.id).toBe('f1');
    expect(escolherFormulaUmToque('sku-A', '346J', [cand({})], '346J - ACRIL BS')).toBeNull();
  });

  it('nomeCompativel: TODA palavra de cor do catálogo precisa estar no rótulo (Codex P1 rodada 5)', () => {
    expect(nomeCompativel('H109 - VERDE AGUA 900ML', 'VERDE FOLHA')).toBe(false);
    expect(nomeCompativel('346J - ACRIL BS | NÃO USAR PLATINA', 'PLATINA BIANCO')).toBe(false);
    // a observação (após |) cita a cor INTEIRA — ainda assim não identifica o que foi comprado
    expect(nomeCompativel('346J - ACRIL BS | trocar por PLATINA BIANCO', 'PLATINA BIANCO')).toBe(false);
    expect(nomeCompativel('346J PLATINA BIANCA (perola urbana)', 'PLATINA BIANCO')).toBe(true);
    expect(nomeCompativel('346J PLATINA', 'PLATINA BIANCO')).toBe(false);
    // 1 letra de diferença só em palavra longa: "OURO" × "OUROS" não é tolerado
    expect(nomeCompativel('345J OUROS', 'OURO')).toBe(false);
    // catálogo sem palavra de cor (só código) não é verificável
    expect(nomeCompativel('H109 PALHA', 'H109 - BS')).toBe(false);
  });

  it('nomeCompativel ignora embalagem/sufixo (BS, ML, GL, galão, números)', () => {
    expect(nomeCompativel('346J - BS 900ML GALÃO', 'PLATINA BIANCO - BS')).toBe(false);
    expect(nomeCompativel('H109 PALHA 3,6 GALÃO', 'PALHA')).toBe(true);
    expect(nomeCompativel('AÇÚCAR CRISTAL', 'ACUCAR CRISTAL - BS')).toBe(true);
  });

  it('código do rótulo casa com o cor_id "CÓDIGO - BS" do catálogo vivo; linha distinta só pela base', () => {
    const h109 = cand({ id: 'fh', cor_id: 'H109 - BS', nome_cor: 'PALHA H109 - BS' });
    expect(escolherFormulaUmToque('sku-A', 'H109', [h109], 'PALHA H109 - BS 3,6 GALÃO')?.id).toBe('fh');
    // mesmo código em 2 linhas NA MESMA base → ambíguo
    const acril = cand({ id: 'fa', cor_id: 'H109 - ACRIL BS', nome_cor: 'PALHA H109 - ACRIL BS' });
    expect(escolherFormulaUmToque('sku-A', 'H109', [h109, acril], 'PALHA H109 - BS')).toBeNull();
    // "H1090 - BS" não é "H109"
    expect(escolherFormulaUmToque('sku-A', 'H109', [cand({ cor_id: 'H1090 - BS', nome_cor: 'PALHA' })], 'PALHA H109')).toBeNull();
  });

  it('identidade exata (tint_cor_id) compara o cor_id INTEIRO', () => {
    const h109 = cand({ id: 'fh', cor_id: 'H109 - BS' });
    const acril = cand({ id: 'fa', cor_id: 'H109 - ACRIL BS' });
    expect(escolherFormulaUmToque('sku-A', 'h109 - acril bs', [h109, acril], null)?.id).toBe('fa');
  });

  it('casamento é EXATO, não por prefixo/substring', () => {
    expect(escolherFormulaUmToque('sku-A', '346', [cand({})], null)).toBeNull();
  });
});

describe('decidirUmToque — preço do motor ou nada', () => {
  it('sem breakdown do motor (carregando/erro) → null, mesmo com CSV', () => {
    expect(decidirUmToque(150, undefined)).toBeNull();
    expect(decidirUmToque(150, null)).toBeNull();
  });

  it('motor sem preço confiável (precoFinal null) → null, o CSV não fura', () => {
    expect(decidirUmToque(150, motor(null))).toBeNull();
  });

  it('preço R$ 0 → null (nunca vende a zero)', () => {
    expect(decidirUmToque(null, motor(0))).toBeNull();
  });

  it('paridade com as outras embalagens: regra do maior via selectAltPrice', () => {
    const d = decidirUmToque(150.01, motor(120));
    const alt = selectAltPrice(Math.ceil(150.01 * 10) / 10, motor(120), null);
    expect(d).toEqual({ preco: alt.preco, fonte: alt.fonte, custoCorantes: 3.2 });
    expect(d?.fonte).toBe('tabela');
    expect(d?.preco).toBe(150.1);
  });

  it('cálculo maior que a tabela → fonte calculado', () => {
    expect(decidirUmToque(100, motor(130.04))).toEqual({ preco: 130.1, fonte: 'calculado', custoCorantes: 3.2 });
  });
});

describe('pode-adicionar — a regra ÚNICA das portas de cor', () => {
  it('precoVendavel: só número finito > 0', () => {
    expect([null, undefined, 0, -1, NaN, Infinity].map(precoVendavel)).toEqual([false, false, false, false, false, false]);
    expect(precoVendavel(0.01)).toBe(true);
  });

  it('podeAdicionarCor: carregando ou indisponível segura, mesmo com número', () => {
    expect(podeAdicionarCor({ precoCarregando: true, disponivel: true, precoFinal: 100 })).toBe(false);
    expect(podeAdicionarCor({ precoCarregando: false, disponivel: false, precoFinal: 100 })).toBe(false);
    expect(podeAdicionarCor({ precoCarregando: false, disponivel: true, precoFinal: 100 })).toBe(true);
  });

  it('desconto que arredonda a R$ 0,00 não vende — sem teto de desconto', () => {
    expect(aplicarDesconto(0.4, 99.99)).toBe(0);
    expect(podeAdicionarCor({ precoCarregando: false, disponivel: true, precoFinal: aplicarDesconto(0.4, 99.99) })).toBe(false);
    expect(aplicarDesconto(100, 99)).toBe(1);
  });
});
