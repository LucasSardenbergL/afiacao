/**
 * mapa-coerente-na-ref.ts — o mapa de fingerprints da REF descreve a FONTE da ref?
 *
 * ## O furo (medido em 2026-09-27, #2611)
 *
 * A sonda não calcula o hash do código que roda: ela devolve `FONTE_SHA256[edge]`, o valor ESTÁTICO
 * do mapa compilado no bundle (`criarRespostaSonda`, `_shared/sonda-versao.ts`). O bot do Lovable
 * (`gpt-engineer-app[bot]`) empurra commits "Changes" que editam o corpo de uma edge SEM regravar o
 * mapa. Medido na `sync-reprocess`: em `1b654757d` o mapa diz `a88a1175…` e o fecho recalculado dá
 * `13c44503…`. Um pacote montado dessa `main` embarca o corpo do bot, prod passa a responder o par
 * CANÔNICO, e o `pendencias:deploy` dá CONFERE com prod rodando `Number(codigoPedido)` no caminho de
 * pedidos do Omie (`docs/historico/sonda-bump-retorno-ao-canonico.md` §2).
 *
 * O `sonda:fingerprint` do CI não fecha isso: o bot empurra direto na `main`, sem PR e sem CI. O
 * único ponto por onde TODO deploy passa é o emissor da colagem — é lá que a conferência mora.
 *
 * ## O que decide (três regras, todas sobre a árvore do MESMO commit)
 *
 * Está NO REGIME a edge que tem `versao.ts` OU que o mapa lista — a 2ª metade existe porque tirar o
 * `versao.ts` e levar a sonda para o `index.ts` escapava da conferência mantendo o par servido
 * (Codex, 2026-09-27). Para cada edge no regime:
 *
 *   1. **fonte:** o fingerprint do fecho recalculado com a régua do `sonda:fingerprint --write`
 *      (`fingerprintDaEdge`, lendo a ref) tem de ser o do mapa. Diverge, ou falta no mapa ⇒ recusa.
 *   2. **marcador:** listada no mapa e sem `versao.ts` ⇒ recusa. É o estado que o gate do CI chama
 *      de "no mapa mas não é edge instrumentada", e a main só chega nele sem CI.
 *   3. **forma do mapa:** o arquivo tem de ser BYTE A BYTE o que o `--write` grava para aquelas
 *      entradas. O mapa vai no bundle e é código: o `parsearMapa` só lê as linhas de hash, então um
 *      statement a mais (ex.: reatribuir `Number`) passava com todas as entradas certas (Codex, P1).
 *
 * Edge fora do regime não tem par a mentir; o emissor DIZ quais ficaram fora.
 *
 * ## Fail-closed
 *
 * Mecânica que não responde LANÇA (o chamador converte em exit 2): inventário que não lista o
 * `index.ts` da própria edge, mapa ilegível ou que parseia VAZIO com edge com `versao.ts` a conferir,
 * import local que não resolve na ref. "Não consegui conferir" nunca vira "coerente".
 *
 * ## O que NÃO fecha (limite herdado do extrator de imports, não desta conferência)
 *
 * O fecho é o do `sonda:fingerprint`: import com comentário entre `from` e o literal, `import()` com
 * template, import com atributos, especificador bare resolvido por import map e arquivo com nome de
 * teste IMPORTADO pelo código servido ficam fora do digest. Codex comparou por AST os 241 arquivos
 * de hoje e não achou nenhum; se aparecer, é o extrator que se conserta — aqui herda-se o conserto.
 */

import {
  ARQ_MAPA,
  ARQ_MARCADOR,
  type ArvoreDeFonte,
  fingerprintDaEdge,
  parsearMapa,
  RAIZ_EDGES,
  renderizarMapa,
} from '../sonda-fingerprint';

export type MotivoIncoerencia = 'fonte-diverge' | 'fora-do-mapa' | 'sem-marcador';

export interface Incoerencia {
  edge: string;
  motivo: MotivoIncoerencia;
  /** O valor do mapa commitado na ref, ou `null` se a edge não está nele. */
  commitado: string | null;
  recalculado: string;
}

export interface ConferenciaMapa {
  /** No regime, com o mapa batendo com o fecho recalculado. */
  coerentes: string[];
  /** Sem `versao.ts` e fora do mapa: não servem `fonte`, não há par a mentir. */
  foraDoRegime: string[];
  incoerentes: Incoerencia[];
  /** O arquivo do mapa difere do que o `--write` grava para as mesmas entradas. */
  mapaForaDaForma: boolean;
}

/** A conferência manda recusar a colagem? Um só critério para os dois emissores. */
export function recusa(c: ConferenciaMapa): boolean {
  return c.incoerentes.length > 0 || c.mapaForaDaForma;
}

export function conferirMapaNaRef(entrada: {
  edges: readonly string[];
  /** A árvore do COMMIT resolvido — a mesma de onde sai a fatia da colagem. */
  arvore: ArvoreDeFonte;
  /** `ls-tree` dos diretórios das edges nesse commit, que RESPONDEU. */
  inventario: ReadonlySet<string>;
  raiz: string;
}): ConferenciaMapa {
  const { arvore, inventario, raiz } = entrada;
  const edges = [...new Set(entrada.edges)].sort();

  const cegas = edges.filter((e) => !inventario.has(`${RAIZ_EDGES}/${e}/index.ts`));
  if (cegas.length > 0) {
    throw new Error(
      `o inventário de ${arvore.rotulo} não lista o index.ts de ${cegas.join(', ')} — listagem que não vê ` +
        'a própria edge não prova que ela está fora do regime de fingerprint',
    );
  }

  const comMarcador = new Set(edges.filter((e) => inventario.has(`${RAIZ_EDGES}/${e}/${ARQ_MARCADOR}`)));
  const bytesMapa = arvore.ler(ARQ_MAPA);
  if (bytesMapa === null) {
    if (comMarcador.size > 0) {
      throw new Error(`${ARQ_MAPA} ilegível em ${arvore.rotulo} — sem o mapa não há como provar o par que a sonda vai servir`);
    }
    return { coerentes: [], foraDoRegime: edges, incoerentes: [], mapaForaDaForma: false };
  }
  const texto = bytesMapa.toString('utf8');
  const mapa = parsearMapa(texto);
  if (comMarcador.size > 0 && Object.keys(mapa).length === 0) {
    throw new Error(`${ARQ_MAPA} em ${arvore.rotulo} parseou VAZIO — é o parser ou o arquivo, não um repo sem sondas`);
  }

  const noRegime = edges.filter((e) => comMarcador.has(e) || Object.hasOwn(mapa, e));
  const foraDoRegime = edges.filter((e) => !noRegime.includes(e));
  if (noRegime.length === 0) return { coerentes: [], foraDoRegime, incoerentes: [], mapaForaDaForma: false };

  const coerentes: string[] = [];
  const incoerentes: Incoerencia[] = [];
  for (const edge of noRegime) {
    const recalculado = fingerprintDaEdge(edge, raiz, arvore);
    const commitado = Object.hasOwn(mapa, edge) ? mapa[edge] : null;
    if (!comMarcador.has(edge)) incoerentes.push({ edge, motivo: 'sem-marcador', commitado, recalculado });
    else if (commitado === null) incoerentes.push({ edge, motivo: 'fora-do-mapa', commitado, recalculado });
    else if (commitado !== recalculado) incoerentes.push({ edge, motivo: 'fonte-diverge', commitado, recalculado });
    else coerentes.push(edge);
  }
  return { coerentes, foraDoRegime, incoerentes, mapaForaDaForma: texto !== renderizarMapa(mapa) };
}

const curto = (h: string | null): string => (h === null ? '—' : `${h.slice(0, 12)}…`);

function linhaDe(i: Incoerencia): string {
  switch (i.motivo) {
    case 'fonte-diverge':
      return `   · ${i.edge}: mapa ${curto(i.commitado)} · fonte recalculada ${curto(i.recalculado)}`;
    case 'fora-do-mapa':
      return `   · ${i.edge}: mapa SEM a edge · fonte recalculada ${curto(i.recalculado)}`;
    case 'sem-marcador':
      return `   · ${i.edge}: está no mapa (${curto(i.commitado)}) e SEM ${ARQ_MARCADOR} — a sonda pode servir o mapa fora do regime`;
  }
}

/** A recusa, com o PORQUÊ e o REMÉDIO — texto único para os dois emissores (pacote e prompt). */
export function relatarRecusa(c: ConferenciaMapa, sha: string): string {
  const rev = sha.slice(0, 9);
  const arquivos = c.incoerentes.map((i) => `${RAIZ_EDGES}/${i.edge}/`).join(' ');
  return [
    `⛔ RECUSADO: o mapa de fingerprints do commit ${rev} NÃO descreve a fonte desse mesmo commit.`,
    ...c.incoerentes.map(linhaDe),
    ...(c.mapaForaDaForma
      ? [`   · ${ARQ_MAPA}: não é o que o \`--write\` grava — há texto a mais no mapa, e ele vai no bundle como código`]
      : []),
    '   Por quê: a sonda devolve FONTE_SHA256[edge] ESTÁTICO do mapa. Deployar esta ref poria no ar um',
    '   corpo que o mapa não descreve, prod responderia o par do mapa e o ledger daria CONFERE sobre bytes',
    '   que ninguém revisou (docs/historico/sonda-bump-retorno-ao-canonico.md §2).',
    `   Quem mexeu: git log --format='%h %an %s' ${rev} -- ${arquivos} ${ARQ_MAPA} ${RAIZ_EDGES}/_shared/`,
    '   (commit "Changes" do gpt-engineer-app[bot] é o suspeito conhecido).',
    '   Remédio: edição NÃO pedida → revert por PR (com bump de VERSAO, sonda-bump-retorno-ao-canonico.md).',
    '            edição legítima → PR com `bun run sonda:fingerprint -- --write` (+ bump se mudou comportamento).',
    '   Depois do merge, rode este comando de novo. Nenhuma colagem foi emitida.',
  ].join('\n');
}

/** O que ficou fora do regime é DITO — calado, pareceria conferido. */
export function relatarForaDoRegime(c: ConferenciaMapa): string | null {
  return c.foraDoRegime.length === 0
    ? null
    : `ℹ️ fora do regime de fingerprint (sem ${ARQ_MARCADOR} e fora do mapa, não servem \`fonte\`): ${c.foraDoRegime.join(', ')}`;
}
