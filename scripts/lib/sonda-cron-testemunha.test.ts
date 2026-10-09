import { describe, expect, it } from 'vitest';
import {
  alvosForaDoRepo,
  classificarSemPergunta,
  cronSondaParado,
  type Disparo,
  julgarSondaCron,
  toleranciaDoCronMin,
} from './sonda-cron-testemunha';

/** `idadeMin` default 10: recente, dentro do teto — o caso comum em quase todo cenário. */
const disparo = (tickId: string, edge: string, requestId: number, idadeMin = 10): Disparo => ({
  tickId,
  edge,
  requestId,
  idadeMin,
});

/** Cenário base: 2 disparos recentes de 1 edge, ambos atestados, ledger CONFERE. */
function base() {
  return {
    ativosNoBanco: ['monthly-report'],
    allowlistDoRepo: ['monthly-report'],
    disparos: [disparo('t2', 'monthly-report', 200, 30), disparo('t1', 'monthly-report', 100, 150)],
    atestacoes: [
      { requestId: 200, edgeDoCorpo: 'monthly-report' },
      { requestId: 100, edgeDoCorpo: 'monthly-report' },
    ],
    estadoPorEdge: new Map([['monthly-report', 'CONFERE']]),
  };
}

describe('julgarSondaCron — o silêncio como sinal de rollback', () => {
  it('tudo atestado: nenhum achado', () => {
    expect(julgarSondaCron(base()).achados).toEqual([]);
  });

  it('2 ticks mudos com ledger CONFERE: SONDA_CRON_SILENCIOSA, nomeando os request_id', () => {
    const e = { ...base(), atestacoes: [] };
    const r = julgarSondaCron(e);
    expect(r.achados).toHaveLength(1);
    expect(r.achados[0].classe).toBe('SONDA_CRON_SILENCIOSA');
    expect(r.achados[0].edge).toBe('monthly-report');
    expect(r.achados[0].detalhe).toMatch(/200, 100|100, 200/);
  });

  it('1 tick mudo de 2 é AVISO, não pendência — timeout e 429 acontecem (precisão > recall)', () => {
    const e = { ...base(), atestacoes: [{ requestId: 200, edgeDoCorpo: 'monthly-report' }] };
    const r = julgarSondaCron(e);
    expect(r.achados).toEqual([]);
    expect(r.avisos.join(' ')).toMatch(/1 de 2/);
  });

  it('silêncio com ledger DIVERGE é ESPERADO: o ramo não está no ar, cobrar sonda é ruído', () => {
    for (const estado of ['DIVERGE_P1', 'DIVERGE_P2', 'INCOERENTE', 'NUNCA_ATESTADA']) {
      const e = { ...base(), atestacoes: [], estadoPorEdge: new Map([['monthly-report', estado]]) };
      expect(julgarSondaCron(e).achados, estado).toEqual([]);
    }
  });

  it('edge INATIVA no banco não gera achado — silêncio ali é obediência ao kill switch', () => {
    const e = { ...base(), ativosNoBanco: [], atestacoes: [] };
    expect(julgarSondaCron(e).achados).toEqual([]);
  });

  it('edge sem disparo em nenhum tick: nada a concluir (não é silêncio, é ausência de pergunta)', () => {
    const e = { ...base(), disparos: [], atestacoes: [] };
    expect(julgarSondaCron(e).achados).toEqual([]);
  });

  it('só 1 disparo na história (cron recém-aplicado) é AVISO, não pendência', () => {
    const e = {
      ...base(),
      disparos: [disparo('t1', 'monthly-report', 100)],
      atestacoes: [],
    };
    const r = julgarSondaCron(e);
    expect(r.achados).toEqual([]);
    expect(r.avisos.join(' ')).toMatch(/1 de 1/);
  });

  it('quando o relé declarou a CAUSA, ela substitui a especulação de rollback', () => {
    const e = {
      ...base(),
      atestacoes: [],
      motivos: [
        { requestId: 200, classe: 'sem-chave' },
        { requestId: 100, classe: 'sem-chave' },
      ],
    };
    const d = julgarSondaCron(e).achados[0].detalhe;
    expect(d).toMatch(/O relé respondeu: sem-chave/);
    expect(d).toMatch(/provisione SONDA_HMAC_KEY/);
    expect(d).not.toMatch(/Rollback, deploy parcial/);
  });

  it('sem motivo conhecido, mantém as três hipóteses — não inventa uma causa', () => {
    const d = julgarSondaCron({ ...base(), atestacoes: [] }).achados[0].detalhe;
    expect(d).toMatch(/Rollback, deploy parcial ou bundle recriado/);
  });

  it('classes distintas aparecem todas, sem repetir', () => {
    const e = {
      ...base(),
      atestacoes: [],
      motivos: [
        { requestId: 200, classe: 'timeout' },
        { requestId: 100, classe: 'timeout' },
      ],
    };
    const d = julgarSondaCron(e).achados[0].detalhe;
    expect(d).toMatch(/O relé respondeu: timeout\./);
    expect(d).not.toMatch(/provisione SONDA_HMAC_KEY/);
  });

  it('a resposta que se identifica como OUTRA edge é IDENTIDADE_INCOERENTE', () => {
    const e = {
      ...base(),
      atestacoes: [
        { requestId: 200, edgeDoCorpo: 'calculate-scores' },
        { requestId: 100, edgeDoCorpo: 'monthly-report' },
      ],
    };
    const r = julgarSondaCron(e);
    const inc = r.achados.filter((a) => a.classe === 'IDENTIDADE_INCOERENTE');
    expect(inc).toHaveLength(1);
    expect(inc[0].detalhe).toMatch(/pediu monthly-report.*calculate-scores/);
  });

  it('atestação de request_id DESCONHECIDO é ignorada — não é deste cron', () => {
    const e = { ...base(), atestacoes: [{ requestId: 999, edgeDoCorpo: 'seja-la-quem-for' }] };
    const r = julgarSondaCron(e);
    expect(r.achados.filter((a) => a.classe === 'IDENTIDADE_INCOERENTE')).toEqual([]);
  });

  it('edge do repo ainda não habilitada no banco vira AVISO com o remédio', () => {
    const e = { ...base(), allowlistDoRepo: ['monthly-report', 'calculate-scores'] };
    expect(julgarSondaCron(e).avisos.join(' ')).toMatch(/calculate-scores.*ainda não ativa no banco/);
  });

  it('só os 2 disparos MAIS RECENTES dela contam — um terceiro mais antigo não dilui o silêncio', () => {
    const e = {
      ...base(),
      disparos: [
        disparo('t3', 'monthly-report', 300, 20),
        disparo('t2', 'monthly-report', 200, 140),
        disparo('t1', 'monthly-report', 100, 250),
      ],
      atestacoes: [{ requestId: 100, edgeDoCorpo: 'monthly-report' }],
    };
    const r = julgarSondaCron(e);
    expect(r.achados[0]?.classe).toBe('SONDA_CRON_SILENCIOSA');
  });
});

/**
 * A janela é POR EDGE — os 2 últimos disparos DELA —, não os 2 ticks globais mais recentes.
 *
 * Medido em prod em 2026-09-10: às 23:14:15Z um tick manual PARCIAL (o one-liner
 * `deploy_sonda_disparar(ARRAY['sonda-relay'])` que o `sonda:sql` oferece, 1 disparo) caiu entre os
 * ticks cheios das 22:37Z e 00:37Z. Com a janela GLOBAL de 2 ticks, as outras 15 edges ficavam com
 * **1** disparo dentro dela e, por ~2 h, o silêncio delas só podia virar AVISO ("1 de 1 tick(s)
 * recentes sem resposta") — nunca `SONDA_CRON_SILENCIOSA`, que é a pergunta que o mecanismo inteiro
 * existe para responder. Dois parciais em sequência zeravam a janela das demais.
 *
 * Contagem real do recorte naquele instante (`row_number()` contra a prod, âncora 2026-09-10 23:20Z):
 * janela global → 1 edge com 2 disparos e **14 com 1**; janela por edge → **15 com 2**, nenhuma com 1.
 */
describe('julgarSondaCron — a janela é POR EDGE: um tick parcial não zera o poder de detecção', () => {
  /** Cheio (94 min) → parcial de 1 edge (60 min) → cheio (30 min), o cenário medido. */
  function comTickParcial() {
    return {
      ...base(),
      ativosNoBanco: ['monthly-report', 'sonda-relay'],
      allowlistDoRepo: ['monthly-report', 'sonda-relay'],
      disparos: [
        disparo('t-cheio-2', 'monthly-report', 200, 30),
        disparo('t-cheio-2', 'sonda-relay', 201, 30),
        disparo('t-parcial', 'sonda-relay', 150, 60),
        disparo('t-cheio-1', 'monthly-report', 100, 94),
        disparo('t-cheio-1', 'sonda-relay', 101, 94),
      ],
      estadoPorEdge: new Map([
        ['monthly-report', 'CONFERE'],
        ['sonda-relay', 'CONFERE'],
      ]),
    };
  }

  it('a edge muda nos DOIS disparos DELA é acusada, mesmo com um tick parcial no meio', () => {
    const e = { ...comTickParcial(), atestacoes: [{ requestId: 150, edgeDoCorpo: 'sonda-relay' }, { requestId: 201, edgeDoCorpo: 'sonda-relay' }] };
    const r = julgarSondaCron(e);
    const mudas = r.achados.filter((a) => a.classe === 'SONDA_CRON_SILENCIOSA');
    expect(mudas).toHaveLength(1);
    expect(mudas[0].edge).toBe('monthly-report');
    expect(mudas[0].detalhe).toMatch(/200, 100|100, 200/);
    expect(r.avisos).toEqual([]);
  });

  it('controle: a MESMA edge respondendo nos dois disparos dela não vira achado nem aviso', () => {
    const e = {
      ...comTickParcial(),
      atestacoes: [
        { requestId: 200, edgeDoCorpo: 'monthly-report' },
        { requestId: 100, edgeDoCorpo: 'monthly-report' },
        { requestId: 201, edgeDoCorpo: 'sonda-relay' },
        { requestId: 150, edgeDoCorpo: 'sonda-relay' },
      ],
    };
    const r = julgarSondaCron(e);
    expect(r.achados).toEqual([]);
    expect(r.avisos).toEqual([]);
    expect(r.semPergunta).toEqual([]);
  });

  it('DOIS parciais em sequência também não zeram a janela das demais', () => {
    const e = {
      ...base(),
      disparos: [
        disparo('t-parcial-b', 'outra-edge', 301, 20),
        disparo('t-parcial-a', 'outra-edge', 300, 40),
        disparo('t-cheio-2', 'monthly-report', 200, 70),
        disparo('t-cheio-1', 'monthly-report', 100, 190),
      ],
      atestacoes: [],
    };
    const r = julgarSondaCron(e);
    expect(r.achados.map((a) => a.classe)).toEqual(['SONDA_CRON_SILENCIOSA']);
    expect(r.avisos).toEqual([]);
  });

  it('o exame informado ao resumo conta os disparos POR EDGE que julgaram, e quantos responderam', () => {
    const r = julgarSondaCron(comTickParcial());
    expect(r.exame).toEqual({ disparos: 4, atestados: 2 });
  });

  it('o exame NÃO conta disparo de edge inativa — ela está fora da população examinada', () => {
    const e = {
      ...base(),
      disparos: [
        disparo('t2', 'monthly-report', 200, 30),
        disparo('t2', 'desligada-no-kill-switch', 900, 30),
        disparo('t1', 'monthly-report', 100, 150),
        disparo('t1', 'desligada-no-kill-switch', 901, 150),
      ],
    };
    expect(julgarSondaCron(e).exame).toEqual({ disparos: 2, atestados: 2 });
  });

  it('o exame só conta o que entrou na janela — disparo acima do teto fica fora da contagem', () => {
    const e = {
      ...base(),
      disparos: [disparo('t2', 'monthly-report', 200, 30), disparo('t1', 'monthly-report', 100, 400)],
    };
    expect(julgarSondaCron(e).exame).toEqual({ disparos: 1, atestados: 1 });
  });

  it('empate de idade desempata pelo request_id MAIOR — o recorte não depende da ordem das linhas', () => {
    const e = {
      ...base(),
      disparos: [
        disparo('t-manual', 'monthly-report', 100, 30),
        disparo('t-cheio', 'monthly-report', 200, 30),
        disparo('t-velho', 'monthly-report', 50, 90),
      ],
      atestacoes: [{ requestId: 50, edgeDoCorpo: 'monthly-report' }],
    };
    const r = julgarSondaCron(e);
    // os que julgam são 200 e 100 (idade 30, ids maiores); o 50, atestado, ficou fora do recorte
    expect(r.achados.map((a) => a.classe)).toEqual(['SONDA_CRON_SILENCIOSA']);
    expect(r.achados[0].detalhe).toMatch(/200, 100|100, 200/);
    expect(r.exame).toEqual({ disparos: 2, atestados: 0 });
  });
});

/**
 * O TETO de idade é o que o `LIMIT 2` por tick global dava de graça: dois disparos ANTIGOS — edge
 * desligada pelo kill switch e religada — não podem formar acusação de rollback. A régua é a MESMA
 * tolerância do `cronSondaParado` e do teto da espera (2 períodos do cron + 15 min): uma definição só.
 */
describe('julgarSondaCron — o teto de idade dos disparos que julgam', () => {
  it('2 disparos ACIMA do teto não acusam: a edge fica sem pergunta, não muda', () => {
    const e = {
      ...base(),
      disparos: [disparo('t2', 'monthly-report', 200, 400), disparo('t1', 'monthly-report', 100, 520)],
      atestacoes: [],
    };
    const r = julgarSondaCron(e);
    expect(r.achados).toEqual([]);
    expect(r.avisos).toEqual([]);
    expect(r.semPergunta).toEqual(['monthly-report']);
  });

  it('no teto exato ainda julga; acima dele sai do exame', () => {
    const noTeto = {
      ...base(),
      disparos: [
        disparo('t2', 'monthly-report', 200, toleranciaDoCronMin()),
        disparo('t1', 'monthly-report', 100, toleranciaDoCronMin()),
      ],
      atestacoes: [],
    };
    expect(julgarSondaCron(noTeto).achados.map((a) => a.classe)).toEqual(['SONDA_CRON_SILENCIOSA']);

    const acima = {
      ...noTeto,
      disparos: [
        disparo('t2', 'monthly-report', 200, toleranciaDoCronMin() + 0.1),
        disparo('t1', 'monthly-report', 100, toleranciaDoCronMin() + 0.1),
      ],
    };
    expect(julgarSondaCron(acima).achados).toEqual([]);
    expect(julgarSondaCron(acima).semPergunta).toEqual(['monthly-report']);
  });

  it('1 disparo dentro do teto e 1 fora: AVISO, não acusação (precisão > recall)', () => {
    const e = {
      ...base(),
      disparos: [disparo('t2', 'monthly-report', 200, 30), disparo('t1', 'monthly-report', 100, 400)],
      atestacoes: [],
    };
    const r = julgarSondaCron(e);
    expect(r.achados).toEqual([]);
    expect(r.avisos.join(' ')).toMatch(/1 de 1/);
  });

  it('idade ILEGÍVEL fica FORA do exame — ausente não é recente (fail-closed)', () => {
    const e = {
      ...base(),
      disparos: [disparo('t2', 'monthly-report', 200, Number.NaN), disparo('t1', 'monthly-report', 100, Number.NaN)],
      atestacoes: [],
    };
    const r = julgarSondaCron(e);
    expect(r.achados).toEqual([]);
    expect(r.semPergunta).toEqual(['monthly-report']);
  });
});

/**
 * O que o juiz PULA sem acusar também tem de sair no resultado (2026-09-10, logo após a onda 5).
 *
 * `omie-desconto-backfill` entrou ativa no banco depois do último tick: nenhum tick a perguntou, o
 * juiz corretamente não acusou — e o resumo, que só olhava achados e avisos, afirmou "toda edge ativa
 * foi atestada" sobre 16 edges com 15 examinadas. Os dois `continue` que não deixavam rastro são
 * exatamente as duas listas abaixo; nenhuma delas vira achado nem aviso.
 */
describe('julgarSondaCron — o que ficou FORA do exame sai no resultado, sem acusar', () => {
  it('edge ativa que nenhum tick perguntou vai para semPergunta — e não vira achado nem aviso', () => {
    const e = { ...base(), ativosNoBanco: ['monthly-report', 'omie-desconto-backfill'] };
    const r = julgarSondaCron(e);
    expect(r.semPergunta).toEqual(['omie-desconto-backfill']);
    expect(r.achados).toEqual([]);
    expect(r.avisos).toEqual([]);
  });

  it('edge perguntada em ao menos 1 dos ticks que julgam NÃO está em semPergunta', () => {
    const e = { ...base(), disparos: [disparo('t2', 'monthly-report', 200)], atestacoes: [{ requestId: 200, edgeDoCorpo: 'monthly-report' }] };
    expect(julgarSondaCron(e).semPergunta).toEqual([]);
  });

  it('pergunta ACIMA do teto de idade não conta como pergunta — é o que o LIMIT por tick dava de graça', () => {
    const e = {
      ...base(),
      disparos: [disparo('t1', 'monthly-report', 100, toleranciaDoCronMin() + 1)],
      atestacoes: [{ requestId: 100, edgeDoCorpo: 'monthly-report' }],
    };
    expect(julgarSondaCron(e).semPergunta).toEqual(['monthly-report']);
  });

  it('nenhum disparo na história (cron que nunca rodou): toda ativa fica em semPergunta', () => {
    const e = { ...base(), ativosNoBanco: ['calculate-scores', 'monthly-report'], disparos: [], atestacoes: [] };
    expect(julgarSondaCron(e).semPergunta).toEqual(['calculate-scores', 'monthly-report']);
  });

  it('silêncio relevado porque o ledger não diz CONFERE vai para silencioEsperado — sem acusar', () => {
    const e = { ...base(), atestacoes: [], estadoPorEdge: new Map([['monthly-report', 'DIVERGE_P1']]) };
    const r = julgarSondaCron(e);
    expect(r.silencioEsperado).toEqual(['monthly-report']);
    expect(r.achados).toEqual([]);
    expect(r.avisos).toEqual([]);
  });

  it('tudo atestado: as duas listas vazias', () => {
    const r = julgarSondaCron(base());
    expect(r.semPergunta).toEqual([]);
    expect(r.silencioEsperado).toEqual([]);
  });

  it('silêncio com CONFERE é achado, não silencioEsperado', () => {
    const r = julgarSondaCron({ ...base(), atestacoes: [] });
    expect(r.achados[0]?.classe).toBe('SONDA_CRON_SILENCIOSA');
    expect(r.silencioEsperado).toEqual([]);
  });
});

/**
 * Esperar por uma pergunta tem TETO (laço de espera sem desistência é fail-OPEN): até ele, a edge sem
 * pergunta é só a vez dela; acima, o dispatcher — que pergunta TODA ativa a cada tick — não está
 * perguntando por ela. A tolerância é a mesma do `cronSondaParado`: uma definição só.
 */
describe('classificarSemPergunta — o teto da espera por uma pergunta', () => {
  it('a tolerância é 2 períodos do cron + 15 min — 255 min no cron de 2 h, a mesma do cronSondaParado', () => {
    expect(toleranciaDoCronMin()).toBe(255);
    expect(toleranciaDoCronMin(1)).toBe(135);
    expect(cronSondaParado(toleranciaDoCronMin())).toBe(false);
    expect(cronSondaParado(toleranciaDoCronMin() + 0.1)).toBe(true);
  });

  it('espera dentro do teto: aguardando, com a medida', () => {
    const c = classificarSemPergunta(['omie-desconto-backfill'], new Map([['omie-desconto-backfill', 40]]));
    expect(c.aguardando).toEqual([{ edge: 'omie-desconto-backfill', minutos: 40 }]);
    expect(c.atrasadas).toEqual([]);
  });

  it('no teto exato ainda aguarda; acima dele é atrasada', () => {
    const c = classificarSemPergunta(['a', 'b'], new Map([['a', 255], ['b', 255.1]]));
    expect(c.aguardando).toEqual([{ edge: 'a', minutos: 255 }]);
    expect(c.atrasadas).toEqual([{ edge: 'b', minutos: 255.1 }]);
  });

  it('o teto acompanha o período do cron', () => {
    const c = classificarSemPergunta(['a'], new Map([['a', 200]]), 1);
    expect(c.atrasadas).toEqual([{ edge: 'a', minutos: 200 }]);
  });

  it('sem medida da espera: aguardando com minutos null — ausente não vira zero nem atraso', () => {
    const c = classificarSemPergunta(['a'], new Map());
    expect(c.aguardando).toEqual([{ edge: 'a', minutos: null }]);
    expect(c.atrasadas).toEqual([]);
  });

  it('só classifica quem está em semPergunta — medida de edge perguntada é ignorada', () => {
    const c = classificarSemPergunta([], new Map([['monthly-report', 999]]));
    expect(c).toEqual({ aguardando: [], atrasadas: [] });
  });
});

describe('alvosForaDoRepo — o banco não pode sondar o que o repo não provou', () => {
  it('acusa alvo ativo no banco que não está na allowlist do repo', () => {
    expect(alvosForaDoRepo(['monthly-report', 'omie-webhook'], ['monthly-report'])).toEqual(['omie-webhook']);
  });
  it('banco ⊆ repo é o estado normal', () => {
    expect(alvosForaDoRepo(['monthly-report'], ['monthly-report', 'calculate-scores'])).toEqual([]);
  });
});

describe('cronSondaParado', () => {
  it('nunca rodou (recém-aplicado) NÃO é falha', () => expect(cronSondaParado(null)).toBe(false));
  it('dentro de 2 períodos + 15 min está vivo', () => expect(cronSondaParado(4 * 60 + 10)).toBe(false));
  it('acima da tolerância está parado', () => expect(cronSondaParado(4 * 60 + 16)).toBe(true));
});
