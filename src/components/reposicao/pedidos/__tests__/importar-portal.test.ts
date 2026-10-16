import { describe, expect, it } from 'vitest';
import { interpretarRespostaImportacao, PROTOCOLO_PORTAL_RE } from '../importar-portal';

describe('interpretarRespostaImportacao', () => {
  it('sucesso só com PO confirmado (ok + concluido)', () => {
    const r = interpretarRespostaImportacao(
      { ok: true, etapa: 'concluido', pedido_id: 3610, omie_numero: '4521', valor_total: 5181.82, mensagem: 'ok', itens: [] },
      '2140603',
    );
    expect([r.tom, r.titulo, r.pedidoId, r.omieNumero, r.valorTotal]).toEqual(['sucesso', 'Pedido 2140603 importado', 3610, '4521', 5181.82]);
  });

  it('já existia com PO: sucesso com título próprio', () => {
    const r = interpretarRespostaImportacao({ ok: true, etapa: 'concluido', ja_existia: true, pedido_id: 1 }, '2140603');
    expect([r.tom, r.titulo]).toEqual(['sucesso', 'Pedido 2140603 já estava importado']);
  });

  it('gravado sem PO no Omie: aviso, não sucesso', () => {
    const r = interpretarRespostaImportacao({ ok: false, etapa: 'omie', pedido_id: 3610, mensagem: 'sem PO' }, '2140603');
    expect([r.tom, r.mensagem]).toEqual(['aviso', 'sem PO']);
  });

  it('ok:true sem etapa concluido NÃO é sucesso (ausente ≠ sucesso)', () => {
    expect(interpretarRespostaImportacao({ ok: true }, '1').tom).toBe('erro');
  });

  it('falha de leitura e de importação viram erro com o motivo da edge', () => {
    const l = interpretarRespostaImportacao({ ok: false, etapa: 'leitura', mensagem: 'portal fora do ar' }, '2140603');
    expect([l.tom, l.titulo, l.mensagem]).toEqual(['erro', 'Não consegui ler o pedido 2140603 no portal', 'portal fora do ar']);
    const i = interpretarRespostaImportacao({ ok: false, etapa: 'importacao', mensagem: 'sem de-para: X' }, '2140603');
    expect([i.tom, i.titulo]).toEqual(['erro', 'Pedido 2140603 não foi importado']);
  });

  it('falha de leitura traz o trace como detalhe técnico; sucesso não traz', () => {
    const l = interpretarRespostaImportacao({ ok: false, etapa: 'leitura', mensagem: 'x', trace: [{ step: 'consulta_lida', n_linhas: 0 }] }, '1');
    expect(l.detalheTecnico).toContain('consulta_lida');
    expect(interpretarRespostaImportacao({ ok: true, etapa: 'concluido', pedido_id: 1 }, '1').detalheTecnico).toBeNull();
  });

  it('resposta nula/lixo é erro', () => {
    expect(interpretarRespostaImportacao(null, '1').tom).toBe('erro');
    expect(interpretarRespostaImportacao('x', '1').tom).toBe('erro');
  });
});

describe('PROTOCOLO_PORTAL_RE', () => {
  it('só dígitos, 3 a 12', () => {
    expect(['2140603', '123', '123456789012'].every((s) => PROTOCOLO_PORTAL_RE.test(s))).toBe(true);
    expect(['12', '21406O3', ' 2140603', '1234567890123', ''].some((s) => PROTOCOLO_PORTAL_RE.test(s))).toBe(false);
  });
});
