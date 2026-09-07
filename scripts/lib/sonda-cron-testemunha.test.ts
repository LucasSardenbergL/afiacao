import { describe, expect, it } from 'vitest';
import {
  alvosForaDoRepo,
  cronSondaParado,
  type Disparo,
  julgarSondaCron,
} from './sonda-cron-testemunha';

const disparo = (tickId: string, edge: string, requestId: number): Disparo => ({ tickId, edge, requestId });

/** Cenário base: 2 ticks, 1 edge, ambos atestados, ledger CONFERE. */
function base() {
  return {
    ativosNoBanco: ['monthly-report'],
    allowlistDoRepo: ['monthly-report'],
    ticksRecentes: ['t2', 't1'],
    disparos: [disparo('t2', 'monthly-report', 200), disparo('t1', 'monthly-report', 100)],
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

  it('só 1 tick na história (cron recém-aplicado) é AVISO, não pendência', () => {
    const e = {
      ...base(),
      ticksRecentes: ['t1'],
      disparos: [disparo('t1', 'monthly-report', 100)],
      atestacoes: [],
    };
    const r = julgarSondaCron(e);
    expect(r.achados).toEqual([]);
    expect(r.avisos.join(' ')).toMatch(/1 de 1/);
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

  it('só os 2 ticks MAIS RECENTES contam — um terceiro tick antigo não dilui o silêncio', () => {
    const e = {
      ...base(),
      ticksRecentes: ['t3', 't2', 't1'],
      disparos: [
        disparo('t3', 'monthly-report', 300),
        disparo('t2', 'monthly-report', 200),
        disparo('t1', 'monthly-report', 100),
      ],
      atestacoes: [{ requestId: 100, edgeDoCorpo: 'monthly-report' }],
    };
    const r = julgarSondaCron(e);
    expect(r.achados[0]?.classe).toBe('SONDA_CRON_SILENCIOSA');
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
