import { describe, expect, it } from 'vitest';

import {
  agruparAlvos,
  alvosDeCorpo,
  type AlvoRpc,
  type CorposEsperados,
  familiaDe,
  FORMATO_SONDA,
  julgarPrecondicao,
  TOKEN_NAO,
  TOKEN_SEM_CORPO,
  TOKEN_SIM,
  type LeituraSonda,
  montarSondaPrecondicao,
  parsearSondaPrecondicao,
  relatarPrecondicao,
} from './precondicao-banco';

/**
 * Hashes FIXOS, digitados à mão — conferíveis com `printf '<corpo>' | md5`. Não saem de
 * `md5Exato(...)` de propósito: valor esperado calculado pelo código sob teste valida a si mesmo,
 * que foi o defeito que criou o eixo de dialeto.
 */
const MD5_ATUAL = '0cc175b9c0f1b6a831c399e269772661'; // md5('a')
const MD5_VELHO = '92eb5ffee6ae2fec3ad71c777531578f'; // md5('b')
/**
 * `md5(AMOSTRA_CORPO_JS)`. Digitado, não calculado — e MEDIDO nas duas pontas em 2026-09-09:
 *   printf '\n á  b ' | md5                     -> 85057feac85f4771e5b13242a337aa91
 *   psql -c "SELECT md5(E'\n á  b ')"           -> 85057feac85f4771e5b13242a337aa91
 * O banco é a ponta que importa: é ele que emite esta linha na sonda de verdade.
 */
const MD5_AMOSTRA = '85057feac85f4771e5b13242a337aa91';

/** Leitura sadia: controles positivos de pé, RPC presente, corpo o da ÚLTIMA migration. */
function leituraOk(rpcs: string[] = ['reposicao_claim_disparo']): LeituraSonda {
  return {
    medicoes: rpcs.map((rpc) => ({ rpc, existe: true, familia: 24 })),
    corpos: new Map(rpcs.map((rpc) => [rpc, { md5s: [MD5_ATUAL], overloads: 1 }])),
    funcoesPublic: 1200,
    fim: true,
    dialetoOk: true,
  };
}

/** Histórico commitado, com os controles positivos do eixo 5 satisfeitos. */
function corposCom(
  versoes: { migration: string; md5: string }[],
  rpc = 'reposicao_claim_disparo',
): CorposEsperados {
  return {
    historico: new Map([[`public.${rpc}`, versoes]]),
    inventarioDaRef: 721,
    migrationsLidas: Math.max(versoes.length, 1),
    funcoesConhecidas: versoes.length === 0 ? 0 : 1,
  };
}

/** O eixo 5 satisfeito: prod roda o corpo da última (e única) migration commitada. */
const CORPOS_OK = corposCom([{ migration: '20260101000000_a.sql', md5: MD5_ATUAL }]);

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
        `autoteste|md5corpo|${MD5_AMOSTRA}|`,
        `corpo|a_um|${MD5_ATUAL}|1`,
        `corpo|b_dois|${TOKEN_SEM_CORPO}|1`,
        `fim|${FORMATO_SONDA}||`,
      ].join('\n'),
    );
    expect(r.medicoes).toEqual([
      { rpc: 'a_um', existe: true, familia: 24 },
      { rpc: 'b_dois', existe: false, familia: 0 },
    ]);
    expect(r.corpos.get('a_um')).toEqual({ md5s: [MD5_ATUAL], overloads: 1 });
    // `SEM-CORPO` entra como AUSÊNCIA, não como valor: guardá-lo faria dois desconhecidos "baterem".
    expect(r.corpos.get('b_dois')).toEqual({ md5s: [], overloads: 1 });
    expect(r.funcoesPublic).toBe(1200);
    expect(r.fim).toBe(true);
    expect(r.dialetoOk).toBe(true);
  });

  it('overload chega como DUAS linhas do mesmo nome, e a contagem sobrevive', () => {
    const r = parsearSondaPrecondicao(
      [`corpo|a_um|${MD5_ATUAL}|2`, `corpo|a_um|${MD5_VELHO}|2`].join('\n'),
    );
    expect(r.corpos.get('a_um')).toEqual({ md5s: [MD5_ATUAL, MD5_VELHO], overloads: 2 });
  });

  it('o autoteste de md5 é o laço TS↔SQL: valor errado derruba o DIALETO inteiro', () => {
    const linhas = (md5: string) =>
      [
        `autoteste|presente|${TOKEN_SIM}|`,
        `autoteste|ausente|${TOKEN_NAO}|`,
        `autoteste|md5corpo|${md5}|`,
      ].join('\n');
    expect(parsearSondaPrecondicao(linhas(MD5_AMOSTRA)).dialetoOk).toBe(true);
    expect(parsearSondaPrecondicao(linhas(MD5_ATUAL)).dialetoOk).toBe(false);
    // Ausente ≠ confirmado: sem a linha, o dialeto não foi provado.
    expect(parsearSondaPrecondicao(linhas(MD5_AMOSTRA).split('\n').slice(0, 2).join('\n')).dialetoOk).toBe(false);
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
    expect(julgarPrecondicao(ALVO, leituraOk(), 0, CORPOS_OK).estado).toBe('LIBERADA');
  });

  it('eixo 1 — sem marcador de fim é INCERTA, ainda que nada pareça ausente', () => {
    const v = julgarPrecondicao(ALVO, { ...leituraOk(), fim: false }, 0, CORPOS_OK);
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join(' ')).toMatch(/truncada|marcador/);
  });

  it('eixo 2 — controle positivo ZERO é INCERTA, não "prod sem funções"', () => {
    const v = julgarPrecondicao(ALVO, { ...leituraOk(), funcoesPublic: 0 }, 0, CORPOS_OK);
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join(' ')).toMatch(/controle positivo ZERO/);
  });

  it('eixo 4 — dialeto não confirmado é INCERTA, mesmo com tudo parecendo presente', () => {
    const v = julgarPrecondicao(ALVO, { ...leituraOk(), dialetoOk: false }, 0, CORPOS_OK);
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join(' ')).toMatch(/DIALETO/);
  });

  it('eixo 3 — indireção conhecida é INCERTA: lista furada não libera', () => {
    const v = julgarPrecondicao(ALVO, leituraOk(), 2, CORPOS_OK);
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join(' ')).toMatch(/indireção|INCOMPLETA/);
  });

  it('alvo que a sonda não devolveu é ausência de DADO — INCERTA, não LIBERADA', () => {
    const v = julgarPrecondicao(ALVO, { medicoes: [], corpos: new Map(), funcoesPublic: 1200, fim: true, dialetoOk: true }, 0, CORPOS_OK);
    expect(v.estado).toBe('INCERTA');
    expect(v.naoMedidos).toEqual(['reposicao_claim_disparo']);
  });

  it('BLOQUEADA quando a RPC foi MEDIDA e está ausente — o caso #2285', () => {
    const v = julgarPrecondicao(
      ALVO,
      { medicoes: [{ rpc: 'reposicao_claim_disparo', existe: false, familia: 22 }], corpos: new Map(), funcoesPublic: 1200, fim: true, dialetoOk: true },
      0,
      CORPOS_OK,
    );
    expect(v.estado).toBe('BLOQUEADA');
    expect(v.ausentes[0].edges).toEqual(['disparar-pedidos-aprovados']);
  });

  it('BLOQUEADA e INCERTA não colapsam: medir-e-faltar ≠ não-conseguir-medir', () => {
    const faltando = julgarPrecondicao(
      ALVO,
      { medicoes: [{ rpc: 'reposicao_claim_disparo', existe: false, familia: 22 }], corpos: new Map(), funcoesPublic: 1200, fim: true, dialetoOk: true },
      0,
      CORPOS_OK,
    );
    const semMedir = julgarPrecondicao(ALVO, { medicoes: [], corpos: new Map(), funcoesPublic: 1200, fim: true, dialetoOk: true }, 0, CORPOS_OK);
    expect(faltando.estado).not.toBe(semMedir.estado);
  });
});

describe('relatarPrecondicao — a família decide a AÇÃO, não só o diagnóstico', () => {
  it('família povoada manda APLICAR esta migration', () => {
    const t = relatarPrecondicao(
      julgarPrecondicao(
        ALVO,
        { medicoes: [{ rpc: 'reposicao_claim_disparo', existe: false, familia: 22 }], corpos: new Map(), funcoesPublic: 1200, fim: true, dialetoOk: true },
        0,
        CORPOS_OK,
      ),
    );
    expect(t).toMatch(/falta ESTA migration/);
    expect(t).toContain('disparar-pedidos-aprovados');
  });

  it('família VAZIA manda diagnosticar — reaplicar aqui conserta o diagnóstico errado', () => {
    const t = relatarPrecondicao(
      julgarPrecondicao(
        ALVO,
        { medicoes: [{ rpc: 'reposicao_claim_disparo', existe: false, familia: 0 }], corpos: new Map(), funcoesPublic: 1200, fim: true, dialetoOk: true },
        0,
        CORPOS_OK,
      ),
    );
    expect(t).toMatch(/diagnostique, não reaplique/);
  });

  it('o texto do LIBERADA não contém a palavra que o operador procura para agir', () => {
    expect(relatarPrecondicao(julgarPrecondicao(ALVO, leituraOk(), 0, CORPOS_OK))).not.toMatch(/⛔/);
  });
});

describe('eixo 5 — "existe" ≠ "está na versão que a edge espera" (#2428)', () => {
  const HIST_DUAS = [
    { migration: '20260908163659_pedido_nasce_com_identidade_de_linha.sql', md5: MD5_VELHO },
    { migration: '20260908215704_desconto_valor_atravessa_os_escritores.sql', md5: MD5_ATUAL },
  ];

  /** O cenário MEDIDO em prod: a RPC existe, e o corpo é o da migration ANTERIOR. */
  function leituraComCorpoVelho(): LeituraSonda {
    return {
      ...leituraOk(),
      corpos: new Map([['reposicao_claim_disparo', { md5s: [MD5_VELHO], overloads: 1 }]]),
    };
  }

  it('BLOQUEIA quando prod roda o corpo de uma migration ANTERIOR — o incidente', () => {
    const v = julgarPrecondicao(ALVO, leituraComCorpoVelho(), 0, corposCom(HIST_DUAS));
    expect(v.estado).toBe('BLOQUEADA');
    expect(v.desatualizadas).toHaveLength(1);
    expect(v.desatualizadas[0].esperada).toContain('20260908215704');
    expect(v.desatualizadas[0].emProd).toContain('20260908163659');
    // Sem isto, o operador não sabe QUEM quebra: era o que o gate de existência já nomeava.
    expect(v.desatualizadas[0].edges).toEqual(['disparar-pedidos-aprovados']);
  });

  it('a RPC EXISTIR não basta: o eixo antigo diria LIBERADA sobre a mesma leitura', () => {
    // A leitura tem `existe: true` e os quatro eixos antigos de pé. O único que muda o veredito é
    // o corpo — se este teste ficar verde com `ausentes` não-vazio, ele mede outra coisa.
    const v = julgarPrecondicao(ALVO, leituraComCorpoVelho(), 0, corposCom(HIST_DUAS));
    expect(v.ausentes).toEqual([]);
    expect(v.naoMedidos).toEqual([]);
    expect(v.motivos).toEqual([]);
    expect(v.estado).toBe('BLOQUEADA');
  });

  it('DERIVA histórica NÃO bloqueia — 11 das 65 RPCs do repo estão nela', () => {
    const v = julgarPrecondicao(
      ALVO,
      { ...leituraOk(), corpos: new Map([['reposicao_claim_disparo', { md5s: ['f'.repeat(32)], overloads: 1 }]]) },
      0,
      corposCom(HIST_DUAS),
    );
    expect(v.estado).toBe('LIBERADA');
    expect(v.desatualizadas).toEqual([]);
    // Mas fica DECLARADA: um gate que só mostra o que afirmou deixa achar que afirmou sobre tudo.
    expect(v.naoConferidas.map((n) => n.rpc)).toEqual(['reposicao_claim_disparo']);
    expect(v.naoConferidas[0].motivo).toMatch(/edição manual/);
  });

  it('empate — a migration NOVA repete um corpo antigo — é EM_DIA, não bloqueio', () => {
    // O md5 casa com a última E com a anterior. Varrer de trás para frente acharia a anterior
    // primeiro e bloquearia uma leva correta: a igualdade não diz qual das duas rodou.
    const v = julgarPrecondicao(ALVO, leituraOk(), 0, corposCom([
      { migration: '20260101000000_a.sql', md5: MD5_ATUAL },
      { migration: '20260202000000_b.sql', md5: MD5_ATUAL },
    ]));
    expect(v.estado).toBe('LIBERADA');
    expect(v.naoConferidas).toEqual([]);
  });

  it('overload em prod é INDECIDÍVEL, não "bate com algum"', () => {
    const v = julgarPrecondicao(
      ALVO,
      { ...leituraOk(), corpos: new Map([['reposicao_claim_disparo', { md5s: [MD5_VELHO, MD5_ATUAL], overloads: 2 }]]) },
      0,
      corposCom(HIST_DUAS),
    );
    expect(v.estado).toBe('LIBERADA');
    expect(v.naoConferidas[0].motivo).toMatch(/2 assinaturas/);
  });

  it('prod sem corpo textual (prosqlbody, LANGUAGE c) não conta como em dia', () => {
    const v = julgarPrecondicao(
      ALVO,
      { ...leituraOk(), corpos: new Map([['reposicao_claim_disparo', { md5s: [], overloads: 1 }]]) },
      0,
      corposCom(HIST_DUAS),
    );
    expect(v.naoConferidas[0].motivo).toMatch(/corpo textual/);
    expect(v.desatualizadas).toEqual([]);
  });

  it('RPC AUSENTE não vira ruído do eixo 5 — o eixo antigo já fechou o veredito', () => {
    const v = julgarPrecondicao(
      ALVO,
      {
        medicoes: [{ rpc: 'reposicao_claim_disparo', existe: false, familia: 22 }],
        corpos: new Map(),
        funcoesPublic: 1200,
        fim: true,
        dialetoOk: true,
      },
      0,
      corposCom(HIST_DUAS),
    );
    expect(v.ausentes).toHaveLength(1);
    expect(v.naoConferidas).toEqual([]);
    expect(v.desatualizadas).toEqual([]);
  });

  it('controle positivo: inventário VAZIO da ref é INCERTA, não "nada a conferir"', () => {
    const v = julgarPrecondicao(ALVO, leituraComCorpoVelho(), 0, {
      historico: new Map(),
      inventarioDaRef: 0,
      migrationsLidas: 0,
      funcoesConhecidas: 0,
    });
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join('\n')).toMatch(/CEGO/);
  });

  it('controle positivo: arquivos lidos e ZERO funções extraídas é extrator quebrado', () => {
    const v = julgarPrecondicao(ALVO, leituraOk(), 0, {
      historico: new Map(),
      inventarioDaRef: 721,
      migrationsLidas: 33,
      funcoesConhecidas: 0,
    });
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join('\n')).toMatch(/NENHUMA função/);
  });

  it('sem CREATE commitado o eixo declara que não sabe, e não bloqueia', () => {
    const v = julgarPrecondicao(ALVO, leituraOk(), 0, {
      historico: new Map([['public.outra_qualquer', [{ migration: 'm.sql', md5: MD5_ATUAL }]]]),
      inventarioDaRef: 721,
      migrationsLidas: 1,
      funcoesConhecidas: 1,
    });
    expect(v.estado).toBe('LIBERADA');
    expect(v.naoConferidas[0].motivo).toMatch(/nenhuma migration commita/);
  });
});

describe('alvosDeCorpo — o conjunto ACOPLADO da migration, não só o que a leva chama', () => {
  it('puxa as irmãs da mesma migration, ainda que nenhuma edge da leva as chame', () => {
    // O caso real: 20260908215704 recria os TRÊS escritores de order_items, mas
    // `reconciliar_pedidos_omie` é chamada por `sync-reprocess`, não por `omie-vendas-sync`.
    const historico = new Map([
      ['public.criar_pedidos_com_itens', [{ migration: '20260908215704_x.sql', md5: MD5_ATUAL }]],
      ['public.reconciliar_pedidos_omie', [{ migration: '20260908215704_x.sql', md5: MD5_ATUAL }]],
      ['public.nao_relacionada', [{ migration: '20260101000000_y.sql', md5: MD5_ATUAL }]],
    ]);
    const fora = alvosDeCorpo([{ rpc: 'criar_pedidos_com_itens', edges: ['omie-vendas-sync'] }], historico);
    expect(fora).toContain('reconciliar_pedidos_omie');
    expect(fora).not.toContain('nao_relacionada');
  });

  it('a RPC da leva entra mesmo sem histórico — senão ela sumiria da SONDA', () => {
    expect(alvosDeCorpo([{ rpc: 'sem_ddl_commitada', edges: ['e'] }], new Map())).toEqual([
      'sem_ddl_commitada',
    ]);
  });
});
