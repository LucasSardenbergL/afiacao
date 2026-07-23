import { describe, it, expect } from 'vitest';
import { coletarPaginado, type BuscarPagina } from '../rpcPaginada';

/**
 * Fonte falsa que devolve `total` linhas numeradas, respeitando o intervalo FECHADO [de, ate] do
 * `.range()`. Registra os intervalos pedidos para que os testes possam afirmar sobre o off-by-one,
 * que é exatamente onde este tipo de bug mora.
 */
function fonteFake(total: number) {
  const pedidos: Array<[number, number]> = [];
  const buscar: BuscarPagina<{ i: number }> = async (de, ate) => {
    pedidos.push([de, ate]);
    const linhas = [];
    for (let i = de; i <= ate && i < total; i++) linhas.push({ i });
    return { data: linhas, error: null };
  };
  return { buscar, pedidos };
}

describe('coletarPaginado', () => {
  it('traz TODAS as linhas quando o total passa de uma página — o bug dos 214 clientes', async () => {
    // 1.214 é o número real de clientes com pedido em prod (2026-07-20). Com uma só requisição,
    // 214 sumiam em silêncio.
    const { buscar, pedidos } = fonteFake(1214);
    const linhas = await coletarPaginado(buscar, { tamanhoPagina: 1000 });

    expect(linhas).toHaveLength(1214);
    expect(pedidos).toEqual([[0, 999], [1000, 1999]]);
  });

  it('não repete nem pula linha entre páginas', async () => {
    const { buscar } = fonteFake(1214);
    const linhas = await coletarPaginado(buscar, { tamanhoPagina: 1000 });

    const vistos = new Set(linhas.map(l => l.i));
    expect(vistos.size).toBe(1214);            // sem duplicata
    expect(Math.min(...vistos)).toBe(0);
    expect(Math.max(...vistos)).toBe(1213);    // sem buraco nas pontas
  });

  it('pede uma página a mais quando o total é múltiplo exato do tamanho', async () => {
    // Página cheia é ambígua: pode ser a última exata. Parar aqui truncaria em 1.000 quem tem
    // exatamente 1.000 — o caso mais traiçoeiro porque não deixa resto para denunciar.
    const { buscar, pedidos } = fonteFake(1000);
    const linhas = await coletarPaginado(buscar, { tamanhoPagina: 1000 });

    expect(linhas).toHaveLength(1000);
    expect(pedidos).toEqual([[0, 999], [1000, 1999]]);
  });

  it('resolve em uma requisição quando cabe numa página', async () => {
    const { buscar, pedidos } = fonteFake(7);
    const linhas = await coletarPaginado(buscar, { tamanhoPagina: 1000 });

    expect(linhas).toHaveLength(7);
    expect(pedidos).toHaveLength(1);
  });

  it('devolve vazio sem estourar quando a fonte não tem linha', async () => {
    const { buscar } = fonteFake(0);
    await expect(coletarPaginado(buscar)).resolves.toEqual([]);
  });

  it('LANÇA em data null sem error — resposta malformada não é fim da fonte', async () => {
    // REVERSÃO do assert que canonizava o bug (money-path §6: "teste pode CANONIZAR o
    // defeito"): o `?? []` convertia `{data:null, error:null}` em página vazia → EOF falso.
    // Fim legítimo é `data: []` (coberto pelo teste da fonte sem linha, acima). Mesmo
    // contrato do fetchAllPages (@/lib/postgrest) e do buscarTodasPaginas pós-#1564.
    const buscar: BuscarPagina<{ i: number }> = async () => ({ data: null, error: null });
    await expect(coletarPaginado(buscar, { rotulo: 'rpc_malformada' }))
      .rejects.toThrow('rpc_malformada pág.0: data null sem error');
  });

  it('data null sem error no MEIO lança e não devolve o acumulado parcial', async () => {
    // Página 0 cheia + página 1 malformada: o bug antigo devolveria as 1000 primeiras como
    // se fossem a fonte inteira — indistinguível de uma fonte que de fato tem 1000.
    const buscar: BuscarPagina<{ i: number }> = async (de) =>
      de === 0
        ? { data: Array.from({ length: 1000 }, (_, i) => ({ i })), error: null }
        : { data: null, error: null };

    await expect(coletarPaginado(buscar, { tamanhoPagina: 1000, rotulo: 'rpc_meio' }))
      .rejects.toThrow('rpc_meio pág.1: data null sem error');
  });

  it('LANÇA quando uma página falha — nunca devolve resultado parcial como se fosse completo', async () => {
    // O ponto money-path: meia base lida é PIOR que erro, porque parece sucesso. Quem chama
    // degrada explicitamente (congela o valor anterior); silenciar aqui tiraria essa escolha dele.
    const buscar: BuscarPagina<{ i: number }> = async (de) =>
      de === 0
        ? { data: Array.from({ length: 1000 }, (_, i) => ({ i })), error: null }
        : { data: null, error: { message: 'timeout' } };

    await expect(coletarPaginado(buscar, { tamanhoPagina: 1000, rotulo: 'rpc_x' }))
      .rejects.toThrow('rpc_x pág.1: timeout');
  });

  it('aborta em vez de rodar para sempre se a fonte só devolve página cheia', async () => {
    // Ordem instável ou junção cartesiana fariam isto. Falhar alto > consumir a memória do worker.
    const buscar: BuscarPagina<{ i: number }> = async () => ({
      data: Array.from({ length: 10 }, (_, i) => ({ i })),
      error: null,
    });

    await expect(coletarPaginado(buscar, { tamanhoPagina: 10, maxPaginas: 3, rotulo: 'rpc_loop' }))
      .rejects.toThrow('rpc_loop: mais de 30 linhas — abortado por segurança');
  });

  it('rejeita tamanhoPagina inválido em vez de entrar em loop', async () => {
    const { buscar } = fonteFake(5);
    await expect(coletarPaginado(buscar, { tamanhoPagina: 0 })).rejects.toThrow('tamanhoPagina');
  });
});
