#!/usr/bin/env bun
/**
 * diretiva-ambiente-gate.ts — o docblock de ambiente do vitest só vale no cabeçalho, uma vez.
 * ============================================================================================
 *
 * O vitest 3.2.6 procura a diretiva de ambiente com REGEX NO ARQUIVO INTEIRO, não na primeira
 * linha, e aceita o alias `jest` (node_modules/vitest/dist/chunks/coverage.DfSpMS-b.js:2403-2407).
 * Neste repo, cheio de gates textuais que citam literais para asserir sobre OUTROS arquivos, isso
 * é uma armadilha real: basta um teste mencionar o literal numa asserção para ele trocar o próprio
 * ambiente em silêncio — e ficar verde, porque o teste não sabe em que ambiente deveria estar.
 *
 * Foi reproduzido durante a construção DESTE gate: escrever o literal completo dentro de uma
 * asserção selecionou `node` para o arquivo de teste do gate.
 *
 * Este gate NÃO usa o stripper compartilhado de comentários (`removerComentarios` de
 * `@/lib/gates/limpeza-fonte`). A regra geral do CLAUDE.md o inverteria: aqui a diretiva VIVE num
 * comentário, e é o comentário que o vitest lê. O gate mede o mesmo texto cru que o vitest mede.
 *
 * A lista de arquivos vem dos `include` IMPORTADOS de vitest.config.ts — não de um espelho.
 * Espelho desatualiza em silêncio; import quebra alto.
 *
 * ⚠️ O denominador é a UNIÃO dos `include` de TODOS os `test.projects` (hoje `node` para `.ts` e
 * `dom` para `.tsx`), porque desde o #2336 não existe mais `test.include` na raiz. Ler um só
 * project ficaria verde por ORDENAÇÃO: metade da suíte sairia do denominador sem nada gritar — e
 * arquivo que o gate não olha é aprovado por AUSÊNCIA, que é exatamente a doença que ele existe
 * para caçar. Daí o fail-CLOSED de `globsDosProjects`: sem `projects`, com project SEM `include`
 * próprio, ou com união vazia, o gate LANÇA em vez de auditar um denominador menor que a suíte.
 */
import { readFileSync } from "node:fs";

// `import { Glob } from "bun"` quebra a análise estática do Vite: `diretiva-ambiente-gate.test.ts`
// importa `auditarDiretivas` deste módulo, e o vitest resolve o GRAFO inteiro do arquivo antes de
// rodar qualquer teste — "Failed to resolve import 'bun'", suíte inteira vermelha, mesmo sem
// nenhum teste chamar `lerArquivosDoInclude`. `Bun.Glob` é o MESMO objeto via global ambiente (tipado
// por `bun-types`, já em tsconfig.scripts.json), sem import — nada para o Vite resolver.
//
// `vitest.config.ts` (abaixo) também NÃO é import estático, pelo MESMO motivo com um efeito pior:
// reproduzido ao vivo — importar `../vitest.config` no topo deste arquivo faz o vitest quebrar com
// "Invariant violation: new TextEncoder().encode('') instanceof Uint8Array is incorrectly false"
// ao transformar `diretiva-ambiente-gate.test.ts`, porque esse import carrega o plugin
// `@vitejs/plugin-react-swc` — e o SSR module runner do PRÓPRIO vitest tenta montar o grafo
// inteiro (inclusive o config, com o plugin) antes de rodar qualquer teste, mesmo que nenhum teste
// chame `lerArquivosDoInclude`. `import()` dinâmico, só executado dentro da função — nunca
// alcançado pelo teste —, resolve: confirmado que o vitest NÃO segue um `import()` dinâmico não
// chamado. A CLI real (`bun scripts/diretiva-ambiente-gate.ts`, sem Vite no meio) não tem esse
// problema de qualquer forma; a lazyness aqui é só para não derrubar o TESTE do gate.

export const LINHAS_CABECALHO = 5;
export const AMBIENTES_PERMITIDOS = ["jsdom", "node"] as const;

// MESMO regex do vitest (coverage.DfSpMS-b.js:2403), em modo global para CONTAR ocorrências.
const RE_AMBIENTE = /@(vitest|jest)-environment\s+([\w-]+)\b/g;
const RE_OPCOES = /@(?:vitest|jest)-environment-options\b/g;

export type Achado = { caminho: string; linha?: number; msg: string };
export type Arquivo = { caminho: string; texto: string };

function linhaDe(texto: string, indice: number): number {
  return texto.slice(0, indice).split("\n").length;
}

export function auditarDiretivas(arquivos: Arquivo[]): Achado[] {
  const achados: Achado[] = [];
  for (const { caminho, texto } of arquivos) {
    if (RE_OPCOES.test(texto)) {
      achados.push({ caminho, msg: "usa a diretiva de environment-options; não é suportada neste repo" });
      RE_OPCOES.lastIndex = 0;
      continue;
    }
    RE_OPCOES.lastIndex = 0;
    const ocorrencias = [...texto.matchAll(RE_AMBIENTE)];
    if (ocorrencias.length === 0) continue;
    if (ocorrencias.length > 1) {
      achados.push({
        caminho,
        linha: linhaDe(texto, ocorrencias[1].index!),
        msg: `${ocorrencias.length} ocorrências da diretiva de ambiente; o vitest obedece a PRIMEIRA e ignora o resto`,
      });
      continue;
    }
    const [m] = ocorrencias;
    const linha = linhaDe(texto, m.index!);
    if (m[1] === "jest") {
      achados.push({ caminho, linha, msg: "usa o alias jest; o vitest o obedece, mas neste repo só o alias vitest é permitido" });
      continue;
    }
    if (linha > LINHAS_CABECALHO) {
      achados.push({ caminho, linha, msg: `diretiva fora das primeiras ${LINHAS_CABECALHO} linhas do arquivo` });
      continue;
    }
    if (!(AMBIENTES_PERMITIDOS as readonly string[]).includes(m[2])) {
      achados.push({ caminho, linha, msg: `ambiente "${m[2]}" fora da allowlist (${AMBIENTES_PERMITIDOS.join(", ")})` });
    }
  }
  return achados;
}

/**
 * Forma MÍNIMA da config que este gate consome. Declarada aqui (em vez de importar o tipo do
 * vitest) porque o que interessa é o CONTRATO que o gate exige — e é ele que precisa quebrar alto
 * quando a config mudar de forma.
 */
export type ConfigComProjects = {
  test?: { projects?: unknown[] };
};

/**
 * A união dos `include` de todos os `test.projects`, ou uma exceção. Fail-CLOSED em três degraus,
 * todos com a mesma justificativa: denominador menor que a suíte transforma o gate em verde por
 * ausência. Separada de `lerArquivosDoInclude` para ser testável sem tocar em disco.
 */
export function globsDosProjects(config: ConfigComProjects): string[] {
  const projects = config.test?.projects;
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error(
      "vitest.config.ts não expôs test.projects — o gate não tem denominador e falha FECHADO",
    );
  }
  const globs: string[] = [];
  projects.forEach((project, i) => {
    const include = (project as { test?: { include?: unknown } } | undefined)?.test?.include;
    if (!Array.isArray(include) || include.length === 0) {
      // Project sem `include` próprio cai no default do vitest (ou herda a raiz por `extends`), e
      // o gate não tem como saber QUAIS arquivos são. Silenciar aqui é aceitar auditar menos do
      // que roda — a saída certa é declarar o `include` no project.
      const nome = (project as { test?: { name?: unknown } } | undefined)?.test?.name;
      throw new Error(
        `test.projects[${i}]${typeof nome === "string" ? ` ("${nome}")` : ""} não declara include próprio — ` +
          "o gate auditaria MENOS arquivos do que o vitest roda e falha FECHADO",
      );
    }
    for (const g of include) {
      if (typeof g !== "string") {
        throw new Error(`test.projects[${i}].test.include tem entrada não-string — o gate falha FECHADO`);
      }
      globs.push(g);
    }
  });
  if (globs.length === 0) {
    throw new Error("a união dos include dos projects veio vazia — o gate falha FECHADO");
  }
  return globs;
}

export async function lerArquivosDoInclude(): Promise<Arquivo[]> {
  const { default: viteConfig } = await import("../vitest.config");
  const padroes = globsDosProjects(viteConfig as ConfigComProjects);
  const caminhos = new Set<string>();
  for (const padrao of padroes) {
    for (const c of new Bun.Glob(padrao).scanSync(".")) caminhos.add(c);
  }
  return [...caminhos].sort().map((caminho) => ({ caminho, texto: readFileSync(caminho, "utf8") }));
}

if (import.meta.main) {
  const arquivos = await lerArquivosDoInclude();
  const achados = auditarDiretivas(arquivos);
  for (const a of achados) console.error(`✗ ${a.caminho}${a.linha ? `:${a.linha}` : ""} ${a.msg}`);
  if (achados.length === 0) {
    console.log(`✓ diretiva-ambiente: ${arquivos.length} arquivos, nenhuma diretiva mal colocada.`);
  }
  process.exit(achados.length > 0 ? 1 : 0);
}
