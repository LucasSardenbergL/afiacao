import { describe, it, expect } from 'vitest';
import { acumularPiso, classificarPagina, lerNCodPed, PISO_ZERO, type PisoTotais } from './omie-pagina';

// Matriz COMPORTAMENTAL da classificação de página do PesquisarPedCompra (money-path, PR1 reconciliação de PO
// excluído no Omie). Cada caso aqui é um shape que um Codex challenge xhigh (v3.3→v3.8, 9 rodadas) provou que
// publicava sinal INVÁLIDO. Antes eram guardrails textuais (grep de nome) — que não pegam comportamento.
//
// Critério money-path: publicar sinal de run inválido envenena a base de verdade do PR2 (que decide QUEM provar
// por ID). Fail-closed: na dúvida, anomalia.

const pedido = (nCodPed: unknown) => ({ cabecalho_consulta: { nCodPed } });
const ctx = (over: Partial<{ pagina: number; idsVistos: Set<number>; piso: PisoTotais }> = {}) => ({
  pagina: over.pagina ?? 1,
  idsVistos: over.idsVistos ?? new Set<number>(),
  piso: over.piso ?? PISO_ZERO,
});

describe('acumularPiso — os totais do Omie são PISO (só crescem, nunca são apagados)', () => {
  it('acumula o MAIOR total declarado', () => {
    let piso = acumularPiso({ nTotalRegistros: 100, nTotalPaginas: 2 }, PISO_ZERO);
    piso = acumularPiso({ nTotalRegistros: 505, nTotalPaginas: 6 }, piso);
    expect(piso).toEqual({ registros: 505, paginas: 6 });
  });

  it('Codex #8: resposta terminal SEM totais NÃO apaga o piso declarado antes', () => {
    // pág1 declara 505/6; pág6 faulta sem totais → o piso tem de continuar 505/6 (senão o run "completo"
    // termina faltando POs e publica assim mesmo).
    const piso = acumularPiso({ nTotalRegistros: 505, nTotalPaginas: 6 }, PISO_ZERO);
    expect(acumularPiso({ faultstring: 'Não existem registros' }, piso)).toEqual({ registros: 505, paginas: 6 });
  });

  it('total MENOR não rebaixa o piso (sub-reporte do Omie não apaga o máximo já visto)', () => {
    const piso = acumularPiso({ nTotalRegistros: 500, nTotalPaginas: 5 }, PISO_ZERO);
    expect(acumularPiso({ nTotalRegistros: 10, nTotalPaginas: 1 }, piso)).toEqual({ registros: 500, paginas: 5 });
  });

  it('totais ausentes/ilegíveis mantêm o piso zero (empresa vazia legítima)', () => {
    expect(acumularPiso({}, PISO_ZERO)).toEqual({ registros: 0, paginas: 0 });
    expect(acumularPiso({ nTotalRegistros: 'x', nTotalPaginas: null }, PISO_ZERO)).toEqual({ registros: 0, paginas: 0 });
  });
});

describe('lerNCodPed — canônico: presente, inteiro SEGURO e positivo', () => {
  it('aceita número e string numérica', () => {
    expect(lerNCodPed(pedido(1073))).toBe(1073);
    expect(lerNCodPed(pedido('12101983534'))).toBe(12101983534);
  });

  it('aceita o fallback cabecalho.nCodPed', () => {
    expect(lerNCodPed({ cabecalho: { nCodPed: 55 } })).toBe(55);
  });

  it('rejeita ausente/vazio/ilegível', () => {
    expect(lerNCodPed(pedido(undefined))).toBeNull();
    expect(lerNCodPed(pedido(null))).toBeNull();
    expect(lerNCodPed(pedido(''))).toBeNull();
    expect(lerNCodPed(pedido('abc'))).toBeNull();
    expect(lerNCodPed({})).toBeNull();
    expect(lerNCodPed(null)).toBeNull();
  });

  it('rejeita não-positivo e INSEGURO (>2^53 arredondaria → bigint errado no sinal)', () => {
    expect(lerNCodPed(pedido(0))).toBeNull();
    expect(lerNCodPed(pedido(-5))).toBeNull();
    expect(lerNCodPed(pedido('9007199254740993'))).toBeNull(); // 2^53+1
  });

  it('Codex v3.5: NÃO cai na coerção do Number (true→1, "1e3"→1000, [5]→5, " 7 "→7)', () => {
    // um ID ERRADO entrando no sinal é pior que nenhum: o PO real fica "não visto" e o forjado vira "visto".
    expect(lerNCodPed(pedido(true))).toBeNull();
    expect(lerNCodPed(pedido('1e3'))).toBeNull();
    expect(lerNCodPed(pedido([5]))).toBeNull();
    expect(lerNCodPed(pedido(' 7 '))).toBeNull();
    expect(lerNCodPed(pedido('0x10'))).toBeNull();
    expect(lerNCodPed(pedido(1.5))).toBeNull();
  });
});

describe('classificarPagina — nPagina declarada × solicitada (Codex #9 P1)', () => {
  it('resposta STALE/misrouted (nPagina 3 quando pedimos a 2) é anomalia, não fim', () => {
    const r = classificarPagina({ nPagina: 3, pedidos_pesquisa: [] }, ctx({ pagina: 2 }));
    expect(r.tipo).toBe('anomalia');
  });

  it('nPagina ausente é tolerado (nem toda resposta traz)', () => {
    expect(classificarPagina({ pedidos_pesquisa: [] }, ctx({ pagina: 2 })).tipo).toBe('fim');
  });

  it('nPagina igual à solicitada segue o fluxo normal', () => {
    expect(classificarPagina({ nPagina: 2, pedidos_pesquisa: [] }, ctx({ pagina: 2 })).tipo).toBe('fim');
  });
});

describe('classificarPagina — fault (Codex #5/#7/#8/#9)', () => {
  it('fault "não existem registros" + piso zero = FIM legítimo (empresa vazia)', () => {
    expect(classificarPagina({ faultstring: 'Não existem registros para a página [1]' }, ctx()).tipo).toBe('fim');
  });

  it('Codex #8: fault terminal que CONTRADIZ o piso é truncamento, não fim', () => {
    // {faultstring:"sem registros", nTotalRegistros:500} na página 1 → ids=0 publicaria marcador VAZIO válido.
    const r = classificarPagina(
      { faultstring: 'Não existem registros', nTotalRegistros: 500, nTotalPaginas: 5 },
      ctx({ piso: { registros: 500, paginas: 5 } }),
    );
    expect(r.tipo).toBe('anomalia');
  });

  it('Codex #9: fault terminal com PAYLOAD de pedidos se contradiz → anomalia', () => {
    const r = classificarPagina(
      { faultcode: '5113', faultstring: 'Não existem registros para a página [1]', pedidos_pesquisa: [pedido(123)] },
      ctx(),
    );
    expect(r.tipo).toBe('anomalia');
  });

  it('Codex #9: fault terminal com alias TORTO → anomalia (não engole o fail-closed)', () => {
    const r = classificarPagina(
      { faultstring: 'Não existem registros', pedidos_pesquisa: '', pedido_compra_produto: [] },
      ctx(),
    );
    expect(r.tipo).toBe('anomalia');
  });

  it('Codex #5: faultcode SEM faultstring (HTTP 200) é erro real → anomalia', () => {
    const r = classificarPagina({ faultcode: 'SOAP-ENV:Server-500', pedidos_pesquisa: [] }, ctx());
    expect(r.tipo).toBe('anomalia');
  });

  it('fault genérico → anomalia', () => {
    expect(classificarPagina({ faultstring: 'Erro interno' }, ctx()).tipo).toBe('anomalia');
  });
});

describe('classificarPagina — shape/aliases (Codex #4/#5/#6)', () => {
  it('2xx não-JSON ({raw}) → anomalia (não vira [] → fim)', () => {
    expect(classificarPagina({} as never, ctx()).tipo).toBe('anomalia');
  });

  it('alias em tipo CONFLITANTE (pedidos_pesquisa:"") → anomalia', () => {
    const r = classificarPagina({ pedidos_pesquisa: '', pedido_compra_produto: [pedido(1)] }, ctx());
    expect(r.tipo).toBe('anomalia');
  });

  it('DUAS listas array (uma vazia, outra cheia) → anomalia (antes pegava a 1ª = vazia → fim espúrio)', () => {
    const r = classificarPagina({ pedidos_pesquisa: [], pedido_compra_produto: [pedido(7)] }, ctx());
    expect(r.tipo).toBe('anomalia');
  });

  it('exatamente 1 lista com dados → dados', () => {
    const r = classificarPagina({ pedidos_pesquisa: [pedido(1073), pedido(1115)] }, ctx());
    expect(r).toMatchObject({ tipo: 'dados', ids: [1073, 1115] });
  });
});

describe('classificarPagina — lista vazia × piso (Codex #7)', () => {
  it('vazia com piso zero = FIM (empresa vazia legítima)', () => {
    expect(classificarPagina({ pedidos_pesquisa: [] }, ctx()).tipo).toBe('fim');
  });

  it('vazia que contradiz nTotalRegistros → anomalia', () => {
    const r = classificarPagina({ pedidos_pesquisa: [] }, ctx({ piso: { registros: 500, paginas: 0 } }));
    expect(r.tipo).toBe('anomalia');
  });

  it('vazia numa página que o Omie declarou existir → anomalia', () => {
    const r = classificarPagina({ pedidos_pesquisa: [] }, ctx({ pagina: 3, piso: { registros: 0, paginas: 5 } }));
    expect(r.tipo).toBe('anomalia');
  });

  it('vazia COERENTE (todos os registros já vistos, além da última página declarada) = FIM', () => {
    const r = classificarPagina(
      { pedidos_pesquisa: [] },
      ctx({ pagina: 6, idsVistos: new Set([1, 2, 3]), piso: { registros: 3, paginas: 5 } }),
    );
    expect(r.tipo).toBe('fim');
  });
});

describe('classificarPagina — IDs canônicos e sobreposição (Codex #9 P1)', () => {
  it('pedido sem nCodPed canônico invalida a coleta', () => {
    expect(classificarPagina({ pedidos_pesquisa: [pedido(1), pedido(null)] }, ctx()).tipo).toBe('anomalia');
  });

  it('nCodPed INSEGURO (>2^53) invalida a coleta', () => {
    expect(classificarPagina({ pedidos_pesquisa: [pedido('9007199254740993')] }, ctx()).tipo).toBe('anomalia');
  });

  it('ID repetido de PÁGINA ANTERIOR → anomalia (o Set deduplicaria em silêncio e um PO sumiria)', () => {
    const r = classificarPagina({ pedidos_pesquisa: [pedido(100)] }, ctx({ pagina: 2, idsVistos: new Set([100]) }));
    expect(r.tipo).toBe('anomalia');
  });

  it('ID duplicado na MESMA página → anomalia', () => {
    expect(classificarPagina({ pedidos_pesquisa: [pedido(5), pedido(5)] }, ctx()).tipo).toBe('anomalia');
  });
});

describe('INVARIANTE-MOR: o piso NUNCA é teto (o Omie SUB-REPORTA — #979/#1009)', () => {
  it('página CHEIA além do nTotalPaginas declarado segue como dados (não para de paginar)', () => {
    // Omie declara 1 página, mas a página 3 vem cheia (sub-reporte). Tem de continuar coletando.
    const r = classificarPagina(
      { nTotalPaginas: 1, nTotalRegistros: 100, pedidos_pesquisa: [pedido(777)] },
      ctx({ pagina: 3, idsVistos: new Set([1, 2]), piso: { registros: 100, paginas: 1 } }),
    );
    expect(r).toMatchObject({ tipo: 'dados', ids: [777] });
  });

  it('IDs reais ACIMA do total declarado não geram falso truncamento no fim', () => {
    // declarou 100 registros, coletamos 800 (sub-reporte): a vazia seguinte é fim legítimo, não anomalia.
    const idsVistos = new Set(Array.from({ length: 800 }, (_, i) => i + 1));
    const r = classificarPagina({ pedidos_pesquisa: [] }, ctx({ pagina: 9, idsVistos, piso: { registros: 100, paginas: 5 } }));
    expect(r.tipo).toBe('fim');
  });
});

describe('cenário end-to-end do Codex #9 (sobreposição parcial omitia o PO 101)', () => {
  it('universo 1..101 com pág2 repetindo o ID 100 → anomalia (antes: publicava sem o 101)', () => {
    // pág1: IDs 1..100, declara 100/1. O Set fica com 100 distintos.
    const piso1 = acumularPiso({ nTotalRegistros: 100, nTotalPaginas: 1 }, PISO_ZERO);
    const pag1 = classificarPagina(
      { nTotalRegistros: 100, nTotalPaginas: 1, pedidos_pesquisa: Array.from({ length: 100 }, (_, i) => pedido(i + 1)) },
      ctx({ pagina: 1, piso: piso1 }),
    );
    expect(pag1.tipo).toBe('dados');
    const idsVistos = new Set((pag1 as { ids: number[] }).ids);
    expect(idsVistos.size).toBe(100);

    // pág2 devolve [100] — já visto. Antes: o Set deduplicava, terminava com 100 distintos, 100 > 100 era
    // false e o fim passava PUBLICANDO sem o PO 101. Agora a sobreposição é fatal.
    const pag2 = classificarPagina({ pedidos_pesquisa: [pedido(100)] }, ctx({ pagina: 2, idsVistos, piso: piso1 }));
    expect(pag2.tipo).toBe('anomalia');
  });
});
