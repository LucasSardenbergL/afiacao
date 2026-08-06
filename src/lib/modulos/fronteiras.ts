// Fronteiras entre módulos (F2): coleta de arestas cross-módulo + ratchet contra baseline.
// Regra: negócio importa só de si + plataforma; plataforma não importa de negócio,
// EXCETO composition roots declarados (COMPOSICAO_RAIZ no manifesto).
// Spec: docs/superpowers/specs/2026-07-08-modularizacao-f2-fronteiras-design.md
import { extrairImports, resolverImport } from "./imports";
import { donoDoArquivo } from "./resolver";
import type { ModuloApp } from "./tipos";

export type Aresta = {
  de: string;
  para: string;
  deModulo: string;
  paraModulo: string;
  kind: "runtime" | "type";
};

export type ProblemaFronteira = { tipo: "vazamento-novo" | "baseline-resolvida"; detalhe: string };

const ehCodigo = (p: string) => p.endsWith(".ts") || p.endsWith(".tsx");
const ehInterno = (spec: string) => spec.startsWith("@/") || spec.startsWith(".");

/**
 * Varre os arquivos .ts/.tsx e coleta arestas de import que CRUZAM fronteira proibida.
 * Leitor injetado (puro/testável); o gate injeta readFileSync, os testes um fake.
 * Não-resolvidos e não-analisáveis são CONTADOS e expostos — nunca ignorados silenciosos.
 */
export function coletarArestasCross(
  arquivos: string[],
  modulos: ModuloApp[],
  composicaoRaiz: string[],
  ler: (path: string) => string,
): { arestas: Aresta[]; naoResolvidos: number; naoAnalisaveis: number } {
  const arvore = new Set(arquivos);
  const composicao = new Set(composicaoRaiz);
  const donoCache = new Map<string, string | null>();
  const dono = (p: string): string | null => {
    if (!donoCache.has(p)) {
      const d = donoDoArquivo(p, modulos);
      donoCache.set(p, d.length === 1 ? d[0] : null);
    }
    return donoCache.get(p) ?? null;
  };
  const kindDoModulo = new Map(modulos.map((m) => [m.id, m.kind]));

  const arestas: Aresta[] = [];
  let naoResolvidos = 0;
  let naoAnalisaveis = 0;

  for (const arq of arquivos) {
    if (!ehCodigo(arq)) continue;
    const deModulo = dono(arq);
    if (!deModulo) continue; // manifesto podre é assunto do gate F1 — aqui não inventa dono
    const extracao = extrairImports(ler(arq), arq);
    naoAnalisaveis += extracao.naoAnalisaveis;

    for (const imp of extracao.imports) {
      if (!ehInterno(imp.spec)) continue; // pacote npm não é fronteira interna
      const alvo = resolverImport(imp.spec, arq, arvore);
      if (!alvo) {
        naoResolvidos++;
        continue;
      }
      if (!ehCodigo(alvo)) continue; // css/asset não é dependência arquitetural
      const paraModulo = dono(alvo);
      if (!paraModulo || paraModulo === deModulo) continue;
      if (kindDoModulo.get(paraModulo) === "plataforma") continue; // plataforma é base de todos
      if (composicao.has(arq)) continue; // composition root declarado
      arestas.push({ de: arq, para: alvo, deModulo, paraModulo, kind: imp.kind });
    }
  }

  arestas.sort((a, b) =>
    a.de === b.de ? (a.para === b.para ? a.kind.localeCompare(b.kind) : a.para.localeCompare(b.para)) : a.de.localeCompare(b.de),
  );
  // dedup (mesmo arquivo pode importar o mesmo alvo 2x com o mesmo kind)
  const vistas = new Set<string>();
  const unicas = arestas.filter((a) => {
    const k = `${a.de}|${a.para}|${a.kind}`;
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });

  return { arestas: unicas, naoResolvidos, naoAnalisaveis };
}

const chave = (a: Aresta) => `${a.de}|${a.para}|${a.kind}`;
const descreve = (a: Aresta) => `${a.de} → ${a.para} (${a.deModulo}→${a.paraModulo}, ${a.kind})`;

/** Ratchet: aresta nova fora da baseline = erro; aresta da baseline já resolvida = erro (burn-down). */
export function validarContraBaseline(arestas: Aresta[], baseline: Aresta[]): ProblemaFronteira[] {
  const problemas: ProblemaFronteira[] = [];
  const naBaseline = new Set(baseline.map(chave));
  const atuais = new Set(arestas.map(chave));

  for (const a of arestas) {
    if (!naBaseline.has(chave(a))) problemas.push({ tipo: "vazamento-novo", detalhe: descreve(a) });
  }
  for (const b of baseline) {
    if (!atuais.has(chave(b))) problemas.push({ tipo: "baseline-resolvida", detalhe: descreve(b) });
  }
  return problemas;
}
