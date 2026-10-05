import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type CorpoVivo, historicoDeCorpos, md5Exato, type VersaoDeCorpo } from './corpo-esperado';

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
  type TextosVivos,
  type VigenciaNoRepo,
} from './precondicao-banco';
import { md5DeTokens } from './tokens-sql';

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
  versoes: VersaoDeCorpo[],
  rpc = 'reposicao_claim_disparo',
): CorposEsperados {
  return {
    historico: new Map([[`public.${rpc}`, versoes]]),
    inventarioDaRef: 721,
    migrationsLidas: Math.max(versoes.length, 1),
    funcoesConhecidas: versoes.length === 0 ? 0 : 1,
    // Vazia de propósito: estes cenários não têm irmã, e a vigência só decide sobre irmã.
    vigencia: new Map(),
  };
}

/** O eixo 5 satisfeito: prod roda o corpo da última (e única) migration commitada. */
const CORPOS_OK = corposCom([{ migration: '20260101000000_a.sql', md5: MD5_ATUAL, corpo: 'a' }]);

/**
 * O canal de texto ÍNTEGRO e VAZIO. Os testes dos eixos de antes não chegam ao re-teste por tokens
 * (só o que o md5 exato chama de DERIVA chega) — e o que chega declara o seu texto, explícito, no
 * bloco do re-teste. Se algum destes passar a chegar, o veredito vira INCERTA e o teste acusa.
 */
const SEM_TEXTOS: TextosVivos = { porNome: new Map(), falhas: [] };
const julgarSemTexto = (
  alvos: readonly AlvoRpc[],
  leitura: LeituraSonda,
  indirecoes: number,
  corpos: CorposEsperados,
) => julgarPrecondicao(alvos, leitura, indirecoes, corpos, SEM_TEXTOS);

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

  it('aceita `_` inicial — 9 funções `public` são assim, e a varredura de corpo mede TODAS', () => {
    // `_data_health_compute` é metade de um conjunto ACOPLADO do CLAUDE.md; recusá-la tirava da
    // medição exatamente a função que mais precisa dela. O alfabeto segue `[a-z0-9_]`.
    const sql = montarSondaPrecondicao(['_data_health_compute']);
    expect(sql).toContain("('_data_health_compute')");
    expect(() => montarSondaPrecondicao(["_x'; --"])).toThrow(/fora do formato literal/);
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
    expect(julgarSemTexto(ALVO, leituraOk(), 0, CORPOS_OK).estado).toBe('LIBERADA');
  });

  it('eixo 1 — sem marcador de fim é INCERTA, ainda que nada pareça ausente', () => {
    const v = julgarSemTexto(ALVO, { ...leituraOk(), fim: false }, 0, CORPOS_OK);
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join(' ')).toMatch(/truncada|marcador/);
  });

  it('eixo 2 — controle positivo ZERO é INCERTA, não "prod sem funções"', () => {
    const v = julgarSemTexto(ALVO, { ...leituraOk(), funcoesPublic: 0 }, 0, CORPOS_OK);
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join(' ')).toMatch(/controle positivo ZERO/);
  });

  it('eixo 4 — dialeto não confirmado é INCERTA, mesmo com tudo parecendo presente', () => {
    const v = julgarSemTexto(ALVO, { ...leituraOk(), dialetoOk: false }, 0, CORPOS_OK);
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join(' ')).toMatch(/DIALETO/);
  });

  it('eixo 3 — indireção conhecida é INCERTA: lista furada não libera', () => {
    const v = julgarSemTexto(ALVO, leituraOk(), 2, CORPOS_OK);
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join(' ')).toMatch(/indireção|INCOMPLETA/);
  });

  it('alvo que a sonda não devolveu é ausência de DADO — INCERTA, não LIBERADA', () => {
    const v = julgarSemTexto(ALVO, { medicoes: [], corpos: new Map(), funcoesPublic: 1200, fim: true, dialetoOk: true }, 0, CORPOS_OK);
    expect(v.estado).toBe('INCERTA');
    expect(v.naoMedidos).toEqual(['reposicao_claim_disparo']);
  });

  it('BLOQUEADA quando a RPC foi MEDIDA e está ausente — o caso #2285', () => {
    const v = julgarSemTexto(
      ALVO,
      { medicoes: [{ rpc: 'reposicao_claim_disparo', existe: false, familia: 22 }], corpos: new Map(), funcoesPublic: 1200, fim: true, dialetoOk: true },
      0,
      CORPOS_OK,
    );
    expect(v.estado).toBe('BLOQUEADA');
    expect(v.ausentes[0].edges).toEqual(['disparar-pedidos-aprovados']);
  });

  it('BLOQUEADA e INCERTA não colapsam: medir-e-faltar ≠ não-conseguir-medir', () => {
    const faltando = julgarSemTexto(
      ALVO,
      { medicoes: [{ rpc: 'reposicao_claim_disparo', existe: false, familia: 22 }], corpos: new Map(), funcoesPublic: 1200, fim: true, dialetoOk: true },
      0,
      CORPOS_OK,
    );
    const semMedir = julgarSemTexto(ALVO, { medicoes: [], corpos: new Map(), funcoesPublic: 1200, fim: true, dialetoOk: true }, 0, CORPOS_OK);
    expect(faltando.estado).not.toBe(semMedir.estado);
  });
});

describe('relatarPrecondicao — a família decide a AÇÃO, não só o diagnóstico', () => {
  it('família povoada manda APLICAR esta migration', () => {
    const t = relatarPrecondicao(
      julgarSemTexto(
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
      julgarSemTexto(
        ALVO,
        { medicoes: [{ rpc: 'reposicao_claim_disparo', existe: false, familia: 0 }], corpos: new Map(), funcoesPublic: 1200, fim: true, dialetoOk: true },
        0,
        CORPOS_OK,
      ),
    );
    expect(t).toMatch(/diagnostique, não reaplique/);
  });

  it('o texto do LIBERADA não contém a palavra que o operador procura para agir', () => {
    expect(relatarPrecondicao(julgarSemTexto(ALVO, leituraOk(), 0, CORPOS_OK))).not.toMatch(/⛔/);
  });
});

describe('eixo 5 — "existe" ≠ "está na versão que a edge espera" (#2428)', () => {
  const HIST_DUAS = [
    { migration: '20260908163659_pedido_nasce_com_identidade_de_linha.sql', md5: MD5_VELHO, corpo: 'b' },
    { migration: '20260908215704_desconto_valor_atravessa_os_escritores.sql', md5: MD5_ATUAL, corpo: 'a' },
  ];

  /** O cenário MEDIDO em prod: a RPC existe, e o corpo é o da migration ANTERIOR. */
  function leituraComCorpoVelho(): LeituraSonda {
    return {
      ...leituraOk(),
      corpos: new Map([['reposicao_claim_disparo', { md5s: [MD5_VELHO], overloads: 1 }]]),
    };
  }

  it('BLOQUEIA quando prod roda o corpo de uma migration ANTERIOR — o incidente', () => {
    const v = julgarSemTexto(ALVO, leituraComCorpoVelho(), 0, corposCom(HIST_DUAS));
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
    const v = julgarSemTexto(ALVO, leituraComCorpoVelho(), 0, corposCom(HIST_DUAS));
    expect(v.ausentes).toEqual([]);
    expect(v.naoMedidos).toEqual([]);
    expect(v.motivos).toEqual([]);
    expect(v.estado).toBe('BLOQUEADA');
  });

  it('DERIVA histórica NÃO bloqueia — 11 das 65 RPCs do repo estão nela', () => {
    // Prod roda 'z' (md5 digitado: `printf z | md5`), corpo que migration nenhuma commitou. Chega ao
    // re-teste por tokens — por isso traz o TEXTO — e não casa por lá também.
    const v = julgarPrecondicao(
      ALVO,
      { ...leituraOk(), corpos: new Map([['reposicao_claim_disparo', { md5s: ['fbade9e36a3f36d3d676c1b808451dd7'], overloads: 1 }]]) },
      0,
      corposCom(HIST_DUAS),
      { porNome: new Map([['reposicao_claim_disparo', ['z']]]), falhas: [] },
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
    const v = julgarSemTexto(ALVO, leituraOk(), 0, corposCom([
      { migration: '20260101000000_a.sql', md5: MD5_ATUAL, corpo: 'a' },
      { migration: '20260202000000_b.sql', md5: MD5_ATUAL, corpo: 'a' },
    ]));
    expect(v.estado).toBe('LIBERADA');
    expect(v.naoConferidas).toEqual([]);
  });

  it('overload em prod é INDECIDÍVEL, não "bate com algum"', () => {
    const v = julgarSemTexto(
      ALVO,
      { ...leituraOk(), corpos: new Map([['reposicao_claim_disparo', { md5s: [MD5_VELHO, MD5_ATUAL], overloads: 2 }]]) },
      0,
      corposCom(HIST_DUAS),
    );
    expect(v.estado).toBe('LIBERADA');
    expect(v.naoConferidas[0].motivo).toMatch(/2 assinaturas/);
  });

  it('prod sem corpo textual (prosqlbody, LANGUAGE c) não conta como em dia', () => {
    const v = julgarSemTexto(
      ALVO,
      { ...leituraOk(), corpos: new Map([['reposicao_claim_disparo', { md5s: [], overloads: 1 }]]) },
      0,
      corposCom(HIST_DUAS),
    );
    expect(v.naoConferidas[0].motivo).toMatch(/corpo textual/);
    expect(v.desatualizadas).toEqual([]);
  });

  it('RPC AUSENTE não vira ruído do eixo 5 — o eixo antigo já fechou o veredito', () => {
    const v = julgarSemTexto(
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
    const v = julgarSemTexto(ALVO, leituraComCorpoVelho(), 0, {
      historico: new Map(),
      inventarioDaRef: 0,
      migrationsLidas: 0,
      funcoesConhecidas: 0,
      vigencia: new Map(),
    });
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join('\n')).toMatch(/CEGO/);
  });

  it('controle positivo: arquivos lidos e ZERO funções extraídas é extrator quebrado', () => {
    const v = julgarSemTexto(ALVO, leituraOk(), 0, {
      historico: new Map(),
      inventarioDaRef: 721,
      migrationsLidas: 33,
      funcoesConhecidas: 0,
      vigencia: new Map(),
    });
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join('\n')).toMatch(/NENHUMA função/);
  });

  it('sem CREATE commitado o eixo declara que não sabe, e não bloqueia', () => {
    const v = julgarSemTexto(ALVO, leituraOk(), 0, {
      historico: new Map([['public.outra_qualquer', [{ migration: 'm.sql', md5: MD5_ATUAL, corpo: 'a' }]]]),
      inventarioDaRef: 721,
      migrationsLidas: 1,
      funcoesConhecidas: 1,
      vigencia: new Map(),
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
      ['public.criar_pedidos_com_itens', [{ migration: '20260908215704_x.sql', md5: MD5_ATUAL, corpo: 'a' }]],
      ['public.reconciliar_pedidos_omie', [{ migration: '20260908215704_x.sql', md5: MD5_ATUAL, corpo: 'a' }]],
      ['public.nao_relacionada', [{ migration: '20260101000000_y.sql', md5: MD5_ATUAL, corpo: 'a' }]],
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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Eixo 5, 2ª pergunta: o que o md5 EXATO chamou de DERIVA é re-testado por TOKENS
// (docs/historico/deriva-so-de-comentario-no-corpo.md)
// ═══════════════════════════════════════════════════════════════════════════════════════════
// Em prod, 31 funções rodavam o corpo commitado MENOS as linhas de comentário, e o relatório dizia
// "edição manual" sobre a mesma lógica. O critério de "mesma lógica" é UM só — `mesmosTokens`, o
// scanner do #2576 — e as checagens exatas vêm antes e não mudam.
describe('eixo 5 — o que o md5 exato chama de DERIVA é re-testado por TOKENS', () => {
  const RPC = 'reposicao_claim_disparo';
  const VELHA = '20260908163659_pedido_nasce_com_identidade_de_linha.sql';
  const NOVA = '20260908215704_desconto_valor_atravessa_os_escritores.sql';
  const VELHO_TXT = 'BEGIN\n  -- antes\n  RETURN 1;\nEND;';
  const NOVO_TXT = 'BEGIN\n  -- nota\n  RETURN 2;\nEND;';
  const PROD_NOVO = 'BEGIN\n  RETURN 2;\nEND;';
  const PROD_VELHO = 'BEGIN\n  RETURN 1;\nEND;';
  const PROD_EDITADO = 'BEGIN\n  RETURN 3;\nEND;';
  /** md5 DIGITADOS — conferíveis com `printf '<corpo>' | md5` (o `\n` do printf é o LF do corpo). */
  const MD5 = {
    velho: 'c6b49a509097b9e565d43c5ba230b6a4',
    novo: 'fe3976797851ba140c7b15d5a25ace6e',
    prodNovo: 'ce4ddd2bf00f6904e90f235dd4c43b88',
    prodVelho: '67f373071560ba94845995105c614eb8',
    editado: '722b7bb34888b903978d05ca1a1464ed',
  };
  const HIST: VersaoDeCorpo[] = [
    { migration: VELHA, md5: MD5.velho, corpo: VELHO_TXT },
    { migration: NOVA, md5: MD5.novo, corpo: NOVO_TXT },
  ];
  /** Prod com UM corpo: o md5 que a sonda mediu e o texto que a sonda de detalhe trouxe (ou não). */
  const prod = (md5: string, texto: string | null, falhas: string[] = []) => ({
    leitura: { ...leituraOk([RPC]), corpos: new Map([[RPC, { md5s: [md5], overloads: 1 }]]) },
    textos: { porNome: new Map<string, string[]>(texto === null ? [] : [[RPC, [texto]]]), falhas },
  });
  const julgar = (p: ReturnType<typeof prod>, hist: VersaoDeCorpo[] = HIST) =>
    julgarPrecondicao(ALVO, p.leitura, 0, corposCom(hist), p.textos);

  it('prod = a ÚLTIMA versão a menos de comentário ⇒ VARIANTE_COSMETICA: libera, em lista PRÓPRIA, com método, migration e hash', () => {
    const v = julgar(prod(MD5.prodNovo, PROD_NOVO));
    expect(v.estado).toBe('LIBERADA');
    // O md5 dos tokens é o MESMO dos dois lados — é isso que "cosmética" afirma.
    expect(md5DeTokens(PROD_NOVO)).toBe(md5DeTokens(NOVO_TXT));
    expect(v.cosmeticas).toEqual([
      { rpc: RPC, esperada: NOVA, prova: { md5Prod: MD5.prodNovo, md5Repo: MD5.novo, md5Tokens: md5DeTokens(NOVO_TXT) } },
    ]);
    // Não é "fora do alcance": o gate AFIRMOU algo — e era aqui que ele dizia "edição manual".
    expect(v.naoConferidas).toEqual([]);
    expect(v.desatualizadas).toEqual([]);
    const t = relatarPrecondicao(v);
    expect(t).toContain('VARIANTE_COSMETICA');
    expect(t).toContain(`\`${NOVA}\``);
    expect(t).toContain(MD5.prodNovo);
    expect(t).toContain(MD5.novo);
    expect(t).toContain(md5DeTokens(NOVO_TXT));
    expect(t).toMatch(/método: tokens/);
    expect(t).not.toMatch(/edição manual/);
  });

  it('prod = uma versão ANTERIOR a menos de comentário ⇒ CORPO_ANTERIOR por tokens: BLOQUEIA (o P1 latente — antes caía em DERIVA e liberava)', () => {
    const v = julgar(prod(MD5.prodVelho, PROD_VELHO));
    expect(v.estado).toBe('BLOQUEADA');
    expect(v.desatualizadas).toEqual([
      {
        rpc: RPC,
        edges: ['disparar-pedidos-aprovados'],
        esperada: NOVA,
        emProd: VELHA,
        casouPor: 'tokens',
        prova: { md5Prod: MD5.prodVelho, md5Repo: MD5.velho, md5Tokens: md5DeTokens(VELHO_TXT) },
      },
    ]);
    expect(v.cosmeticas).toEqual([]);
    const t = relatarPrecondicao(v);
    expect(t).toContain('casou por TOKENS');
    expect(t).toContain(MD5.prodVelho);
    expect(t).toContain(MD5.velho);
  });

  it('as checagens EXATAS vêm antes: o corpo da última, byte a byte, é EM_DIA — não variante', () => {
    // Corpo de prod IGUAL ao da última: os tokens também são iguais. Julgá-los antes trocaria EM_DIA
    // por VARIANTE, e o relatório diria "a menos de comentário" sobre o que está simplesmente em dia.
    const v = julgar(prod(MD5.novo, NOVO_TXT));
    expect(v.estado).toBe('LIBERADA');
    expect(v.cosmeticas).toEqual([]);
    expect(v.naoConferidas).toEqual([]);
  });

  it('EXCEÇÃO CONSERVADORA: a última só ACRESCENTOU comentário e prod = a anterior EXATA ⇒ segue bloqueando, pelo md5', () => {
    // Lógica idêntica (tokens iguais aos da última), mas a precedência EXATA diz CORPO_ANTERIOR —
    // documentado em corpo-esperado.ts. Afrouxar exigiria julgar tokens ANTES do exato, e é essa
    // inversão que este teste reprova.
    const v = julgar(prod(MD5.prodVelho, PROD_VELHO), [
      { migration: VELHA, md5: MD5.prodVelho, corpo: PROD_VELHO },
      { migration: NOVA, md5: '05b8a8354aaeb1e127c2f88bd81d6898', corpo: 'BEGIN\n  -- nota\n  RETURN 1;\nEND;' },
    ]);
    expect(v.estado).toBe('BLOQUEADA');
    expect(v.desatualizadas.map((d) => d.casouPor)).toEqual(['md5-exato']);
    expect(v.cosmeticas).toEqual([]);
    expect(relatarPrecondicao(v)).toContain('byte a byte');
  });

  it('empate: última e anterior com os MESMOS tokens, prod casando só por tokens ⇒ VARIANTE da última (a última primeiro, como no exato)', () => {
    const v = julgar(prod(MD5.prodVelho, PROD_VELHO), [
      { migration: VELHA, md5: '8c69c64be1d1bd0d2da2702eb912ab80', corpo: 'BEGIN\n  -- a\n  RETURN 1;\nEND;' },
      { migration: NOVA, md5: '111ba088d09292b0fc749b9587d77004', corpo: 'BEGIN\n  -- b\n  RETURN 1;\nEND;' },
    ]);
    expect(v.estado).toBe('LIBERADA');
    expect(v.cosmeticas.map((c) => c.esperada)).toEqual([NOVA]);
    expect(v.desatualizadas).toEqual([]);
  });

  it('DERIVA de verdade — nem byte a byte, nem por tokens — segue sem bloquear, e o motivo diz que os DOIS métodos rodaram', () => {
    const v = julgar(prod(MD5.editado, PROD_EDITADO));
    expect(v.estado).toBe('LIBERADA');
    expect(v.cosmeticas).toEqual([]);
    expect(v.naoConferidas.map((n) => n.rpc)).toEqual([RPC]);
    expect(v.naoConferidas[0].motivo).toMatch(/nem por tokens/);
    expect(v.naoConferidas[0].motivo).toMatch(/edição manual/);
  });

  it('sem o TEXTO de prod o re-teste não roda ⇒ INCERTA — nem "edição manual", nem "cosmética"', () => {
    const v = julgar(prod(MD5.prodNovo, null, ['o detalhe não trouxe o marcador `deriva-corpo/1` — saída truncada']));
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join('\n')).toMatch(/TOKENS/);
    expect(v.motivos.join('\n')).toContain('saída truncada');
    expect(v.cosmeticas).toEqual([]);
    expect(v.naoConferidas).toEqual([]);
  });

  it('texto que NÃO reproduz o md5 medido não é usado ⇒ INCERTA (usá-lo afirmaria sobre OUTRO corpo)', () => {
    // A sonda mediu o corpo EDITADO; o texto que chegou é o da última sem comentário. Usado às
    // cegas, ele daria VARIANTE_COSMETICA — verde — sobre uma edição manual.
    const v = julgar(prod(MD5.editado, PROD_NOVO));
    expect(v.estado).toBe('INCERTA');
    expect(v.cosmeticas).toEqual([]);
  });

  it('Codex P1 (código): falha do canal com texto VÁLIDO ⇒ INCERTA — a leitura incoerente não sustenta "cosmética"', () => {
    // Antes, o texto que reproduzia o md5 bastava, e a truncagem ficava só no relatório do canal.
    const v = julgar(prod(MD5.prodNovo, PROD_NOVO, ['o detalhe não trouxe o marcador `deriva-corpo/1` — saída truncada']));
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join('\n')).toContain('saída truncada');
    // E nenhum veredito POR TOKENS sai de um canal em que o gate disse não acreditar.
    expect(v.cosmeticas).toEqual([]);
  });

  it('canal incoerente ⇒ INCERTA mesmo com o corpo em dia byte a byte: a incoerência põe a leitura INTEIRA em dúvida', () => {
    // O caso do Codex: sonda diz 1 overload, detalhe diz 2 — o "em dia" pode ser o overload errado.
    const v = julgar(prod(MD5.novo, null, ['f: a sonda contou 1 overload(s) e o detalhe trouxe 2']));
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join('\n')).toMatch(/canal/);
  });

  it('o "APLIQUE" vem com a ressalva de DML — reaplicar o ARQUIVO inteiro re-executa backfill (os dois métodos)', () => {
    for (const v of [
      julgar(prod(MD5.prodVelho, PROD_VELHO)), // por tokens
      julgarSemTexto(ALVO, { ...leituraOk(), corpos: new Map([[RPC, { md5s: [MD5_VELHO], overloads: 1 }]]) }, 0, corposCom([
        { migration: VELHA, md5: MD5_VELHO, corpo: 'b' },
        { migration: NOVA, md5: MD5_ATUAL, corpo: 'a' },
      ])), // byte a byte
    ]) {
      const t = relatarPrecondicao(v);
      expect(t).toContain('APLIQUE essa migration');
      expect(t).toMatch(/reaplicar o ARQUIVO inteiro re-executa/);
      expect(t).toMatch(/20260606190000.*backfill one-time sobre pedidos vivos/);
    }
  });

  it('o caso REAL, de ponta a ponta (SQL → extração → histórico → veredito): `reposicao_persistir_qtde_inteira` é cosmética', () => {
    const nome = '20260606190000_reposicao_qtde_inteira_persist.sql';
    const sql = readFileSync(join(import.meta.dirname, '..', '..', 'supabase', 'migrations', nome), 'utf8');
    const historico = historicoDeCorpos([{ nome, sql }]);
    const rpc = 'reposicao_persistir_qtde_inteira';
    const versoes = historico.get(`public.${rpc}`) ?? [];
    expect(versoes.map((x) => x.md5)).toEqual(['fcc3048e4b173db55acddd207abd00fc']); // medido no banco (doc)
    // Prod = o corpo do arquivo menos as 3 linhas de comentário (L42, L43, L53). O md5 que isso tem
    // de dar foi MEDIDO no banco em 2026-09-26 e está digitado — se a fixture errar, isto acusa.
    const prodTxt = versoes[0].corpo.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    expect(md5Exato(prodTxt)).toBe('0f1d1cd2d9fefafa9465bd5fb287f200');
    const v = julgarPrecondicao(
      [{ rpc, edges: ['disparar-pedidos-aprovados'] }],
      {
        medicoes: [{ rpc, existe: true, familia: 40 }],
        corpos: new Map([[rpc, { md5s: ['0f1d1cd2d9fefafa9465bd5fb287f200'], overloads: 1 }]]),
        funcoesPublic: 1200,
        fim: true,
        dialetoOk: true,
      },
      0,
      { historico, inventarioDaRef: 721, migrationsLidas: 1, funcoesConhecidas: historico.size, vigencia: new Map() },
      { porNome: new Map([[rpc, [prodTxt]]]), falhas: [] },
    );
    expect(v.estado).toBe('LIBERADA');
    expect(v.cosmeticas).toEqual([
      expect.objectContaining({
        rpc,
        esperada: nome,
        prova: expect.objectContaining({
          md5Prod: '0f1d1cd2d9fefafa9465bd5fb287f200',
          md5Repo: 'fcc3048e4b173db55acddd207abd00fc',
        }),
      }),
    ]);
    expect(relatarPrecondicao(v)).not.toMatch(/edição manual/);
  });

  it('ponta a ponta, o lado que BLOQUEIA: duas migrations em SQL, prod = a 1ª sem comentário ⇒ CORPO_ANTERIOR por tokens', () => {
    const v1 = {
      nome: '20260101000000_v1.sql',
      sql: 'CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  -- desconto: 10\n  RETURN 10;\nEND;\n$$;\n',
    };
    const v2 = {
      nome: '20260202000000_v2.sql',
      sql: 'CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  -- desconto: 90\n  RETURN 90;\nEND;\n$$;\n',
    };
    const historico = historicoDeCorpos([v1, v2]);
    const prodTxt = '\nBEGIN\n  RETURN 10;\nEND;\n';
    const v = julgarPrecondicao(
      [{ rpc: 'f', edges: ['edge-x'] }],
      {
        medicoes: [{ rpc: 'f', existe: true, familia: 3 }],
        // A sonda simulada: o md5 é o que o BANCO calcularia do prosrc (`md5Exato`, a receita do banco).
        corpos: new Map([['f', { md5s: [md5Exato(prodTxt)], overloads: 1 }]]),
        funcoesPublic: 1200,
        fim: true,
        dialetoOk: true,
      },
      0,
      { historico, inventarioDaRef: 2, migrationsLidas: 2, funcoesConhecidas: historico.size, vigencia: new Map() },
      { porNome: new Map([['f', [prodTxt]]]), falhas: [] },
    );
    expect(v.estado).toBe('BLOQUEADA');
    expect(v.desatualizadas.map((d) => [d.emProd, d.esperada, d.casouPor])).toEqual([[v1.nome, v2.nome, 'tokens']]);
  });

  it('Codex P1 (código): `1e1 _0` × `1e1_0` — prod = a ANTERIOR sem comentário BLOQUEIA; e o inverso é DERIVA, não anterior', () => {
    const julgarCom = (hist: VersaoDeCorpo[], prodTxt: string) =>
      julgarPrecondicao(
        ALVO,
        { ...leituraOk([RPC]), corpos: new Map([[RPC, { md5s: [md5Exato(prodTxt)], overloads: 1 }]]) },
        0,
        corposCom(hist),
        { porNome: new Map([[RPC, [prodTxt]]]), falhas: [] },
      );
    const corpo = (migration: string, c: string): VersaoDeCorpo => ({ migration, md5: md5Exato(c), corpo: c });
    const bloqueia = julgarCom([corpo(VELHA, '-- anterior\nSELECT 1e1 _0;'), corpo(NOVA, 'SELECT 1e1_0;')], 'SELECT 1e1 _0;');
    expect(bloqueia.estado).toBe('BLOQUEADA');
    expect(bloqueia.desatualizadas.map((d) => [d.emProd, d.casouPor])).toEqual([[VELHA, 'tokens']]);
    expect(bloqueia.cosmeticas).toEqual([]);
    const inverso = julgarCom([corpo(VELHA, 'SELECT 1e1_0;'), corpo(NOVA, 'SELECT 7;')], 'SELECT 1e1 _0;');
    expect(inverso.estado).toBe('LIBERADA');
    expect(inverso.desatualizadas).toEqual([]);
    expect(inverso.naoConferidas.map((n) => n.rpc)).toEqual([RPC]);
  });

  describe('os reprodutores do Codex viram regressão do caminho por tokens', () => {
    const TAG = `$${'q'.repeat(130)}$`;
    /** Prod e repo com corpos que DIFEREM byte a byte (o exato não casa); quem decide é o re-teste. */
    const veredito = (repo: string, prodTxt: string) => {
      expect(md5Exato(repo)).not.toBe(md5Exato(prodTxt));
      return julgarPrecondicao(
        ALVO,
        // A sonda simulada: o md5 é o que o BANCO calcularia do prosrc.
        { ...leituraOk([RPC]), corpos: new Map([[RPC, { md5s: [md5Exato(prodTxt)], overloads: 1 }]]) },
        0,
        corposCom([{ migration: NOVA, md5: md5Exato(repo), corpo: repo }]),
        { porNome: new Map([[RPC, [prodTxt]]]), falhas: [] },
      );
    };

    const naoCosmeticos: [string, string, string][] = [
      ['P1: `\\r` isolado ENCERRA o comentário — o `RETURN 1` é código', 'BEGIN\n-- c\rRETURN 1;\nRETURN 2;\nEND;', 'BEGIN\nRETURN 2;\nEND;'],
      ["P1: continuação de E'' herda o escape — o `-- desconto=90` é LITERAL", "RETURN E'a'\n'x\\'\n-- desconto=90\n\\'';", "RETURN E'a'\n'x\\'\n-- desconto=10\n\\'';"],
      ["P1: continuação de E'' — apagar a \"linha de comentário\" muda o literal", "RETURN E'a'\n'x\\'\n-- desconto=90\n\\'';", "RETURN E'a'\n'x\\'\n\\'';"],
      ['P1: tag de dollar-quote com 130 letras — o conteúdo é literal', `SELECT ${TAG} -- desconto=90 ${TAG};`, `SELECT ${TAG} -- desconto=10 ${TAG};`],
      ["espaço DENTRO de literal: 'a  b' × 'a b'", "SELECT 'a  b';", "SELECT 'a b';"],
      ['comentário DENTRO de dollar-quote é conteúdo: =90 × =10', 'EXECUTE $q$ SELECT 1 -- desconto=90\n$q$;', 'EXECUTE $q$ SELECT 1 -- desconto=10\n$q$;'],
      ['P2: `a$q$` é identificador, não abre dollar-quote — o literal mudou', 'DECLARE a$q$ int := 1;\nBEGIN\nRETURN a$q$;\nEND;', 'DECLARE a$q$ int := 2;\nBEGIN\nRETURN a$q$;\nEND;'],      // Auto-challenge (Caminho B, 2026-10-02), MEDIDO em prod: `SELECT <NBSP>x FROM (SELECT 1 AS x) s`
      // → ERROR column " x" does not exist. Para o scan.l, NBSP/BOM/U+2028 são caractere de IDENTIFICADOR;
      // o `\s` do JS os engolia como espaço quando ABRIAM um token.
      ['espaço Unicode (NBSP) abrindo token é IDENTIFICADOR para o scan.l, não espaço', 'SELECT x FROM t;', 'SELECT \u00a0x FROM t;'],      // Parecer de código do Codex (2026-10-05), confirmado no PG17 de prod:
      ['Codex P1: `_` no expoente (1e1_0 = 10¹⁰) × número + alias (1e1 _0 = 10)', 'SELECT 1e1_0;', 'SELECT 1e1 _0;'],
      ['Codex P1: número colado em identificador é trailing junk no PG17 — `1abc` não é `1 abc`', 'SELECT 1 abc;', 'SELECT 1abc;'],
      ['Codex P2: comentário de BLOCO entre literais quebra a continuação', "SELECT 'a'\n'b';", "SELECT 'a'/*\n*/'b';"],
    ];
    for (const [rotulo, repo, prodTxt] of naoCosmeticos) {
      it(`NÃO é cosmético — ${rotulo}`, () => {
        const v = veredito(repo, prodTxt);
        expect(v.cosmeticas).toEqual([]);
        expect(v.estado).toBe('LIBERADA'); // DERIVA não bloqueia — mas fica declarada
        expect(v.naoConferidas.map((n) => n.rpc)).toEqual([RPC]);
      });
    }

    // Controles positivos na MESMA suíte: sem eles, um re-teste que nunca casa passaria em todos acima.
    const cosmeticos: [string, string, string][] = [
      ['`\\r` encerra o comentário e só ELE some', 'BEGIN\n-- c\rRETURN 1;\nRETURN 2;\nEND;', 'BEGIN\nRETURN 1;\nRETURN 2;\nEND;'],
      ['P2: `a$q$` é identificador e o `-- $q$` é comentário', 'DECLARE a$q$ int := 1;\nBEGIN\n-- $q$\nRETURN a$q$;\nEND;', 'DECLARE a$q$ int := 1;\nBEGIN\nRETURN a$q$;\nEND;'],
      ['comentário de bloco e espaço FORA de literal', "SELECT /* nota */ 'a  b',\n   1;", "SELECT 'a  b', 1;"],      // E o outro lado, também medido em prod: `SELECT\f1` e `SELECT\v1` devolvem 1 — \f e \v SÃO espaço.
      ['\\f e \\v SÃO espaço para o scan.l', 'SELECT 1;', 'SELECT\f1\v;'],
    ];
    for (const [rotulo, repo, prodTxt] of cosmeticos) {
      it(`É cosmético (controle) — ${rotulo}`, () => {
        const v = veredito(repo, prodTxt);
        expect(v.cosmeticas.map((c) => c.rpc)).toEqual([RPC]);
        expect(v.naoConferidas).toEqual([]);
      });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Parecer de CONFIRMAÇÃO do Codex (2026-10-05): o veredito por tokens só vale se os DOIS modos de
// standard_conforming_strings concordam — exigir os dois só para "cosmético" tirava o BLOQUEIO do
// anterior que casa em `on` (regressão da 1ª correção, reproduzida com corpo real do repo).
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('eixo 5 — os modos de standard_conforming_strings têm de CONCORDAR no veredito por tokens', () => {
  const RPC = 'reposicao_claim_disparo';
  const VELHA = '20260908163659_pedido_nasce_com_identidade_de_linha.sql';
  const NOVA = '20260908215704_desconto_valor_atravessa_os_escritores.sql';
  const corpo = (migration: string, c: string): VersaoDeCorpo => ({ migration, md5: md5Exato(c), corpo: c });
  /** A sonda simulada: o md5 é o que o BANCO calcularia do prosrc (`md5Exato`, a receita do banco). */
  const julgarCom = (hist: VersaoDeCorpo[], prodTxt: string, falhas: string[] = []) =>
    julgarPrecondicao(
      ALVO,
      { ...leituraOk([RPC]), corpos: new Map([[RPC, { md5s: [md5Exato(prodTxt)], overloads: 1 }]]) },
      0,
      corposCom(hist),
      { porNome: new Map([[RPC, [prodTxt]]]), falhas },
    );

  it('P1 (regressão da leitura dupla): anterior que só casa em `on` ⇒ INCERTA — nunca DERIVA liberada', () => {
    const v = julgarCom([corpo(VELHA, "SELECT '\\'::text; -- anterior\n"), corpo(NOVA, "SELECT 'novo'::text;")], "SELECT '\\'::text;");
    expect(v.estado).toBe('INCERTA');
    expect(v.motivos.join('\n')).toMatch(/standard_conforming_strings/);
    expect(v.cosmeticas).toEqual([]);
    expect(v.naoConferidas).toEqual([]);
  });

  it('o mesmo P1 com o corpo REAL de `melhoria_clientes_por_produto` (prod = a 1ª versão sem uma linha de comentário)', () => {
    const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
    const nomes = ['20260929000234_padrao_like_contem_escapa_curinga.sql', '20261001014100_universo_pedidos_recencia.sql'];
    const historico = historicoDeCorpos(nomes.map((nome) => ({ nome, sql: readFileSync(join(dir, nome), 'utf8') })));
    const versoes = historico.get('public.melhoria_clientes_por_produto') ?? [];
    expect(versoes.map((x) => x.migration)).toEqual(nomes);
    const linhas = versoes[0].corpo.split('\n');
    const i = linhas.findIndex((l) => l.includes('-- NULLS LAST e OBRIGATORIO'));
    expect(i).toBeGreaterThan(0);
    const prodTxt = [...linhas.slice(0, i), ...linhas.slice(i + 1)].join('\n');
    const rpc = 'melhoria_clientes_por_produto';
    const v = julgarPrecondicao(
      [{ rpc, edges: ['edge-x'] }],
      { medicoes: [{ rpc, existe: true, familia: 9 }], corpos: new Map([[rpc, { md5s: [md5Exato(prodTxt)], overloads: 1 }]]), funcoesPublic: 1200, fim: true, dialetoOk: true },
      0,
      { historico, inventarioDaRef: 2, migrationsLidas: 2, funcoesConhecidas: historico.size, vigencia: new Map() },
      { porNome: new Map([[rpc, [prodTxt]]]), falhas: [] },
    );
    expect(v.estado).not.toBe('LIBERADA');
    expect(v.cosmeticas).toEqual([]);
  });

  it("P1 `N'…'` com scs=off processa barra como o literal comum: a cosmética que só vale em `on` não passa", () => {
    const a = "SELECT N'a\\'--desconto=10\n';";
    const b = "SELECT N'a\\'--desconto=90\n';";
    const v = julgarCom([corpo(VELHA, `-- anterior\n${a}`), corpo(NOVA, b)], a);
    expect(v.estado).not.toBe('LIBERADA');
    expect(v.cosmeticas).toEqual([]);
  });

  it("P2 a herança do E'' no modo `on` separa um par que a leitura `off` não separa (ela se desalinha antes)", () => {
    const a = "SELECT '\\', '/*';\nSELECT E'a'\n'b\\'--desconto=10\n';";
    const b = "SELECT '\\', '/*';\nSELECT E'a'\n'b\\'--desconto=90\n';";
    const v = julgarCom([corpo(VELHA, `-- anterior\n${a}`), corpo(NOVA, b)], a);
    expect(v.estado).not.toBe('LIBERADA');
    expect(v.cosmeticas).toEqual([]);
  });

  it('Codex P1 (rodada 1): literal simples com barra antes da aspa — em `on` é cosmético, em `off` o `-- desconto` é LITERAL ⇒ INCERTA', () => {
    const v = julgarCom([corpo(NOVA, "SELECT 'a\\'--desconto=90\n';")], "SELECT 'a\\'--desconto=10\n';");
    expect(v.estado).toBe('INCERTA');
    expect(v.cosmeticas).toEqual([]);
  });

  it('controle: corpo sem barra que mude fronteira — os dois modos concordam e a cosmética segue valendo', () => {
    const v = julgarCom([corpo(VELHA, 'SELECT 1;'), corpo(NOVA, 'BEGIN\n  -- nota\n  RETURN 2;\nEND;')], 'BEGIN\n  RETURN 2;\nEND;');
    expect(v.estado).toBe('LIBERADA');
    expect(v.cosmeticas.map((c) => c.esperada)).toEqual([NOVA]);
  });

  it('P1 irmã da migration sem NENHUMA linha na sonda (nem `rpc`) ⇒ não medida — INCERTA, não "indecidível"', () => {
    const historico = new Map([
      ['public.f_chamada', [corpo(NOVA, 'SELECT 1;')]],
      ['public.g_irma', [corpo(VELHA, 'SELECT 7;'), corpo(NOVA, 'SELECT 8;')]],
    ]);
    const v = julgarPrecondicao(
      [{ rpc: 'f_chamada', edges: ['edge-x'] }],
      { medicoes: [{ rpc: 'f_chamada', existe: true, familia: 2 }], corpos: new Map([['f_chamada', { md5s: [md5Exato('SELECT 1;')], overloads: 1 }]]), funcoesPublic: 1200, fim: true, dialetoOk: true },
      0,
      { historico, inventarioDaRef: 2, migrationsLidas: 2, funcoesConhecidas: 2, vigencia: new Map() },
      { porNome: new Map([['f_chamada', ['SELECT 1;']]]), falhas: [] },
    );
    expect(v.estado).toBe('INCERTA');
    expect(v.naoMedidos).toContain('g_irma');
  });

  it('P2 INCERTA com anterior EXATO: o relatório diagnostica, mas não manda aplicar — manda remedir', () => {
    const v = julgarCom([corpo(VELHA, 'SELECT 7;'), corpo(NOVA, 'SELECT 8;')], 'SELECT 7;', ['o detalhe não trouxe o marcador `deriva-corpo/1` — saída truncada']);
    expect(v.estado).toBe('INCERTA');
    expect(v.desatualizadas.map((d) => d.emProd)).toEqual([VELHA]);
    const t = relatarPrecondicao(v);
    expect(t).not.toContain('APLIQUE essa migration');
    expect(t).toContain('corrija a medição');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Codex, rodada 3 do #2757 (P1 PREEXISTENTE, executado): a irmã da migration medida como AUSENTE
// (`rpc|g|NAO|…`, `n|g|0`) caía em "sem corpo textual comparável" e a leva saía LIBERADA — `f` no ar
// chamando `g`, que a migration não criou, e a falha só em runtime. Mas ausente também é a irmã que
// uma migration POSTERIOR aposentou (DROP, SET SCHEMA, RENAME), e o histórico de corpos só modela
// CREATE: quem separa as duas é a vigência no repo (`modelarRepo`, via `CorposEsperados.vigencia`).
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('irmã AUSENTE em prod — a vigência no repo decide (Codex, rodada 3 do #2757)', () => {
  const M = '20260908215704_desconto_valor_atravessa_os_escritores.sql';
  const ANTERIOR = '20260908163659_pedido_nasce_com_identidade_de_linha.sql';
  const DROP = '20260915000000_aposenta_g_irma.sql';
  const corpo = (migration: string, c: string): VersaoDeCorpo => ({ migration, md5: md5Exato(c), corpo: c });
  const CORPO_F = 'BEGIN RETURN public.g_irma(); END;';
  const CORPO_G = 'BEGIN RETURN 7; END;';
  const CORPO_G_ANTERIOR = 'BEGIN RETURN 6; END;';
  const ALVO_F: AlvoRpc[] = [{ rpc: 'f_chama_g', edges: ['edge-x'] }];
  const historico = new Map([
    ['public.f_chama_g', [corpo(M, CORPO_F)]],
    ['public.g_irma', [corpo(ANTERIOR, CORPO_G_ANTERIOR), corpo(M, CORPO_G)]],
  ]);
  const VIGENTE: VigenciaNoRepo = { estado: 'VIGENTE', ultimosCreates: [M] };
  /** prod: `f` presente com o corpo da M (EM_DIA); `g` MEDIDA — ausente por default, sem linha de corpo. */
  const leitura = (g: { existe: boolean; corpo?: string } = { existe: false }): LeituraSonda => {
    const corpos = new Map<string, CorpoVivo>([['f_chama_g', { md5s: [md5Exato(CORPO_F)], overloads: 1 }]]);
    if (g.corpo !== undefined) corpos.set('g_irma', { md5s: [md5Exato(g.corpo)], overloads: 1 });
    return {
      medicoes: [
        { rpc: 'f_chama_g', existe: true, familia: 3 },
        { rpc: 'g_irma', existe: g.existe, familia: 0 },
      ],
      corpos,
      funcoesPublic: 1200,
      fim: true,
      dialetoOk: true,
    };
  };
  const corposCom = (vigencia: ReadonlyMap<string, VigenciaNoRepo>): CorposEsperados => ({
    historico,
    inventarioDaRef: 2,
    migrationsLidas: 2,
    funcoesConhecidas: 2,
    vigencia,
  });
  const julgar = (vigencia: ReadonlyMap<string, VigenciaNoRepo>, l = leitura(), indirecoes = 0) =>
    julgarPrecondicao(ALVO_F, l, indirecoes, corposCom(vigencia), SEM_TEXTOS);
  const com = (g: VigenciaNoRepo) => new Map<string, VigenciaNoRepo>([['f_chama_g', VIGENTE], ['g_irma', g]]);

  it('P1 (reprodutor do Codex): irmã VIGENTE e AUSENTE ⇒ BLOQUEADA — a migration não foi aplicada por inteiro', () => {
    const v = julgar(com(VIGENTE));
    expect(v.estado).toBe('BLOQUEADA');
    expect(v.ausentes).toEqual([
      { rpc: 'g_irma', edges: [], familia: 0, irma: { de: [{ alvo: 'f_chama_g', migration: M }], ultimosCreates: [M] } },
    ]);
    // Deixou de ser "fora do alcance": o gate AFIRMOU a ausência.
    expect(v.naoConferidas.map((n) => n.rpc)).not.toContain('g_irma');
  });

  it('controle (mesma invocação): a irmã PRESENTE com o corpo da última ⇒ LIBERADA — existir é o que a regra cobra', () => {
    const v = julgar(com(VIGENTE), leitura({ existe: true, corpo: CORPO_G }));
    expect(v.estado).toBe('LIBERADA');
    expect(v.ausentes).toEqual([]);
  });

  it('controle: irmã VIGENTE presente com o corpo ANTERIOR segue BLOQUEADA pelo eixo de corpo (o que já valia)', () => {
    const v = julgar(com(VIGENTE), leitura({ existe: true, corpo: CORPO_G_ANTERIOR }));
    expect(v.estado).toBe('BLOQUEADA');
    expect(v.desatualizadas.map((d) => [d.rpc, d.emProd])).toEqual([['g_irma', ANTERIOR]]);
  });

  it('irmã APOSENTADA (DROP/SET SCHEMA/RENAME posterior) e ausente ⇒ não conta: LIBERADA, e o relatório diz por quê', () => {
    const v = julgar(com({ estado: 'APOSENTADA', por: [DROP] }));
    expect(v.estado).toBe('LIBERADA');
    expect(v.ausentes).toEqual([]);
    const g = v.naoConferidas.find((n) => n.rpc === 'g_irma');
    expect(g?.motivo).toContain('APOSENTADA');
    expect(g?.motivo).toContain(DROP);
  });

  it('irmã APOSENTADA mas PRESENTE com o corpo ANTERIOR ⇒ não conta: o gate não manda APLICAR o CREATE de uma função que o repo removeu', () => {
    const v = julgar(com({ estado: 'APOSENTADA', por: [DROP] }), leitura({ existe: true, corpo: CORPO_G_ANTERIOR }));
    expect(v.estado).toBe('LIBERADA');
    expect(v.desatualizadas).toEqual([]);
    expect(v.naoConferidas.find((n) => n.rpc === 'g_irma')?.motivo).toContain('EXISTE em prod');
  });

  it('irmã com vigência INDETERMINADA e ausente ⇒ INCERTA, com o motivo do modelo', () => {
    const v = julgar(com({ estado: 'INDETERMINADA', motivo: 'assinatura que não se resolve' }));
    expect(v.estado).toBe('INCERTA');
    expect(v.ausentes).toEqual([]);
    expect(v.motivos.join('\n')).toMatch(/g_irma.*assinatura que não se resolve/);
  });

  it('irmã ausente que o modelo do repo NÃO conhece (fora do mapa) ⇒ INCERTA — ausente ≠ vigente, e ≠ aposentada', () => {
    const v = julgar(new Map([['f_chama_g', VIGENTE]]));
    expect(v.estado).toBe('INCERTA');
    expect(v.ausentes).toEqual([]);
    expect(v.motivos.join('\n')).toMatch(/g_irma/);
  });

  it('irmã que TAMBÉM é RPC da leva e está ausente: um alvo só, com as edges — sem segunda entrada de irmã', () => {
    const v = julgarPrecondicao([...ALVO_F, { rpc: 'g_irma', edges: ['edge-y'] }], leitura(), 0, corposCom(com(VIGENTE)), SEM_TEXTOS);
    expect(v.estado).toBe('BLOQUEADA');
    expect(v.ausentes).toEqual([{ rpc: 'g_irma', edges: ['edge-y'], familia: 0 }]);
  });

  it('relatório BLOQUEADA: nomeia a irmã, de onde ela veio e o último CREATE, e manda APLICAR com a ressalva de DML — sem a ação de família', () => {
    const t = relatarPrecondicao(julgar(com(VIGENTE)));
    expect(t).toContain('`g_irma`');
    expect(t).toContain('nenhuma edge da leva a chama');
    expect(t).toContain(`\`f_chama_g\` em \`${M}\``);
    expect(t).toContain('APLIQUE essa migration');
    expect(t).toContain('reaplicar o ARQUIVO inteiro re-executa');
    // "diagnostique, não reaplique" é a ação do ALVO ausente de família vazia — a irmã não a herda.
    expect(t).not.toContain('diagnostique');
  });

  it('relatório INCERTA com irmã VIGENTE ausente: diagnostica, mas não manda aplicar — manda remedir', () => {
    const v = julgar(com(VIGENTE), leitura(), 1);
    expect(v.estado).toBe('INCERTA');
    const t = relatarPrecondicao(v);
    expect(t).toContain('`g_irma`');
    expect(t).not.toContain('APLIQUE essa migration');
    expect(t).toContain('corrija a medição');
  });
});
