import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Contrato do gerarFilaConciliacao (botão "Gerar Fila" de /financeiro/conciliacao) — money-path.
 *
 * `fin_movimentacoes` guarda o MESMO pagamento do Omie sob duas óticas (`categoria_descricao`):
 * `CONTA_A_*` = o lançamento do TÍTULO, `CONTA_CORRENTE_*` = o lançamento no BANCO — e ainda
 * PREVISÕES (`PREVISAO_*`). Conciliação é extrato contra título: a pergunta é "cada movimento
 * do BANCO está explicado?", então só a ótica bancária entra na fila. Sem o filtro, o mesmo
 * pagamento virava dois itens do mesmo título — e a linha da ótica do título casa com o próprio
 * título por construção (falso "conciliado"), ou vira "divergência" quando o título está aberto.
 * Medido na PROD em 2026-09-10 (simulação sobre a população): 56.962 itens sem filtro × 31.160
 * com a ótica bancária.
 *
 * DEFESA — hoje inerte: `fin_conciliacao` nunca teve uma linha e `fin_permissoes` está vazia,
 * então a RLS recusa toda gravação vinda do app. Por isso o contrato também cobre a FALHA de
 * gravação: antes ela era engolida e o toast dizia "0 itens gerados".
 *
 * O mock reproduz o PostgREST no que importa aqui: filtros valem sobre a linha inteira, mas só
 * as colunas do `.select()` voltam. Um filtro de ótica feito em JS sobre coluna não selecionada
 * ZERA a fila — a armadilha que o mock antigo do getFluxoCaixa aprovava.
 */

type Row = Record<string, unknown>;
type Erro = { message: string; code?: string };

const state: {
  db: Record<string, Row[]>;
  upserts: Row[];
  erroNaLeitura: Record<string, Erro | undefined>;
  erroNaGravacao: Erro | null;
} = { db: {}, upserts: [], erroNaLeitura: {}, erroNaGravacao: null };

/** LIKE do SQL: `%` = qualquer sequência, `_` = um caractere. */
const casaLike = (valor: unknown, padrao: string) =>
  typeof valor === 'string' &&
  new RegExp(`^${padrao.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`).test(valor);

function makeBuilder(tabela: string) {
  const filtros: Array<(r: Row) => boolean> = [];
  let colunas: string[] | null = null;
  let limite: number | null = null;
  const projetar = (r: Row): Row => {
    if (!colunas) return r;
    const out: Row = {};
    for (const c of colunas) if (c in r) out[c] = r[c];
    return out;
  };
  const builder = {
    select: (cols: string) => {
      colunas = cols.split(',').map((c) => c.trim()).filter(Boolean);
      return builder;
    },
    eq: (col: string, val: unknown) => {
      filtros.push((r) => r[col] === val);
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      filtros.push((r) => vals.includes(r[col]));
      return builder;
    },
    // Semântica SQL: NULL em `NOT LIKE`/`NOT IN` é desconhecido e a linha NÃO volta.
    not: (col: string, op: string, val: unknown) => {
      if (op === 'like') filtros.push((r) => r[col] != null && !casaLike(r[col], String(val)));
      else if (op === 'in') filtros.push((r) => r[col] != null && !(val as unknown[]).includes(r[col]));
      else throw new Error(`mock: operador .not('${op}') não suportado`);
      return builder;
    },
    limit: (n: number) => {
      limite = n;
      return builder;
    },
    upsert: (payload: Row) => ({
      then: (resolve: (v: { data: null; error: Erro | null }) => unknown, reject?: (e: unknown) => unknown) => {
        if (!state.erroNaGravacao) state.upserts.push({ tabela, ...payload });
        return Promise.resolve({ data: null, error: state.erroNaGravacao }).then(resolve, reject);
      },
    }),
    then: (resolve: (v: { data: Row[] | null; error: Erro | null }) => unknown, reject?: (e: unknown) => unknown) => {
      const erro = state.erroNaLeitura[tabela];
      if (erro) return Promise.resolve({ data: null, error: erro }).then(resolve, reject);
      const casadas = (state.db[tabela] ?? []).filter((r) => filtros.every((f) => f(r)));
      // PostgREST real: capa de 1.000 linhas por request.
      const rows = casadas.slice(0, Math.min(limite ?? 1000, 1000)).map(projetar);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (tabela: string) => makeBuilder(tabela) },
}));

import { gerarFilaConciliacao, resumirGeracaoConciliacao } from '@/services/financeiroConciliacao';

/** Movimento com TODAS as colunas que a PROD tem — a ótica inclusa (fixture sem ela é cega). */
const mov = (id: string, categoria_descricao: string | null, tipo: 'E' | 'S', valor: number, lanc: number | null, company = 'oben'): Row => ({
  id,
  company,
  omie_ncodcc: 10,
  data_movimento: '2026-09-01',
  valor,
  descricao: `${categoria_descricao} · ${id}`,
  tipo,
  omie_codigo_lancamento: lanc,
  conciliado: false,
  categoria_descricao,
});

function semear() {
  state.db = {
    fin_contas_receber: [
      { id: 'cr-1001', company: 'oben', omie_codigo_lancamento: 1001, valor_documento: 1000 },
      { id: 'cr-1003', company: 'oben', omie_codigo_lancamento: 1003, valor_documento: 1000 },
      { id: 'cr-1004', company: 'oben', omie_codigo_lancamento: 1004, valor_documento: 700 },
    ],
    fin_contas_pagar: [{ id: 'cp-2001', company: 'oben', omie_codigo_lancamento: 2001, valor_documento: 800 }],
    fin_movimentacoes: [
      // o mesmo recebimento nas duas óticas
      mov('m-titulo-1001', 'CONTA_A_RECEBER', 'E', 1000, 1001),
      mov('m-banco-1001', 'CONTA_CORRENTE_REC', 'E', 1000, 1001),
      // duas baixas PARCIAIS no banco (eventos distintos) + o resumo cumulativo do título
      mov('m-titulo-1003', 'CONTA_A_RECEBER', 'E', 1000, 1003),
      mov('m-banco-1003a', 'CONTA_CORRENTE_REC', 'E', 400, 1003),
      mov('m-banco-1003b', 'CONTA_CORRENTE_REC', 'E', 600, 1003),
      // PREVISÕES: tipo E, valor>0, título preenchido — e a de 700 casaria "conciliado" com cr-1004
      mov('m-prev-pv', 'PREVISAO_PEDIDO_VENDA', 'E', 700, 1004),
      mov('m-prev-os', 'PREVISAO_ORDEM_SERVICO', 'E', 300, 1005),
      // o mesmo pagamento nas duas óticas
      mov('m-banco-2001', 'CONTA_CORRENTE_PAG', 'S', 800, 2001),
      mov('m-titulo-2001', 'CONTA_A_PAGAR', 'S', 800, 2001),
      // extrato sem título (transferência/tarifa): É item de conciliação — é o que precisa de olho humano
      mov('m-banco-sem-titulo', 'CONTA_CORRENTE_REC', 'E', 250, null),
      // ótica ausente e ótica desconhecida com prefixo bancário: allowlist exata, ficam fora
      mov('m-otica-nula', null, 'E', 1000, 1001),
      mov('m-otica-nova', 'CONTA_CORRENTE_TRF', 'E', 90, null),
      // outra empresa
      mov('m-banco-colacor', 'CONTA_CORRENTE_REC', 'E', 1000, 1001, 'colacor'),
      // já conciliado: não volta para a fila (hoje a flag é sempre false na PROD — ver o service)
      { ...mov('m-banco-ja-conciliado', 'CONTA_CORRENTE_REC', 'E', 500, 1001), conciliado: true },
    ],
  };
}

const movIdsGravados = () => state.upserts.map((u) => u.mov_id).sort();
const item = (movId: string) => state.upserts.find((u) => u.mov_id === movId);

beforeEach(() => {
  state.upserts = [];
  state.erroNaLeitura = {};
  state.erroNaGravacao = null;
  semear();
});

describe('gerarFilaConciliacao — só a ótica BANCÁRIA vira item da fila', () => {
  it('gera um item por movimento do banco da empresa, e nenhum da ótica do título ou de previsão', async () => {
    const r = await gerarFilaConciliacao('oben');
    expect(movIdsGravados()).toEqual(
      ['m-banco-1001', 'm-banco-1003a', 'm-banco-1003b', 'm-banco-2001', 'm-banco-sem-titulo'].sort(),
    );
    expect(r).toEqual({ lidos: 5, criados: 5, falhas: 0, primeiraFalha: null });
  });

  it('o mesmo pagamento não vira dois itens do mesmo título', async () => {
    await gerarFilaConciliacao('oben');
    const porTitulo = state.upserts.filter((u) => u.titulo_id === 'cr-1001');
    expect(porTitulo.map((u) => u.mov_id)).toEqual(['m-banco-1001']);
    expect(state.upserts.filter((u) => u.titulo_id === 'cp-2001').map((u) => u.mov_id)).toEqual(['m-banco-2001']);
  });

  it('previsão não entra — nem a que casaria "conciliado" com um título de mesmo valor', async () => {
    await gerarFilaConciliacao('oben');
    expect(state.upserts.some((u) => u.titulo_id === 'cr-1004')).toBe(false);
    expect(state.upserts.some((u) => String(u.mov_id).startsWith('m-prev'))).toBe(false);
  });

  it('baixas parciais são eventos distintos: um item por baixa, não um por título', async () => {
    await gerarFilaConciliacao('oben');
    expect(state.upserts.filter((u) => u.titulo_id === 'cr-1003').map((u) => u.mov_valor).sort()).toEqual([400, 600]);
  });

  it('casa o movimento do banco com o título (CR e CP) e deixa o extrato sem título pendente', async () => {
    await gerarFilaConciliacao('oben');
    expect(item('m-banco-1001')).toMatchObject({ tipo_titulo: 'CR', titulo_id: 'cr-1001', status: 'conciliado', tipo_match: 'automatico' });
    expect(item('m-banco-2001')).toMatchObject({ tipo_titulo: 'CP', titulo_id: 'cp-2001', status: 'conciliado', tipo_match: 'automatico' });
    expect(item('m-banco-sem-titulo')).toMatchObject({ titulo_id: null, status: 'pendente', tipo_match: null });
  });
});

describe('gerarFilaConciliacao — falha não vira silêncio', () => {
  it('gravação recusada (RLS sem pode_conciliar) é CONTADA, não engolida', async () => {
    state.erroNaGravacao = { message: 'new row violates row-level security policy for table "fin_conciliacao"', code: '42501' };
    const r = await gerarFilaConciliacao('oben');
    expect(r).toEqual({
      lidos: 5,
      criados: 0,
      falhas: 5,
      primeiraFalha: 'new row violates row-level security policy for table "fin_conciliacao"',
    });
  });

  it('leitura dos movimentos que falha REJEITA — não vira "0 itens gerados"', async () => {
    state.erroNaLeitura.fin_movimentacoes = { message: 'MARCA-LEITURA-MOVS canceling statement due to statement timeout', code: '57014' };
    await expect(gerarFilaConciliacao('oben')).rejects.toMatchObject({ code: '57014', message: expect.stringContaining('MARCA-LEITURA-MOVS') });
    expect(state.upserts).toEqual([]);
  });

  it('busca de título que falha é CONTADA como não gerada — não vira "sem match" (pendente)', async () => {
    state.erroNaLeitura.fin_contas_receber = { message: 'MARCA-BUSCA-CR permission denied for table fin_contas_receber', code: '42501' };
    const r = await gerarFilaConciliacao('oben');
    // os 4 movimentos com título falham na busca; só o extrato sem título (sem busca) é gravado
    expect(r).toEqual({ lidos: 5, criados: 1, falhas: 4, primeiraFalha: 'MARCA-BUSCA-CR permission denied for table fin_contas_receber' });
    expect(movIdsGravados()).toEqual(['m-banco-sem-titulo']);
  });
});

describe('resumirGeracaoConciliacao — o que o toast diz', () => {
  it('sem falha: sucesso com a contagem', () => {
    expect(resumirGeracaoConciliacao({ lidos: 5, criados: 5, falhas: 0, primeiraFalha: null })).toEqual({
      tipo: 'sucesso',
      titulo: '5 itens gerados na fila de conciliação',
      descricao: null,
    });
  });

  it('com falha: ERRO que diz quantos ficaram de fora e por quê — nunca "0 itens gerados" como sucesso', () => {
    expect(
      resumirGeracaoConciliacao({ lidos: 5, criados: 0, falhas: 5, primeiraFalha: 'new row violates row-level security policy' }),
    ).toEqual({
      tipo: 'erro',
      titulo: '5 de 5 itens não gerados na fila de conciliação',
      descricao: 'new row violates row-level security policy',
    });
  });

  it('com falha sem mensagem: descrição honesta, não fabricada', () => {
    expect(resumirGeracaoConciliacao({ lidos: 3, criados: 2, falhas: 1, primeiraFalha: null })).toEqual({
      tipo: 'erro',
      titulo: '1 de 3 itens não gerados na fila de conciliação',
      descricao: 'O banco recusou a gravação sem mensagem — tente de novo ou avise a equipe.',
    });
  });
});
