import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ehFalhaSistemicaDoPortal } from '../sayerlack-pos-login';
import {
  decidirAjusteLote,
  decidirAlertaAjusteLote,
  decidirAlertaLoteMinimo,
  extrairCamposPayloadEfetivar,
  extrairLoteMinimoPortal,
  lerAjustesLoteDaEvidencia,
  lerLoteMinimoDaEvidencia,
  provarGradeAjustada,
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
    ).toEqual({ skuPortal: 'YO20.1464.00BB', lote: 20, qtdeEnviada: 1, motivo: null });
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
      motivo: null,
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

  // Funções que rodam TAMBÉM no Chrome remoto (interpoladas via toString() no template do Browserless):
  // sem crase, sem cifrão-chave e sem chamar outra função do módulo (no Chrome ela não existe).
  const INTERPOLADAS = ['extrairLoteMinimoPortal', 'decidirAjusteLote', 'provarGradeAjustada', 'extrairCamposPayloadEfetivar'];
  const EXPORTADAS_DO_MODULO = ['descreverMotivoLote', 'lerLoteMinimoDaEvidencia', 'decidirAlertaLoteMinimo',
    'lerAjustesLoteDaEvidencia', 'decidirAlertaAjusteLote', ...INTERPOLADAS];
  for (const nome of INTERPOLADAS) {
    it(nome + ' é interpolável no Browserless (sem crase, cifrão-chave nem chamada a outra função do módulo)', () => {
      const src = readFileSync(CANONICO, 'utf8');
      const inicio = src.indexOf('export function ' + nome + '(');
      expect(inicio).toBeGreaterThan(-1);
      const corpo = src.slice(inicio, src.indexOf('\n}\n', inicio) + 2);
      expect(corpo.length).toBeGreaterThan(100);
      expect(corpo.includes('`')).toBe(false);
      expect(corpo.includes('${')).toBe(false);
      for (const outra of EXPORTADAS_DO_MODULO.filter((x) => x !== nome)) {
        expect(corpo.includes(outra + '(')).toBe(false);
      }
      expect(corpo.includes('MOTIVOS_LOTE')).toBe(false);
    });

    it('o edge injeta ' + nome + ' no script do Browserless', () => {
      const edge = readFileSync(resolve(ROOT, 'supabase/functions/enviar-pedido-portal-sayerlack/index.ts'), 'utf8');
      expect(edge.includes('const ' + nome + ' = ${' + nome + '.toString()};')).toBe(true);
    });
  }
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

// ============================================================
// Fase 1 (revisada): subir ao lote, efetivar e registrar a divergência.
// Forma real da grade no 4505 (screenshot + evidence.loteMinimo.linha, 2026-11-18): linha confirmada mostra
// Qtd UN como texto ("1"); a recusada fica em edição com input Qtd UN = "1".
// ============================================================
describe('decidirAjusteLote', () => {
  it('caso real do 4505: lote 20, enviado 1 → ajustar para 20', () => {
    expect(decidirAjusteLote(20, 1, false)).toEqual({ acao: 'ajustar', lote: 20 });
  });
  it('lote não inteiro (12,5 lido como 12.5) → aborta, nunca arredonda', () => {
    expect(decidirAjusteLote(12.5, 1, false)).toEqual({ acao: 'abortar', motivo: 'lote_nao_inteiro' });
  });
  it('lote ≤ qtde enviada (recusa incoerente) → aborta', () => {
    expect(decidirAjusteLote(20, 20, false)).toEqual({ acao: 'abortar', motivo: 'lote_nao_maior' });
    expect(decidirAjusteLote(5, 6, false)).toEqual({ acao: 'abortar', motivo: 'lote_nao_maior' });
  });
  it('item já ajustado → aborta (2ª recusa nunca vira 2º palpite)', () => {
    expect(decidirAjusteLote(24, 1, true)).toEqual({ acao: 'abortar', motivo: 'ja_ajustado' });
  });
  it('qtde enviada inválida → aborta', () => {
    expect(decidirAjusteLote(20, Number.NaN, false)).toEqual({ acao: 'abortar', motivo: 'lote_nao_maior' });
    expect(decidirAjusteLote(20, 0.5, false)).toEqual({ acao: 'abortar', motivo: 'lote_nao_maior' });
  });
});

describe('provarGradeAjustada (a grade prova; o texto do alerta não)', () => {
  const esperados = [{ sku_portal: 'YC.1400FP', qtde: 1 }, { sku_portal: 'YO20.1464.00BB', qtde: 20 }];
  const conf = (sku: string, q: string) => ({ sku_portal: sku, qtd_un_texto: q, em_edicao: false });
  it('grade confirmada e batendo → ok', () => {
    expect(provarGradeAjustada([conf('YC.1400FP', '1'), conf('YO20.1464.00BB', '20')], esperados)).toEqual({ ok: true });
  });
  it('linha ainda em edição (recusa repetida) → reprova', () => {
    const r = provarGradeAjustada([conf('YC.1400FP', '1'), { sku_portal: 'YO20.1464.00BB', qtd_un_texto: null, em_edicao: true }], esperados);
    expect(r).toEqual({ ok: false, motivo: 'linha_em_edicao', linha: 1 });
  });
  it('Qtd UN ficou 1 (o portal não aceitou o 20) → reprova', () => {
    expect(provarGradeAjustada([conf('YC.1400FP', '1'), conf('YO20.1464.00BB', '1')], esperados))
      .toEqual({ ok: false, motivo: 'qtde_divergente', linha: 1 });
  });
  it('Qtd UN com separador ("1.000", "20,0000") é ambígua → reprova, nunca lê como 1 ou 20', () => {
    expect(provarGradeAjustada([conf('YC.1400FP', '1'), conf('YO20.1464.00BB', '20,0000')], esperados))
      .toEqual({ ok: false, motivo: 'qtde_ilegivel', linha: 1 });
    expect(provarGradeAjustada([conf('YC.1400FP', '1.000'), conf('YO20.1464.00BB', '20')], esperados))
      .toEqual({ ok: false, motivo: 'qtde_ilegivel', linha: 0 });
  });
  it('linhas a mais/a menos, SKU trocado ou não identificado → reprova', () => {
    expect(provarGradeAjustada([conf('YC.1400FP', '1')], esperados)).toEqual({ ok: false, motivo: 'n_linhas', linha: null });
    expect(provarGradeAjustada([conf('YO20.1464.00BB', '20'), conf('YC.1400FP', '1')], esperados))
      .toEqual({ ok: false, motivo: 'sku_divergente', linha: 0 });
    expect(provarGradeAjustada([conf('', '1'), conf('YO20.1464.00BB', '20')], esperados))
      .toEqual({ ok: false, motivo: 'sku_divergente', linha: 0 });
  });
  it('grade ilegível (null) → reprova, nunca passa por falta de dado', () => {
    expect(provarGradeAjustada(null, esperados)).toEqual({ ok: false, motivo: 'sem_grade', linha: null });
  });
  it('em_edicao ausente (forma inesperada) conta como edição', () => {
    const r = provarGradeAjustada([conf('YC.1400FP', '1'), { sku_portal: 'YO20.1464.00BB', qtd_un_texto: '20' } as never], esperados);
    expect(r).toEqual({ ok: false, motivo: 'linha_em_edicao', linha: 1 });
  });
});

describe('extrairCamposPayloadEfetivar (evidência pós-clique)', () => {
  it('multipart: guarda só campos de item/qtde', () => {
    const b = '------X\r\nContent-Disposition: form-data; name="_token"\r\n\r\nabc\r\n' +
      '------X\r\nContent-Disposition: form-data; name="itens[1][it_codigo]"\r\n\r\nYO20.1464.00BB\r\n' +
      '------X\r\nContent-Disposition: form-data; name="itens[1][qtd_un]"\r\n\r\n20\r\n';
    expect(extrairCamposPayloadEfetivar(b)).toEqual([['itens[1][it_codigo]', 'YO20.1464.00BB'], ['itens[1][qtd_un]', '20']]);
  });
  it('urlencoded', () => {
    expect(extrairCamposPayloadEfetivar('_token=x&items%5B0%5D%5Bit_codigo%5D=YC.1400FP&items%5B0%5D%5Bqtde%5D=1'))
      .toEqual([['items[0][it_codigo]', 'YC.1400FP'], ['items[0][qtde]', '1']]);
  });
  it('vazio/ausente → []', () => {
    expect(extrairCamposPayloadEfetivar(null)).toEqual([]);
    expect(extrairCamposPayloadEfetivar('')).toEqual([]);
  });
});

describe('lerAjustesLoteDaEvidencia (Chrome remoto = não confiável)', () => {
  const enviados = [{ sku_portal: 'YC.1400FP', qtde: 1 }, { sku_portal: 'YO20.1464.00BB', qtde: 1 }];
  it('ajuste coerente com o que esta execução enviou → válido', () => {
    const r = lerAjustesLoteDaEvidencia({ ajustesLote: [{ idx: 1, skuPortal: 'YO20.1464.00BB', qtdeOriginal: 1, lote: 20 }] }, enviados);
    expect(r).toEqual({ validos: [{ idx: 1, skuPortal: 'YO20.1464.00BB', qtdeOriginal: 1, lote: 20 }], invalidos: 0 });
  });
  it('sem campo → sem ajuste (Fase 0 / envelope velho)', () => {
    expect(lerAjustesLoteDaEvidencia({}, enviados)).toEqual({ validos: [], invalidos: 0 });
    expect(lerAjustesLoteDaEvidencia({ ajustesLote: [] }, enviados)).toEqual({ validos: [], invalidos: 0 });
  });
  it('SKU ≠ item idx, qtde ≠ enviada, lote não inteiro/≤ qtde, idx fora, idx repetido → inválidos', () => {
    const r = lerAjustesLoteDaEvidencia({
      ajustesLote: [
        { idx: 0, skuPortal: 'YO20.1464.00BB', qtdeOriginal: 1, lote: 20 },
        { idx: 1, skuPortal: 'YO20.1464.00BB', qtdeOriginal: 2, lote: 20 },
        { idx: 1, skuPortal: 'YO20.1464.00BB', qtdeOriginal: 1, lote: 20.5 },
        { idx: 1, skuPortal: 'YO20.1464.00BB', qtdeOriginal: 1, lote: 1 },
        { idx: 7, skuPortal: 'YO20.1464.00BB', qtdeOriginal: 1, lote: 20 },
        { idx: 1, skuPortal: 'YO20.1464.00BB', qtdeOriginal: 1, lote: '20' },
        'lixo',
      ],
    }, enviados);
    expect(r).toEqual({ validos: [], invalidos: 7 });
    const dup = lerAjustesLoteDaEvidencia({ ajustesLote: [
      { idx: 1, skuPortal: 'YO20.1464.00BB', qtdeOriginal: 1, lote: 20 },
      { idx: 1, skuPortal: 'YO20.1464.00BB', qtdeOriginal: 1, lote: 20 },
    ] }, enviados);
    expect(dup.validos).toHaveLength(1);
    expect(dup.invalidos).toBe(1);
  });
  it('campo presente mas não-array → 1 inválido (alerta urgente, nunca "sem ajuste")', () => {
    expect(lerAjustesLoteDaEvidencia({ ajustesLote: { idx: 1 } }, enviados)).toEqual({ validos: [], invalidos: 1 });
  });
});

describe('decidirAlertaAjusteLote', () => {
  const base = { protocolo: '123456', ajustes: [{ skuPortal: 'YO20.1464.00BB', qtdeOriginal: 1, lote: 20, descricao: 'VERNIZ PISO' }], invalidos: 0, ledgerGravado: true };
  it('urgente, com o texto pronto ao CRS citando o pedido Sayerlack e as quantidades', () => {
    const a = decidirAlertaAjusteLote(base);
    expect(a.severidade).toBe('urgente');
    expect(a.mensagem).toContain('crs@sayerlack.com.br');
    expect(a.mensagem).toContain('Pedido 123456');
    expect(a.mensagem).toContain('YO20.1464.00BB (VERNIZ PISO): lancado 20 UN pelo lote minimo, precisamos de 1 UN');
    expect(a.mensagem).toContain('cancelamento desse(s) item(ns)');
    expect(a.mensagem).not.toContain('NAO gravou');
  });
  it('ledger não gravado / ajuste ilegível / sem protocolo → diz, nunca omite', () => {
    const a = decidirAlertaAjusteLote({ ...base, protocolo: null, invalidos: 2, ledgerGravado: false });
    expect(a.mensagem).toContain('(SEM PROTOCOLO - conciliar)');
    expect(a.mensagem).toContain('NAO gravou');
    expect(a.mensagem).toContain('2 ajuste(s) com evidencia ilegivel');
  });
  it('Fase 2a: com envio automático, manda NÃO enviar à mão e não traz o texto para copiar', () => {
    const a = decidirAlertaAjusteLote({ ...base, emailAutomatico: true });
    expect(a.mensagem).toContain('SAI AUTOMATICAMENTE');
    expect(a.mensagem).toContain('NAO envie a mao');
    expect(a.mensagem).not.toContain('ACAO: enviar');
    expect(a.titulo).toContain('e-mail ao CRS automatico');
  });
  it('Fase 2a: automático só vale com protocolo, ledger gravado e zero ilegível — senão volta ao manual', () => {
    for (const x of [{ protocolo: null }, { ledgerGravado: false }, { invalidos: 1 }]) {
      const a = decidirAlertaAjusteLote({ ...base, emailAutomatico: true, ...x });
      expect(a.mensagem).toContain('ACAO: enviar a crs@sayerlack.com.br');
      expect(a.mensagem).not.toContain('SAI AUTOMATICAMENTE');
    }
  });
});

describe('decidirAlertaLoteMinimo com motivo (Fase 1)', () => {
  it('diz por que o robô não subiu ao lote', () => {
    const a = decidirAlertaLoteMinimo({ skuPortal: 'X', lote: 20, qtdeEnviada: 1, motivo: 'recusa_apos_ajuste' });
    expect(a?.mensagem).toContain('o portal recusou de novo depois de lancar o lote');
    expect(a?.mensagem).toContain('Nenhum pedido foi colocado');
  });
  it('lerLoteMinimoDaEvidencia carrega o motivo', () => {
    expect(lerLoteMinimoDaEvidencia({ loteMinimo: { lote: 20, skuPortal: 'X', qtdeEnviada: 1, motivo: 'grade_divergente' } })?.motivo).toBe('grade_divergente');
  });
});
