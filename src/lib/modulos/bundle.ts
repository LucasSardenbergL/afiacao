// Atribuição de bytes de bundle por módulo (F4): decoder de sourcemap v3 (VLQ) próprio —
// zero dependência nova — + agregação pelo manifesto. Bytes que não dá pra atribuir com
// segurança vão para "desconhecido"/"?" (regra money-path do tooling: nunca atribuir errado
// em silêncio). Spec: docs/superpowers/specs/2026-07-08-modularizacao-f4-bundle-design.md
import { donoDoArquivo } from "./resolver";
import type { ModuloApp } from "./tipos";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const b64val = new Map([...B64].map((c, i) => [c, i]));

/**
 * Sourcemap v3: para cada linha do arquivo GERADO, segmentos VLQ relativos
 * [ΔcolGerada, ΔsrcIdx, ΔsrcLinha, ΔsrcCol, (ΔnomeIdx)]. Atribui a cada segmento
 * a distância até o próximo (último da linha: aproxima 1 byte — subconta de leve,
 * nunca superconta). srcIdx inválido → bucket "?".
 */
export function bytesPorSource(map: { sources: string[]; mappings: string }): Map<string, number> {
  const bytes = new Map<string, number>();
  let srcIdx = 0; // ΔsrcIdx é relativo ATRAVESSANDO linhas (spec do sourcemap v3)
  for (const linha of map.mappings.split(";")) {
    let col = 0;
    const segs: { col: number; src: number | null }[] = [];
    for (const seg of linha.split(",")) {
      if (!seg) continue;
      const vals: number[] = [];
      let shift = 0;
      let valor = 0;
      for (const ch of seg) {
        const d = b64val.get(ch);
        if (d === undefined) return bytes; // mappings corrompido — devolve o que deu p/ mapear
        valor += (d & 31) << shift;
        if (d & 32) shift += 5;
        else {
          vals.push(valor & 1 ? -(valor >> 1) : valor >> 1);
          valor = 0;
          shift = 0;
        }
      }
      col += vals[0] ?? 0;
      if (vals.length >= 4) srcIdx += vals[1];
      segs.push({ col, src: vals.length >= 4 ? srcIdx : null });
    }
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.src === null) continue;
      const fim = i + 1 < segs.length ? segs[i + 1].col : s.col + 1;
      const nome = map.sources[s.src] ?? "?";
      bytes.set(nome, (bytes.get(nome) ?? 0) + Math.max(0, fim - s.col));
    }
  }
  return bytes;
}

/** Agrega bytes por grupo: `mod:<dono>` (manifesto) · `npm:<pacote>` · `desconhecido`. */
export function agruparBytesPorGrupo(
  bytesPorSrc: Map<string, number>,
  modulos: ModuloApp[],
): Map<string, number> {
  const grupos = new Map<string, number>();
  const soma = (g: string, b: number) => grupos.set(g, (grupos.get(g) ?? 0) + b);

  for (const [source, b] of bytesPorSrc) {
    const limpo = source.replace(/^(\.\.\/)+/, "");
    if (limpo.startsWith("node_modules/")) {
      const partes = limpo.split("/");
      const pacote = partes[1]?.startsWith("@") ? `${partes[1]}/${partes[2] ?? ""}` : (partes[1] ?? "?");
      soma(`npm:${pacote}`, b);
    } else if (limpo.startsWith("src/")) {
      const donos = donoDoArquivo(limpo, modulos);
      soma(donos.length === 1 ? `mod:${donos[0]}` : "desconhecido", b);
    } else {
      soma("desconhecido", b);
    }
  }
  return grupos;
}
