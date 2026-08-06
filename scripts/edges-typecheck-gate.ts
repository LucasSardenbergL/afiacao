#!/usr/bin/env bun
/**
 * edges-typecheck-gate.ts — gate de CI que type-checa as EDGE FUNCTIONS (Deno).
 * ============================================================================================
 *
 * O BURACO QUE ELE TAPA. Nenhum gate do repo type-checava `supabase/functions/`:
 *   - `bun run typecheck` (tsc) → `tsconfig.app.json` cobre só `src/` + testes;
 *   - `bun run test` (vitest) → `include` é `src/**` + `scripts/**`;
 *   - `bun lint` (eslint)    → não type-checa, e não roda em Deno;
 *   - `bun run test:edges`   → `deno test` só type-checa o grafo que os TESTES alcançam, e por
 *     desenho os 15 arquivos de teste testam lógica PURA extraída (ver
 *     docs/historico/ci-testes-edge-deno.md) — nenhum `index.ts` de edge entra no grafo.
 * Resultado: erro de tipo numa edge ficava VERDE em todos os gates e só quebrava em RUNTIME na
 * produção, depois do deploy manual pelo chat do Lovable. Detectado no PR #1498: `classifyProfile`
 * usado sem estar no import em generate-tactical-plan/index.ts passou por 5.527 testes vitest, 181
 * testes deno, typecheck e lint — só apareceu num `deno check` manual.
 *
 * PRECISÃO > RECALL: por que só 6 classes. Hoje as 93 edges têm 141 erros de tipo em 25 delas,
 * quase todos ruído dos tipos gerados do Supabase (`... does not exist on type 'never'`,
 * `@ts-expect-error` obsoleto, e 17 `SupabaseClient not assignable` causados por @supabase/
 * supabase-js aparecer em 6 versões distintas). Código que RODA BEM. Já a classe "símbolo ou módulo
 * não resolve" — a do #1498 — está em ZERO nas 93. Gatear só nela dá um gate VERDE HOJE sem
 * allowlist nenhuma, cobrindo inclusive as 25 sujas e as de money-path. A alternativa (check
 * completo + denylist das 25) excluiria justamente fin-cashflow-engine,
 * enviar-pedido-portal-sayerlack, omie-financeiro e recommend — o gate protegendo onde o risco é
 * MENOR — e criaria um arquivo-lista que vira ímã de conflito entre as ~30 worktrees paralelas.
 * Apertar para check completo é o destino natural, depois que a dívida encolher.
 *
 * TRÊS ARMADILHAS VALIDADAS EMPIRICAMENTE (2026-07-21, deno 2.9.2 — o pin do CI):
 *
 *  1. `--node-modules-dir=none` é OBRIGATÓRIO. Sem ele o `deno check` ABORTA na RESOLUÇÃO, antes
 *     de type-checar qualquer coisa: o package.json da raiz põe o Deno em modo node_modules e o
 *     `npm:@simplewebauthn/server@10.0.1` de biometric-auth não está lá. Bônus: esse modo é mais
 *     fiel ao Edge Runtime real do Supabase, que resolve `npm:` do próprio registry sem
 *     node_modules. O `test:edges` nunca esbarrou nisso porque o `--no-remote` corta antes.
 *
 *  2. O marcador de "rodou e type-checou" é `error: Type checking failed.`, NÃO `Found N errors.`:
 *     com EXATAMENTE 1 erro o Deno omite a linha de contagem. Usar a contagem como marcador
 *     deixaria o gate cego justo no caso de 1 erro — que é a forma típica do #1498.
 *
 *  3. Com o cache de check quente a saída é COMPLETAMENTE VAZIA e exit 0. Ou seja, "saída vazia"
 *     é o caso de SUCESSO normal — não pode ser lido como anomalia. A decisão pende do exit code
 *     + do marcador acima, nunca do volume de saída.
 *
 * FAIL-CLOSED (CLAUDE.md: "ausência de sinal NÃO é aprovação"):
 *   exit 0                              → passa
 *   exit≠0 + marcador de type-check     → parseia e classifica; bloqueia só se houver classe-crash
 *   exit≠0 SEM o marcador               → BLOQUEIA (rede caiu, resolução quebrou, formato mudou).
 *                                         Não conseguir checar ≠ estar limpo.
 * O glob é expandido AQUI (readdirSync), não no shell: o zsh aborta com "no matches found" e o
 * bash passa o glob literal — e um glob que não casa nada viraria verde silencioso. 0 edges = falha.
 * Parse em TypeScript e não em `grep`: imune ao shim `ugrep` e à dobra de acento por locale que
 * produziu o falso-verde do #1483.
 *
 * Uso:  bun run edges:typecheck            # roda no CI (ci.yml, job validate) e local
 *       bun scripts/edges-typecheck-gate.ts --json
 * Custo: ~48s cold (DENO_DIR virgem, 2.245 downloads), ~2,5s warm. Sem actions/cache de propósito:
 * o DENO_DIR é 681 MB (677 de tarballs npm) e economizaria ~30s consumindo ~7% do budget do repo.
 * Spec: docs/superpowers/specs/2026-07-21-edges-typecheck-gate-design.md
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Classes que significam "isto QUEBRA ao executar": o símbolo, módulo ou membro não existe.
 * Deliberadamente NÃO inclui as classes de incompatibilidade de tipo (TS2345/2322/2339/...), que
 * hoje somam a dívida de 141 e descrevem código que roda. Ver o cabeçalho.
 */
export const CLASSES_BLOQUEANTES: ReadonlySet<string> = new Set([
  'TS2304', // Cannot find name 'X'            ← a forma exata do #1498
  'TS2552', // Cannot find name 'X'. Did you mean 'Y'?
  'TS2307', // Cannot find module 'X'
  'TS2305', // Module 'X' has no exported member 'Y'
  'TS2724', // 'X' has no exported member named 'Y'. Did you mean 'Z'?
  'TS2503', // Cannot find namespace 'X'
]);

/** Marcador de que o Deno chegou a type-checar (ver armadilha 2 no cabeçalho). */
const MARCADOR_TYPECHECK = 'error: Type checking failed.';

export interface Ocorrencia {
  codigo: string;
  mensagem: string;
  /** Caminho relativo à raiz do repo, ou null se a âncora `at file://` não veio. */
  arquivo: string | null;
  linha: number | null;
}

export type Veredito =
  | { tipo: 'passa'; toleradas: Ocorrencia[] }
  | { tipo: 'bloqueia'; motivo: 'classe-crash'; bloqueantes: Ocorrencia[]; toleradas: Ocorrencia[] }
  | { tipo: 'bloqueia'; motivo: 'infra'; detalhe: string };

// O ESC vai como `\x1b` escapado, não como o byte cru: o byte literal dispara `no-control-regex` no
// ESLint (e fica invisível em diff/review). O deno só emite ANSI quando a saída é TTY — no CI, via
// spawnSync, não emite; o strip existe para a execução local.
// eslint-disable-next-line no-control-regex
const RE_ANSI = /\x1b\[[0-9;]*m/g;
const RE_ERRO = /^(TS\d+) \[ERROR\]: (.*)$/;
const RE_ANCORA = /^\s+at file:\/\/(\S+?):(\d+):(\d+)\s*$/;

export function semAnsi(s: string): string {
  return s.replace(RE_ANSI, '');
}

/** Extrai (código, mensagem, arquivo, linha) de cada `TS#### [ERROR]:` da saída do `deno check`. */
export function extrairOcorrencias(saidaLimpa: string, raiz = ''): Ocorrencia[] {
  const linhas = saidaLimpa.split('\n');
  const out: Ocorrencia[] = [];
  for (let i = 0; i < linhas.length; i++) {
    const m = RE_ERRO.exec(linhas[i]);
    if (!m) continue;
    // A âncora `at file://…` vem depois da mensagem e do trecho de código. Para no próximo erro
    // para não roubar a âncora dele quando este vier sem âncora nenhuma.
    let arquivo: string | null = null;
    let linha: number | null = null;
    for (let j = i + 1; j < linhas.length; j++) {
      if (RE_ERRO.test(linhas[j])) break;
      const a = RE_ANCORA.exec(linhas[j]);
      if (a) {
        arquivo = raiz && a[1].startsWith(raiz) ? a[1].slice(raiz.length).replace(/^\//, '') : a[1];
        linha = Number(a[2]);
        break;
      }
    }
    out.push({ codigo: m[1], mensagem: m[2], arquivo, linha });
  }
  return out;
}

/**
 * O coração do gate — PURO, para ser testável offline (o teste não pode ter dep remota; ver
 * docs/historico/ci-testes-edge-deno.md). Recebe a saída combinada do `deno check` e o exit code.
 */
export function classificar(saida: string, exitCode: number, raiz = ''): Veredito {
  const limpa = semAnsi(saida);

  // Armadilha 3: com cache quente a saída é vazia e exit 0. Sucesso normal.
  if (exitCode === 0) return { tipo: 'passa', toleradas: [] };

  // Armadilha 2 + fail-closed: sem o marcador, o Deno não chegou a type-checar. Rede, resolução
  // (`Could not find a matching package`), permissão, binário ausente… Não sabemos ≠ está limpo.
  if (!limpa.includes(MARCADOR_TYPECHECK)) {
    const primeiraLinhaErro = limpa
      .split('\n')
      .find((l) => l.startsWith('error:') || l.startsWith('Error:'));
    return {
      tipo: 'bloqueia',
      motivo: 'infra',
      detalhe: primeiraLinhaErro?.trim() || '(deno check falhou sem mensagem reconhecível)',
    };
  }

  const ocorrencias = extrairOcorrencias(limpa, raiz);

  // Disse que type-check falhou mas não conseguimos parsear NENHUM erro → o formato da saída mudou
  // (bump do Deno?). Fail-closed: um parser cego que devolve "0 bloqueantes" é falso-verde.
  if (ocorrencias.length === 0) {
    return {
      tipo: 'bloqueia',
      motivo: 'infra',
      detalhe:
        'deno check reportou falha de type-check mas nenhum `TS#### [ERROR]:` foi parseado — ' +
        'formato de saída mudou? (conferir após bump do Deno)',
    };
  }

  const bloqueantes = ocorrencias.filter((o) => CLASSES_BLOQUEANTES.has(o.codigo));
  const toleradas = ocorrencias.filter((o) => !CLASSES_BLOQUEANTES.has(o.codigo));

  return bloqueantes.length > 0
    ? { tipo: 'bloqueia', motivo: 'classe-crash', bloqueantes, toleradas }
    : { tipo: 'passa', toleradas };
}

/** Enumera os `index.ts` de cada pasta sob `supabase/functions/` — no TS, não no shell (ver cabeçalho). */
export function enumerarEdges(raiz: string): string[] {
  const base = join(raiz, 'supabase', 'functions');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join('supabase', 'functions', d.name, 'index.ts'))
    .filter((rel) => existsSync(join(raiz, rel)))
    .sort();
}

/** Agrupa por código, para reportar a dívida tolerada de forma compacta. */
function resumirPorCodigo(ocs: Ocorrencia[]): string {
  const porCodigo = new Map<string, number>();
  for (const o of ocs) porCodigo.set(o.codigo, (porCodigo.get(o.codigo) ?? 0) + 1);
  return [...porCodigo.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c}:${n}`)
    .join(' ');
}

function formatar(o: Ocorrencia): string {
  const local = o.arquivo ? `${o.arquivo}${o.linha ? `:${o.linha}` : ''}` : '(local desconhecido)';
  return `   ${o.codigo}  ${local}\n           ${o.mensagem}`;
}

function main(): number {
  const json = process.argv.includes('--json');
  const raiz = join(import.meta.dir, '..');
  const edges = enumerarEdges(raiz);

  if (edges.length === 0) {
    console.error(
      '❌ edges-typecheck-gate: nenhuma edge encontrada em supabase/functions/*/index.ts.\n' +
        '   Isso não é "nada a checar" — é o gate sem alvo. Conferir o layout do repo.',
    );
    return 1;
  }

  const args = ['check', '--no-lock', '--node-modules-dir=none', ...edges];
  const proc = spawnSync('deno', args, { cwd: raiz, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  if (proc.error) {
    console.error(`❌ edges-typecheck-gate: não consegui executar o deno — ${proc.error.message}`);
    return 1;
  }

  const saida = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
  const veredito = classificar(saida, proc.status ?? 1, raiz);

  if (json) {
    console.log(JSON.stringify({ edges: edges.length, veredito }, null, 2));
    return veredito.tipo === 'passa' ? 0 : 1;
  }

  console.log(`🔎 edges-typecheck-gate — ${edges.length} edges · deno check ${args.slice(1, 3).join(' ')}`);

  if (veredito.tipo === 'bloqueia' && veredito.motivo === 'infra') {
    console.error(
      `\n❌ NÃO FOI POSSÍVEL TYPE-CHECAR as edges (exit ${proc.status}).\n` +
        `   ${veredito.detalhe}\n\n` +
        '   Bloqueando de propósito: não conseguir checar não é o mesmo que estar limpo\n' +
        '   (CLAUDE.md — "ausência de sinal NÃO é aprovação").',
    );
    return 1;
  }

  if (veredito.tipo === 'bloqueia') {
    console.error(
      `\n❌ ${veredito.bloqueantes.length} erro(s) de classe que QUEBRA EM RUNTIME ` +
        '(símbolo/módulo/membro não resolve):\n',
    );
    for (const o of veredito.bloqueantes) console.error(formatar(o));
    if (veredito.toleradas.length > 0) {
      console.error(
        `\n   (${veredito.toleradas.length} erro(s) de outras classes ignorados — dívida conhecida: ` +
          `${resumirPorCodigo(veredito.toleradas)})`,
      );
    }
    console.error(
      '\n   Essa é a classe do PR #1498: passa por typecheck, vitest, deno test e lint,\n' +
        '   e só quebra em RUNTIME na produção depois do deploy manual pelo Lovable.',
    );
    return 1;
  }

  if (veredito.toleradas.length > 0) {
    console.log(
      `✅ 0 erros de classe-crash.\n` +
        `   ${veredito.toleradas.length} erro(s) de outras classes tolerados (dívida conhecida): ` +
        `${resumirPorCodigo(veredito.toleradas)}\n` +
        '   Ver os follow-ups no spec: docs/superpowers/specs/2026-07-21-edges-typecheck-gate-design.md',
    );
  } else {
    console.log('✅ 0 erros de classe-crash (e nenhum outro erro de tipo).');
  }
  return 0;
}

if (import.meta.main) process.exit(main());
