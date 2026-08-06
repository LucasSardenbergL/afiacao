#!/usr/bin/env bun
/**
 * bundle-modulos.ts — custo de bundle por módulo (F4 da modularização)
 * =====================================================================
 *
 * Atribui os bytes de cada chunk do build ao módulo dono (manifesto F1) ou ao pacote
 * npm, separando EAGER (entry + modulepreload do dist/index.html — o que todo usuário
 * paga no boot) de LAZY. Casca de I/O sobre src/lib/modulos/bundle.ts (testado).
 * Spec: docs/superpowers/specs/2026-07-08-modularizacao-f4-bundle-design.md
 *
 * Uso:
 *   heavy bunx vite build --sourcemap   # 1º: build com mapas (minutos — custo explícito)
 *   bun scripts/bundle-modulos.ts       # 2º: relatório
 *
 * Sem dist/ com .map → erro instruindo o build (não roda build escondido).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agruparBytesPorGrupo, bytesPorSource } from "../src/lib/modulos/bundle";
import { MODULOS } from "../src/lib/modulos/manifesto";

const RAIZ = join(import.meta.dir, "..");
const ASSETS = join(RAIZ, "dist", "assets");

if (!existsSync(join(RAIZ, "dist", "index.html"))) {
  console.error("ERRO: dist/index.html não existe. Rode antes: heavy bunx vite build --sourcemap");
  process.exit(65);
}

const indexHtml = readFileSync(join(RAIZ, "dist", "index.html"), "utf8");
const eager = new Set(
  [...indexHtml.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]),
);

const maps = readdirSync(ASSETS).filter((f) => f.endsWith(".js.map"));
if (maps.length === 0) {
  console.error("ERRO: nenhum .js.map em dist/assets. Rode: heavy bunx vite build --sourcemap");
  process.exit(65);
}

const porGrupo = { eager: new Map<string, number>(), lazy: new Map<string, number>() };
let bytesEager = 0;
let bytesLazy = 0;

for (const mapFile of maps) {
  const chunk = mapFile.replace(/\.map$/, "");
  const destino = eager.has(chunk) ? "eager" : "lazy";
  const map: unknown = JSON.parse(readFileSync(join(ASSETS, mapFile), "utf8"));
  const { sources, mappings } = map as { sources?: unknown; mappings?: unknown };
  if (!Array.isArray(sources) || typeof mappings !== "string") continue; // map estranho — pula, não inventa
  const grupos = agruparBytesPorGrupo(bytesPorSource({ sources: sources as string[], mappings }), MODULOS);
  for (const [g, b] of grupos) {
    porGrupo[destino].set(g, (porGrupo[destino].get(g) ?? 0) + b);
    if (destino === "eager") bytesEager += b;
    else bytesLazy += b;
  }
}

const render = (titulo: string, grupos: Map<string, number>, total: number) => {
  console.log(`\n## ${titulo} — ${Math.round(total / 1024)} KB (fonte, pré-minificação do map)`);
  const linhas = [...grupos.entries()].sort((a, b) => b[1] - a[1]);
  for (const [g, b] of linhas.slice(0, 20)) {
    console.log(`${String(Math.round(b / 1024)).padStart(7)} KB ${(((b / total) * 100) || 0).toFixed(1).padStart(6)}%  ${g}`);
  }
  const modNegocio = linhas.filter(([g]) => g.startsWith("mod:") && g !== "mod:plataforma");
  const somaNeg = modNegocio.reduce((s, [, b]) => s + b, 0);
  console.log(`   → módulos de NEGÓCIO neste destino: ${Math.round(somaNeg / 1024)} KB (${(((somaNeg / total) * 100) || 0).toFixed(1)}%)`);
};

console.log(`chunks analisados: ${maps.length} (eager: ${eager.size} · lazy: ${maps.length - eager.size})`);
console.log(`nota: bytes de FONTE mapeada (proxy do custo real minificado+gzip — direção certa, escala diferente)`);
render("EAGER (boot — todo usuário paga)", porGrupo.eager, bytesEager);
render("LAZY (sob demanda)", porGrupo.lazy, bytesLazy);
