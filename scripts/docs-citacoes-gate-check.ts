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
 * 1. **Docs congelados**: `docs/historico/`, `docs/superpowers/` e `docs/ux-audit/` não são
 *    varridos POR INTEIRO. São artefatos DATADOS — um spec de maio que cita o `Index.tsx` de maio
 *    está correto ao descrever o mundo de maio, e exigir que ele acompanhe a `main` é churn sobre
 *    história, além de falso-positivo permanente (medido: 553 das 580 citações do repo vivem
 *    nesses três, e 4 já estão fora de range hoje). Citação PARA dentro deles continua coberta —
 *    quem é varrido é o doc que CITA. O que ATRAVESSA o congelamento é a âncora (seção abaixo).
 * 2. **Caminho externo** (`node_modules`, lib de terceiro, outro projeto): allowlist explícita em
 *    `EXTERNOS`.
 * 3. **Bloco de código cercado** (```/~~~): ali a citação ILUSTRA o formato — cobrá-la obrigaria
 *    quem documenta este gate a inventar um alvo real só para o exemplo. Sai só a CERCA, nunca a
 *    crase inline: a citação canônica NASCE entre crases, e passar o texto pelo `removerCodigo`
 *    do gate de links leva as 22 citações vivas a 0 com exit 0 — verde por cegueira, que é a
 *    falha de `docs/historico/gates-textuais-cegos.md` de novo. Cerca que nunca FECHA engole o
 *    resto do arquivo e vira achado, quando esconde citação.
 *
 * Exclusão CALADA, porém, é o mesmo veneno noutra forma. "21 citações verificadas ✓" lê como
 * cobertura TOTAL tanto quando o gate cobriu tudo quanto quando deixou 596 de fora (medido em
 * 2026-08-25) — quem lê o log do CI não tem como separar os dois casos, e corte deliberado vira
 * indistinguível de cobertura completa. Por isso o resumo conta o PULADO por motivo, no verde e no
 * vermelho, com os zeros explícitos. O caso que cobrou: o §10 de
 * `docs/historico/verificar-sonda-versao.md` ensina sobre gate cego e cita quatro PRs — de dentro
 * da zona não varrida, o que só se descobriu lendo o fonte deste gate por outro motivo.
 *
 * ## Âncora é PROMESSA — e vale onde ela estiver escrita
 *
 * O corte por diretório protege o doc DATADO de ser obrigado a acompanhar a `main`. Ele não
 * protege quem, DENTRO do doc datado, escreveu uma âncora à mão: `<!--cita: ...-->` não se digita
 * por acidente — é uma afirmação sobre o que está na linha HOJE. Até 2026-08-29 essa afirmação só
 * era cobrada se calhasse de morar em pasta viva, e o buraco foi medido: ao escrever
 * `docs/historico/escrita-de-aplicacao-como-sensor-de-deploy.md`, uma âncora sabotada
 * (`<!--cita: SABOTAGEM_QUE_NAO_EXISTE_NA_LINHA-->`) passou com **exit 0 e sem mover o contador**;
 * as âncoras daquele doc tiveram de ser conferidas à mão.
 *
 * Então: **toda citação ANCORADA é verificada, varrida a pasta ou não**. A citação SEM âncora em
 * doc não varrido continua fora — é a dívida declarada, e segue contada no resumo.
 *
 * Estender o DIRETÓRIO inteiro foi medido e recusado no mesmo dia. Das 133 citações de
 * `docs/historico/`, **zero** tinham âncora quebrada: a podridão semântica era nula. 109 não
 * tinham âncora nenhuma, e os 22 achados restantes eram FORMA, não apodrecimento — 13 dos 14 "não
 * existe" eram o caminho abreviado da edge (`sync-reprocess/index.ts` em vez de
 * `supabase/functions/sync-reprocess/index.ts`), mais 5 basenames nus e 3 multi-linha. Ligar a
 * pasta custaria 131 vermelhos e obrigaria a escrever âncora em documento datado — o churn sobre
 * história que o congelamento existe para evitar — para pegar UM alvo de fato sumido
 * (`src/hooks/useDirectTintImport.ts`). Baseline por contagem, a outra saída, é o
 * registro-longe-do-fato que este arquivo recusa duas seções acima. Custo da regra por âncora,
 * medido: 4 citações, todas já verdes. `docs/superpowers/` (453 citações, 0 ancoradas) e
 * `docs/ux-audit/` (7, 0 ancoradas) seguem congelados pela mesma conta — a regra os cobre no dia
 * em que alguém escrever uma âncora lá, sem precisar mexer neste arquivo.
 *
 * Âncora QUEBRADA DE LINHA conta como âncora. A varredura é linha a linha, então o `\s*` que o
 * regex põe entre citação e âncora nunca via um `\n`: o autor escrevia a âncora e o gate lia
 * `null`. Duas citações CORRETAS de `docs/historico/fase-sem-sinal.md` viviam nesse limbo. Em doc
 * vivo isso vira o achado barulhento "não tem âncora"; em doc não varrido sumiria calado, que é o
 * mesmo veneno. Em compensação, a âncora só é adotada pela ÚLTIMA citação da linha e só se nada
 * mais sobrar depois dela — senão ela seria atribuída a uma citação que não é a dona.
 *
 * `CONGELADOS` continua sendo a saída NOMINAL, e agora vale contra a âncora também: doc listado
 * ali declarou que as citações dele estão obsoletas de propósito, e nem a promessa é cobrada.
 *
 * Basename nu (`index.ts:397`) NÃO é exceção: **reprova**. O repo tem 99 `index.ts`, então resolver
 * no chute seria fábrica de falso-positivo — mas *pular* é pior, porque vira a saída de emergência
 * que esvazia o gate (basta escrever o nome curto para nunca mais ser cobrado). Até o #1820 eles
 * eram pulados-e-contados (5 no repo); o #1826 converteu os 5 para caminho completo e fechou a
 * porta. Converter sem fechar seria a contramedida TEXTUAL que este repo já sabe que reincide.
 * Ao converter, dois dos cinco estavam quebrados havia meses: os call sites de
 * `tint_promote_sync_run` tinham ido de :397/:542 para :392/:514, e o `estoque=0` do
 * `fin-cashflow-engine` de :306 para :467.
 *
 * Gate que nasce com exceção implícita é gate que treina a ignorar o vermelho — por isso cada
 * exclusão acima é nominal e tem o porquê escrito.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { removerCercas } from './lib/markdown-codigo';

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
  'THREAT_MODEL.md', // do projeto `aura`, citado como EXEMPLO de doc×código divergindo no default
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

/**
 * Extrai as citações de um markdown. Puro: recebe texto, devolve estrutura.
 *
 * Bloco cercado (```/~~~) fica de fora: ali a citação ILUSTRA o formato, não afirma nada sobre o
 * repo — cobrar `arquivo.md:123<!--cita: trecho-->` escrito como exemplo obrigaria o autor a
 * inventar um alvo real só para documentar o gate. Sai só a CERCA, nunca a crase inline: a citação
 * canônica deste repo nasce entre crases, e passar o texto pelo `removerCodigo` do gate de links
 * levaria as 22 citações vivas a 0 (medido em 2026-08-22) — verde por cegueira, não por acerto.
 */
export function parseCitacoes(
  doc: string,
  texto: string,
): { citacoes: Citacao[]; achados: Achado[]; emCerca: number; escondidas: Citacao[] } {
  const { texto: semCercas, cercaAberta } = removerCercas(texto);
  const brutas = citacoesEm(doc, texto);
  const citacoes = citacoesEm(doc, semCercas);

  // O skip cobra um preço: cerca que nunca fecha esvazia tudo abaixo dela, e um gate que mede só
  // o que sobrou fica verde sem ter olhado. Vira achado — mas só quando escondeu citação de fato,
  // senão o gate passaria a cobrar estilo de markdown, que não é o assunto dele.
  const escondidas = cercaAberta
    ? citacoesEm(doc, cercaAberta.textoEngolido, cercaAberta.linha - 1)
    : [];
  const achados: Achado[] =
    cercaAberta && escondidas.length > 0
      ? [
          {
            doc,
            linhaDoDoc: cercaAberta.linha,
            msg: `cerca de código \`${cercaAberta.marca}\` aberta aqui e nunca fechada — ela engole o resto do arquivo, e com ele ${escondidas.length} citação(ões) que somem da medição em silêncio. Feche o bloco.`,
          },
        ]
      : [];

  // O que a cerca comeu volta como NÚMERO. A cerca esvazia linha a linha e preserva a numeração,
  // então a citação que sobrevive ao strip é sempre um subconjunto da bruta — a diferença é
  // exatamente o pulo. Inclui o que a cerca ABERTA engoliu: aquilo também vira achado, mas pulado
  // é pulado, e some da medição do mesmo jeito.
  return { citacoes, achados, emCerca: brutas.length - citacoes.length, escondidas };
}

/** A âncora sozinha, abrindo a linha — a forma que sobra quando ela quebrou de linha. */
const RE_ANCORA_SOLTA = /^\s*<!--\s*cita:\s*([^>]*?)\s*-->/;

/** O regex sobre um texto JÁ limpo. `offsetLinha` recoloca a numeração do trecho no doc inteiro. */
function citacoesEm(doc: string, texto: string, offsetLinha = 0): Citacao[] {
  const out: Citacao[] = [];
  const linhas = texto.split('\n');
  for (let i = 0; i < linhas.length; i++) {
    const achadas = [...linhas[i].matchAll(RE_CITACAO)];
    for (const m of achadas) {
      let ancora = m[4] !== undefined ? m[4] : null;
      // A âncora pode ter caído na linha SEGUINTE: a varredura é linha a linha, então o `\s*` que
      // o regex põe entre citação e âncora nunca vê um `\n`. Só vale para a ÚLTIMA citação da
      // linha e quando nada mais sobra depois dela — senão a âncora colada abaixo seria atribuída
      // a uma citação que não é a dona dela.
      const sobra = linhas[i].slice((m.index ?? 0) + m[0].length);
      if (ancora === null && m === achadas[achadas.length - 1] && /^\s*$/.test(sobra)) {
        const solta = RE_ANCORA_SOLTA.exec(linhas[i + 1] ?? '');
        if (solta) ancora = solta[1];
      }
      out.push({
        doc,
        linhaDoDoc: offsetLinha + i + 1,
        alvo: m[1],
        linhas: m[2].split(','),
        ancora,
      });
    }
  }
  return out;
}

/**
 * Das citações de um doc, as que carregam âncora. `<!--cita: ...-->` não se digita por acidente: é
 * uma afirmação que um humano escreveu à mão sobre o que está na linha HOJE. Promessa vale onde
 * estiver escrita — inclusive em doc não varrido, onde a citação SEM âncora continua fora (essa é
 * a dívida declarada, e ela segue contada no resumo).
 */
export function apenasAncoradas(citacoes: Citacao[]): Citacao[] {
  return citacoes.filter((c) => c.ancora !== null);
}

/**
 * O que não é "o repo" para este gate: saída de build, vendor — e `.claude`, que hospeda as
 * WORKTREES. Descer ali reencontraria o repo inteiro uma vez por worktree viva, o que estragaria
 * tanto o índice de basename quanto a conta do que ficou fora do escopo.
 */
const IGNORA = new Set(['node_modules', '.git', 'dist', 'build', '.claude', 'coverage']);

/** Índice basename → caminhos, para resolver citação sem `/` só quando ela for ÚNICA. */
export function indexarRepo(raiz: string): Map<string, string[]> {
  const idx = new Map<string, string[]>();
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
      if (casos.length > 1) {
        achados.push({
          ...onde,
          msg: `\`${c.alvo}\` é basename ambíguo — casa com ${casos.length} arquivos no repo. Escreva o caminho completo a partir da raiz (ex.: \`${relative(raiz, casos[0])}\`).`,
        });
        continue;
      }
      if (casos.length === 1) conteudo = lerArquivo(casos[0]);
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
  return { achados, verificadas, externas };
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

/**
 * O COMPLEMENTO de `lerDocsVivos`: todo markdown do repo que este gate não varre. Calculado, e não
 * listado à mão, de propósito — uma lista de zonas congeladas dessincroniza da realidade em
 * silêncio, e o relato voltaria a mentir cobertura. Pega os dois formatos de exclusão: a zona por
 * diretório (o que não está em `ALVOS_VIVOS`) e o artefato nominal de `CONGELADOS`.
 */
export function lerDocsForaDoEscopo(raiz = '.'): string[] {
  const vivos = new Set(lerDocsVivos(raiz));
  const out: string[] = [];
  const anda = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (IGNORA.has(e.name)) continue;
      const q = join(d, e.name);
      if (e.isDirectory()) anda(q);
      else if (e.name.endsWith('.md')) {
        const rel = relative(raiz, q);
        if (!vivos.has(rel)) out.push(rel);
      }
    }
  };
  anda(raiz);
  return out.sort();
}

/**
 * Quantas citações moram nos docs que o gate não varre. Conta TUDO que casa com o formato, cerca
 * inclusive: no doc não varrido ninguém verifica nada, então separar por sub-motivo ali seria
 * precisão inventada.
 */
export function contarCitacoesEm(docs: string[], ler: (doc: string) => string): number {
  let n = 0;
  for (const d of docs) {
    const p = parseCitacoes(d, ler(d));
    n += p.citacoes.length + p.emCerca;
  }
  return n;
}

/** O que o gate deixou de fora, por MOTIVO. */
export interface ForaDoEscopo {
  /** citações em markdown que o gate não varre — congelado por diretório ou nominal */
  emDocNaoVarrido: number;
  /** citações dentro de cerca de código, nos docs que ele varre */
  emCerca: number;
}

/**
 * A linha que o CI mostra. Diz o que foi verificado E o que ficou de fora, por motivo — "21
 * citações verificadas ✓" lê como cobertura TOTAL tanto quando o gate cobriu tudo quanto quando
 * deixou centenas fora, e quem lê o log não tem como separar os dois casos. Corte deliberado que
 * não se anuncia é indistinguível de cobertura completa; os zeros ficam explícitos justamente para
 * o "não pulei nada" ser uma afirmação, e não a ausência da cláusula.
 */
export function formatarResumo(r: Resultado, fora: ForaDoEscopo, ancoradasForaDeCasa = 0): string {
  const total = fora.emDocNaoVarrido + fora.emCerca;
  return (
    `${r.verificadas} citação(ões) verificada(s) contra o conteúdo real` +
    ` (${ancoradasForaDeCasa} ancorada(s) em doc não varrido) · ${r.externas} externa(s)` +
    ` · ${total} fora do escopo (${fora.emDocNaoVarrido} em doc não varrido, ${fora.emCerca} em cerca)`
  );
}

if (import.meta.main) {
  const raiz = process.cwd();
  const ler = (d: string) => readFileSync(join(raiz, d), 'utf8');
  const docs = lerDocsVivos(raiz);
  const parses = docs.map((d) => parseCitacoes(d, ler(d)));

  // Doc não varrido entra pela ÂNCORA, e só por ela. `CONGELADOS` é a saída nominal e vale aqui
  // também: doc listado ali declarou que as citações dele estão obsoletas de propósito.
  const fora = lerDocsForaDoEscopo(raiz);
  const parsesFora = fora.filter((d) => !CONGELADOS.includes(d)).map((d) => parseCitacoes(d, ler(d)));
  const ancoradas = apenasAncoradas(parsesFora.flatMap((p) => p.citacoes));

  const idx = indexarRepo(raiz);
  const r = auditarCitacoes([...parses.flatMap((p) => p.citacoes), ...ancoradas], raiz, idx, (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  });

  // Cerca aberta em doc não varrido só vira achado quando engoliu uma citação ANCORADA — é o
  // único caso em que ela esconde promessa cobrável; cobrar as outras seria reger o markdown de
  // 564 documentos datados que este gate deliberadamente não varre.
  const achados = [
    ...parses.flatMap((p) => p.achados),
    ...parsesFora.filter((p) => apenasAncoradas(p.escondidas).length > 0).flatMap((p) => p.achados),
    ...r.achados,
  ];
  const resumo = formatarResumo(
    r,
    {
      // As ancoradas saíram de "fora do escopo": agora respondem pelo conteúdo como as outras.
      emDocNaoVarrido: contarCitacoesEm(fora, ler) - ancoradas.length,
      emCerca: parses.reduce((soma, p) => soma + p.emCerca, 0),
    },
    ancoradas.length,
  );
  if (achados.length === 0) {
    console.log(`docs-citacoes-gate: ✓ ${resumo}.`);
    process.exit(0);
  }
  console.error(`docs-citacoes-gate: ✗ ${achados.length} citação(ões) quebrada(s). ${resumo}.\n`);
  for (const a of achados) console.error(`  ${a.doc}:${a.linhaDoDoc} — ${a.msg}`);
  console.error(
    `\nUma citação de linha só vale se disser o que espera achar lá. Formato:\n  \`caminho/arquivo.md:123\`<!--cita: trecho literal da linha 123-->`,
  );
  process.exit(1);
}
