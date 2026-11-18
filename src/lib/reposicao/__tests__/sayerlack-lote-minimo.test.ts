import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ehFalhaSistemicaDoPortal } from '../sayerlack-pos-login';
import {
  decidirAlertaLoteMinimo,
  extrairLoteMinimoPortal,
  lerLoteMinimoDaEvidencia,
} from '../sayerlack-lote-minimo';

// Gatilho: pedido 4485 (2026-11-18). O portal recusou YO20.1464.00BB com a frase abaixo,
// copiada do print do founder. Lote em Qtd UN (confirmado pelo founder).
const FRASE_REAL = 'Quantidade informada menor que o lote mínimo de venda (20)';

describe('extrairLoteMinimoPortal', () => {
  it('lê o lote da frase real do portal', () => {
    expect(extrairLoteMinimoPortal([FRASE_REAL])).toEqual({
      lote: 20,
      trecho: 'lote mínimo de venda (20)',
    });
  });

  it('acha a frase em qualquer posição da lista (corpo do POST vazio, alerta no DOM)', () => {
    expect(extrairLoteMinimoPortal([null, '', 'Item gravado', FRASE_REAL])?.lote).toBe(20);
  });

  it('aceita sem acento, caixa alta, espaços extras e decimal com vírgula', () => {
    expect(extrairLoteMinimoPortal(['QUANTIDADE MENOR QUE O LOTE MINIMO DE VENDA ( 12,5 )'])?.lote).toBe(12.5);
  });

  it('dentro de JSON do POST também casa', () => {
    expect(extrairLoteMinimoPortal(['{"success":false,"message":"' + FRASE_REAL + '"}'])?.lote).toBe(20);
  });

  it('ausente ou sem número legível → null (nunca lote fabricado)', () => {
    expect(extrairLoteMinimoPortal([])).toBeNull();
    expect(extrairLoteMinimoPortal([null, undefined, ''])).toBeNull();
    expect(extrairLoteMinimoPortal(['Item gravado com sucesso'])).toBeNull();
    expect(extrairLoteMinimoPortal(['menor que o lote mínimo de venda ()'])).toBeNull();
    expect(extrairLoteMinimoPortal(['menor que o lote mínimo de venda (0)'])).toBeNull();
  });
});

describe('lerLoteMinimoDaEvidencia (evidência vinda do Chrome remoto, não confiável)', () => {
  it('forma completa → contexto do alerta', () => {
    expect(
      lerLoteMinimoDaEvidencia({ loteMinimo: { skuPortal: 'YO20.1464.00BB', lote: 20, qtdeEnviada: 1, trecho: 'x' } }),
    ).toEqual({ skuPortal: 'YO20.1464.00BB', lote: 20, qtdeEnviada: 1 });
  });

  it('lote ausente, string, zero ou NaN → null', () => {
    expect(lerLoteMinimoDaEvidencia(null)).toBeNull();
    expect(lerLoteMinimoDaEvidencia({})).toBeNull();
    expect(lerLoteMinimoDaEvidencia({ loteMinimo: { lote: '20' } })).toBeNull();
    expect(lerLoteMinimoDaEvidencia({ loteMinimo: { lote: 0 } })).toBeNull();
    expect(lerLoteMinimoDaEvidencia({ loteMinimo: { lote: Number.NaN } })).toBeNull();
  });

  it('SKU/qtde estranhos degradam para null sem derrubar o lote', () => {
    expect(lerLoteMinimoDaEvidencia({ loteMinimo: { lote: 20, skuPortal: '', qtdeEnviada: 'um' } })).toEqual({
      skuPortal: null,
      lote: 20,
      qtdeEnviada: null,
    });
  });
});

describe('decidirAlertaLoteMinimo', () => {
  it('alerta como atenção, com SKU, lote e qtde', () => {
    const a = decidirAlertaLoteMinimo({ skuPortal: 'YO20.1464.00BB', lote: 20, qtdeEnviada: 1 });
    expect(a?.severidade).toBe('atencao');
    expect(a?.titulo).toBe('Portal Sayerlack recusou item abaixo do lote minimo');
    expect(a?.mensagem).toContain('YO20.1464.00BB: lote minimo de venda 20 UN, o pedido tinha 1 UN');
    expect(a?.mensagem).toContain('Nenhum pedido foi colocado');
  });

  it('sem lote capturado → diz "nao capturado", nunca inventa número', () => {
    const a = decidirAlertaLoteMinimo(null);
    expect(a?.mensagem).toContain('(SKU nao capturado): lote minimo de venda (lote nao capturado) UN');
  });

  it('não é falha sistêmica: não derruba o resto do lote de pedidos', () => {
    expect(ehFalhaSistemicaDoPortal('LOTE_MINIMO_PORTAL')).toBe(false);
  });
});

// Dois runtimes (vitest em src/ e Deno no edge): byte-idênticos ou CI vermelho.
describe('paridade: sayerlack-lote-minimo (src) × _shared (edge)', () => {
  const ROOT = process.cwd();
  const CANONICO = resolve(ROOT, 'src/lib/reposicao/sayerlack-lote-minimo.ts');
  const ESPELHO = resolve(ROOT, 'supabase/functions/_shared/sayerlack-lote-minimo.ts');

  it('os dois arquivos são byte-idênticos', () => {
    expect(readFileSync(ESPELHO, 'utf8')).toBe(readFileSync(CANONICO, 'utf8'));
  });

  it('extrairLoteMinimoPortal é interpolável no Browserless (sem crase nem cifrão-chave)', () => {
    const src = readFileSync(CANONICO, 'utf8');
    const inicio = src.indexOf('export function extrairLoteMinimoPortal');
    expect(inicio).toBeGreaterThan(-1);
    const corpo = src.slice(inicio, src.indexOf('\n}\n', inicio) + 2);
    expect(corpo.length).toBeGreaterThan(100);
    expect(corpo.includes('`')).toBe(false);
    expect(corpo.includes('${')).toBe(false);
  });

  it('o edge injeta a função no script do Browserless', () => {
    const edge = readFileSync(resolve(ROOT, 'supabase/functions/enviar-pedido-portal-sayerlack/index.ts'), 'utf8');
    expect(edge.includes('const extrairLoteMinimoPortal = ${extrairLoteMinimoPortal.toString()};')).toBe(true);
  });
});

// A lista de erros lógicos pré-submit existe em DUAS cópias: o Set em sayerlack-classificacao.ts
// e o `erroLogicoPreSubmit` inlinado no script do Browserless (que é quem classifica de fato).
// Faltar um tipo na cópia do edge = erro vira `erro_retentavel` e o pedido é re-enviado 3x igual.
describe('paridade: erros lógicos pré-submit (src) × erroLogicoPreSubmit (edge)', () => {
  it('cada tipo do Set aparece no erroLogicoPreSubmit do edge, e vice-versa', () => {
    const ROOT = process.cwd();
    const src = readFileSync(resolve(ROOT, 'src/lib/reposicao/sayerlack-classificacao.ts'), 'utf8');
    const edge = readFileSync(resolve(ROOT, 'supabase/functions/enviar-pedido-portal-sayerlack/index.ts'), 'utf8');
    const blocoSrc = src.slice(src.indexOf('const ERROS_LOGICOS_PRE_SUBMIT'), src.indexOf(']);', src.indexOf('const ERROS_LOGICOS_PRE_SUBMIT')));
    const tiposSrc = [...blocoSrc.matchAll(/^\s*"([A-Z_]+)",/gm)].map((m) => m[1]).sort();
    const iEdge = edge.indexOf('const erroLogicoPreSubmit =');
    const blocoEdge = edge.slice(iEdge, edge.indexOf(';', iEdge));
    const tiposEdge = [...blocoEdge.matchAll(/tipo === '([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(tiposSrc).toContain('LOTE_MINIMO_PORTAL');
    expect(tiposEdge).toEqual(tiposSrc);
  });
});
