#!/usr/bin/env bun
/**
 * docs-citacoes-gate-check.ts — gate de CI que prova que citação `arquivo:linha` ainda aponta
 * para o que ela DIZ que aponta.
 * ============================================================================================
 *
 * A classe: doc vivo que cita uma linha exata de outro arquivo (`docs/ux-audit/03-roadmap.md:94`,
 * `src/index.css:306`). O número de linha não tem vínculo nenhum com o conteúdo — QUALQUER edição
 * acima do ponto citado desloca o alvo, e a citação passa a apontar para outra coisa **em
 * silêncio**: o arquivo existe, a linha existe, o CI fica verde, e o leitor é mandado para a linha
 * errada com toda a confiança do mundo.
 *
 * Por que um gate: medido neste repo, na janela de UM dia. O #1803 gravou 5 citações de linha na §7
 * de `docs/visual-direction/01-direcao.md` para provar de onde vem cada regra de design. No dia
 * seguinte o #1813 inseriu DUAS linhas no cabeçalho de `docs/ux-audit/03-roadmap.md` — as 5
 * citações passaram a apontar para linhas de `**ICE**: I=8 · C=10 · E=9`, e nada no CI piscou. Foi
 * pego por leitura manual, por acaso, porque o autor da inserção era quem tinha acabado de
 * verificar as citações. Nenhum gate do repo cobria isso, e a próxima vez não teria a mesma sorte.
 *
 * ## Por que o número de linha sozinho não dá para verificar (e o que o gate exige no lugar)
 *
 * Checar "o arquivo tem ≥N linhas" não pega nada: no caso acima a linha 92 continuou existindo,
 * só passou a conter outra coisa. Um lockfile de hash também não resolve — desloca, quebra, o
 * autor roda o atualizador, ele re-hasheia a linha ERRADA e o gate volta ao verde com a citação
 * quebrada. Verificação só existe contra uma afirmação SEMÂNTICA que um humano escreveu.
 *
 * Por isso toda citação verificável carrega a sua âncora, co-locada:
 *
 *     `docs/ux-audit/03-roadmap.md:94`<!--cita: Carbon Touch Target-->
 *
 * O comentário HTML não renderiza (o doc lido continua limpo) e vive colado na citação — não é
 * baseline nem manifesto central, que é a forma que este repo já rejeitou noutros gates: registro
 * longe do fato dessincroniza, e ninguém revisa as duas pontas.
 *
 * ## Gate de PRECISÃO — o que fica DE FORA, de propósito
 *
 * 1. **Docs congelados**: `docs/historico/`, `docs/superpowers/` e `docs/ux-audit/` NÃO são
 *    varridos. São artefatos DATADOS — um spec de maio que cita o `Index.tsx` de maio está
 *    correto ao descrever o mundo de maio, e exigir que ele acompanhe a `main` é churn sobre
 *    história, além de falso-positivo permanente (medido: 553 das 580 citações do repo vivem
 *    nesses três, e 4 já estão fora de range hoje). Citação PARA dentro deles continua coberta —
 *    quem é varrido é o doc que CITA.
 * 2. **Basename ambíguo** (`index.ts:397`): sem `/`, e o repo tem dezenas de `index.ts`. Resolver
 *    no chute é fábrica de falso-positivo; o gate só resolve basename que casa com UM arquivo no
 *    repo inteiro. Os ambíguos são CONTADOS e impressos, para o buraco ficar visível sem barrar.
 * 3. **Caminho externo** (`node_modules`, lib de terceiro): allowlist explícita em `EXTERNOS`.
 *
 * Gate que nasce com exceção implícita é gate que treina a ignorar o vermelho — por isso cada
 * exclusão acima é nominal e tem o porquê escrito.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

/** Docs VIVOS — os que precisam estar certos hoje. Congelados ficam fora (ver cabeçalho). */
export const ALVOS_VIVOS = ['CLAUDE.md', 'docs/agent', 'docs/visual-direction', 'docs/runbooks'];

/**
 * Artefatos DATADOS que moram dentro de pasta viva. Nominal e com motivo — a pasta é o default,
 * o arquivo é a exceção. Um relatório fechado cita o código do DIA dele; forçá-lo a acompanhar a
 * `main` reescreveria o registro para descrever um mundo que ele não observou.
 */
export const CONGELADOS = [
  // Revisão `frontend-design` de 2026-05-13, fechada. As citações dela estão obsoletas de
  // PROPÓSITO e provam isso: `CompanySwitcher.tsx:17` era hsl inline e hoje é `tokenVar` (o bug
  // que ela apontou FOI corrigido), e o `.shimmer` de `index.css:373` virou `.animate-shimmer`
  // na 659. Atualizar os números apagaria o achado.
  'docs/visual-direction/05-revisao-skill.md',
];

/** Caminhos que não moram no repo. Nominal e com motivo — nunca um catch-all. */
export const EXTERNOS = [
  'postgrest-js/', // lib do @supabase/postgrest-js; citada para explicar a capa de 1.000 linhas
];

/** Extensões que valem como alvo de citação. */
const EXT = 'md|ts|tsx|css|sql|sh|yml|yaml|json|toml';

/** `caminho.ext:123` (ou `:123,456`), seguido OPCIONALMENTE da âncora `<!--cita: ...-->`. */
const RE_CITACAO = new RegExp(
  `([A-Za-z0-9_][A-Za-z0-9_./-]*\\.(?:${EXT})):(\\d+(?:,\\d+)*)\\)?\`?(\\s*<!--\\s*cita:\\s*([^>]*?)\\s*-->)?`,
  'g',
);

export interface Citacao {
  doc: string;
  linhaDoDoc: number;
  alvo: string;
  linhas: string[];
  ancora: string | null;
}

export interface Achado {
  doc: string;
  linhaDoDoc: number;
  msg: string;
}

/** Extrai as citações de um markdown. Puro: recebe texto, devolve estrutura. */
export function parseCitacoes(doc: string, texto: string): Citacao[] {
  const out: Citacao[] = [];
  const linhas = texto.split('\n');
  for (let i = 0; i < linhas.length; i++) {
    // Bloco de código não é citação — é exemplo. (Heurística barata: linha dentro de ``` é pulada.)
    for (const m of linhas[i].matchAll(RE_CITACAO)) {
      out.push({
        doc,
        linhaDoDoc: i + 1,
        alvo: m[1],
        linhas: m[2].split(','),
        ancora: m[4] !== undefined ? m[4] : null,
      });
    }
  }
  return out;
}

/** Índice basename → caminhos, para resolver citação sem `/` só quando ela for ÚNICA. */
export function indexarRepo(raiz: string): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  const IGNORA = new Set(['node_modules', '.git', 'dist', 'build', '.claude', 'coverage']);
  const anda = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (IGNORA.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) anda(p);
      else {
        const lista = idx.get(e.name) ?? [];
        lista.push(p);
        idx.set(e.name, lista);
      }
    }
  };
  anda(raiz);
  return idx;
}

export interface Resultado {
  achados: Achado[];
  verificadas: number;
  ambiguas: number;
  externas: number;
}

/** O coração: valida cada citação contra o conteúdo REAL da linha citada. */
export function auditarCitacoes(
  citacoes: Citacao[],
  raiz: string,
  idx: Map<string, string[]>,
  lerArquivo: (p: string) => string | null,
): Resultado {
  const achados: Achado[] = [];
  let verificadas = 0;
  let ambiguas = 0;
  let externas = 0;

  for (const c of citacoes) {
    const onde = { doc: c.doc, linhaDoDoc: c.linhaDoDoc };

    if (EXTERNOS.some((e) => c.alvo.includes(e))) {
      externas++;
      continue;
    }

    // Resolve: relativo ao doc → relativo à raiz → basename único no repo. Quem responde
    // "existe?" é o próprio `lerArquivo` — assim o auditor não toca o disco e é testável puro.
    let conteudo: string | null = null;
    for (const t of [resolve(dirname(join(raiz, c.doc)), c.alvo), resolve(raiz, c.alvo)]) {
      conteudo = lerArquivo(t);
      if (conteudo !== null) break;
    }
    if (conteudo === null && !c.alvo.includes('/')) {
      const casos = idx.get(basename(c.alvo)) ?? [];
      if (casos.length !== 1) {
        ambiguas++; // basename que casa com 0 ou N arquivos — inverificável, ver cabeçalho §2
        continue;
      }
      conteudo = lerArquivo(casos[0]);
    }
    if (conteudo === null) {
      achados.push({ ...onde, msg: `cita \`${c.alvo}\`, que NÃO existe no repo` });
      continue;
    }

    if (c.linhas.length > 1) {
      achados.push({
        ...onde,
        msg: `\`${c.alvo}:${c.linhas.join(',')}\` cita várias linhas de uma vez — uma âncora só descreve UMA linha. Separe em citações independentes, cada uma com o seu \`<!--cita: ...-->\`.`,
      });
      continue;
    }

    const linhasAlvo = conteudo.split('\n');
    const n = Number(c.linhas[0]);
    if (n < 1 || n > linhasAlvo.length) {
      achados.push({
        ...onde,
        msg: `\`${c.alvo}:${n}\` está FORA do arquivo (ele tem ${linhasAlvo.length} linhas)`,
      });
      continue;
    }

    if (c.ancora === null) {
      achados.push({
        ...onde,
        msg: `\`${c.alvo}:${n}\` não tem âncora. Sem ela o número de linha é inverificável — acrescente \`<!--cita: <trecho literal da linha>-->\` logo depois. Hoje a linha ${n} é: ${recorte(linhasAlvo[n - 1])}`,
      });
      continue;
    }
    if (c.ancora === '') {
      achados.push({ ...onde, msg: `\`${c.alvo}:${n}\` tem âncora VAZIA` });
      continue;
    }
    if (!linhasAlvo[n - 1].includes(c.ancora)) {
      achados.push({
        ...onde,
        msg: `\`${c.alvo}:${n}\` deveria conter "${c.ancora}", mas a linha ${n} é: ${recorte(linhasAlvo[n - 1])}`,
      });
      continue;
    }
    verificadas++;
  }
  return { achados, verificadas, ambiguas, externas };
}

const recorte = (s: string) => {
  const t = s.trim();
  return t.length === 0 ? '(vazia)' : `«${t.slice(0, 90)}${t.length > 90 ? '…' : ''}»`;
};

/** Lista os markdowns vivos que o gate varre. */
export function lerDocsVivos(raiz = '.'): string[] {
  const out: string[] = [];
  for (const alvo of ALVOS_VIVOS) {
    const p = join(raiz, alvo);
    if (!existsSync(p)) continue;
    if (statSync(p).isFile()) {
      out.push(relative(raiz, p));
      continue;
    }
    const anda = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const q = join(d, e.name);
        if (e.isDirectory()) anda(q);
        else if (e.name.endsWith('.md')) {
          const rel = relative(raiz, q);
          if (!CONGELADOS.includes(rel)) out.push(rel);
        }
      }
    };
    anda(p);
  }
  return out.sort();
}

if (import.meta.main) {
  const raiz = process.cwd();
  const docs = lerDocsVivos(raiz);
  const citacoes = docs.flatMap((d) => parseCitacoes(d, readFileSync(join(raiz, d), 'utf8')));
  const idx = indexarRepo(raiz);
  const r = auditarCitacoes(citacoes, raiz, idx, (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  });

  const resumo = `${r.verificadas} citação(ões) verificada(s) contra o conteúdo real · ${r.ambiguas} inverificável(is) por basename ambíguo · ${r.externas} externa(s)`;
  if (r.achados.length === 0) {
    console.log(`docs-citacoes-gate: ✓ ${resumo}.`);
    process.exit(0);
  }
  console.error(`docs-citacoes-gate: ✗ ${r.achados.length} citação(ões) quebrada(s). ${resumo}.\n`);
  for (const a of r.achados) console.error(`  ${a.doc}:${a.linhaDoDoc} — ${a.msg}`);
  console.error(
    `\nUma citação de linha só vale se disser o que espera achar lá. Formato:\n  \`caminho/arquivo.md:123\`<!--cita: trecho literal da linha 123-->`,
  );
  process.exit(1);
}
