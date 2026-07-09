// Métricas PURAS do boletim de saúde por módulo (sem I/O — quem lê fs/git/subprocessos é
// scripts/boletim-modulos.ts). Regra money-path aplicada ao tooling: métrica sem fonte
// confiável = "desconhecido"; módulo sem teste = "sem-testes" — NUNCA 0/"passou" fabricado.
import { casaPadrao } from "./padrao";
import { donoDoArquivo } from "./resolver";
import type { ModuloApp } from "./tipos";

export type StatusTestes = "passou" | "falhou" | "sem-testes" | "desconhecido";

export type LinhaBoletim = {
  id: string;
  arquivos: number;
  arquivosTeste: number;
  loc: number;
  densidade: string;
  churn30d: number | "desconhecido";
  churn90d: number | "desconhecido";
  testes: StatusTestes;
  testesDetalhe: string;
  errosTs: number | "desconhecido";
  errosLint: number | "desconhecido";
  riscos: string[];
};

const ehTeste = (path: string) => path.includes(".test.") || path.includes(".spec.");

export function contarArquivos(arquivos: string[], m: ModuloApp): { codigo: number; teste: number } {
  let codigo = 0;
  let teste = 0;
  for (const a of arquivos) {
    const noCodigo = m.codigo.some((p) => casaPadrao(p, a));
    const nosTestes = m.testes.some((p) => casaPadrao(p, a));
    if (!noCodigo && !nosTestes) continue;
    if (nosTestes || ehTeste(a)) teste++;
    else codigo++;
  }
  return { codigo, teste };
}

export function atribuirPorDono<T>(
  itens: { path: string; valor: T }[],
  modulos: ModuloApp[],
): { porModulo: Map<string, T[]>; semDono: number } {
  const porModulo = new Map<string, T[]>();
  let semDono = 0;
  for (const item of itens) {
    const donos = donoDoArquivo(item.path, modulos);
    if (donos.length === 0) {
      semDono++;
      continue;
    }
    // Ownership é exclusivo (gate garante 1 dono); donos[0] é o dono.
    porModulo.set(donos[0], [...(porModulo.get(donos[0]) ?? []), item.valor]);
  }
  return { porModulo, semDono };
}

type ResultadoModulo = { passaram: number; falharam: number };

/** Atribui o run GLOBAL do vitest (reporter json) por módulo. Shape inesperado → "desconhecido". */
export function parseResultadosVitest(
  json: unknown,
  modulos: ModuloApp[],
  raizRepo: string,
): Map<string, ResultadoModulo> | "desconhecido" {
  if (typeof json !== "object" || json === null) return "desconhecido";
  const testResults = (json as { testResults?: unknown }).testResults;
  if (!Array.isArray(testResults)) return "desconhecido";

  const resultado = new Map<string, ResultadoModulo>();
  for (const tr of testResults) {
    if (typeof tr !== "object" || tr === null) return "desconhecido";
    const { name, status } = tr as { name?: unknown; status?: unknown };
    if (typeof name !== "string" || typeof status !== "string") return "desconhecido";
    const rel = name.startsWith(raizRepo) ? name.slice(raizRepo.length).replace(/^\//, "") : name;
    const donos = donoDoArquivo(rel, modulos);
    if (donos.length === 0) continue;
    const atual = resultado.get(donos[0]) ?? { passaram: 0, falharam: 0 };
    if (status === "passed") atual.passaram++;
    else atual.falharam++;
    resultado.set(donos[0], atual);
  }
  return resultado;
}

export function statusTestesDoModulo(
  arquivosTeste: number,
  resultado: ResultadoModulo | undefined,
): StatusTestes {
  if (arquivosTeste === 0) return "sem-testes";
  if (!resultado) return "desconhecido";
  return resultado.falharam > 0 ? "falhou" : "passou";
}

/** Extrai paths das linhas de erro do tsc (`path(l,c): error TS...`). */
export function parseErrosTsc(stdout: string): { path: string }[] {
  const erros: { path: string }[] = [];
  for (const linha of stdout.split("\n")) {
    const m = linha.match(/^(.+?)\(\d+,\d+\): error TS/);
    if (m) erros.push({ path: m[1] });
  }
  return erros;
}

export function montarMarkdown(
  linhas: LinhaBoletim[],
  meta: { data: string; naoClassificados: number; avisos: string[] },
): string {
  const cab =
    "| Módulo | Arquivos | Testes (arq) | Densidade | LOC | Churn 30d | Churn 90d | Suíte | Erros TS | Erros lint | Riscos |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|";
  const corpo = linhas.map((l) =>
    `| ${l.id} | ${l.arquivos} | ${l.arquivosTeste} | ${l.densidade} | ${l.loc} | ${l.churn30d} | ${l.churn90d} | ${l.testes}${l.testesDetalhe ? ` (${l.testesDetalhe})` : ""} | ${l.errosTs} | ${l.errosLint} | ${l.riscos.join(", ") || "—"} |`,
  );

  return [
    `# Boletim de saúde por módulo — ${meta.data}`,
    "",
    `Gerado por \`bun scripts/boletim-modulos.ts boletim\`. Fonte de ownership: \`src/lib/modulos/manifesto.ts\` (gate no CI).`,
    "",
    `Não classificados: ${meta.naoClassificados}`,
    "",
    cab,
    sep,
    ...corpo,
    "",
    "## Metodologia e limitações",
    "",
    "- **Fatos**: nº de arquivos, LOC, resultado da suíte (1 run GLOBAL do vitest atribuído por dono do path), erros de tsc/eslint LOCALIZADOS por dono. O typecheck é um programa único — \"Erros TS\" é a LOCALIZAÇÃO do erro, não um \"typecheck do módulo\".",
    "- **Proxies (fracos, rotulados)**: densidade testes/arquivos e churn git — indicam superfície de risco, não qualidade.",
    "- **Desconhecidos (nunca fabricados)**: Cobertura = desconhecida (provider não instalado — decisão F1 p/ não tocar lockfile); bugs históricos por módulo = desconhecido (fonte docs/historico é prosa não-estruturada). Módulo sem teste aparece como `sem-testes`, jamais como aprovado.",
    ...(meta.avisos.length ? ["", "## Avisos desta geração", "", ...meta.avisos.map((a) => `- ${a}`)] : []),
    "",
  ].join("\n");
}
