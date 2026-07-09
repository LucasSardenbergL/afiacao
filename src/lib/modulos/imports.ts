// Extrator de imports para o gate de fronteiras (F2) — parser TS de verdade, não regex.
// Por quê: o risco nº1 do verificador próprio é FALSO NEGATIVO (subcontar = gate que mente).
// `typescript` já é dependência do projeto (tsc) — parse sintático puro, sem type-check.
// Spec: docs/superpowers/specs/2026-07-08-modularizacao-f2-fronteiras-design.md §4
import ts from "typescript";

export type ImportExtraido = { spec: string; kind: "runtime" | "type" };
export type ExtracaoImports = {
  imports: ImportExtraido[];
  /** import()/mock com argumento não-literal — contado e exposto, nunca ignorado silencioso. */
  naoAnalisaveis: number;
};

export function extrairImports(conteudo: string, nomeArquivo: string): ExtracaoImports {
  const sf = ts.createSourceFile(
    nomeArquivo,
    conteudo,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    nomeArquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const imports: ImportExtraido[] = [];
  let naoAnalisaveis = 0;

  const registra = (moduleSpecifier: ts.Expression | undefined, tipo: boolean) => {
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      imports.push({ spec: moduleSpecifier.text, kind: tipo ? "type" : "runtime" });
    }
  };

  const visita = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      registra(node.moduleSpecifier, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node)) {
      // `export … from` / `export * from` — re-export é import arquitetural (parecer Codex F2).
      registra(node.moduleSpecifier, node.isTypeOnly === true);
    } else if (ts.isCallExpression(node)) {
      const ehImportDinamico = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const texto = ehImportDinamico ? "" : node.expression.getText(sf);
      const ehMock = texto === "vi.mock" || texto === "jest.mock";
      if (ehImportDinamico || ehMock) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) imports.push({ spec: arg.text, kind: "runtime" });
        else naoAnalisaveis++;
      }
    }
    ts.forEachChild(node, visita);
  };
  visita(sf);

  return { imports, naoAnalisaveis };
}

const dirnamePosix = (p: string): string => p.slice(0, p.lastIndexOf("/"));

function normalizaPosix(p: string): string {
  const partes: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") partes.pop();
    else partes.push(seg);
  }
  return partes.join("/");
}

/**
 * Resolve um spec interno para um path da árvore (convenção do repo: `@/` absoluto ou relativo).
 * Pacote npm → null. Interno que não resolve → null (o chamador CONTA como não-resolvido).
 * CSS/asset resolvem normalmente — o filtro "só .ts/.tsx/.d.ts conta como aresta" é do chamador.
 */
export function resolverImport(spec: string, arquivoOrigem: string, arvore: Set<string>): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith(".")) base = normalizaPosix(`${dirnamePosix(arquivoOrigem)}/${spec}`);
  else return null;

  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (arvore.has(cand)) return cand;
  }
  return null;
}
