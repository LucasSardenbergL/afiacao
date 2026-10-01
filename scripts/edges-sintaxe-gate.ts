#!/usr/bin/env bun
/**
 * edges-sintaxe-gate.ts — gate de CI: todo módulo de edge PARSEIA no V8 (`node --check`).
 * ============================================================================================
 *
 * O BURACO. Módulo que o V8 recusa ao compilar é edge que NÃO BOOTA: o Edge Runtime responde
 * BOOT_ERROR 503 a TODA chamada, até o próximo deploy. Os 5 gates de edge que o CI já tinha deixam
 * essa classe passar, cada um por um motivo:
 *   - `test:edges` só carrega o grafo que os TESTES importam, e nenhum teste importa `index.ts`
 *     (ele chama `Deno.serve` e importa `https:`/`npm:`, fora do `--no-remote`);
 *   - `edges:typecheck` é de PRECISÃO: bloqueia só "símbolo/módulo não resolve" e tolera o resto —
 *     inclusive TS2451/TS2393, a redeclaração;
 *   - o vitest lê a edge como TEXTO; `sonda:bump`/`sonda:fingerprint` medem VERSAO e hash.
 *
 * INCIDENTE (#2720): o #2700 declarou `resposta` duas vezes no MESMO escopo do handler da
 * `analyze-unified-order`. Verde nos 31 gates do CI, a edge ficou em BOOT_ERROR 503 em produção de
 * ~08:41Z a ~09:56Z de 2026-10-01 (docs/historico/ia-nao-precifica.md). RECORRÊNCIA: a prova da
 * sonda por cron (#2404/#2415, classe NAO_COMPILA) já tinha achado a classe em 3 commits da main —
 * `omie-cliente@a0596c33f` e `@cbe2c488c` (`upsertAddressFromOmie` declarada 2×) e
 * `omie-sync-nfes-recebidas@b880daeb1` (arquivo truncado).
 *
 * DUAS CAMADAS, e cada uma pega um caso REAL que a outra deixa passar (medido nos 4 commits):
 *   1. o parser do TypeScript (`transpileModule` + `reportDiagnostics`). No truncado do b880daeb1
 *      ele acusa `'}' expected` — e o transpile, tolerante, CONSERTA o arquivo e emite JS válido,
 *      que o `node --check` aprova. Por isso diagnóstico de transpile reprova sozinho: o JS que o
 *      V8 leria não é o arquivo que vai para o ar.
 *   2. o parser do V8 (`node --check` no JS transpilado, como `.mjs`). Redeclaração é EARLY ERROR:
 *      o V8 recusa o módulo inteiro antes de executar uma linha. O `transpileModule` não faz
 *      bind/check e passa pelos 3 casos de identificador duplicado com ZERO diagnósticos. O motor é
 *      o mesmo do Deno do Edge Runtime, e a mensagem é a mesma do log do BOOT_ERROR.
 *   O `--check` só compila: não executa e não resolve import (`https:`/`npm:`/`jsr:` ficam texto)
 *   — por isso o gate roda offline, sem Deno e sem rede.
 *
 * FAIL-CLOSED ("ausência de sinal NÃO é aprovação"). Antes de olhar o repo, o gate CALIBRA as duas
 * camadas na MESMA invocação: um truncado TEM de dar diagnóstico de parse, um módulo com
 * redeclaração TEM de sair recusado pelo node, e um módulo limpo (import remoto + top-level await)
 * TEM de sair aceito. Node ausente, quebrado ou shim que sempre sai 0 vira NAO_CHECADO, nunca OK.
 * Zero módulos também. Cada `node --check` tem teto; sinal, exit fora de 0/1 ou exit 1 sem
 * `SyntaxError` é "não consegui checar", não veredito.
 *
 * DONO DO VERMELHO: o PR cujo diff contém o arquivo apontado — o vermelho é determinístico e traz
 * arquivo, mensagem do V8 e as linhas do fonte. Se a main já chegou vermelha (commit direto do
 * Lovable, que não passa pelo CI), a edge cai no próximo deploy dela: restaure por PR antes, como o
 * "Changes" que atropela a main (docs/agent/deploy.md).
 *
 * Uso:  bun run edges:sintaxe                        # CI (job validate) e local
 *       bun scripts/edges-sintaxe-gate.ts --raiz <dir>
 *       EDGES_SINTAXE_NODE=<binário> bun run edges:sintaxe   # outro node
 * Exit: 0 todo módulo parseia · 1 algum módulo RECUSADO · 2 NAO_CHECADO (não consegui checar).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

export const RAIZ_EDGES = 'supabase/functions';

/** Parse de um módulo de 1.500 linhas leva milissegundos: 30 s é processo travado, não carga. */
const TETO_MS = 30_000;
const PARALELO = Math.max(1, Math.min(4, cpus().length));

const EXTENSOES = /\.(?:ts|mts|tsx|js|mjs|jsx)$/;
/** Convenção do `deno test`: `test.ts`, `*_test.ts` e `*.test.ts`. */
const TESTE = /(?:^|[_.])test\.(?:ts|mts|tsx|js|mjs|jsx)$/;

/** As 3 sentinelas da calibração — uma por veredito que o gate precisa saber dar. */
const SENTINELA_TRUNCADA = 'export function f(): number {\n  return 1;\n';
const SENTINELA_RECUSA = 'export function f(): number {\n  let x: number = 1;\n  const x = 2;\n  return x;\n}\n';
const SENTINELA_ACEITA =
  'import { y } from "https://deno.land/x/nao_existe@0.0.0/mod.ts";\n' +
  'const z: number = await Promise.resolve(1);\nexport { y, z };\n';

export interface DiagnosticoTs {
  linha: number;
  coluna: number;
  mensagem: string;
}

export interface SaidaNode {
  status: number | null;
  sinal: string | null;
  stderr: string;
  stdout?: string;
  /** O processo nem subiu (ENOENT, EACCES…). */
  erro?: string;
}

export type ResultadoV8 =
  | { tipo: 'aceito' }
  | { tipo: 'recusado'; mensagem: string; trecho: string }
  | { tipo: 'nao-checado'; motivo: string };

/**
 * Todo módulo não-teste sob `supabase/functions/` (inclusive `_shared/`, que entra no bundle de
 * quem o importa) e o número de edges (diretório com `index.ts`). O glob é expandido aqui, não no
 * shell: glob que não casa nada viraria verde silencioso — e 0 módulos é NAO_CHECADO no `main`.
 */
export function enumerarModulos(raiz: string): { modulos: string[]; edges: number } {
  const base = join(raiz, RAIZ_EDGES);
  if (!existsSync(base)) return { modulos: [], edges: 0 };
  const modulos: string[] = [];
  const visitar = (relDir: string): void => {
    for (const e of readdirSync(join(raiz, relDir), { withFileTypes: true })) {
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) visitar(rel);
      } else if (e.isFile() && EXTENSOES.test(e.name) && !TESTE.test(e.name) && !e.name.endsWith('.d.ts')) {
        modulos.push(rel);
      }
    }
  };
  visitar(RAIZ_EDGES);
  modulos.sort();
  const edges = readdirSync(base, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && existsSync(join(base, e.name, 'index.ts')),
  ).length;
  return { modulos, edges };
}

/** Camada 1: tira os tipos SEM rebaixar a sintaxe (o V8 tem de ver as declarações como o Deno). */
export function transpilar(fonte: string, nome: string): { js: string; diagnosticos: DiagnosticoTs[] } {
  const r = ts.transpileModule(fonte, {
    fileName: nome,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  });
  const diagnosticos = (r.diagnostics ?? []).map((d) => {
    const pos =
      d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
    return { linha: pos.line + 1, coluna: pos.character + 1, mensagem: ts.flattenDiagnosticMessageText(d.messageText, ' ') };
  });
  return { js: r.outputText, diagnosticos };
}

/**
 * Camada 2, o veredito: o que o `node --check` disse. Formato do stderr (node ≥ 20):
 * `<arquivo>:<linha>` · a linha de código · o circunflexo · `SyntaxError: <mensagem>`.
 */
export function classificarNodeCheck(s: SaidaNode): ResultadoV8 {
  if (s.erro !== undefined) return { tipo: 'nao-checado', motivo: `o node não executou (${s.erro})` };
  if (s.status === 0) return { tipo: 'aceito' };
  const linhas = s.stderr.split('\n');
  const i = linhas.findIndex((l) => l.startsWith('SyntaxError: '));
  if (s.status === 1 && i >= 0) {
    const trecho = /:\d+$/.test(linhas[0] ?? '') ? (linhas[1] ?? '').trim() : '';
    return { tipo: 'recusado', mensagem: linhas[i].slice('SyntaxError: '.length).trim(), trecho };
  }
  if (s.sinal !== null) {
    return { tipo: 'nao-checado', motivo: `node --check morto por ${s.sinal} (teto de ${TETO_MS / 1000}s)` };
  }
  const resto = s.stderr.trim().slice(0, 200) || '(stderr vazio)';
  return { tipo: 'nao-checado', motivo: `node --check saiu ${s.status} sem SyntaxError: ${resto}` };
}

function juntar(ns: number[]): string {
  return ns.length === 1 ? String(ns[0]) : `${ns.slice(0, -1).join(', ')} e ${ns[ns.length - 1]}`;
}

/**
 * Onde consertar. O JS transpilado não tem as linhas do fonte (os tipos somem), então, para a
 * redeclaração, a pista são as linhas do FONTE que declaram o identificador; no resto, o trecho.
 */
function pista(fonte: string, r: { mensagem: string; trecho: string }): string {
  const m = /^Identifier '([^']+)' has already been declared$/.exec(r.mensagem);
  if (m) {
    const id = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const borda = (s: string): string => String.raw`(?<![\p{ID_Continue}$])${s}(?![\p{ID_Continue}$])`;
    const declara = new RegExp(
      String.raw`\b(?:let|const|var)\s[^=;]*?${borda(id)}|\b(?:function\s*\*?|class|enum)\s+${borda(id)}|\bimport\b[^;]*?${borda(id)}`,
      'u',
    );
    const linhas = fonte.split('\n').flatMap((l, i) => (declara.test(l) ? [i + 1] : []));
    if (linhas.length > 0) return ` — declarado nas linhas ${juntar(linhas.slice(0, 6))} do fonte`;
  }
  return r.trecho ? ` — no JS transpilado: \`${r.trecho.slice(0, 120)}\`` : '';
}

function rodarNode(node: string, args: string[]): Promise<SaidaNode> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const p = spawn(node, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const teto = setTimeout(() => p.kill('SIGKILL'), TETO_MS);
    let feito = false;
    // `error` e `close` podem vir os dois (ENOENT): só o primeiro decide.
    const fim = (s: SaidaNode): void => {
      if (feito) return;
      feito = true;
      clearTimeout(teto);
      resolve(s);
    };
    p.stdout?.setEncoding('utf8');
    p.stderr?.setEncoding('utf8');
    p.stdout?.on('data', (c: string) => {
      if (stdout.length < 65_536) stdout += c;
    });
    p.stderr?.on('data', (c: string) => {
      if (stderr.length < 65_536) stderr += c;
    });
    p.on('error', (e) => fim({ status: null, sinal: null, stderr, stdout, erro: e.message }));
    p.on('close', (status, sinal) => fim({ status, sinal, stderr, stdout }));
  });
}

/** Laço com teto: cada item roda uma vez, no máximo `n` processos ao mesmo tempo. */
async function emPool<T, R>(itens: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(itens.length);
  let proximo = 0;
  const trabalhador = async (): Promise<void> => {
    while (proximo < itens.length) {
      const k = proximo++;
      out[k] = await f(itens[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, trabalhador));
  return out;
}

async function checarJs(node: string, arquivo: string, js: string): Promise<ResultadoV8> {
  writeFileSync(arquivo, js);
  return classificarNodeCheck(await rodarNode(node, ['--check', arquivo]));
}

function descrever(r: ResultadoV8): string {
  return r.tipo === 'aceito' ? 'aceitou' : r.tipo === 'recusado' ? `recusou: ${r.mensagem}` : r.motivo;
}

/** `null` = as duas camadas dão os 3 vereditos certos neste ambiente; senão, o motivo. */
async function calibrar(node: string, dir: string): Promise<string | null> {
  if (transpilar(SENTINELA_TRUNCADA, 'calibracao.ts').diagnosticos.length === 0) {
    return 'o parser do TypeScript aprovou um modulo truncado';
  }
  const recusa = transpilar(SENTINELA_RECUSA, 'calibracao.ts');
  const aceita = transpilar(SENTINELA_ACEITA, 'calibracao.ts');
  if (recusa.diagnosticos.length > 0 || aceita.diagnosticos.length > 0) {
    return 'o parser do TypeScript acusou erro numa sentinela valida';
  }
  const r1 = await checarJs(node, join(dir, 'calibracao-recusa.mjs'), recusa.js);
  if (r1.tipo !== 'recusado') return `\`${node} --check\` nao recusou um modulo com redeclaracao (${descrever(r1)})`;
  const r2 = await checarJs(node, join(dir, 'calibracao-aceita.mjs'), aceita.js);
  if (r2.tipo !== 'aceito') {
    return `\`${node} --check\` nao aceitou um modulo limpo com import remoto e top-level await (${descrever(r2)})`;
  }
  return null;
}

export async function main(
  argv: string[],
  opcoes: { node?: string; saida?: (linha: string) => void } = {},
): Promise<number> {
  const saida = opcoes.saida ?? ((l: string) => console.log(l));
  const i = argv.indexOf('--raiz');
  const raiz = i >= 0 && argv[i + 1] ? argv[i + 1] : process.cwd();
  const node = opcoes.node ?? process.env.EDGES_SINTAXE_NODE ?? 'node';
  const naoChecado = (motivo: string): number => {
    saida(`❌ NAO_CHECADO edges:sintaxe — ${motivo}`);
    saida('   Bloqueando de propósito: não conseguir checar não é o mesmo que estar limpo.');
    return 2;
  };

  const t0 = performance.now();
  const { modulos, edges } = enumerarModulos(raiz);
  if (modulos.length === 0 || edges === 0) {
    return naoChecado(`gate sem alvo: ${modulos.length} modulo(s) e ${edges} edge(s) em ${join(raiz, RAIZ_EDGES)}`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'edges-sintaxe-'));
  try {
    const v = await rodarNode(node, ['--version']);
    const versao = v.status === 0 ? /^v\d+\.\d+\.\d+/.exec((v.stdout ?? '').trim())?.[0] : undefined;
    if (!versao) return naoChecado(`\`${node} --version\` sem resposta valida (${v.erro ?? `exit ${v.status}`})`);
    const calibracao = await calibrar(node, dir);
    if (calibracao) return naoChecado(`calibracao: ${calibracao}`);

    const recusados: { rel: string; linha: string }[] = [];
    const paraV8: { rel: string; fonte: string; js: string; arquivo: string }[] = [];
    modulos.forEach((rel, n) => {
      const fonte = readFileSync(join(raiz, rel), 'utf8');
      const { js, diagnosticos } = transpilar(fonte, rel);
      if (diagnosticos.length > 0) {
        const d = diagnosticos[0];
        const mais = diagnosticos.length > 1 ? ` (+${diagnosticos.length - 1})` : '';
        recusados.push({ rel, linha: `RECUSADO ${rel}:${d.linha}:${d.coluna} [ts-parse] ${d.mensagem}${mais}` });
        return;
      }
      paraV8.push({ rel, fonte, js, arquivo: join(dir, `${n}.mjs`) });
    });

    const resultados = await emPool(paraV8, PARALELO, (m) => checarJs(node, m.arquivo, m.js));
    const naoChecados: string[] = [];
    resultados.forEach((r, k) => {
      const m = paraV8[k];
      if (r.tipo === 'recusado') recusados.push({ rel: m.rel, linha: `RECUSADO ${m.rel} [v8] ${r.mensagem}${pista(m.fonte, r)}` });
      else if (r.tipo === 'nao-checado') naoChecados.push(`   ${m.rel}: ${r.motivo}`);
    });
    recusados.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

    if (recusados.length > 0) {
      saida(
        `❌ edges:sintaxe — ${recusados.length} de ${modulos.length} módulo(s) RECUSADO(s): o Edge Runtime não ` +
          'carrega o módulo, a edge não boota e responde BOOT_ERROR 503 a toda chamada até o redeploy (#2720).',
      );
      for (const r of recusados) saida(r.linha);
      if (naoChecados.length > 0) saida(`   + ${naoChecados.length} módulo(s) NAO_CHECADO:\n${naoChecados.join('\n')}`);
      saida(
        '   Conserte no PR que o introduziu. Se a main já chegou assim (commit direto do Lovable, sem CI),\n' +
          '   restaure por PR antes do próximo deploy dessa edge.',
      );
      return 1;
    }
    if (naoChecados.length > 0) return naoChecado(`${naoChecados.length} modulo(s) sem veredito:\n${naoChecados.join('\n')}`);

    const s = ((performance.now() - t0) / 1000).toFixed(1);
    saida(
      `✅ OK edges:sintaxe — ${modulos.length} modulos de ${edges} edges parseiam no V8 ` +
        `(node ${versao} · TypeScript ${ts.version}) em ${s}s`,
    );
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (codigo) => process.exit(codigo),
    (e: unknown) => {
      console.log(`❌ NAO_CHECADO edges:sintaxe — erro interno: ${e instanceof Error ? e.stack : String(e)}`);
      process.exit(2);
    },
  );
}
