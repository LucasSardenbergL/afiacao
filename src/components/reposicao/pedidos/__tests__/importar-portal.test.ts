import { describe, expect, it } from 'vitest';
import {
  corpoDoErroEdge, esperaDaRodada, interpretarErroEdge, interpretarRespostaImportacao, lerNumerosPortal, linkDoPedido, MAX_NUMEROS_POR_VEZ, msAteReleituraPosCron, normalizarPainel,
  PROTOCOLO_PORTAL_RE, respostaIndeterminada, statusDoErroEdge, vereditoPainel,
} from '../importar-portal';
import { painelV2 } from './painel-portal-fixture';

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

  it('ok:true sem etapa concluido NÃO é sucesso (ausente ≠ sucesso) — e também não é "não importado"', () => {
    const r = interpretarRespostaImportacao({ ok: true }, '1');
    expect(r.tom).toBe('aviso');
    expect(r.titulo).toBe('Não sei se o pedido 1 entrou');
  });

  it('falha de leitura e de importação viram erro com o motivo da edge', () => {
    const l = interpretarRespostaImportacao({ ok: false, etapa: 'leitura', mensagem: 'portal fora do ar' }, '2140603');
    expect([l.tom, l.titulo, l.mensagem]).toEqual(['erro', 'Não consegui ler o pedido 2140603 no portal', 'portal fora do ar']);
    const i = interpretarRespostaImportacao({ ok: false, etapa: 'importacao', sqlstate: 'IP002', mensagem: 'sem de-para: X' }, '2140603');
    expect([i.tom, i.titulo, i.mensagem]).toEqual(['erro', 'Pedido 2140603 não foi importado', 'sem de-para: X']);
  });

  it('falha de leitura traz o trace como detalhe técnico; sucesso não traz', () => {
    const l = interpretarRespostaImportacao({ ok: false, etapa: 'leitura', mensagem: 'x', trace: [{ step: 'consulta_lida', n_linhas: 0 }] }, '1');
    expect(l.detalheTecnico).toContain('consulta_lida');
    expect(interpretarRespostaImportacao({ ok: true, etapa: 'concluido', pedido_id: 1 }, '1').detalheTecnico).toBeNull();
  });

  it('resposta 2xx nula/lixo é INDETERMINADA (pode ter gravado), não erro (Codex C1)', () => {
    for (const lixo of [null, 'x', [], 42]) {
      const r = interpretarRespostaImportacao(lixo, '1');
      expect(r.tom).toBe('aviso');
      expect(r.titulo).toBe('Não sei se o pedido 1 entrou');
    }
  });
});

describe('pontos cegos Onda 2 (2026-11-07)', () => {
  it('pedido gravado + recusa no re-disparo: aviso "está no app — falta resolver", nunca "não foi importado"', () => {
    for (const etapa of ['leitura', 'importacao'] as const) {
      const r = interpretarRespostaImportacao({ ok: false, etapa, ja_existia: true, pedido_id: 77, mensagem: 'cancelado no portal' }, '2140501');
      expect(r.tom).toBe('aviso');
      expect(r.titulo).toBe('Pedido 2140501 está no app (#77) — falta resolver');
      expect(r.titulo).not.toMatch(/não foi importado/);
      expect(r.pedidoId).toBe(77);
      expect(r.mensagem).toBe('cancelado no portal');
    }
  });
  it('PO lançado à mão no Omie: aviso com o pedido (abre pelo link), não erro', () => {
    const r = interpretarRespostaImportacao({ ok: false, etapa: 'importacao', ja_existia: true, pedido_id: 9, motivo: 'po_manual_no_omie', omie_numero: '1278' }, '7000001');
    expect(r.tom).toBe('aviso');
    expect(r.pedidoId).toBe(9);
  });
  it('controle: recusa SEM pedido gravado continua erro "não foi importado"', () => {
    const r = interpretarRespostaImportacao({ ok: false, etapa: 'importacao', sqlstate: 'CP006', mensagem: 'x' }, '5');
    expect(r.tom).toBe('erro');
    expect(r.titulo).toBe('Pedido 5 não foi importado');
  });
});

describe('PROTOCOLO_PORTAL_RE', () => {
  it('só dígitos, 3 a 12', () => {
    expect(['2140603', '123', '123456789012'].every((s) => PROTOCOLO_PORTAL_RE.test(s))).toBe(true);
    expect(['12', '21406O3', ' 2140603', '1234567890123', ''].some((s) => PROTOCOLO_PORTAL_RE.test(s))).toBe(false);
  });
});

describe('revisão Fable+Codex (2026-11)', () => {
  it('SKU sem de-para (IP002) traz a ação de abrir o Mapeamento de SKU; recusa sem tela não inventa link', () => {
    const r = interpretarRespostaImportacao({ ok: false, etapa: 'importacao', sqlstate: 'IP002', mensagem: 'x' }, '1');
    expect(r.acao).toEqual({ rotulo: 'Abrir Mapeamento de SKU', href: '/admin/sku-mapeamento' });
    expect(interpretarRespostaImportacao({ ok: false, etapa: 'importacao', sqlstate: 'CP006', mensagem: 'x' }, '1').acao).toBeNull();
  });

  it('condição de pagamento gravada aparece no resultado', () => {
    const r = interpretarRespostaImportacao({ ok: true, etapa: 'concluido', pedido_id: 1, condicao: 'A07 · Para 7 dias' }, '1');
    expect(r.condicao).toBe('A07 · Para 7 dias');
  });

  it('gravado sem PO confirmado continua aviso COM o pedido (nunca "não foi importado")', () => {
    const r = interpretarRespostaImportacao({ ok: false, etapa: 'omie', pedido_id: 3644, mensagem: 'gravado' }, '2141068');
    expect([r.tom, r.pedidoId]).toEqual(['aviso', 3644]);
  });

  it('resposta sem corpo é INDETERMINADA: aviso, manda reimportar, proíbe lançar à mão', () => {
    const r = respostaIndeterminada('2141068', 'timeout');
    expect(r.tom).toBe('aviso');
    expect(r.titulo).toBe('Não sei se o pedido 2141068 entrou');
    expect(r.mensagem).toContain('Importar de novo');
    expect(r.mensagem).toContain('Não lance à mão no Omie');
  });

  it('link do pedido usa o deep link de Gerir pedidos', () => {
    expect(linkDoPedido(3644)).toBe('/admin/reposicao/pedidos?id=3644');
  });
});

describe('corpoDoErroEdge (Codex P2, 2026-11-07)', () => {
  it('lê o corpo de um 500 com pedido_id; a tela mostra o pedido, não "não foi importado"', async () => {
    const err = { context: new Response(JSON.stringify({ ok: false, etapa: 'leitura', pedido_id: 12, ja_existia: true, mensagem: 'Configuração ausente' }), { status: 500 }) };
    const corpo = await corpoDoErroEdge(err);
    expect(corpo?.pedido_id).toBe(12);
    const r = interpretarErroEdge(corpo, 500, null, '2140603', 'x');
    expect(r.tom).toBe('aviso');
    expect(r.pedidoId).toBe(12);
  });
  it('sem contexto, corpo não-JSON ou lista: null', async () => {
    expect(await corpoDoErroEdge(new Error('x'))).toBeNull();
    expect(await corpoDoErroEdge({ context: new Response('<html>', { status: 502 }) })).toBeNull();
    expect(await corpoDoErroEdge({ context: new Response('[1]', { status: 500 }) })).toBeNull();
  });
});

describe('revisão 2, B7: sem desfecho reconhecido é "não sei se entrou", nunca "não foi importado"', () => {
  const INDETERMINADO = 'Não sei se o pedido 9 entrou';
  it('objeto incompleto em 2xx', () => {
    for (const incompleto of [{}, { ok: false }, { mensagem: 'x' }, { etapa: 'outra', ok: false }, { ok: false, etapa: 'importacao' }, { ok: false, etapa: 'importacao', mensagem: 'Resposta inesperada da importação: {}' }]) {
      const r = interpretarRespostaImportacao(incompleto, '9');
      expect([r.tom, r.titulo]).toEqual(['aviso', INDETERMINADO]);
      expect(r.titulo).not.toMatch(/não foi importado/);
    }
  });
  it('500 com {"error": …} ou etapa importacao sem SQLSTATE: indeterminado (mensagem de infraestrutura não prova rollback)', () => {
    for (const corpo of [{ error: 'Internal' }, { ok: false, etapa: 'importacao', mensagem: 'erro inesperado' }]) {
      const r = interpretarErroEdge(corpo, 500, null, '9', 'Edge Function returned a non-2xx status code');
      expect([r.tom, r.titulo]).toEqual(['aviso', INDETERMINADO]);
    }
  });
  it('sem corpo: 5xx/sem status é indeterminado; 4xx com mensagem é recusa de entrada', () => {
    expect(interpretarErroEdge(null, 504, null, '9', 'timeout').titulo).toBe(INDETERMINADO);
    expect(interpretarErroEdge(null, null, null, '9', 'Failed to fetch').titulo).toBe(INDETERMINADO);
    const r = interpretarErroEdge(null, 401, 'JWT expirado', '9', 'x');
    expect([r.tom, r.titulo, r.mensagem]).toEqual(['erro', 'Pedido 9 não foi importado', 'JWT expirado']);
  });
  it('controle: 4xx com corpo de recusa de entrada e leitura que falhou continuam erro', () => {
    expect(interpretarErroEdge({ ok: false, mensagem: 'Número do pedido deve ter só dígitos (3 a 12).' }, 400, null, '9', 'x').tom).toBe('erro');
    expect(interpretarErroEdge({ ok: false, etapa: 'leitura', mensagem: 'login recusado' }, 500, null, '9', 'x').titulo).toBe('Não consegui ler o pedido 9 no portal');
  });
  it('status do erro sai do Response em error.context', () => {
    expect(statusDoErroEdge({ context: new Response('x', { status: 502 }) })).toBe(502);
    expect(statusDoErroEdge(new Error('x'))).toBeNull();
  });
});

describe('revisão 2, B8: situação lida e não gravada aparece', () => {
  it('situacao_gravada:"erro" vira aviso próprio, em qualquer tom', () => {
    const ok = interpretarRespostaImportacao({ ok: true, etapa: 'concluido', pedido_id: 1, situacao_portal: 'Aberto', situacao_gravada: 'erro' }, '1');
    expect(ok.tom).toBe('sucesso');
    expect(ok.avisoSituacao).toContain('"Aberto"');
    expect(ok.avisoSituacao).toContain('não foi gravada');
    const rec = interpretarRespostaImportacao({ ok: false, etapa: 'leitura', pedido_id: 2, situacao_gravada: 'erro' }, '2');
    expect(rec.avisoSituacao).not.toBeNull();
  });
  it('controle: aceita/nao_aceita/ilegivel/ausente não avisam', () => {
    for (const g of ['aceita', 'nao_aceita', 'ilegivel', undefined]) {
      expect(interpretarRespostaImportacao({ ok: true, etapa: 'concluido', pedido_id: 1, situacao_gravada: g }, '1').avisoSituacao).toBeNull();
    }
  });
});

describe('8.5: vários números de uma vez', () => {
  it('separa por espaço, vírgula, ponto e vírgula e linha; repetido conta uma vez, na ordem', () => {
    expect(lerNumerosPortal('2140603, 2140604\n2140605;2140603  2140606')).toEqual({
      validos: ['2140603', '2140604', '2140605', '2140606'], invalidos: [], excedentes: [],
    });
  });
  it('o que não é número do portal volta em invalidos (nada é chamado por ele)', () => {
    expect(lerNumerosPortal('2140603 12 1234567890123').invalidos).toEqual(['12', '1234567890123']);
  });
  it(`acima de ${MAX_NUMEROS_POR_VEZ} vai para excedentes, não some`, () => {
    const muitos = Array.from({ length: MAX_NUMEROS_POR_VEZ + 2 }, (_, i) => String(1000 + i)).join(' ');
    const r = lerNumerosPortal(muitos);
    expect([r.validos.length, r.excedentes]).toEqual([MAX_NUMEROS_POR_VEZ, ['1020', '1021']]);
  });
  it('vazio: nada', () => {
    expect(lerNumerosPortal('  \n ')).toEqual({ validos: [], invalidos: [], excedentes: [] });
  });
});

describe('normalizarPainel v2 (6.2: contrato rígido)', () => {
  it('lê listas, totais e rodada; descarta linha sem identidade', () => {
    const p = normalizarPainel(painelV2({
      pendencias: [{ protocolo: '2140762', mensagem: 'NCM sem alíquota', tentativas: 2, ultima_em: '2026-10-20T15:00:00Z' }, { mensagem: 'sem protocolo' }],
      total_pendencias: 1,
      sem_po: [{ pedido_id: 3700, protocolo: '2141500', status: 'falha_envio', origem: 'app', desde: '2026-11-07T10:00:00Z', pendencia_mensagem: 'disparo falhou', pendencia_tentativas: 3 }, { protocolo: 'x' }],
      total_sem_po: 1,
    }));
    expect(p.pendencias).toEqual([{ protocolo: '2140762', mensagem: 'NCM sem alíquota', tentativas: 2, ultimaEm: '2026-10-20T15:00:00Z' }]);
    expect(p.semPo).toEqual([expect.objectContaining({ pedidoId: 3700, origem: 'app', pendenciaMensagem: 'disparo falhou', pendenciaTentativas: 3 })]);
    expect(p.rodada.efetiva?.lidos).toBe(7);
  });
  it('{} , versão 1 (só as 3 listas), total ausente e não-objeto LANÇAM — nunca "nada pendente"', () => {
    expect(() => normalizarPainel({})).toThrow(/ilegível/);
    expect(() => normalizarPainel({ pendencias: [], sem_po: [], importados: [] })).toThrow(/versão/);
    const semTotal = painelV2(); delete (semTotal as Record<string, unknown>).total_sem_po;
    expect(() => normalizarPainel(semTotal)).toThrow(/total_sem_po/);
    const semLista = painelV2(); delete (semLista as Record<string, unknown>).cancelado_com_po;
    expect(() => normalizarPainel(semLista)).toThrow(/cancelado_com_po/);
    expect(() => normalizarPainel(painelV2({ rodada: {} }))).toThrow(/rodada/);
    expect(() => normalizarPainel(null)).toThrow(/ilegível/);
    expect(() => normalizarPainel([])).toThrow(/ilegível/);
  });
});

describe('vereditoPainel (6.1: "nada pendente" só com prova)', () => {
  const v = (over: Record<string, unknown> = {}) => vereditoPainel(normalizarPainel(painelV2(over)));
  it('rodada efetiva em dia, sem espera, sem pendência: ok', () => {
    expect(v().tom).toBe('ok');
  });
  it('sem rodada efetiva, fora do dia ou com a última falhando depois: sem_prova (nunca ok)', () => {
    expect(v({ rodada: { em_dia: false, ultima_efetiva: null, ultima: null } }).tom).toBe('sem_prova');
    expect(v({ rodada: { ...painelV2().rodada as object, em_dia: false } }).tom).toBe('sem_prova');
    const falhou = v({ rodada: { ...painelV2().rodada as object, ultima: { em: '2026-11-09T20:30:00Z', status: 'erro', erro: 'login recusado' } } });
    expect([falhou.tom, falhou.motivo]).toEqual(['sem_prova', expect.stringContaining('falhou')]);
    // controle: erro ANTES da efetiva não derruba o veredito
    expect(v({ rodada: { ...painelV2().rodada as object, ultima: { em: '2026-11-07T20:30:00Z', status: 'erro' } } }).tom).toBe('ok');
  });
  it('rodada que não informou a espera (null) não vira zero: sem_prova', () => {
    const ef = { ...(painelV2().rodada as { ultima_efetiva: object }).ultima_efetiva, indeterminados: null };
    expect(v({ rodada: { ...painelV2().rodada as object, ultima_efetiva: ef } }).tom).toBe('sem_prova');
  });
  it('espera conhecida, aguardando disparo ou pendência: atenção', () => {
    const ef = { ...(painelV2().rodada as { ultima_efetiva: object }).ultima_efetiva, adiados: 2 };
    expect(v({ rodada: { ...painelV2().rodada as object, ultima_efetiva: ef } }).tom).toBe('atencao');
    expect(v({ aguardando_disparo: { total: 1, mais_antigo_em: null } }).tom).toBe('atencao');
    expect(v({ pendentes_unicos: 1 }).tom).toBe('atencao');
  });
  it('esperaDaRodada descreve só o que é > 0', () => {
    const ef = { ...(painelV2().rodada as { ultima_efetiva: object }).ultima_efetiva, adiados: 2, carencia: 1 };
    const e = esperaDaRodada(normalizarPainel(painelV2({ rodada: { ...painelV2().rodada as object, ultima_efetiva: ef } })));
    expect(e.total).toBe(3);
    expect(e.partes).toEqual(['1 em carência (esperando o espelho do Omie)', '2 adiado(s) por tempo']);
  });
});

describe('msAteReleituraPosCron (6.7)', () => {
  // SP = UTC−3. 12:30 SP = 15:30 UTC; a releitura é 7 min depois.
  it('antes do cron do meio-dia: relê às 12:37 SP', () => {
    expect(msAteReleituraPosCron(new Date('2026-11-09T15:00:00Z'))).toBe(37 * 60_000);
  });
  it('depois da última do dia (22:37 SP): a próxima é 12:37 do dia seguinte', () => {
    expect(msAteReleituraPosCron(new Date('2026-11-10T02:00:00Z'))).toBe((13 * 60 + 37) * 60_000);
  });
});
