import { describe, it, expect } from 'vitest';
import {
  CLASSES_BLOQUEANTES,
  classificar,
  enumerarEdges,
  extrairOcorrencias,
  semAnsi,
} from './edges-typecheck-gate';

/**
 * Fixtures são saída REAL do `deno check` capturada em 2026-07-21 (deno 2.9.2, o pin do CI) contra
 * este repo. Nada sintético: o valor do gate está em acertar o formato do Deno, e formato inventado
 * testaria o parser contra a minha suposição em vez de contra a ferramenta.
 *
 * O teste é OFFLINE por desenho (só strings) — teste de edge não pode ter dep remota, senão o
 * jsr.io/npm entra no caminho de entrega de todo PR. Ver docs/historico/ci-testes-edge-deno.md.
 */

const RAIZ = '/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/dazzling-pare-167cec';

/** Cache de check quente: saída vazia + exit 0. É o caso de SUCESSO normal (armadilha 3). */
const VAZIO = '\n';

/** 1 erro apenas → o Deno OMITE a linha `Found N errors.` (armadilha 2). Forma típica do #1498. */
const SABOTADO_UM_ERRO = `Check supabase/functions/calculate-scores/index.ts
TS2304 [ERROR]: Cannot find name 'simboloQueNaoExiste'.
const _sab = simboloQueNaoExiste(1);
             ~~~~~~~~~~~~~~~~~~~
    at file://${RAIZ}/supabase/functions/calculate-scores/index.ts:658:14

error: Type checking failed.
`;

/** Classe-crash ISOLADA no meio da dívida tolerada, na mesma edge (money-path, suja). */
const MISTO = `Check supabase/functions/omie-financeiro/index.ts
TS2345 [ERROR]: Argument of type '{ parameter: string; value: "omie_sync" | "edge_fn" | "cron"; is_local: boolean; }' is not assignable to parameter of type 'undefined'.
  await supabase.rpc('set_config', {
                                   ^
    at file://${RAIZ}/supabase/functions/omie-financeiro/index.ts:332:36

TS2345 [ERROR]: Argument of type 'SupabaseClient<any, "public", "public", any, any>' is not assignable to parameter of type 'SupabaseClient<unknown, { PostgrestVersion: string; }, never, never, { PostgrestVersion: string; }>'.
  Types of property 'rest' are incompatible.
    Type 'PostgrestClient<any, any, "public", any>' is not assignable to type 'PostgrestClient<unknown, { PostgrestVersion: string; }, never, never>'.
      Type '"public"' is not assignable to type 'never'.
    await setAuditOrigem(supabase, 'omie_sync');
                         ~~~~~~~~
    at file://${RAIZ}/supabase/functions/omie-financeiro/index.ts:2092:26

TS2571 [ERROR]: Object is of type 'unknown'.
      const total = resp.total_de_registros;
                    ~~~~
    at file://${RAIZ}/supabase/functions/omie-financeiro/index.ts:701:21

TS2304 [ERROR]: Cannot find name 'helperInexistente'.
const _sab = helperInexistente(1);
             ~~~~~~~~~~~~~~~~~
    at file://${RAIZ}/supabase/functions/omie-financeiro/index.ts:2431:14

Found 11 errors.

error: Type checking failed.
`;

/** Dívida pré-existente pura: nenhuma classe-crash. É o baseline verde de hoje (141 erros). */
const SO_DIVIDA = `Check supabase/functions/omie-financeiro/index.ts
TS2571 [ERROR]: Object is of type 'unknown'.
      const total = resp.total_de_registros;
                    ~~~~
    at file://${RAIZ}/supabase/functions/omie-financeiro/index.ts:701:21

TS2578 [ERROR]: Unused '@ts-expect-error' directive.
      // @ts-expect-error - fin_contas_receber may not be in generated supabase types yet
      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    at file://${RAIZ}/supabase/functions/fin-cashflow-engine/index.ts:214:7

TS2339 [ERROR]: Property 'product_id' does not exist on type 'never'.
    at file://${RAIZ}/supabase/functions/recommend/index.ts:88:31

Found 141 errors.

error: Type checking failed.
`;

/**
 * Falha de RESOLUÇÃO — o que acontece sem `--node-modules-dir=none` (armadilha 1). Repare que NÃO
 * há `error: Type checking failed.`: o Deno abortou antes de type-checar coisa alguma.
 */
const RESOLUCAO = `error: Could not find a matching package for 'npm:@simplewebauthn/server@10.0.1' in the node_modules directory. Ensure you have all your JSR and npm dependencies listed in your deno.json or package.json, then run \`deno install\`. Alternatively, turn on auto-install by specifying \`"nodeModulesDir": "auto"\` in your deno.json file.
    at file://${RAIZ}/supabase/functions/biometric-auth/index.ts:3:46
`;

describe('classificar — o caminho feliz', () => {
  it('exit 0 com saída vazia (cache de check quente) passa', () => {
    // Armadilha 3: saída vazia é SUCESSO normal, não anomalia. Se isto virar "bloqueia", todo PR
    // com cache quente fica vermelho; se a regra pendesse do volume de saída, seria falso-verde.
    expect(classificar(VAZIO, 0).tipo).toBe('passa');
  });

  it('dívida pré-existente sem classe-crash passa, e reporta as toleradas', () => {
    const v = classificar(SO_DIVIDA, 1, RAIZ);
    expect(v.tipo).toBe('passa');
    if (v.tipo !== 'passa') throw new Error('inalcançável');
    expect(v.toleradas.map((o) => o.codigo)).toEqual(['TS2571', 'TS2578', 'TS2339']);
  });
});

describe('classificar — a classe que quebra em runtime (#1498)', () => {
  it('bloqueia com UM erro só, quando o Deno omite a linha `Found N errors.`', () => {
    // Armadilha 2: se o gate exigisse `Found N errors.` como marcador, ficaria cego exatamente
    // aqui — e 1 erro é a forma típica do símbolo faltando no import.
    expect(SABOTADO_UM_ERRO).not.toContain('Found ');
    const v = classificar(SABOTADO_UM_ERRO, 1, RAIZ);
    expect(v.tipo).toBe('bloqueia');
    if (v.tipo !== 'bloqueia' || v.motivo !== 'classe-crash') throw new Error('esperava classe-crash');
    expect(v.bloqueantes).toHaveLength(1);
    expect(v.bloqueantes[0].codigo).toBe('TS2304');
    expect(v.bloqueantes[0].arquivo).toBe('supabase/functions/calculate-scores/index.ts');
    expect(v.bloqueantes[0].linha).toBe(658);
  });

  it('isola a classe-crash no meio da dívida tolerada da mesma edge', () => {
    // É o que permite gatear as 25 edges sujas sem allowlist: o veredito não é "o arquivo está
    // vermelho", é "apareceu um erro DESTA classe".
    const v = classificar(MISTO, 1, RAIZ);
    expect(v.tipo).toBe('bloqueia');
    if (v.tipo !== 'bloqueia' || v.motivo !== 'classe-crash') throw new Error('esperava classe-crash');
    expect(v.bloqueantes.map((o) => o.codigo)).toEqual(['TS2304']);
    expect(v.toleradas.map((o) => o.codigo)).toEqual(['TS2345', 'TS2345', 'TS2571']);
  });
});

describe('classificar — fail-closed ("ausência de sinal NÃO é aprovação")', () => {
  it('bloqueia quando o deno aborta na RESOLUÇÃO, sem chegar a type-checar', () => {
    // Armadilha 1. Sem `--node-modules-dir=none` é literalmente isto que acontece neste repo.
    const v = classificar(RESOLUCAO, 1, RAIZ);
    expect(v.tipo).toBe('bloqueia');
    if (v.tipo !== 'bloqueia' || v.motivo !== 'infra') throw new Error('esperava infra');
    expect(v.detalhe).toContain('Could not find a matching package');
  });

  it('bloqueia em exit≠0 sem saída nenhuma (rede caiu, binário sumiu)', () => {
    const v = classificar('', 1);
    expect(v.tipo).toBe('bloqueia');
    if (v.tipo !== 'bloqueia' || v.motivo !== 'infra') throw new Error('esperava infra');
  });

  it('bloqueia se disser que type-check falhou mas nada for parseável (formato mudou)', () => {
    // Guarda contra bump do Deno: um parser cego que devolve "0 bloqueantes" é falso-verde.
    const v = classificar('error: Type checking failed.\n', 1);
    expect(v.tipo).toBe('bloqueia');
    if (v.tipo !== 'bloqueia' || v.motivo !== 'infra') throw new Error('esperava infra');
    expect(v.detalhe).toContain('formato de saída mudou');
  });
});

describe('extrairOcorrencias', () => {
  it('não rouba a âncora do erro seguinte quando um erro vem sem âncora', () => {
    const s = `TS2304 [ERROR]: Cannot find name 'a'.
TS2339 [ERROR]: Property 'b' does not exist.
    at file:///r/supabase/functions/x/index.ts:10:1
`;
    const ocs = extrairOcorrencias(s, '/r');
    expect(ocs).toHaveLength(2);
    expect(ocs[0].arquivo).toBeNull();
    expect(ocs[1].arquivo).toBe('supabase/functions/x/index.ts');
  });

  it('sobrevive a códigos ANSI (saída de TTY)', () => {
    const comAnsi = `\x1b[1m\x1b[31mTS2304\x1b[0m [ERROR]: Cannot find name 'x'.`;
    expect(extrairOcorrencias(semAnsi(comAnsi))).toHaveLength(1);
  });
});

describe('invariantes do gate', () => {
  it('as 6 classes bloqueantes são as de "não resolve" — nenhuma de incompatibilidade', () => {
    // Trava a decisão precisão>recall do desenho: TS2345/2322/2339/2571/2578 são a dívida de 141
    // que o gate TOLERA de propósito. Incluir uma delas aqui deixaria o gate vermelho na main.
    expect([...CLASSES_BLOQUEANTES].sort()).toEqual([
      'TS2304',
      'TS2305',
      'TS2307',
      'TS2503',
      'TS2552',
      'TS2724',
    ]);
    for (const divida of ['TS2345', 'TS2322', 'TS2339', 'TS2571', 'TS2578', 'TS2769']) {
      expect(CLASSES_BLOQUEANTES.has(divida)).toBe(false);
    }
  });

  it('enumera as edges do repo de verdade (glob vazio seria falso-verde)', () => {
    // O gate expande o glob no TS e não no shell: zsh aborta com "no matches found", bash passa o
    // glob literal. 0 edges tem que ser FALHA, não "nada a checar".
    // `process.cwd()` e não `import.meta.url`: sob Vite/vitest o segundo vira o caminho VIRTUAL
    // `/@fs/…`, que não existe no disco — o teste passaria a medir 0 edges por acidente de bundler.
    const edges = enumerarEdges(process.cwd());
    expect(edges.length).toBeGreaterThan(80);
    expect(edges.every((e) => e.endsWith('/index.ts'))).toBe(true);
  });
});
