import { describe, it, expect } from 'vitest';
import type { CompradorSugerido } from '@/lib/venda-cliente/sugestoes';
import {
  cobrancasDoDia,
  recomprasDoDia,
  montarCombinado,
  textoCombinado,
  clientesEsfriando,
  esfriandoDaVendedora,
} from '../combinado-dia';

/** Item da fila de cobrança, derivado da assinatura do módulo (sem importar de outro módulo no teste). */
type FilaItem = Parameters<typeof cobrancasDoDia>[0][number];

const HOJE = '2026-11-20';
const REGINA = 'R';

function fila(over: Partial<FilaItem>): FilaItem {
  return {
    company: 'oben', omieCodigoCliente: 1, nomeCliente: 'ACME', saldoVencido: 1000, nVencidas: 1, diasVencidoMax: 10,
    faixa: '<=45d', donaUserId: REGINA, donaNome: 'Regina', casoId: null, estado: 'a_contatar', proximoContatoEm: null,
    notaAtual: null, atualizadoEm: null, promessaId: null, promessaData: null, promessaValor: null, promessaSituacao: null,
    saldoInicialCoorte: null, nTitulosCoorte: null, saldoAtualCoorte: null, coorteCorteEm: null, ultimoContatoEm: null,
    nContatos: 0, podeAgir: true, podeQuitar: false,
    ...over,
  };
}

/** `valor` é dividido entre os itens; `null` deixa o 1º item sem preço. */
function comprador(id: string, valor: number | null, nItens = 1, tipo = 'recompra'): CompradorSugerido {
  return {
    compradorId: id, nome: `Cliente ${id}`, telefone: null, motivoEntrada: 'recompra', valorRefTotal: 999999,
    sugestoes: Array.from({ length: nItens }, (_, k) => ({
      id: `${id}-${k}`, tipo, empresa: 'colacor', omieCodigoProduto: k, descricao: k === 0 ? 'Seladora PU' : `Item ${k}`,
      familia: null, qtdRef: 1, valorRef: valor == null ? (k === 0 ? null : 10) : valor / nItens, precoAlvo: null, cadenciaDias: 30,
    })) as CompradorSugerido['sugestoes'],
  };
}

describe('cobrancasDoDia', () => {
  it('[CB-FILTRO] só da vendedora, ≤45d, cobrável, saldo > 0, sem promessa aberta, contato não adiado; saldo desc', () => {
    const r = cobrancasDoDia(
      [
        fila({ omieCodigoCliente: 1, saldoVencido: 500 }),
        fila({ omieCodigoCliente: 2, saldoVencido: 2000, estado: 'contatado' }),
        fila({ omieCodigoCliente: 3, donaUserId: 'T' }), // outra dona
        fila({ omieCodigoCliente: 4, faixa: '46-90d' }), // velho demais para o combinado
        fila({ omieCodigoCliente: 5, estado: 'promessa' }),
        fila({ omieCodigoCliente: 6, promessaSituacao: 'aberta', estado: 'contatado' }),
        fila({ omieCodigoCliente: 7, saldoVencido: null }), // saldo desconhecido não vira R$ 0 a cobrar
        fila({ omieCodigoCliente: 8, proximoContatoEm: '2026-11-25T12:00:00Z' }), // agendado para depois
        fila({ omieCodigoCliente: 9, proximoContatoEm: '2026-11-20T09:00:00Z', saldoVencido: 700 }), // é hoje
      ],
      REGINA,
      HOJE,
    );
    expect(r.map((f) => f.omieCodigoCliente)).toEqual([2, 9, 1]);
  });
});

describe('montarCombinado', () => {
  it('[CB-ALTERNA] cobrança, recompra, cobrança — no máximo 3', () => {
    const r = montarCombinado(
      [fila({ omieCodigoCliente: 1 }), fila({ omieCodigoCliente: 2 }), fila({ omieCodigoCliente: 3 })],
      recomprasDoDia([comprador('b', 800), comprador('a', 900)]),
    );
    expect(r.map((x) => `${x.tipo}:${x.clienteRef}`)).toEqual(['cobranca:1', 'recompra:a', 'cobranca:2']);
  });

  it('[CB-COMPLETA] uma lista acabou → a outra completa; as duas vazias → vazio', () => {
    expect(montarCombinado([], [comprador('a', 1), comprador('b', 2), comprador('c', 3), comprador('d', 4)]).length).toBe(3);
    expect(montarCombinado([fila({})], []).map((x) => x.tipo)).toEqual(['cobranca']);
    expect(montarCombinado([], [])).toEqual([]);
  });

  it('[CB-SEM-VALOR] recompra sem valor de referência vai ao fim e o texto diz "valor a confirmar", nunca R$ 0', () => {
    const ord = recomprasDoDia([
      comprador('semvalor', null, 2),
      comprador('caro', 5000),
      comprador('vazio', 10, 0),
      comprador('complemento', 99999, 1, 'complemento'), // não é recompra atrasada
    ]);
    expect(ord.map((c) => c.compradorId)).toEqual(['caro', 'semvalor']);
    expect(ord[0].valorRefTotal).toBe(5000); // recalculado sobre a recompra, não o total da RPC
    const it = montarCombinado([], [ord[1]])[0];
    expect(it.valor).toBeNull();
    expect(it.detalhe).toContain('valor a confirmar');
    expect(it.detalhe).not.toMatch(/R\$\s?0,00/);
  });
});

describe('clientesEsfriando', () => {
  const ped = (c: string | null, dia: string | null, total: number | null = 100, account = 'oben') => ({
    customer_user_id: c, order_date_kpi: dia, total, account,
  });

  it('[ES-JANELA] comprou no último ano e a última compra tem mais de 90 dias; ativo e velho demais ficam fora', () => {
    const r = clientesEsfriando(
      [
        ped('esfriou', '2026-03-10', 300), ped('esfriou', '2026-08-01', 200, 'colacor'), // última 01/08 = 111 dias
        ped('ativo', '2026-05-01'), ped('ativo', '2026-10-01'), // comprou há 50 dias
        ped('limite', '2026-08-22'), // exatamente 90 dias: ainda não esfriou
        ped('antigo', '2025-11-19'), // fora dos 12 meses
        ped(null, '2026-04-01'), ped('semdata', null),
      ],
      HOJE,
    );
    expect(r).toEqual([
      { clienteId: 'esfriou', empresa: 'colacor', ultimaCompra: '2026-08-01', diasSemCompra: 111, receita12m: 500 },
    ]);
  });

  it('[ES-AUSENTE] pedido sem total deixa a receita null (nunca soma como zero) e vai ao fim', () => {
    const r = clientesEsfriando(
      [ped('a', '2026-06-01', null), ped('a', '2026-06-02', 900), ped('b', '2026-06-01', 50), ped('c', '2026-06-01', 700)],
      HOJE,
    );
    expect(r.map((x) => [x.clienteId, x.receita12m])).toEqual([['c', 700], ['b', 50], ['a', null]]);
  });

  it('[ES-DONO] só a carteira da vendedora e sem quem já está na recompra dela', () => {
    const lista = clientesEsfriando([ped('x', '2026-06-01'), ped('y', '2026-06-01'), ped('z', '2026-06-01')], HOJE);
    const donos = new Map([['x', REGINA], ['y', REGINA], ['z', 'OUTRA']]);
    expect(esfriandoDaVendedora(lista, donos, REGINA, new Set(['y'])).map((c) => c.clienteId)).toEqual(['x']);
  });
});

describe('montarCombinado com esfriando', () => {
  const esf = (id: string, receita: number | null) => ({
    clienteId: id, empresa: 'oben', ultimaCompra: '2026-08-01', diasSemCompra: 111, receita12m: receita,
  });

  it('[CB-RODIZIO] cobrança → recompra → esfriando; fonte vazia passa a vez', () => {
    const tres = montarCombinado([fila({ omieCodigoCliente: 1 })], recomprasDoDia([comprador('a', 900)]), [esf('e', 5000)]);
    expect(tres.map((x) => `${x.tipo}:${x.clienteRef}`)).toEqual(['cobranca:1', 'recompra:a', 'esfriando:e']);
    const semRecompra = montarCombinado([fila({ omieCodigoCliente: 1 }), fila({ omieCodigoCliente: 2 })], [], [esf('e', 1)]);
    expect(semRecompra.map((x) => x.tipo)).toEqual(['cobranca', 'esfriando', 'cobranca']);
    expect(montarCombinado([], [], [esf('a', 1), esf('b', 1), esf('c', 1), esf('d', 1)]).length).toBe(3);
  });

  it('[CB-ESF-TEXTO] nome do cadastro, dias sem comprar e o comprado em 12 meses; sem receita → "a confirmar", nunca R$ 0', () => {
    const [comValor] = montarCombinado([], [], [esf('e', 12452)], new Map([['e', 'Marcenaria X']]));
    expect(comValor.nome).toBe('Marcenaria X');
    expect(comValor.detalhe).toMatch(/^esfriando: sem comprar há 111 dias · comprou R\$\s?12\.452,00 em 12 meses$/);
    const [semValor] = montarCombinado([], [], [esf('f', null)]);
    expect(semValor.valor).toBeNull();
    expect(semValor.nome).toBe('cliente sem nome no cadastro');
    expect(semValor.detalhe).toContain('a confirmar');
    expect(semValor.detalhe).not.toMatch(/R\$\s?0,00/);
  });
});

describe('textoCombinado', () => {
  it('[CB-TEXTO] primeiro nome, data, itens numerados com empresa e o pedido de desfecho', () => {
    const itens = montarCombinado([fila({ nomeCliente: 'ACME', saldoVencido: 1500, diasVencidoMax: 12 })], recomprasDoDia([comprador('a', 900, 3)]));
    const t = textoCombinado({
      vendedora: 'REGINA CELIA DE CASTRO',
      hoje: HOJE,
      itens,
      nomeEmpresa: (c) => (c === 'oben' ? 'Oben' : 'Colacor'),
      linkApp: 'https://app/meu-dia',
    });
    expect(t).toContain('Combinado de hoje (20/11), REGINA:');
    expect(t).toMatch(/1\. ACME \(Oben\): cobrar R\$\s?1\.500,00 vencido, até 12 dias/);
    expect(t).toMatch(/2\. Cliente a \(Colacor\): recompra atrasada: Seladora PU e mais 2 itens · ref\. R\$\s?900,00/);
    expect(t).toContain('Me devolve o desfecho');
    expect(t).toContain('https://app/meu-dia');
  });
});
