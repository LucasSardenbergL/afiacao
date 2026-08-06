/**
 * Gate do índice de `docs/historico/`.
 *
 * O README de lá se declara o índice consultável do diário de PR ("venha aqui quando precisar do
 * detalhe/contexto de uma entrega"). Um doc que existe no diretório e não está na tabela é
 * INVISÍVEL para quem consulta pelo índice — e não há sinal nenhum: nada quebra, o CI fica verde,
 * o autor da entrega não percebe.
 *
 * Foi o que aconteceu duas vezes: o #1658 fechou 9 arquivos ausentes (metade do histórico recente,
 * incluindo o registro central da linha de custo de contexto) e 4 dias depois o #1665 fechou outros
 * dois — um deles entrou na main junto com os PRs do próprio programa que documenta.
 *
 * O gate roda como teste vitest (`scripts/historico-indice-gate-check.test.ts`), então entra no
 * `bun run test` do job `validate` sem step novo de CI.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const HISTORICO_DIR = 'docs/historico';
export const README = 'README.md';

/**
 * Piso de tamanho do resumo. Existe para barrar a entrada-fantasma (`| [x.md](x.md) | TODO |`),
 * que satisfaz o gate e não informa nada. 30 é folgado de propósito: a menor célula real do índice
 * tem 42 chars, então nenhuma entrada honesta esbarra nisso.
 */
export const RESUMO_MIN_CHARS = 30;

export type Achado = { level: 'error'; file: string; line: number; msg: string };

/** Uma linha de dados da tabela do índice. */
export type Entrada = { href: string; texto: string; resumo: string; line: number };

const LINK_MD = /^\s*\[([^\]]+)\]\(([^)]+)\)\s*$/;

/**
 * Extrai as entradas da tabela. Só conta o link da PRIMEIRA COLUNA — é isso que distingue "este
 * doc tem entrada própria" de "este doc foi CITADO no resumo de outro". Os dois casam `(nome.md)`
 * numa busca solta pelo arquivo inteiro, e confundi-los devolveria verde para um doc invisível.
 */
export function parseEntradas(readme: string): Entrada[] {
  const entradas: Entrada[] = [];

  readme.split('\n').forEach((linha, i) => {
    if (!linha.trimStart().startsWith('|')) return;

    // A célula de resumo pode conter `|` (código inline, tabelas citadas): separo a 1ª coluna e
    // devolvo o RESTO junto, em vez de assumir contagem de colunas.
    const partes = linha.split('|');
    if (partes.length < 3) return;
    if (partes[partes.length - 1].trim() === '') partes.pop(); // borda direita `… |`

    const m = LINK_MD.exec(partes[1]);
    if (!m) return; // cabeçalho, separador `| --- |`, ou linha sem link na 1ª coluna

    entradas.push({
      texto: m[1].trim(),
      href: m[2].trim(),
      resumo: partes.slice(2).join('|').trim(),
      line: i + 1,
    });
  });

  return entradas;
}

/**
 * @param docs  nomes dos `.md` do diretório (sem o README)
 * @param readme conteúdo do README
 */
export function auditarIndice(docs: string[], readme: string): Achado[] {
  const achados: Achado[] = [];
  const readmePath = join(HISTORICO_DIR, README);
  const entradas = parseEntradas(readme);
  const porHref = new Map<string, Entrada[]>();

  for (const e of entradas) {
    const lista = porHref.get(e.href) ?? [];
    lista.push(e);
    porHref.set(e.href, lista);
  }

  // Invariante 1 (ÓRFÃO): todo doc do diretório tem entrada. É o buraco dos #1658/#1665.
  for (const doc of [...docs].sort()) {
    if (porHref.has(doc)) continue;
    achados.push({
      level: 'error',
      file: readmePath,
      line: 0,
      msg: `\`${doc}\` existe em ${HISTORICO_DIR}/ e NÃO tem linha no índice — fica invisível para quem consulta pelo índice. Acrescente \`| [${doc}](${doc}) | <resumo com os PRs/números da entrega> |\` à tabela.`,
    });
  }

  // Invariante 2 (ENTRADA MORTA): toda entrada aponta para um doc que existe — pega o renomeado
  // e o apagado, cujo link vira 404 silencioso no GitHub.
  const existe = new Set(docs);
  for (const e of entradas) {
    if (existe.has(e.href) || e.href === README) continue;
    achados.push({
      level: 'error',
      file: readmePath,
      line: e.line,
      msg: `a entrada aponta para \`${e.href}\`, que não existe em ${HISTORICO_DIR}/ — link morto (doc renomeado ou removido sem atualizar o índice).`,
    });
  }

  // Invariante 3 (DUPLICATA): um doc, uma entrada. Duas sessões paralelas que dão append do mesmo
  // arquivo em posições diferentes NÃO conflitam no merge — o git aceita as duas.
  for (const [href, lista] of porHref) {
    if (lista.length < 2) continue;
    achados.push({
      level: 'error',
      file: readmePath,
      line: lista[1].line,
      msg: `\`${href}\` tem ${lista.length} entradas no índice (linhas ${lista.map((e) => e.line).join(', ')}) — mantenha uma só.`,
    });
  }

  for (const e of entradas) {
    // Invariante 4 (TEXTO = HREF): `[a.md](b.md)` é copiar-colar de outra linha; o leitor clica
    // esperando `a.md` e cai em `b.md`.
    if (e.texto !== e.href) {
      achados.push({
        level: 'error',
        file: readmePath,
        line: e.line,
        msg: `o texto do link (\`${e.texto}\`) diverge do destino (\`${e.href}\`) — provável copiar-colar; os dois têm que ser o nome do arquivo.`,
      });
    }

    // Invariante 5 (RESUMO REAL): entrada sem conteúdo satisfaz o gate e não indexa nada.
    if (e.resumo.length < RESUMO_MIN_CHARS) {
      achados.push({
        level: 'error',
        file: readmePath,
        line: e.line,
        msg: `o resumo de \`${e.href}\` tem ${e.resumo.length} chars (mínimo ${RESUMO_MIN_CHARS}) — o índice existe para dizer O QUE tem no doc; cite os PRs/números concretos da entrega.`,
      });
    }
  }

  return achados;
}

/** Lê o diretório do disco. Isolado do audit p/ o teste não precisar de fixture em arquivo. */
export function lerHistorico(dir: string = HISTORICO_DIR): { docs: string[]; readme: string } {
  const docs = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== README)
    .sort();
  return { docs, readme: readFileSync(join(dir, README), 'utf8') };
}

if (import.meta.main) {
  const { docs, readme } = lerHistorico();
  const achados = auditarIndice(docs, readme);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(achados, null, 2));
  } else {
    for (const a of achados) console.error(`✗ ${a.file}${a.line ? `:${a.line}` : ''} ${a.msg}`);
    if (achados.length === 0) {
      console.log(`✓ índice do histórico: ${docs.length} docs, ${docs.length} entradas, nenhum órfão nem link morto.`);
    }
  }
  process.exit(achados.length > 0 ? 1 : 0);
}
