#!/usr/bin/env bun
/**
 * boletim-modulos.ts — saúde por módulo do manifesto (F1 da modularização)
 * =========================================================================
 *
 * Casca fina de I/O sobre a lógica pura de src/lib/modulos/ (testada por vitest).
 * Spec: docs/superpowers/specs/2026-07-08-modularizacao-f1-manifesto-boletim-design.md
 *
 * Uso:
 *   bun scripts/boletim-modulos.ts boletim [--out docs/modulos/x.md] [--sem-testes] [--sem-typecheck] [--sem-lint]
 *   bun scripts/boletim-modulos.ts test <id-do-modulo>     # roda SÓ os testes do módulo (dev loop)
 *
 * Honestidade (regra money-path do repo aplicada ao tooling):
 *   - etapa pulada por flag → coluna "desconhecido" + aviso no relatório (nunca 0 fabricado);
 *   - módulo sem teste → "sem-testes" (nunca "passou");
 *   - typecheck é GLOBAL (tsconfig único) → reportamos a LOCALIZAÇÃO dos erros por dono,
 *     nunca "typecheck do módulo X passou".
 *
 * ⚠️ Rodada completa (testes+tsc+lint) é PESADA — prefixe com `heavy` (semáforo M2 8GB).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listarArquivosSrc } from "../src/lib/modulos/arvore";
import {
  atribuirPorDono,
  contarArquivos,
  montarMarkdown,
  parseErrosTsc,
  parseResultadosVitest,
  statusTestesDoModulo,
  type LinhaBoletim,
} from "../src/lib/modulos/boletim";
import { MODULOS, NAO_CLASSIFICADOS } from "../src/lib/modulos/manifesto";
import { casaPadrao } from "../src/lib/modulos/padrao";
import { validarManifesto } from "../src/lib/modulos/resolver";

const RAIZ = join(import.meta.dir, "..");
const MAX_BUFFER = 64 * 1024 * 1024;

function locDosArquivos(paths: string[]): number {
  let total = 0;
  for (const p of paths) {
    try {
      const conteudo = readFileSync(join(RAIZ, p), "utf8");
      total += conteudo.length === 0 ? 0 : conteudo.split("\n").length;
    } catch {
      // arquivo ilegível (binário/permissão) — não conta, não inventa
    }
  }
  return total;
}

function churnPorModulo(janela: string): { porModulo: Map<string, number>; aviso: string | null } {
  const r = spawnSync("git", ["log", `--since=${janela}`, "--name-only", "--pretty=format:"], {
    cwd: RAIZ,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") {
    return { porModulo: new Map(), aviso: `churn ${janela}: git log falhou — coluna vira "desconhecido"` };
  }
  const paths = r.stdout.split("\n").filter((l) => l.startsWith("src/"));
  const { porModulo, semDono } = atribuirPorDono(
    paths.map((p) => ({ path: p, valor: 1 })),
    MODULOS,
  );
  const contagem = new Map<string, number>();
  for (const [id, valores] of porModulo) contagem.set(id, valores.length);
  const aviso =
    semDono > 0
      ? `churn ${janela}: ${semDono} path(s) do git log sem dono atual (arquivos deletados/renomeados) — ignorados`
      : null;
  return { porModulo: contagem, aviso };
}

function rodarSuiteGlobal(): { resultado: ReturnType<typeof parseResultadosVitest>; aviso: string | null } {
  const outFile = join(mkdtempSync(join(tmpdir(), "boletim-vitest-")), "resultados.json");
  // exit ≠ 0 com JSON válido ainda é resultado válido — falha de teste é DADO do boletim.
  spawnSync("bunx", ["vitest", "run", "--reporter=json", `--outputFile=${outFile}`], {
    cwd: RAIZ,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  try {
    const json: unknown = JSON.parse(readFileSync(outFile, "utf8"));
    const resultado = parseResultadosVitest(json, MODULOS, RAIZ);
    return {
      resultado,
      aviso: resultado === "desconhecido" ? "suíte: JSON do vitest em shape inesperado — coluna 'desconhecido'" : null,
    };
  } catch {
    return { resultado: "desconhecido", aviso: "suíte: vitest não produziu JSON legível — coluna 'desconhecido'" };
  }
}

function rodarTypecheckGlobal(): { porModulo: Map<string, number> | "desconhecido"; aviso: string | null } {
  const r = spawnSync("bunx", ["tsc", "--noEmit", "-p", "tsconfig.app.json"], {
    cwd: RAIZ,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (typeof r.stdout !== "string") return { porModulo: "desconhecido", aviso: "typecheck: sem stdout — 'desconhecido'" };
  const erros = parseErrosTsc(r.stdout);
  const { porModulo } = atribuirPorDono(
    erros.map((e) => ({ path: e.path, valor: 1 })),
    MODULOS,
  );
  const contagem = new Map<string, number>();
  for (const m of MODULOS) contagem.set(m.id, (porModulo.get(m.id) ?? []).length);
  const aviso = r.status === 0 ? null : `typecheck global FALHOU (${erros.length} erro(s)) — contagem localizada por dono na coluna`;
  return { porModulo: contagem, aviso };
}

function rodarLintGlobal(): { porModulo: Map<string, number> | "desconhecido"; aviso: string | null } {
  const r = spawnSync("bunx", ["eslint", ".", "--format", "json"], {
    cwd: RAIZ,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (typeof r.stdout !== "string" || r.stdout.trim() === "") {
    return { porModulo: "desconhecido", aviso: "lint: eslint sem saída JSON — 'desconhecido'" };
  }
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) return { porModulo: "desconhecido", aviso: "lint: JSON inesperado — 'desconhecido'" };
    const itens: { path: string; valor: number }[] = [];
    for (const arq of parsed) {
      const { filePath, errorCount } = arq as { filePath?: unknown; errorCount?: unknown };
      if (typeof filePath !== "string" || typeof errorCount !== "number") continue;
      if (errorCount === 0) continue;
      const rel = filePath.startsWith(RAIZ) ? filePath.slice(RAIZ.length).replace(/^\//, "") : filePath;
      itens.push({ path: rel, valor: errorCount });
    }
    const { porModulo } = atribuirPorDono(itens, MODULOS);
    const contagem = new Map<string, number>();
    for (const m of MODULOS) contagem.set(m.id, (porModulo.get(m.id) ?? []).reduce((s, v) => s + v, 0));
    return { porModulo: contagem, aviso: null };
  } catch {
    return { porModulo: "desconhecido", aviso: "lint: JSON ilegível — 'desconhecido'" };
  }
}

function cmdBoletim(args: string[]): number {
  const semTestes = args.includes("--sem-testes");
  const semTypecheck = args.includes("--sem-typecheck");
  const semLint = args.includes("--sem-lint");
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  if (outIdx >= 0 && !outPath) {
    console.error("ERRO: --out exige um caminho");
    return 64;
  }

  const arquivos = listarArquivosSrc(RAIZ);

  // Gate primeiro: boletim sobre manifesto podre seria número mentiroso.
  const problemas = validarManifesto(arquivos, MODULOS, NAO_CLASSIFICADOS);
  if (problemas.length > 0) {
    console.error(`ERRO: manifesto com ${problemas.length} problema(s) — rode o gate: bunx vitest run src/lib/modulos`);
    for (const p of problemas.slice(0, 10)) console.error(`  [${p.tipo}] ${p.detalhe}`);
    return 65;
  }

  const avisos: string[] = [];
  const churn30 = churnPorModulo("30 days ago");
  const churn90 = churnPorModulo("90 days ago");
  if (churn30.aviso) avisos.push(churn30.aviso);
  if (churn90.aviso) avisos.push(churn90.aviso);

  let suite: ReturnType<typeof parseResultadosVitest> = "desconhecido";
  if (semTestes) avisos.push("suíte de testes PULADA por --sem-testes — coluna 'desconhecido'");
  else {
    const r = rodarSuiteGlobal();
    suite = r.resultado;
    if (r.aviso) avisos.push(r.aviso);
  }

  let tsPorModulo: Map<string, number> | "desconhecido" = "desconhecido";
  if (semTypecheck) avisos.push("typecheck PULADO por --sem-typecheck — coluna 'desconhecido'");
  else {
    const r = rodarTypecheckGlobal();
    tsPorModulo = r.porModulo;
    if (r.aviso) avisos.push(r.aviso);
  }

  let lintPorModulo: Map<string, number> | "desconhecido" = "desconhecido";
  if (semLint) avisos.push("lint PULADO por --sem-lint — coluna 'desconhecido'");
  else {
    const r = rodarLintGlobal();
    lintPorModulo = r.porModulo;
    if (r.aviso) avisos.push(r.aviso);
  }

  const linhas: LinhaBoletim[] = MODULOS.map((m) => {
    const { codigo, teste } = contarArquivos(arquivos, m);
    const doModulo = arquivos.filter((a) => [...m.codigo, ...m.testes].some((p) => casaPadrao(p, a)));
    const resultadoSuite = suite === "desconhecido" ? undefined : suite.get(m.id);
    const status = suite === "desconhecido" && !semTestes && teste > 0 ? "desconhecido" : statusTestesDoModulo(teste, resultadoSuite);
    return {
      id: m.id,
      arquivos: codigo,
      arquivosTeste: teste,
      loc: locDosArquivos(doModulo),
      densidade: codigo === 0 ? "—" : `${(teste / codigo).toFixed(2)} (proxy fraco)`,
      churn30d: churn30.porModulo.size === 0 ? "desconhecido" : (churn30.porModulo.get(m.id) ?? 0),
      churn90d: churn90.porModulo.size === 0 ? "desconhecido" : (churn90.porModulo.get(m.id) ?? 0),
      testes: semTestes && teste > 0 ? "desconhecido" : status,
      testesDetalhe: resultadoSuite ? `${resultadoSuite.passaram}✓/${resultadoSuite.falharam}✗ arq` : "",
      errosTs: tsPorModulo === "desconhecido" ? "desconhecido" : (tsPorModulo.get(m.id) ?? 0),
      errosLint: lintPorModulo === "desconhecido" ? "desconhecido" : (lintPorModulo.get(m.id) ?? 0),
      riscos: [
        ...(m.risco.moneyPath ? ["money-path"] : []),
        ...(m.risco.offlineFirst ? ["offline-first"] : []),
        ...(m.risco.authSensitive ? ["auth-sensitive"] : []),
      ],
    };
  });

  const hoje = new Date().toISOString().slice(0, 10);
  const md = montarMarkdown(linhas, { data: hoje, naoClassificados: NAO_CLASSIFICADOS.length, avisos });
  if (outPath) {
    writeFileSync(join(RAIZ, outPath), md);
    console.log(`boletim gravado em ${outPath}`);
  }
  console.log(md);
  return 0;
}

function cmdTest(id: string | undefined): number {
  if (!id) {
    console.error(`ERRO: informe o id do módulo. Ids: ${MODULOS.map((m) => m.id).join(", ")}`);
    return 64;
  }
  const m = MODULOS.find((x) => x.id === id);
  if (!m) {
    console.error(`ERRO: módulo "${id}" não existe. Ids: ${MODULOS.map((m2) => m2.id).join(", ")}`);
    return 64;
  }
  const arquivos = listarArquivosSrc(RAIZ);
  const arquivosDoModulo = arquivos.filter((a) => [...m.codigo, ...m.testes].some((p) => casaPadrao(p, a)));
  const arquivosDeTeste = arquivosDoModulo.filter((a) => a.includes(".test.") || a.includes(".spec."));
  if (arquivosDeTeste.length === 0) {
    console.log(`sem-testes: módulo "${id}" não tem arquivo de teste mapeado (isso é DADO, não sucesso)`);
    return 0;
  }
  console.log(`rodando ${arquivosDeTeste.length} arquivo(s) de teste do módulo "${id}"…`);
  const r = spawnSync("bunx", ["vitest", "run", ...arquivosDeTeste], { cwd: RAIZ, stdio: "inherit" });
  return r.status ?? 1;
}

const [subcomando, ...resto] = process.argv.slice(2);
let exit: number;
switch (subcomando) {
  case "boletim":
    exit = cmdBoletim(resto);
    break;
  case "test":
    exit = cmdTest(resto[0]);
    break;
  default:
    console.error("uso: bun scripts/boletim-modulos.ts <boletim|test> [...]");
    exit = 64;
}
process.exit(exit);
