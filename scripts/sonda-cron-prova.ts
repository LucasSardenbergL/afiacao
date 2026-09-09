#!/usr/bin/env bun
/**
 * sonda-cron-prova.ts — a PROVA da allowlist da sonda por cron.
 * ============================================================================================
 *
 * ## O buraco que ele tapa
 *
 * O cron pergunta a versão de uma edge emitindo um `OPTIONS` (via `sonda-relay`). A afirmação que
 * o mecanismo inteiro apoia é: *nenhum bundle que já esteve nesta edge executa efeito ao receber
 * esse request*. Isso é uma afirmação sobre a HISTÓRIA, e texto não a prova.
 *
 * Medido (2026-09-05): um critério textual "gate antes de IO" aplicado às 1.164 versões dos 54
 * `index.ts` reprovou 37 edges — parte ruído (helper de auth com nome próprio, comentário contendo
 * `Deno.serve(`), parte ausência REAL de autenticação. Um gate textual ou reprova o que é seguro,
 * ou — pior — aprova o que não leu. Aqui cada closure histórico é EXECUTADO com o request real e o
 * efeito é CONTADO, com controle positivo provando que o contador enxerga o fluxo real daquele
 * mesmo bundle.
 *
 * ## Modos
 *
 *   bun scripts/sonda-cron-prova.ts --backfill <edge>|--tudo   executa e grava o manifesto
 *   bun scripts/sonda-cron-prova.ts --gate                     CI: G1..G4 + cobertura, sem gravar
 *   bun scripts/sonda-cron-prova.ts --falsificar               os sintéticos têm de sair FALHA
 *
 * ## Exit
 *   0 tudo prova · 1 FALHA/INVERIFICAVEL/gate reprovado · 2 MECÂNICA (git raso, deno ausente,
 *   runner sem veredito) — mecânica NUNCA é "tudo limpo".
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import { digerir, extrairImportsLocais, fecharGrafo } from './sonda-fingerprint';
import { extrairRemotos, gerarImportMap } from '../supabase/harness-sonda-rollback/mapa-imports';
import { SONDA_CRON_ALVOS } from '../supabase/functions/_shared/sonda-cron-alvos';

const HARNESS = 'supabase/harness-sonda-rollback';
const MANIFESTO = 'supabase/functions/_shared/sonda-cron-prova.json';
const CHAVE_TESTE = 'u'.repeat(44);
/** Sentinela do stripper: o maior bloco de comentário contíguo do relé (ver `maiorBlocoDescartado`). */
const MIN_LINHAS_DESCARTADAS_RELE = 8;

type Chamada = {
  status: number; probe: boolean; efeitos: number; fetches: number;
  corpoHash: string; headers: Record<string, string>; quiesceu: boolean;
};
export type Veredito = {
  importErro: string | null; efeitosNoImport: number; handler: boolean;
  a: Chamada; b: Array<Chamada & { nome: string }>;
  c: { classe: string; efeitos: number; fetches: number; degrau: string | null };
  tentativasControle?: Array<{ nome: string; status: number; efeitos: number; fetches: number }>;
  chamadas?: string[]; fetchUrls?: string[];
};
export type Classe = 'PASSA' | 'FALHA' | 'INVERIFICAVEL' | 'NAO_COMPILA';
type Entrada = { sha: string; veredito: Classe; motivo: string; controle: string; em: string };
type Manifesto = { harness: string; vereditos: Record<string, Record<string, Entrada>> };

/** Falha de MECÂNICA: o instrumento não mediu. Nunca vira "sem divergência". */
export class Mecanica extends Error {}

function git(args: string[], raiz: string): string {
  const r = spawnSync('git', args, { cwd: raiz, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Mecanica(`git ${args.slice(0, 3).join(' ')} falhou: ${(r.stderr || '').slice(0, 200)}`);
  return r.stdout;
}

/**
 * Ponto fixo da enumeração: descobrir os commits a partir do fecho de HOJE perderia um
 * `_shared/helper-antigo.ts` que só um `index.ts` velho importava — e com ele, closures inteiros.
 * Aqui o conjunto de arquivos cresce até estabilizar.
 */
export function pontoFixoDeArquivos(
  inicial: string[],
  historico: (arquivos: string[]) => string[],
  fechoEm: (sha: string) => string[],
): { arquivos: string[]; shas: string[] } {
  const arquivos = new Set(inicial);
  let shas = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const novos = historico([...arquivos]);
    const antes = arquivos.size;
    shas = new Set(novos);
    for (const sha of novos) for (const f of fechoEm(sha)) arquivos.add(f);
    if (arquivos.size === antes) break;
  }
  return { arquivos: [...arquivos].sort(), shas: [...shas] };
}

/** `--follow` aceita UM pathspec por vez — passar um conjunto aborta o git (achado do challenge). */
function historicoComRenames(arquivos: string[], raiz: string): string[] {
  const shas = new Set<string>();
  for (const f of arquivos) {
    const r = spawnSync('git', ['log', '--follow', '--format=%H', '--', f], {
      cwd: raiz, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Mecanica(`git log --follow -- ${f}: ${(r.stderr || '').slice(0, 150)}`);
    for (const l of r.stdout.split('\n')) if (/^[0-9a-f]{40}$/.test(l)) shas.add(l);
  }
  return [...shas];
}

function fechoNoSha(sha: string, edge: string, raiz: string): string[] {
  const vistos = new Set<string>();
  const fila = [`supabase/functions/${edge}/index.ts`];
  while (fila.length > 0) {
    const p = fila.pop() as string;
    if (vistos.has(p)) continue;
    const r = spawnSync('git', ['show', `${sha}:${p}`], { cwd: raiz, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) continue; // não existia neste sha: não faz parte deste fecho
    // O mapa de fingerprints fica FORA do fecho, como no gerador oficial (`fecharGrafo`): ele é
    // DERIVADO do fecho, então incluí-lo faria todo PR que regenera o mapa criar um closure novo
    // de toda edge — ruído que não corresponde a mudança de comportamento nenhuma.
    if (p === 'supabase/functions/_shared/sonda-fingerprints.ts') continue;
    vistos.add(p);
    for (const esp of extrairImportsLocais(r.stdout)) {
      fila.push(resolve('/', p, '..', esp).slice(1));
    }
  }
  return [...vistos].sort();
}

export function enumerarClosures(edge: string, raiz = process.cwd()): Array<{ sha: string; identidade: string }> {
  const inicial = fecharGrafo(`supabase/functions/${edge}/index.ts`, raiz);
  const { shas } = pontoFixoDeArquivos(inicial, (fs) => historicoComRenames(fs, raiz), (sha) => fechoNoSha(sha, edge, raiz));
  if (shas.length === 0) throw new Mecanica(`${edge}: 0 commits na história — checkout raso? (o CI usa fetch-depth: 0)`);
  const porIdentidade = new Map<string, { sha: string; identidade: string }>();
  for (const sha of shas) {
    const arquivos = fechoNoSha(sha, edge, raiz);
    if (!arquivos.includes(`supabase/functions/${edge}/index.ts`)) continue; // a edge não existia
    const h = createHash('sha256');
    for (const a of arquivos) {
      const c = git(['show', `${sha}:${a}`], raiz);
      h.update(a).update('\0').update(String(Buffer.byteLength(c))).update('\0').update(c);
    }
    const identidade = h.digest('hex');
    if (!porIdentidade.has(identidade)) porIdentidade.set(identidade, { sha, identidade });
  }
  return [...porIdentidade.values()];
}

/**
 * Identidade do HARNESS. Sem ela, um veredito PASSA obtido quando o stub não contava um SDK
 * continuaria valendo depois de o stub ser corrigido — o cache seria a memória de uma prova que
 * não existe mais.
 */
export function identidadeDoHarness(raiz = process.cwd()): string {
  const stubs = readdirSync(resolve(raiz, HARNESS, 'stubs')).sort().map((f) => `${HARNESS}/stubs/${f}`);
  const arquivos = [
    `${HARNESS}/runner.ts`, `${HARNESS}/mapa-imports.ts`, `${HARNESS}/materializar.ts`,
    'supabase/functions/_shared/sonda-cron.ts', ...stubs,
  ];
  const deno = spawnSync('deno', ['--version'], { encoding: 'utf8' });
  if (deno.status !== 0) throw new Mecanica('deno ausente — a prova não pode rodar');
  return `${digerir(arquivos, raiz)}:${createHash('sha256').update(deno.stdout.split('\n')[0]).digest('hex').slice(0, 16)}`;
}

/**
 * A chave contém tudo que produz o veredito: a identidade do closure (conteúdo do fecho naquele
 * sha), a do harness (runner, stubs, request builder, versão do Deno) e a dos CONTROLES da edge.
 * O que se espera de (a) é derivado do PRÓPRIO closure (`closureTemRamo`), então não entra na
 * chave: closure diferente já é identidade diferente.
 *
 * ⚠️ Os controles entraram em 2026-09-07, depois de a falsificação sair VERDE. Eles decidem a
 * parte (c) do protocolo — `PASSA` vs `INVERIFICAVEL` — e vinham de FORA do closure e de fora do
 * harness (`sonda-cron-alvos.ts` não está em `identidadeDoHarness`). Consequência medida: trocar
 * o controle de `sync-reprocess` por um corpo inerte NÃO reexecutou nada e os 43 vereditos
 * antigos seguiram valendo. Era exatamente a cegueira que o comentário de `identidadeDoHarness`
 * diz evitar — memória de uma prova que não existe mais — só que na outra metade do protocolo.
 */
export function chaveDoManifesto(identidade: string, harness: string, controles: string): string {
  return `${identidade}@${harness}@${controles}`;
}

/** Identidade dos controles de UMA edge: só a dela caduca quando ela muda. */
export function identidadeDosControles(edge: string): string {
  const alvo = SONDA_CRON_ALVOS.find((a) => a.edge === edge);
  return createHash('sha256').update(JSON.stringify(alvo?.controles ?? [])).digest('hex').slice(0, 16);
}

/**
 * Erros que provam que o bundle NÃO COMPILA — e a lista é POSITIVA de propósito.
 *
 * A distinção que ela faz é a única coisa que separa esta classe de uma porta dos fundos:
 *
 *   · NÃO COMPILA (aqui)  — `SyntaxError`, identificador duplicado, fonte não-parseável. O
 *     arquivo é inválido em QUALQUER ambiente. Deno recusa o módulo, a função não boota, e um
 *     bundle que não boota nunca respondeu a request nenhum — muito menos executou efeito ao
 *     receber o `OPTIONS` do cron. É afirmação sobre o ARTEFATO, não sobre o harness.
 *   · NÃO RESOLVE (fora)  — `Could not find a matching package`, módulo ausente, import relativo
 *     inválido. Isso é falha do HARNESS materializando o closure: em prod o mesmo import
 *     resolveria. Não prova nada sobre o bundle, e continua `INVERIFICAVEL` — barrando.
 *
 * Confundir os dois é o modo de falha caro: bastaria o harness perder um stub para uma edge
 * inteira ser "perdoada". Por isso o default é BARRAR e só estes padrões saem da barra.
 *
 * Medido em 2026-09-08, FORA do harness (`git cat-file -p <sha>:<path>` + `deno fmt`, com o HEAD
 * do mesmo arquivo como controle em 0 SyntaxError): `omie-sync-nfes-recebidas@b880daeb1` e os
 * closures de `omie-cliente` caem no primeiro grupo — o `index.ts` commitado não parseia.
 */
const ERROS_DE_COMPILACAO: readonly RegExp[] = [
  /\bSyntaxError\b/,
  /has already been declared/,
  /The module's source code could not be parsed/,
];

/** `true` só para erro que prova bundle inválido; qualquer outro erro continua barrando. */
export function naoCompila(importErro: string): boolean {
  return ERROS_DE_COMPILACAO.some((re) => re.test(importErro));
}

export function classificarVeredito(v: Veredito, closureTemORamo: boolean): Classe {
  if (v.efeitosNoImport > 0) return 'FALHA'; // IO no topo do módulo
  // Ordem importa: o bundle que não compila é julgado ANTES do INVERIFICAVEL genérico, porque o
  // que ele afirma é mais forte — "isto nunca esteve no ar", não "não consegui medir".
  if (v.importErro !== null && naoCompila(v.importErro)) return 'NAO_COMPILA';
  if (v.importErro !== null || !v.handler) return 'INVERIFICAVEL';
  const a = v.a;
  if (a.efeitos > 0 || a.fetches > 0 || !a.quiesceu || a.status < 200 || a.status >= 300) return 'FALHA';
  const b0 = v.b[0];
  if (!v.b.every((b) => b.efeitos === 0 && b.fetches === 0 && b.quiesceu && b.corpoHash === b0.corpoHash && b.status === b0.status)) {
    return 'FALHA';
  }
  // Closure SEM o ramo que responde a sonda: impossível, algo muito errado. Closure COM o ramo que
  // não responde: regressão silenciosa — o cron ficaria em silêncio achando que sondou.
  if (closureTemORamo ? !a.probe : a.probe) return 'FALHA';
  if (v.c.classe === 'inconclusivo') return 'INVERIFICAVEL';
  return 'PASSA';
}

/**
 * O closure TEM o ramo? — e não "veio depois do commit X".
 *
 * A versão anterior perguntava `git merge-base --is-ancestor <desde> <sha>`, com `desde` gravado na
 * allowlist. Isso amarra o veredito a um sha do PRÓPRIO branch: o rebase o reescreve e o squash do
 * auto-merge o descarta, então logo após o merge o sha não existiria mais e todo closure novo — os
 * que respondem a sonda — seria classificado como FALHA. A propriedade que decide é do closure, não
 * da linha do tempo: se ele contém o ramo, tem de atestar; se não contém, atestar seria impossível.
 */
function closureTemRamo(sha: string, edge: string, raiz: string): boolean {
  const r = spawnSync('git', ['show', `${sha}:supabase/functions/${edge}/index.ts`], {
    cwd: raiz, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Mecanica(`${edge}@${sha}: index.ts ilegível ao decidir se o closure tem o ramo`);
  return /atenderSondaOptions\(/.test(removerComentarios(r.stdout));
}

function executar(edge: string, sha: string | null, raiz: string, indexDireto?: string): Veredito {
  const dir = sha ? mkdtempSync(join(tmpdir(), `closure-${edge}-`)) : '';
  try {
    let indexPath: string;
    let mapaPath: string;
    if (sha) {
      const existe = (c: string) =>
        spawnSync('git', ['ls-tree', '--name-only', sha, c], { cwd: raiz, encoding: 'utf8' }).stdout.trim().length > 0;
      const caminhos = [`supabase/functions/${edge}`, 'supabase/functions/_shared'].filter(existe);
      if (caminhos.length === 0) throw new Mecanica(`${edge}@${sha}: nenhum caminho existe neste sha`);
      const tar = execFileSync('git', ['archive', sha, ...caminhos], { cwd: raiz, maxBuffer: 256 * 1024 * 1024 });
      writeFileSync(join(dir, 'c.tar'), tar);
      execFileSync('tar', ['-x', '-C', dir, '-f', join(dir, 'c.tar')]);
      indexPath = join(dir, 'supabase/functions', edge, 'index.ts');
      if (!existsSync(indexPath)) throw new Mecanica(`${edge}@${sha}: archive sem index.ts — materialização vazia não é zero efeito`);
      const remotos = new Set<string>();
      for (const arq of fechoLocalDisco(indexPath)) for (const r of extrairRemotos(readFileSync(arq, 'utf8'))) remotos.add(r);
      const mapa = gerarImportMap([...remotos].sort(), `file://${resolve(raiz, HARNESS, 'stubs')}`);
      if (mapa.desconhecidos.length > 0) {
        return { importErro: `especificador fora do catálogo: ${mapa.desconhecidos.join(',')}`, efeitosNoImport: 0, handler: false } as Veredito;
      }
      mapaPath = join(dir, 'import_map.json');
      writeFileSync(mapaPath, JSON.stringify(mapa));
    } else {
      indexPath = indexDireto as string;
      mapaPath = resolve(raiz, HARNESS, 'import_map.json');
    }
    const alvo = SONDA_CRON_ALVOS.find((a) => a.edge === edge);
    if (!alvo) throw new Mecanica(`${edge}: fora da allowlist`);
    const leitura = [resolve(raiz, HARNESS), sha ? dir : resolve(raiz, 'supabase/functions')].join(',');
    const r = spawnSync('deno', [
      'run', '--no-remote', `--import-map=${mapaPath}`, `--allow-read=${leitura}`,
      resolve(raiz, HARNESS, 'runner.ts'), indexPath, edge, CHAVE_TESTE, JSON.stringify(alvo.controles),
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
    const linhas = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{'));
    if (linhas.length === 0) {
      throw new Mecanica(`runner sem veredito (${edge}@${sha ?? 'HEAD'}): ${(r.stderr || '').slice(0, 250)}`);
    }
    return JSON.parse(linhas[linhas.length - 1]);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const IMPORT_LOCAL = /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g;
function fechoLocalDisco(entrada: string): string[] {
  const vistos = new Set<string>();
  const fila = [entrada];
  while (fila.length > 0) {
    const arq = fila.pop() as string;
    if (vistos.has(arq) || !existsSync(arq)) continue;
    vistos.add(arq);
    const fonte = readFileSync(arq, 'utf8');
    for (const m of fonte.matchAll(IMPORT_LOCAL)) {
      const esp = m[1] ?? m[2];
      if (esp) fila.push(resolve(arq, '..', esp));
    }
  }
  return [...vistos];
}

// ── Gates ────────────────────────────────────────────────────────────────────────────────────
export function gateG1(edge: string, codigo: string): string | null {
  const i = codigo.indexOf('Deno.serve(');
  if (i < 0) return `${edge}: Deno.serve( não encontrado — o gate mediria o arquivo errado`;
  const bloco = codigo.slice(i).match(/if \(req\.method === ['"]OPTIONS['"]\) \{([\s\S]*?)\n\s*\}/);
  if (!bloco) return `${edge}: bloco OPTIONS não encontrado`;
  const c = bloco[1];
  const pr = c.indexOf('atenderSondaOptions(');
  // O corpo do preflight NÃO é `null` em toda edge: `reposicao-depara-sayerlack-auto`,
  // `carteira-positivacao-snapshot` e `omie-nfe-webhook` respondem `'ok'` desde sempre. Casar a
  // forma literal `null` obrigaria a MUDAR o preflight dessas três para o gate passar — o oposto
  // do que ele protege. Quem garante "não mudou" é a parte (b) do runner, que compara a resposta
  // sem credencial byte a byte com o preflight do browser; aqui basta que o fallback exista.
  const mc = /return new Response\((?:null|'[^']*'|"[^"]*"|`[^`]*`), \{ headers: corsHeaders \}\)/.exec(c);
  const pc = mc ? mc.index : -1;
  if (pr < 0) return `${edge}: o bloco OPTIONS não chama atenderSondaOptions — o cron nunca atesta esta edge`;
  if (pc < 0) return `${edge}: o bloco OPTIONS perdeu o return de CORS com corpo literal`;
  if (pr > pc) return `${edge}: atenderSondaOptions está DEPOIS do return de CORS — código morto`;
  if (/req\.json\(|req\.text\(|createClient\(|fetch\(/.test(removerComentarios(c))) {
    return `${edge}: IO dentro do bloco OPTIONS`;
  }
  return null;
}

/**
 * G3 mede o RELÉ, e mede o código SEM comentário: o cabeçalho dele explica por que existe um único
 * `fetch(`, e um gate que contasse a explicação como ocorrência reprovaria a própria documentação.
 * O stripper é o COMPARTILHADO (entende string, template e regex); regex local apagaria o miolo.
 */
export function gateG3(codigoCru: string): string | null {
  const codigo = removerComentarios(codigoCru);
  const n = (codigo.match(/\bfetch\(/g) ?? []).length;
  if (n !== 1) return `relé: ${n} chamada(s) a fetch( no código (sem comentários) — tem de ser exatamente 1`;
  // O argumento do fetch tem de ser a VARIÁVEL que nasceu em `montarRequestSonda` e passou pela
  // `barreiraSaida`. Assim o gate não depende de proibir strings (o relé legitimamente cita
  // `x-cron-secret` no CORS de ENTRADA — é o header que o cron manda PARA ele).
  const m = codigo.match(/const (\w+) = montarRequestSonda\(/);
  if (!m) return 'relé: o request de saída não nasce de `const <var> = montarRequestSonda(...)`';
  const saida = m[1];
  if (!new RegExp(`barreiraSaida\\(${saida},`).test(codigo)) {
    return `relé: o request \`${saida}\` não passa por barreiraSaida antes de sair`;
  }
  if (!new RegExp(`fetch\\(${saida}[,)]`).test(codigo)) {
    return `relé: o fetch não recebe \`${saida}\` — o request de saída seria outro objeto, fora da barreira`;
  }
  if (/fetch\([^)]*method\s*:/.test(codigo)) return 'relé: method: literal no fetch de saída';
  if (/headers\s*:\s*\{[^}]*cron-secret/i.test(codigo)) {
    return 'relé: x-cron-secret montado em headers de saída — o segredo do cron não pode ir para a alvo';
  }
  return null;
}

/** Sentinela do stripper: se ele parar de limpar, G3 volta a contar comentário como código. */
export function sentinelaStripper(codigoCru: string): string | null {
  const linhasCruas = codigoCru.split('\n');
  const limpas = removerComentarios(codigoCru).split('\n');
  let maior = 0, atual = 0;
  for (let i = 0; i < linhasCruas.length; i++) {
    if (linhasCruas[i].trim() === '') continue;
    atual = (limpas[i] ?? '').trim() === '' ? atual + 1 : 0;
    if (atual > maior) maior = atual;
  }
  if (maior < MIN_LINHAS_DESCARTADAS_RELE) {
    return `stripper: descartou no máximo ${maior} linhas contíguas do relé (esperado ≥ ${MIN_LINHAS_DESCARTADAS_RELE}) — sub-limpeza faz G3 contar comentário como código`;
  }
  return null;
}

export function gateG4(migrations: Array<{ nome: string; sql: string }>, allowlist: string[]): string | null {
  const ok = new Set(allowlist);
  for (const m of migrations) {
    if (!/deploy_sonda_alvos/.test(m.sql)) continue;
    for (const mm of m.sql.matchAll(/INSERT INTO public\.deploy_sonda_alvos[\s\S]*?VALUES([\s\S]*?);/gi)) {
      for (const v of mm[1].matchAll(/\(\s*'([a-z0-9-]+)'/g)) {
        if (!ok.has(v[1])) return `${m.nome}: INSERT em deploy_sonda_alvos com slug fora da allowlist: ${v[1]}`;
      }
    }
  }
  return null;
}

function lerManifesto(raiz: string): Manifesto {
  const p = resolve(raiz, MANIFESTO);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { harness: '', vereditos: {} };
}
function gravarManifesto(m: Manifesto, raiz: string): void {
  const ord: Manifesto = { harness: m.harness, vereditos: {} };
  for (const e of Object.keys(m.vereditos).sort()) {
    ord.vereditos[e] = {};
    for (const k of Object.keys(m.vereditos[e]).sort()) ord.vereditos[e][k] = m.vereditos[e][k];
  }
  writeFileSync(resolve(raiz, MANIFESTO), `${JSON.stringify(ord, null, 1)}\n`);
}

function provarEdge(edge: string, m: Manifesto, raiz: string, log: (s: string) => void, reexecutarTudo = false) {
  // Default-deny também aqui: só se prova o que o cron vai sondar (o `executar` relê a entrada
  // para pegar os controles; esta checagem é a que dá mensagem legível se alguém chamar direto).
  if (!SONDA_CRON_ALVOS.some((a) => a.edge === edge)) {
    throw new Mecanica(`${edge}: fora da allowlist — provar edge que o cron não sonda não significa nada`);
  }
  const idControles = identidadeDosControles(edge);
  const closures = enumerarClosures(edge, raiz);
  const ruins: string[] = [];
  const naoCompilam: string[] = [];
  let passa = 0;
  m.vereditos[edge] ??= {};
  const visitadas = new Set<string>();
  for (const c of closures) {
    const k = chaveDoManifesto(c.identidade, m.harness, idControles);
    visitadas.add(k);
    const commitado = m.vereditos[edge][k];
    let e = commitado;
    if (!e || reexecutarTudo) {
      const v = executar(edge, c.sha, raiz);
      const cls = classificarVeredito(v, closureTemRamo(c.sha, edge, raiz));
      e = {
        sha: c.sha,
        veredito: cls,
        motivo: cls === 'PASSA' ? '' : (v.importErro ?? JSON.stringify({ a: v.a, b: v.b?.map((b) => [b.nome, b.efeitos, b.fetches]) }).slice(0, 280)),
        controle: v.c?.classe ?? 'inconclusivo',
        em: new Date().toISOString(),
      };
      // ADULTERAÇÃO: o manifesto dizia uma coisa e a re-execução diz outra. Reprovar aqui é o que
      // torna o arquivo commitado inútil como forma de calar o gate.
      if (commitado && commitado.veredito !== cls) {
        ruins.push(
          `${edge}@${c.sha.slice(0, 9)}: MANIFESTO ADULTERADO — commitado diz ${commitado.veredito}, a re-execução diz ${cls}`,
        );
      }
      m.vereditos[edge][k] = e;
      if (!commitado) log(`  ${edge}@${c.sha.slice(0, 9)} ${cls}${e.motivo ? ` — ${e.motivo.slice(0, 110)}` : ''}`);
    }
    if (e.veredito === 'PASSA') passa++;
    // `NAO_COMPILA` não entra em `ruins`: o closure não podia estar no ar, então não há o que
    // provar sobre ele. Mas vira LINHA no relatório — perdoar em silêncio é como um gate morre.
    else if (e.veredito === 'NAO_COMPILA') naoCompilam.push(`${edge}@${e.sha.slice(0, 9)}: ${e.motivo.slice(0, 110)}`);
    else ruins.push(`${edge}@${e.sha.slice(0, 9)}: ${e.veredito} — ${e.motivo.slice(0, 140)}`);
  }
  // Poda: chave que nenhum closure enumerado usa é veredito de uma pergunta que não se faz mais
  // (desde antigo, harness antigo). Manifesto que só cresce vira arquivo de lixo em que ninguém
  // consegue distinguir prova viva de resíduo.
  let podadas = 0;
  for (const k of Object.keys(m.vereditos[edge])) {
    if (!visitadas.has(k)) { delete m.vereditos[edge][k]; podadas++; }
  }
  return { total: closures.length, passa, ruins, naoCompilam, podadas };
}

export function main(argv: string[], raiz = process.cwd()): number {
  const log = (s: string) => console.log(s);
  try {
    const m = lerManifesto(raiz);
    const harness = identidadeDoHarness(raiz);
    if (m.harness !== harness) {
      if (m.harness) log(`harness mudou (${m.harness.slice(0, 12)} → ${harness.slice(0, 12)}): todos os vereditos caducam e serão re-executados`);
      m.harness = harness;
      m.vereditos = {};
    }

    if (argv.includes('--falsificar')) {
      const sint = resolve(raiz, HARNESS, 'sinteticos');
      const devemPassar = new Set(['gate-ignorado', 'ramo-morto', 'padrao']);
      // Esperado EXATO por sintético — o binário "PASSA vs resto" não distingue as duas classes
      // que a onda 4 introduziu, e é justamente a distinção entre elas que precisa ser vigiada:
      // `nao-compila` DISPENSA (bundle inválido nunca bootou) e `import-irresolvivel` BARRA
      // (falha do harness não prova nada sobre prod). Trocar um pelo outro abre a porta dos
      // fundos, e é isso que estas duas linhas impedem.
      const classeExata = new Map<string, Classe>([
        ['nao-compila', 'NAO_COMPILA'],
        ['import-irresolvivel', 'INVERIFICAVEL'],
      ]);
      let vermelhos = 0;
      for (const nome of readdirSync(sint).sort()) {
        const mapa = gerarImportMap(['npm:@supabase/supabase-js@2'], `file://${resolve(raiz, HARNESS, 'stubs')}`);
        const mapaPath = join(mkdtempSync(join(tmpdir(), 'sint-')), 'map.json');
        writeFileSync(mapaPath, JSON.stringify(mapa));
        const r = spawnSync('deno', [
          'run', '--no-remote', `--import-map=${mapaPath}`, `--allow-read=${resolve(raiz, HARNESS)}`,
          resolve(raiz, HARNESS, 'runner.ts'), join(sint, nome, 'index.ts'), nome, CHAVE_TESTE,
          JSON.stringify([{ metodo: 'POST', headers: { 'content-type': 'application/json', 'x-cron-secret': '$CRON_SECRET' }, corpo: '{}', nota: 'controle do sintético' }]),
        ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        const linhas = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{'));
        if (linhas.length === 0) throw new Mecanica(`sintético ${nome}: runner sem veredito`);
        const cls = classificarVeredito(JSON.parse(linhas[linhas.length - 1]), false);
        const exata = classeExata.get(nome);
        const esperado = exata ?? (devemPassar.has(nome) ? 'PASSA' : 'FALHA/INVERIFICAVEL');
        const ok = exata ? cls === exata : (devemPassar.has(nome) ? cls === 'PASSA' : cls !== 'PASSA');
        log(`  sintético ${nome}: ${cls} (esperado ${esperado}) ${ok ? '✅' : '❌'}`);
        if (!ok) vermelhos++;
      }
      return vermelhos === 0 ? 0 : 1;
    }

    const i = argv.indexOf('--backfill');
    const edges = i >= 0 && argv[i + 1] && argv[i + 1] !== '--tudo'
      ? [argv[i + 1]]
      : SONDA_CRON_ALVOS.map((a) => a.edge);
    let falhas = 0;

    for (const edge of edges) {
      if (!SONDA_CRON_ALVOS.some((a) => a.edge === edge)) {
        log(`❌ ${edge}: fora da allowlist — só se prova o que o cron vai sondar`);
        return 1;
      }
      const g1 = gateG1(edge, readFileSync(resolve(raiz, `supabase/functions/${edge}/index.ts`), 'utf8'));
      if (g1) { log(`G1 ❌ ${g1}`); falhas++; }
      const r = provarEdge(edge, m, raiz, log, argv.includes('--gate'));
      log(`${edge}: ${r.passa}/${r.total} closures PASSA ${r.ruins.length ? '❌' : '✅'}${r.podadas ? ` (${r.podadas} entrada(s) órfã(s) podada(s))` : ''}`);
      for (const x of r.ruins) log(`   ${x}`);
      // Dispensa NUNCA é silêncio: o closure que não compila sai NOMEADO, com o erro que o
      // dispensou. Quem lê o relatório vê quantas provas não foram feitas, e por quê.
      if (r.naoCompilam.length > 0) {
        log(`   ⓘ ${r.naoCompilam.length} closure(s) NAO_COMPILA — dispensados (bundle inválido nunca bootou):`);
        for (const x of r.naoCompilam) log(`      ${x}`);
      }
      if (r.ruins.length > 0) falhas++;
    }

    const releCru = readFileSync(resolve(raiz, 'supabase/functions/sonda-relay/index.ts'), 'utf8');
    const sent = sentinelaStripper(releCru);
    if (sent) { log(`STRIPPER ❌ ${sent}`); falhas++; }
    const g3 = gateG3(releCru);
    if (g3) { log(`G3 ❌ ${g3}`); falhas++; }

    const dirMig = resolve(raiz, 'supabase/migrations');
    const migs = existsSync(dirMig)
      ? readdirSync(dirMig).filter((f) => f.endsWith('.sql')).map((f) => ({ nome: f, sql: readFileSync(join(dirMig, f), 'utf8') }))
      : [];
    const g4 = gateG4(migs, SONDA_CRON_ALVOS.map((a) => a.edge));
    if (g4) { log(`G4 ❌ ${g4}`); falhas++; }

    if (argv.includes('--gate')) {
      // No `--gate` o manifesto NÃO é regravado, e a checagem não é "o arquivo está idêntico".
      // Motivo medido (2026-09-06): o GitHub testa um merge commit EFÊMERO que não existe quando o
      // manifesto é gerado, então "idêntico" é impossível no CI e reprovaria todo PR. O que o gate
      // exige é mais forte: ele RE-EXECUTA cada closure (ignorando o cache) e reprova (a) qualquer
      // veredito ≠ PASSA e (b) qualquer divergência entre o commitado e a re-execução — que é a
      // definição de manifesto adulterado.
      const novos = spawnSync('git', ['diff', '--quiet', '--', MANIFESTO], { cwd: raiz }).status !== 0;
      if (novos) log(`ℹ️  o manifesto local ficaria diferente (closures novos, ex.: o merge commit do PR) — não é reprovação`);
    } else {
      gravarManifesto(m, raiz);
    }
    return falhas === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof Mecanica) { console.error(`MECANICA: ${e.message}`); return 2; }
    throw e;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
