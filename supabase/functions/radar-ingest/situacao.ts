// Situação cadastral RFB (ação `chunk_situacao`): vocabulário e validação de linha.
// Espelho Deno de `scripts/radar/situacao.ts` (a edge não importa `scripts/`). Mantenha os dois iguais —
// `situacao_test.ts` fixa os códigos oficiais da RFB (01 nula · 02 ativa · 03 suspensa · 04 inapta · 08 baixada).
import { CNPJ_RE, dvCnpj } from "./cnpj.ts";

export const SITUACOES = new Set(["01", "02", "03", "04", "08"]);
/** As que tiram um lead da fila e avisam o gestor quando é cliente. */
export const SITUACOES_IRREGULARES = new Set(["03", "04", "08"]);

export type MotivoDescarteSituacao = "cnpj_formato" | "cnpj_dv" | "situacao" | "data";

export type LinhaSituacao = {
  cnpj: string;
  situacao: string;
  data_situacao: string | null;   // YYYY-MM-DD
  motivo_codigo: string | null;
  motivo_descricao: string | null;
};

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

function textoOuNull(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/** Linha válida normalizada, ou o motivo do descarte. Ordem: formato → DV → situação → data (fail-closed). */
export function validarLinhaSituacao(l: Record<string, unknown>):
  | { ok: true; linha: LinhaSituacao }
  | { ok: false; motivo: MotivoDescarteSituacao } {
  const cnpj = String(l.cnpj ?? "");
  if (!CNPJ_RE.test(cnpj)) return { ok: false, motivo: "cnpj_formato" };
  if (dvCnpj(cnpj.slice(0, 12)) !== cnpj.slice(12)) return { ok: false, motivo: "cnpj_dv" };
  const situacao = String(l.situacao ?? "").trim();
  if (!SITUACOES.has(situacao)) return { ok: false, motivo: "situacao" };
  const data = l.data_situacao === null || l.data_situacao === undefined || l.data_situacao === ""
    ? null : String(l.data_situacao);
  if (data !== null && !DATA_RE.test(data)) return { ok: false, motivo: "data" };
  return {
    ok: true,
    linha: {
      cnpj, situacao, data_situacao: data,
      motivo_codigo: textoOuNull(l.motivo_codigo, 10),
      motivo_descricao: textoOuNull(l.motivo_descricao, 200),
    },
  };
}
