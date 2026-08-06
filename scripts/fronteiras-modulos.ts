#!/usr/bin/env bun
/**
 * fronteiras-modulos.ts — fronteiras entre módulos (F2 da modularização)
 * ========================================================================
 *
 * Casca de I/O sobre src/lib/modulos/{fronteiras,imports}.ts (lógica testada por vitest).
 * Spec: docs/superpowers/specs/2026-07-08-modularizacao-f2-fronteiras-design.md
 *
 * Uso:
 *   bun scripts/fronteiras-modulos.ts gerar-baseline   # re-gera src/lib/modulos/fronteiras-baseline.ts
 *   bun scripts/fronteiras-modulos.ts relatorio        # vazamentos por par de módulos (p/ priorizar burn-down)
 *
 * Ritual do ratchet (o gate fronteiras.gate.test.ts explica o mesmo ao falhar):
 *   - vazamento NOVO → mova o código pro módulo dono, extraia pra plataforma, ou
 *     (conscientemente) rode gerar-baseline — a aresta nova aparece no diff do PR.
 *   - aresta RESOLVIDA → rode gerar-baseline pra removê-la (burn-down visível no diff).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listarArquivosSrc } from "../src/lib/modulos/arvore";
import { coletarArestasCross } from "../src/lib/modulos/fronteiras";
import { COMPOSICAO_RAIZ, MODULOS } from "../src/lib/modulos/manifesto";

const RAIZ = join(import.meta.dir, "..");
const BASELINE_PATH = "src/lib/modulos/fronteiras-baseline.ts";

function coletar() {
  const arquivos = listarArquivosSrc(RAIZ);
  return coletarArestasCross(arquivos, MODULOS, COMPOSICAO_RAIZ, (p) => readFileSync(join(RAIZ, p), "utf8"));
}

function cmdGerarBaseline(): number {
  const { arestas, naoResolvidos, naoAnalisaveis } = coletar();
  const linhas = arestas.map(
    (a) =>
      `  { de: ${JSON.stringify(a.de)}, para: ${JSON.stringify(a.para)}, deModulo: ${JSON.stringify(a.deModulo)}, paraModulo: ${JSON.stringify(a.paraModulo)}, kind: ${JSON.stringify(a.kind)} },`,
  );
  const conteudo = [
    "// GERADO por `bun scripts/fronteiras-modulos.ts gerar-baseline` — NÃO editar à mão.",
    "// Baseline do ratchet de fronteiras (F2): as arestas cross-módulo TOLERADAS (dívida",
    "// inventariada em 2026-07-08, burn-down obrigatório — remover ao resolver, o gate cobra).",
    "// Aresta NOVA fora desta lista = CI vermelho (fronteiras.gate.test.ts).",
    'import type { Aresta } from "./fronteiras";',
    "",
    `export const FRONTEIRAS_BASELINE: Aresta[] = [`,
    ...linhas,
    "];",
    "",
  ].join("\n");
  writeFileSync(join(RAIZ, BASELINE_PATH), conteudo);
  console.log(`baseline re-gerada: ${arestas.length} aresta(s) em ${BASELINE_PATH}`);
  console.log(`não-resolvidos: ${naoResolvidos} · não-analisáveis: ${naoAnalisaveis} (expostos, não bloqueiam)`);
  return 0;
}

function cmdRelatorio(): number {
  const { arestas, naoResolvidos, naoAnalisaveis } = coletar();
  const porPar = new Map<string, number>();
  const porTipo = { runtime: 0, type: 0 };
  for (const a of arestas) {
    const k = `${a.deModulo} → ${a.paraModulo}`;
    porPar.set(k, (porPar.get(k) ?? 0) + 1);
    porTipo[a.kind]++;
  }
  console.log(`arestas cross-módulo toleráveis hoje: ${arestas.length} (runtime ${porTipo.runtime} · type ${porTipo.type})`);
  console.log(`pares de módulos: ${porPar.size} · não-resolvidos: ${naoResolvidos} · não-analisáveis: ${naoAnalisaveis}\n`);
  for (const [par, n] of [...porPar.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`${String(n).padStart(4)}  ${par}`);
  }
  return 0;
}

const subcomando = process.argv[2];
let exit: number;
switch (subcomando) {
  case "gerar-baseline":
    exit = cmdGerarBaseline();
    break;
  case "relatorio":
    exit = cmdRelatorio();
    break;
  default:
    console.error("uso: bun scripts/fronteiras-modulos.ts <gerar-baseline|relatorio>");
    exit = 64;
}
process.exit(exit);
