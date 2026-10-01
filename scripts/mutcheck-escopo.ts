#!/usr/bin/env bun
/**
 * mutcheck-escopo.ts — quais contratos de mutação ESTE diff alcança.
 * ============================================================================================
 *
 * O job `mutation-check` (ci.yml) rodava os 48 contratos `scripts/mutcheck.d/*.mut` em SÉRIE a
 * cada push de PR: 30–43 min por push em 2026-10-01, num job que NÃO é required (o merge não
 * espera por ele). Medido nos runs de 25/09 a 01/10: ele sozinho ocupou **39%** de todo o tempo
 * de runner do repo — e o plano Free tem 20 jobs simultâneos, então esse tempo vira FILA para os
 * jobs que barram o merge. Nos 300 PRs mergeados mais recentes, só **27%** tocaram algum arquivo
 * que um contrato mede.
 *
 * Um contrato só muda de veredito quando muda (a) o fonte que ele muta (`# @src:`), (b) o teste
 * que tem de matar a mutação (`# @test:`), (c) o próprio `.mut`, ou (d) a maquinaria comum —
 * os GATILHOS_GLOBAIS abaixo. Fora disso o PR não tem o que medir ali.
 *
 * Decisão por evento:
 *  - `pull_request` → só os contratos alcançados pelo diff do merge commit (pai 1 → HEAD).
 *    Gatilho global → TODOS. Nenhum alcançado → o job fica SKIPPED (pulado, não verde).
 *  - qualquer outro evento (push/workflow_dispatch na main) → TODOS, como sempre. É a rede: o
 *    que escapar do escopo (ex.: helper de teste compartilhado que o contrato não declara)
 *    aparece no run da main, onde o sensor abre a Issue `mutcheck-cobertura`.
 *
 * Fail-CLOSED em toda incerteza: merge commit sem 2 pais, diff ilegível, nenhum contrato
 * legível ⇒ TODOS; contrato sem alvo declarado ⇒ ele roda. Pular por incerteza seria verde por
 * ausência de dado. Pelo mesmo motivo o script NUNCA sai ≠ 0 — erro vira "roda TODOS".
 *
 * Uso (CI, ver ci.yml):
 *   bun scripts/mutcheck-escopo.ts --evento "$EVENTO" --github-output        # job mutcheck-escopo
 *   bun scripts/mutcheck-escopo.ts --evento "$EVENTO" --materializar <dir>   # job mutation-check
 * Local (o que um PR desta branch rodaria):
 *   bun scripts/mutcheck-escopo.ts --base origin/main --head HEAD
 *
 * Só builtins: o job de escopo não paga `bun install`.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const DIR_CONTRATOS = 'scripts/mutcheck.d';

/**
 * Mudar qualquer um destes pode mudar o veredito de QUALQUER contrato ⇒ roda todos.
 * A ferramenta (`mutcheck.sh`/`mutcheck-all.sh`), este seletor, a prova por consumidor que roda
 * no mesmo job, a definição do job (`ci.yml`), a resolução das dependências (`bun.lock` — inclui o
 * vitest) e a configuração/setup do vitest que todo teste de `src/`/`scripts/` herda.
 * Arquivo de apoio dentro de `scripts/mutcheck.d/` que não seja `.mut` também conta (ver
 * `selecionar`). Renomear um destes sem atualizar a lista só tira PRECISÃO: o run da main segue
 * rodando todos. Por isso não há gate cobrando a lista (regra de máquina meta do CLAUDE.md).
 */
export const GATILHOS_GLOBAIS: readonly string[] = [
  'scripts/mutcheck.sh',
  'scripts/mutcheck-all.sh',
  'scripts/mutcheck-escopo.ts',
  'scripts/prova-consumidores-controle.sh',
  '.github/workflows/ci.yml',
  'bun.lock',
  'vitest.config.ts',
  'src/test/setup.ts',
  'src/test/setup-dom.ts',
];

export interface Contrato {
  /** caminho do `.mut`, relativo à raiz do repo */
  mut: string;
  /** caminhos de `# @src:` e `# @test:` — o que o contrato MEDE */
  alvos: string[];
}

export interface Selecao {
  /** true = roda TODOS os contratos (gatilho global, evento fora de PR, ou não consegui decidir) */
  todos: boolean;
  /** `.mut` selecionados quando `todos` é false; vazio + todos=false ⇒ nada a medir */
  contratos: string[];
  /** uma linha por motivo, para o log do job */
  motivos: string[];
}

/** Mesmo parse do `mutcheck-all.sh` (`sed -n 's/^#[[:space:]]*@src:…'`), mas colhendo TODAS as linhas. */
const RE_ALVO = /^#\s*@(src|test):\s*(\S+)\s*$/;

function normaliza(p: string): string {
  return p.trim().replace(/^\.\//, '');
}

export function lerContrato(mut: string, texto: string): Contrato {
  const alvos: string[] = [];
  for (const linha of texto.split('\n')) {
    const m = linha.match(RE_ALVO);
    if (m) alvos.push(normaliza(m[2]));
  }
  return { mut, alvos };
}

export function roda(sel: Selecao): boolean {
  return sel.todos || sel.contratos.length > 0;
}

/** Função PURA: o diff (lista de caminhos) × os contratos → o que medir. */
export function selecionar(mudados: readonly string[], contratos: readonly Contrato[]): Selecao {
  const arquivos = new Set(mudados.map(normaliza).filter(Boolean));

  const globais = [...arquivos].filter(
    (f) => GATILHOS_GLOBAIS.includes(f) || (f.startsWith(`${DIR_CONTRATOS}/`) && !f.endsWith('.mut')),
  );
  if (globais.length > 0) {
    return {
      todos: true,
      contratos: [],
      motivos: globais.map((f) => `${f}: gatilho global — vale para todo contrato`),
    };
  }

  const contratosSel: string[] = [];
  const motivos: string[] = [];
  for (const c of contratos) {
    if (c.alvos.length === 0) {
      contratosSel.push(c.mut);
      motivos.push(`${c.mut}: sem '# @src:'/'# @test:' — escopo desconhecido, roda (fail-closed)`);
      continue;
    }
    const toques = [c.mut, ...c.alvos].filter((p) => arquivos.has(p));
    if (toques.length > 0) {
      contratosSel.push(c.mut);
      motivos.push(`${c.mut}: alcançado por ${[...new Set(toques)].join(', ')}`);
    }
  }
  return { todos: false, contratos: contratosSel, motivos };
}

/**
 * Evento + entradas que podem ter falhado (`null` = não consegui ler) → seleção. Toda leitura
 * que falhou vira TODOS: aqui "não sei" nunca pode virar "pula".
 */
export function decidir(
  evento: string,
  mudados: readonly string[] | null,
  contratos: readonly Contrato[] | null,
): Selecao {
  if (evento !== 'pull_request') {
    return { todos: true, contratos: [], motivos: [`evento '${evento}' — fora de PR roda TODOS (é a rede da main)`] };
  }
  if (mudados === null) {
    return { todos: true, contratos: [], motivos: ['diff ilegível — sem escopo, roda TODOS (fail-closed)'] };
  }
  if (contratos === null || contratos.length === 0) {
    return {
      todos: true,
      contratos: [],
      motivos: [`nenhum contrato legível em ${DIR_CONTRATOS} — roda TODOS (fail-closed)`],
    };
  }
  return selecionar(mudados, contratos);
}

/** Linhas `chave=valor` para o `$GITHUB_OUTPUT` do job de escopo. */
export function linhasDeSaida(sel: Selecao): string[] {
  return [`roda=${roda(sel)}`, `todos=${sel.todos}`, `contratos=${sel.contratos.join(' ')}`];
}

/**
 * Monta o diretório que o `mutcheck-all.sh` lê via `MUTCHECK_DIR` (o mesmo mecanismo que o teste
 * do sensor usa), com um symlink por contrato selecionado. Devolve o diretório — ou `null` quando
 * o certo é rodar TODOS (então o `MUTCHECK_DIR` não é definido e o default vale).
 */
export function materializar(sel: Selecao, destino: string): string | null {
  if (sel.todos || sel.contratos.length === 0) return null;
  mkdirSync(destino, { recursive: true });
  for (const mut of sel.contratos) symlinkSync(resolve(mut), join(destino, basename(mut)));
  return destino;
}

export function lerContratos(dir: string = DIR_CONTRATOS): Contrato[] | null {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.mut'))
      .sort()
      .map((f) => {
        const mut = `${dir}/${f}`;
        return lerContrato(mut, readFileSync(mut, 'utf8'));
      });
  } catch {
    return null;
  }
}

/**
 * Os dois pais do merge commit que o `actions/checkout` faz no `pull_request` (refs/pull/N/merge):
 * pai 1 = a base no instante do merge de teste, HEAD = o resultado. O diff entre eles é EXATAMENTE
 * o que o PR muda na main. Precisa de `fetch-depth: 2`. Sem 2 pais ⇒ `null` (fail-closed).
 */
export function paisDoMerge(): { base: string; head: string } | null {
  try {
    const shas = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { encoding: 'utf8' })
      .trim()
      .split(/\s+/);
    return shas.length === 3 ? { base: shas[1], head: shas[0] } : null;
  } catch {
    return null;
  }
}

export function arquivosMudados(base: string, head: string): string[] | null {
  try {
    // -z + quotePath=false: caminho cru, sem as aspas/escapes que o git põe em nome com acento.
    // --no-renames: rename vira remoção + adição, então o caminho ANTIGO também alcança o contrato.
    const out = execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', base, head],
      { encoding: 'utf8' },
    );
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function escrever(arquivo: string | undefined, linhas: string[]): void {
  if (!arquivo) throw new Error('variável de ambiente do GitHub ausente');
  appendFileSync(arquivo, `${linhas.join('\n')}\n`);
}

if (import.meta.main) {
  const querSaida = process.argv.includes('--github-output');
  const destino = arg('--materializar');
  try {
    const evento = arg('--evento') ?? 'pull_request';
    let mudados: string[] | null = null;
    if (evento === 'pull_request') {
      const base = arg('--base');
      const par = base ? { base, head: arg('--head') ?? 'HEAD' } : paisDoMerge();
      mudados = par ? arquivosMudados(par.base, par.head) : null;
    }
    const sel = decidir(evento, mudados, lerContratos());

    for (const m of sel.motivos) console.log(`  · ${m}`);
    if (sel.todos) console.log('mutcheck-escopo: TODOS os contratos.');
    else if (sel.contratos.length > 0) console.log(`mutcheck-escopo: ${sel.contratos.length} contrato(s) no escopo deste diff.`);
    else console.log('mutcheck-escopo: nenhum contrato no escopo deste diff — o mutation-check fica pulado (a main roda TODOS).');

    if (querSaida) escrever(process.env.GITHUB_OUTPUT, linhasDeSaida(sel));
    if (destino) {
      const dir = materializar(sel, destino);
      if (dir) escrever(process.env.GITHUB_ENV, [`MUTCHECK_DIR=${dir}`]);
    }
  } catch (e) {
    // Fail-closed: o job de escopo tenta registrar "roda TODOS"; se nem isso der, a condição do
    // `mutation-check` (`roda != 'false'`) roda mesmo assim. No modo materializar, não definir o
    // MUTCHECK_DIR JÁ é rodar todos.
    console.log(`::warning::mutcheck-escopo não decidiu (${e instanceof Error ? e.message : String(e)}) — roda TODOS os contratos.`);
    if (querSaida && process.env.GITHUB_OUTPUT) {
      try {
        appendFileSync(process.env.GITHUB_OUTPUT, 'roda=true\ntodos=true\ncontratos=\n');
      } catch {
        /* a condição do job já trata saída ausente como "roda" */
      }
    }
  }
  process.exit(0);
}
