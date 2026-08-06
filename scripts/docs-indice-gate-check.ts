#!/usr/bin/env bun
/**
 * docs-indice-gate-check.ts — gate de CI que prova que nenhum doc fica INVISÍVEL no índice.
 * ============================================================================================
 *
 * A classe: diretório de docs cujo `README.md` se declara índice, com o índice mantido À MÃO.
 * Adicionar um `.md` sem a linha correspondente é o bug — e ele é SILENCIOSO por construção: o
 * arquivo existe, o CI fica verde, e o doc simplesmente não é encontrado por quem depende do
 * índice. `docs/historico/README.md` diz de si mesmo "Ao concluir uma entrega, registre aqui" —
 * convenção textual, sem nada que a segure.
 *
 * Por que um gate e não (mais) uma frase no README: medido neste repo. O PR #1658 reconciliou o
 * índice do histórico — **9 arquivos invisíveis, metade do histórico recente**. Horas depois, no
 * mesmo dia, o #1659 (uma PR de FEATURE, que só por acaso escreveu um doc) adicionou
 * `programa-cabreuva-colacor.md` sem linha nenhuma, e o índice voltou a mentir. Uma reconciliação
 * manual conserta o estado; ela não conserta a CLASSE, e a classe reincidiu em horas. É a
 * meta-regra do catálogo de retrabalho: contramedida textual reincide, gate estrutural para.
 *
 * O gate é de PRECISÃO, não de recall (mesma doutrina do `edges:typecheck`): só olha diretório que
 * TEM `README.md`, porque ter um README é a declaração de "aqui existe índice". `docs/agent/` fica
 * de fora de propósito — a tabela que o indexa vive no CLAUDE.md e enumera DOMÍNIOS, não arquivos:
 * `review.md`, `threat-model-template.md` e `csv-governo-br.md` são sub-documentos alcançáveis a um
 * salto (de `money-path.md`/`skills.md`) e seriam três falsos-positivos permanentes. Gate que nasce
 * com exceção é gate que treina a ignorar o vermelho.
 *
 * Duas invariantes, as duas direções da mesma mentira:
 *  1. ÓRFÃO — arquivo existe e o índice não o lista (o bug do #1659).
 *  2. LINK QUEBRADO — o índice lista e o arquivo não existe (renomeação/remoção pela metade).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DirIndice {
  /** caminho do diretório, relativo à raiz do repo (ex.: 'docs/historico') */
  dir: string;
  /** conteúdo do README.md que serve de índice */
  readme: string;
  /** nomes dos `.md` irmãos, SEM o README.md */
  arquivos: string[];
}

export interface Achado {
  level: 'error';
  dir: string;
  arquivo: string;
  msg: string;
}

/**
 * Links markdown para irmãos do MESMO diretório: `](x.md)`, `](./x.md)`, `](x.md#secao)`.
 *
 * Não casa `](../agent/x.md)` nem `](https://…)` de propósito — o índice de um diretório só
 * responde pelos arquivos dele, e link para fora não conta como "este arquivo está indexado".
 *
 * A âncora opcional (`#secao`) é o que impede o falso-positivo mais provável: linkar a seção certa
 * de um doc longo é uso NORMAL de markdown, e sem o `(?:#…)?` o gate acusaria "órfão" um arquivo
 * que está indexado. Gate que grita errado é gate que treina a ignorar o vermelho.
 */
const LINK_IRMAO = /\]\(\.?\/?([A-Za-z0-9._-]+\.md)(?:#[^)]*)?\)/g;

export function linksDoIndice(readme: string): Set<string> {
  return new Set(Array.from(readme.matchAll(LINK_IRMAO), (m) => m[1]));
}

export function auditarIndices(dirs: DirIndice[]): Achado[] {
  const achados: Achado[] = [];
  for (const { dir, readme, arquivos } of dirs) {
    const linkados = linksDoIndice(readme);

    for (const arquivo of arquivos) {
      if (linkados.has(arquivo)) continue;
      achados.push({
        level: 'error',
        dir,
        arquivo,
        msg:
          `${dir}/${arquivo} existe e NÃO está no índice ${dir}/README.md — o doc fica invisível ` +
          `para quem procura pelo índice (o CI passa, e ninguém acha o arquivo). Acrescente a linha ` +
          `na tabela do README, com uma descrição do que o doc tem.`,
      });
    }

    for (const link of linkados) {
      if (arquivos.includes(link)) continue;
      achados.push({
        level: 'error',
        dir,
        arquivo: link,
        msg:
          `${dir}/README.md aponta para ${link}, que NÃO existe — renomeação ou remoção feita pela ` +
          `metade. Corrija o link ou remova a linha.`,
      });
    }
  }
  return achados;
}

/** Descobre todo subdiretório de `docs/` que tenha `README.md` — ter README É a declaração de "aqui há índice". */
export function lerDiretoriosIndexados(raiz = 'docs'): DirIndice[] {
  if (!existsSync(raiz)) return [];
  return readdirSync(raiz, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(raiz, e.name))
    .filter((dir) => existsSync(join(dir, 'README.md')))
    .map((dir) => ({
      dir,
      readme: readFileSync(join(dir, 'README.md'), 'utf8'),
      arquivos: readdirSync(dir)
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .sort(),
    }));
}

if (import.meta.main) {
  const achados = auditarIndices(lerDiretoriosIndexados());
  if (achados.length === 0) {
    console.log('docs-indice-gate: ✓ todo doc de diretório indexado está no índice.');
    process.exit(0);
  }
  for (const a of achados) console.error(`✗ ${a.msg}`);
  console.error(`\ndocs-indice-gate: ${achados.length} problema(s).`);
  process.exit(1);
}
