/**
 * sonda-cron-allowlist.ts — a allowlist do cron de sonda (`SONDA_CRON_ALVOS`) lida como TEXTO, de
 * qualquer ref, e o diagnóstico de quando o disco do worktree discorda dela.
 * ============================================================================================
 *
 * Compartilhada pelos DOIS sensores que julgam contra `origin/main` e usam esta allowlist para
 * decidir: o `pendencias:deploy` (o guard de intrusos) e o `sonda:sql` (a recusa do bloco legado).
 * Os dois tinham o mesmo furo — a allowlist vinha do `import` do DISCO enquanto o resto do veredito
 * vinha da ref — e o worktree defasado (~30 no repo) virava, num, o `UPDATE` que desativa edge
 * aprovada (#2464) e, no outro, o POST legado liberado para edge que já tem o relé. A classe está em
 * `docs/historico/sonda-le-worktree-defasado.md`.
 *
 * Mora em `scripts/lib/` por dois motivos: é o que põe o knip vigiando export órfão, e duas cópias
 * deste parser divergiriam — uma lista MENOR que a real é o pior erro possível aqui, nos dois
 * sensores. Quem lê a allowlist para DECIDIR lê por aqui, e na ref; o disco só nomeia a defasagem.
 */
import ts from 'typescript';

export const ARQ_ALLOWLIST = 'supabase/functions/_shared/sonda-cron-alvos.ts';

const EXPORT_ALLOWLIST = 'SONDA_CRON_ALVOS';
const SLUG_EDGE = /^[a-z0-9][a-z0-9-]*$/;

function nomeDaPropriedade(nome: ts.PropertyName): string | null {
  return ts.isIdentifier(nome) || ts.isStringLiteralLike(nome) ? nome.text : null;
}

/**
 * Os slugs de `SONDA_CRON_ALVOS` num TEXTO do arquivo — pela AST do TS, sem executar nada.
 *
 * Texto porque a ref não está no disco; AST e não regex porque o arquivo CITA slugs em comentário
 * (a entrada da onda 5 vem depois de um parágrafo que nomeia `omie-desconto-backfill`) e um regex
 * aprovaria edge por comentário. Para a AST, comentário é trivia e string de `nota` não é propriedade.
 *
 * LANÇA `ALLOWLIST_ILEGIVEL` para toda forma que não seja `{ edge: "<slug>", … }` literal, para
 * texto que não parseia e para o array vazio. Uma lista MENOR que a real é o pior erro possível
 * aqui, nos dois consumidores: no `pendencias:deploy` a edge omitida vira intrusa e o relatório
 * imprime o UPDATE que desativa edge aprovada; no `sonda:sql` ela escapa da recusa e o bloco legado
 * faz POST direto numa edge que tem o caminho seguro. Formato novo na main exige ensinar este parser
 * no mesmo PR (o teste que o compara com o import real reprova antes).
 */
export function extrairAlvosDaAllowlist(fonte: string): string[] {
  const ilegivel = (motivo: string) => new Error(`ALLOWLIST_ILEGIVEL: ${ARQ_ALLOWLIST} — ${motivo}`);

  // Texto truncado ainda vira árvore (o parser do TS se recupera) — e a árvore de um corte no meio
  // do array é uma lista MENOR com cara de lista inteira. O diagnóstico de sintaxe é o que a separa.
  const sintaxe = ts.transpileModule(fonte, { reportDiagnostics: true }).diagnostics ?? [];
  if (sintaxe.length > 0) {
    throw ilegivel(`texto que não parseia: ${ts.flattenDiagnosticMessageText(sintaxe[0].messageText, ' ')}`);
  }

  const arquivo = ts.createSourceFile(ARQ_ALLOWLIST, fonte, ts.ScriptTarget.ESNext, true);
  const trecho = (n: ts.Node) => n.getText(arquivo).replace(/\s+/g, ' ').slice(0, 80);
  let array: ts.ArrayLiteralExpression | null = null;
  for (const st of arquivo.statements) {
    if (!ts.isVariableStatement(st)) continue;
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== EXPORT_ALLOWLIST) continue;
      if (!d.initializer || !ts.isArrayLiteralExpression(d.initializer)) {
        throw ilegivel(`\`${EXPORT_ALLOWLIST}\` não é um array literal`);
      }
      array = d.initializer;
    }
  }
  if (array === null) throw ilegivel(`sem \`export const ${EXPORT_ALLOWLIST}\``);

  const edges: string[] = [];
  for (const el of array.elements) {
    if (!ts.isObjectLiteralExpression(el)) throw ilegivel(`entrada que não é objeto literal: ${trecho(el)}`);
    let edge: string | null = null;
    for (const p of el.properties) {
      if (ts.isSpreadAssignment(p)) throw ilegivel(`entrada com spread: ${trecho(el)}`);
      if (nomeDaPropriedade(p.name) !== 'edge') continue;
      if (!ts.isPropertyAssignment(p) || !ts.isStringLiteralLike(p.initializer)) {
        throw ilegivel(`\`edge\` que não é string literal: ${trecho(p)}`);
      }
      edge = p.initializer.text;
    }
    if (edge === null) throw ilegivel(`entrada sem \`edge\`: ${trecho(el)}`);
    if (!SLUG_EDGE.test(edge)) throw ilegivel(`slug fora do formato de edge: "${edge}"`);
    edges.push(edge);
  }
  if (edges.length === 0) throw ilegivel('array vazio — ausente ≠ zero: "nenhuma aprovada" e "não li" têm a mesma cara');
  return edges;
}

/** Commits entre o worktree e a ref: `aFrente` = só no worktree, `atras` = só na main. */
export interface EstadoWorktree {
  aFrente: number;
  atras: number;
}

/**
 * A saída de `git rev-list --left-right --count HEAD...<ref>` (esquerda = só no HEAD, direita = só
 * na ref). Fora do formato → `null` — ausente ≠ zero: o diagnóstico diz "não consegui contar", nunca
 * "0 atrás". Quem roda o git é o chamador: cada CLI tem o seu executor, a leitura é uma só.
 */
export function parsearEstadoWorktree(saida: string): EstadoWorktree | null {
  const m = /^(\d+)\s+(\d+)$/.exec(saida.trim());
  return m ? { aFrente: Number(m[1]), atras: Number(m[2]) } : null;
}

/**
 * A causa PROVÁVEL da defasagem, pelo que o git contou. Heurística: havendo commit de diferença, ele
 * é o palpite; edição local não commitada só é nomeada quando não há commit de diferença (worktree
 * atrás E com a allowlist editada sai como "atrás" — raro, e o "só na main/só no worktree" ao lado
 * continua dizendo exatamente O QUE diverge).
 */
export function diagnosticoWorktree(w: EstadoWorktree | null, ref: string): string {
  if (w === null) return `não consegui contar os commits entre o seu worktree e ${ref}`;
  if (w.atras > 0) {
    const frente = w.aFrente > 0 ? ` (e ${w.aFrente} à frente)` : '';
    return `seu worktree está ${w.atras} commit(s) atrás de ${ref}${frente} — sincronize antes de medir`;
  }
  if (w.aFrente > 0) return `seu worktree está ${w.aFrente} commit(s) à frente de ${ref} — entrega ainda não mergeada`;
  return `seu worktree não tem commit de diferença para ${ref} — a divergência é edição NÃO commitada`;
}

/**
 * O que difere entre a allowlist da ref e a do disco, na forma que os dois sensores imprimem.
 * Iguais (como CONJUNTO — ordem não é divergência) → `null`: silêncio aqui é o certo.
 */
export function descreverDivergencia(ref: readonly string[], disco: readonly string[]): string | null {
  const naRef = new Set(ref);
  const noDisco = new Set(disco);
  const soNaMain = [...naRef].filter((e) => !noDisco.has(e)).sort();
  const soNoWorktree = [...noDisco].filter((e) => !naRef.has(e)).sort();
  if (soNaMain.length === 0 && soNoWorktree.length === 0) return null;
  return [
    ...(soNaMain.length > 0 ? [`só na main: ${soNaMain.join(', ')}`] : []),
    ...(soNoWorktree.length > 0 ? [`só no seu worktree: ${soNoWorktree.join(', ')}`] : []),
  ].join('; ');
}
