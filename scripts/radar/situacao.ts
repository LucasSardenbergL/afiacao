// Situação cadastral RFB — helpers PUROS da carga (bun). Espelho Deno: `supabase/functions/radar-ingest/situacao.ts`
// (a edge não importa `scripts/`); os dois fixam o mesmo vocabulário oficial da RFB.
//
// Códigos: 01 NULA · 02 ATIVA · 03 SUSPENSA · 04 INAPTA · 08 BAIXADA. A carga extrai a situação de TODO CNPJ
// conhecido (radar ∪ clientes), em qualquer situação; quem decide o que fazer é `radar_aplicar_situacao` (SQL).
// `decisaoSituacao` é o espelho LEGÍVEL dessa regra: serve de oráculo ao leitor e ao teste, não é executado em prod.
import { montarCnpj, normalizarData, normalizarTexto } from "../../src/lib/radar/normalizar";
import type { RadarSituacaoRow } from "./types";

export const SITUACOES = new Set(["01", "02", "03", "04", "08"]);
/** As que tiram um lead da fila e avisam o gestor quando é cliente. */
export const SITUACOES_IRREGULARES = new Set(["03", "04", "08"]);

export const ROTULO_SITUACAO: Record<string, string> = {
  "01": "NULA", "02": "ATIVA", "03": "SUSPENSA", "04": "INAPTA", "08": "BAIXADA",
};

export type MotivoRejeicaoSituacao = "cnpj" | "situacao";

/** Linha bruta do parquet `sit_conhecidos_*` (colunas do layout RFB) → linha do `chunk_situacao`, ou o motivo. */
export function normalizarSituacao(
  r: { b?: string | null; o?: string | null; dv?: string | null; situacao?: string | null; dt_sit?: string | null; motivo?: string | null },
  mapaMotivos: Map<string, string>,
): { ok: true; linha: RadarSituacaoRow } | { ok: false; motivo: MotivoRejeicaoSituacao } {
  const cnpj = montarCnpj(r.b ?? "", r.o ?? "", r.dv ?? "");
  if (!cnpj) return { ok: false, motivo: "cnpj" };
  const situacao = (r.situacao ?? "").trim().padStart(2, "0");
  if (!SITUACOES.has(situacao)) return { ok: false, motivo: "situacao" };
  const codigo = normalizarCodigoMotivo(r.motivo);
  return {
    ok: true,
    linha: {
      cnpj, situacao,
      data_situacao: normalizarData(r.dt_sit ?? ""),
      motivo_codigo: codigo,
      // Ausente ≠ zero: código sem descrição no catálogo fica null, nunca "SEM MOTIVO".
      motivo_descricao: codigo ? (mapaMotivos.get(codigo) ?? null) : null,
    },
  };
}

/** Código de motivo da RFB: 2 dígitos ("1" → "01"); vazio/não-numérico → null. */
export function normalizarCodigoMotivo(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  return s.padStart(2, "0");
}

/** Catálogo `Motivos.zip` (codigo;descricao) já lido pelo DuckDB → Map com código normalizado. */
export function mapaDeMotivos(rows: { c: string; d: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    const c = normalizarCodigoMotivo(r.c);
    const d = normalizarTexto(r.d);
    if (c && d) m.set(c, d);
  }
  return m;
}

export type DecisaoSituacao = "descartar" | "alertar" | "nada";

/**
 * Espelho legível de `radar_aplicar_situacao` (SQL): o que acontece com UMA empresa num lote.
 *  - cliente (ja_cliente OU documento nas fontes) com 03/04/08 → alertar (1ª vez do par cnpj+situação; o dedupe é do SQL);
 *  - lead na fila (status ∉ descartado/virou_cliente) com 03/04/08 → descartar;
 *  - 02/01, lead já descartado/virou_cliente, ou lote mais velho que a foto conhecida → nada.
 */
export function decisaoSituacao(e: {
  situacao: string; cliente: boolean; prospeccao_status: string | null; vigente?: boolean;
}): DecisaoSituacao {
  if (e.vigente === false) return "nada";
  if (!SITUACOES_IRREGULARES.has(e.situacao)) return "nada";
  if (e.cliente) return "alertar";
  if (e.prospeccao_status === null) return "nada"; // fora do radar e não-cliente: não há fila de onde tirar
  if (e.prospeccao_status === "descartado" || e.prospeccao_status === "virou_cliente") return "nada";
  return "descartar";
}
