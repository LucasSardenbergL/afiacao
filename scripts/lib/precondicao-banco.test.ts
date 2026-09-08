import { describe, expect, it } from 'vitest';

import {
  agruparAlvos,
  type AlvoRpc,
  familiaDe,
  FORMATO_SONDA,
  julgarPrecondicao,
  TOKEN_NAO,
  TOKEN_SIM,
  type LeituraSonda,
  montarSondaPrecondicao,
  parsearSondaPrecondicao,
  relatarPrecondicao,
} from './precondicao-banco';

/** Leitura sadia: os dois controles positivos de pé e a RPC presente. */
function leituraOk(rpcs: string[] = ['reposicao_claim_disparo']): LeituraSonda {
  return {
    medicoes: rpcs.map((rpc) => ({ rpc, existe: true, familia: 24 })),
    funcoesPublic: 1200,
    fim: true,
    dialetoOk: true,
  };
}

const ALVO: AlvoRpc[] = [
  { rpc: 'reposicao_claim_disparo', edges: ['disparar-pedidos-aprovados'] },
];

describe('agruparAlvos — duas edges podem depender da MESMA migration', () => {
  it('junta as edges sob a RPC, sem duplicar, em ordem estável', () => {
    const r = agruparAlvos([
      { edge: 'b-edge', rpc: 'x_um' },
      { edge: 'a-edge', rpc: 'x_um' },
      { edge: 'a-edge', rpc: 'x_um' },
      { edge: 'a-edge', rpc: 'a_dois' },
    ]);
    expect(r).toEqual([
      { rpc: 'a_dois', edges: ['a-edge'] },
      { rpc: 'x_um', edges: ['a-edge', 'b-edge'] },
    ]);
  });

  it('destravar uma edge não pode esconder a outra: o alvo nomeia AS DUAS', () => {
    const [alvo] = agruparAlvos([
      { edge: 'edge-a', rpc: 'r_x' },
      { edge: 'edge-b', rpc: 'r_x' },
    ]);
    expect(alvo.edges).toHaveLength(2);
  });
});

describe('familiaDe', () => {
  it('é o prefixo até o primeiro _', () => {
    expect(familiaDe('reposicao_claim_disparo')).toBe('reposicao');
    expect(familiaDe('semunderscore')).toBe('semunderscore');
  });
});

describe('montarSondaPrecondicao — fail-closed a montante', () => {
  it('nomeia toda RPC pedida e carimba o marcador de fim', () => {
    const sql = montarSondaPrecondicao(['b_dois', 'a_um']);
    expect(sql).toContain("('a_um')");
    expect(sql).toContain("('b_dois')");
    expect(sql).toContain(FORMATO_SONDA);
  });

  it('lê o CATÁLOGO e nunca INVOCA a função (invocar mente nos dois sentidos — FU4-E)', () => {
    const sql = montarSondaPrecondicao(['x_um']);
    expect(sql).toContain('pg_proc');
    expect(sql).not.toMatch(/SELECT\s+public\.x_um\s*\(/i);
  });

  it('traz o controle POSITIVO grosso junto — sem ele um zero é ausência de dado', () => {
    expect(montarSondaPrecondicao(['x_um'])).toContain('funcoes_public');
  });

  it('recusa lista vazia — "nenhuma RPC" não é "pré-condição satisfeita"', () => {
    expect(() => montarSondaPrecondicao([])).toThrow(/lista vazia/);
  });

  it('recusa nome fora do formato literal em vez de escapar', () => {
    expect(() => montarSondaPrecondicao(["x'; DROP TABLE t; --"])).toThrow(/fora do formato literal/);
    expect(() => montarSondaPrecondicao(['Maiuscula'])).toThrow(/fora do formato literal/);
  });

  it('é determinística: a mesma leva produz a mesma sonda', () => {
    expect(montarSondaPrecondicao(['b_um', 'a_um'])).toBe(montarSondaPrecondicao(['a_um', 'b_um']));
  });
});

describe('parsearSondaPrecondicao', () => {
  it('lê medições, controle e marcador', () => {
    const r = parsearSondaPrecondicao(
      [
        `rpc|a_um|${TOKEN_SIM}|24`,
        `rpc|b_dois|${TOKEN_NAO}|0`,
        'controle|funcoes_public|1200|',
        `autoteste|presente|${TOKEN_SIM}|`,
        `autoteste|ausente|${TOKEN_NAO}|`,
        `fim|${FORMATO_SONDA}||`,
      ].join('\n'),
    );
    expect(r.medicoes).toEqual([
      { rpc: 'a_um', existe: true, familia: 24 },
      { rpc: 'b_dois', existe: false, familia: 0 },
    ]);
    expect(r.funcoesPublic).toBe(1200);
    expect(r.fim).toBe(true);
    expect(r.dialetoOk).toBe(true);
  });

  it('campo de existência truncado vira AUSENTE, nunca presente', () => {
    const r = parsearSondaPrecondicao(['rpc|a_um||', `fim|${FORMATO_SONDA}||`].join('\n'));
    expect(r.medicoes[0].existe).toBe(false);
  });

  it('marcador de OUTRO formato não conta como fim — o contrato mudou, não adivinhe', () => {
    expect(parsearSondaPrecondicao('fim|precondicao-banco/9||').fim).toBe(false);
  });
});

describe('parsearSondaPrecondicao — o dialeto se prova, não se supõe', () => {
  it('sem as linhas de autoteste o dialeto NÃO é dado por confirmado', () => {
    expect(parsearSondaPrecondicao(`rpc|a_um|${TOKEN_SIM}|1`).dialetoOk).toBe(false);
  });

  it('autoteste que responde ERRADO derruba o dialeto — foi o defeito real da v1', () => {
    const r = parsearSondaPrecondicao(
      ['autoteste|presente|t|', 'autoteste|ausente|f|', `fim|${FORMATO_SONDA}||`].join('\n'),
    );
    expect(r.dialetoOk).toBe(false);
  });

  it('meia-verdade não passa: só uma das duas linhas de autoteste é insuficiente', () => {
    expect(parsearSondaPrecondicao(`autoteste|presente|${TOKEN_SIM}|`).dialetoOk).toBe(false);
  });
});

describe('julgarPrecondicao — os quatro eixos, e nenhum cobre o outro', () => {
  it('LIBERADA só com os dois controles de pé, zero indireção e a RPC presente', () => {
    expect(julgarPrecondicao(ALVO, leituraOk(), 0).estado).toBe('LIBERADA');
  });

  it('eixo 1 — sem marcador de fim é INCERTA, ainda que nada pareça ausente', () => {
    const v = julgarPrecondicao(ALVO, { ...leituraOk(), fim: false }, 0);
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join(' ')).toMatch(/truncada|marcador/);
  });

  it('eixo 2 — controle positivo ZERO é INCERTA, não "prod sem funções"', () => {
    const v = julgarPrecondicao(ALVO, { ...leituraOk(), funcoesPublic: 0 }, 0);
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join(' ')).toMatch(/controle positivo ZERO/);
  });

  it('eixo 4 — dialeto não confirmado é INCERTA, mesmo com tudo parecendo presente', () => {
    const v = julgarPrecondicao(ALVO, { ...leituraOk(), dialetoOk: false }, 0);
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join(' ')).toMatch(/DIALETO/);
  });

  it('eixo 3 — indireção conhecida é INCERTA: lista furada não libera', () => {
    const v = julgarPrecondicao(ALVO, leituraOk(), 2);
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join(' ')).toMatch(/indireção|INCOMPLETA/);
  });

  it('alvo que a sonda não devolveu é ausência de DADO — INCERTA, não LIBERADA', () => {
    const v = julgarPrecondicao(ALVO, { medicoes: [], funcoesPublic: 1200, fim: true, dialetoOk: true }, 0);
    expect(v.estado).toBe('INCERTA');
    expect(v.naoMedidos).toEqual(['reposicao_claim_disparo']);
  });

  it('BLOQUEADA quando a RPC foi MEDIDA e está ausente — o caso #2285', () => {
    const v = julgarPrecondicao(
      ALVO,
      { medicoes: [{ rpc: 'reposicao_claim_disparo', existe: false, familia: 22 }], funcoesPublic: 1200, fim: true, dialetoOk: true },
      0,
    );
    expect(v.estado).toBe('BLOQUEADA');
    expect(v.ausentes[0].edges).toEqual(['disparar-pedidos-aprovados']);
  });

  it('BLOQUEADA e INCERTA não colapsam: medir-e-faltar ≠ não-conseguir-medir', () => {
    const faltando = julgarPrecondicao(
      ALVO,
      { medicoes: [{ rpc: 'reposicao_claim_disparo', existe: false, familia: 22 }], funcoesPublic: 1200, fim: true, dialetoOk: true },
      0,
    );
    const semMedir = julgarPrecondicao(ALVO, { medicoes: [], funcoesPublic: 1200, fim: true, dialetoOk: true }, 0);
    expect(faltando.estado).not.toBe(semMedir.estado);
  });
});

describe('relatarPrecondicao — a família decide a AÇÃO, não só o diagnóstico', () => {
  it('família povoada manda APLICAR esta migration', () => {
    const t = relatarPrecondicao(
      julgarPrecondicao(
        ALVO,
        { medicoes: [{ rpc: 'reposicao_claim_disparo', existe: false, familia: 22 }], funcoesPublic: 1200, fim: true, dialetoOk: true },
        0,
      ),
    );
    expect(t).toMatch(/falta ESTA migration/);
    expect(t).toContain('disparar-pedidos-aprovados');
  });

  it('família VAZIA manda diagnosticar — reaplicar aqui conserta o diagnóstico errado', () => {
    const t = relatarPrecondicao(
      julgarPrecondicao(
        ALVO,
        { medicoes: [{ rpc: 'reposicao_claim_disparo', existe: false, familia: 0 }], funcoesPublic: 1200, fim: true, dialetoOk: true },
        0,
      ),
    );
    expect(t).toMatch(/diagnostique, não reaplique/);
  });

  it('o texto do LIBERADA não contém a palavra que o operador procura para agir', () => {
    expect(relatarPrecondicao(julgarPrecondicao(ALVO, leituraOk(), 0))).not.toMatch(/⛔/);
  });
});
