// PMR/PMP + cobertura da baixa derivada de UMA empresa, via a RPC
// fin_capital_giro_prazos_empresa (migration 20261020150000).
//
// Antes: `.from('v_capital_giro_prazos').eq('company', X)`. A view agrega v_titulo_baixas 2×, e
// v_titulo_baixas materializa o CTE `mov` sobre fin_movimentacoes INTEIRA (sem pushdown de
// company): 1,28 s para a colacor e 4,4–6,3 s com 9 chamadas simultâneas, disputando o
// statement_timeout de 8 s com a RPC fin_titulo_baixas_cr_mapa da mesma chamada (57014 no cron de
// 2026-10-20). A RPC é a cópia das duas views com o filtro de empresa DENTRO do `mov`: O(empresa).
//
// Contrato (money-path "ausente ≠ zero"), três estados que não se confundem:
//   - envelope {existe: false, …4 null} → a view não teria linha para a empresa → prazos null,
//     sem motivo (o "sem linha" de antes);
//   - envelope {existe: true, …} → os 4 campos COMO VIERAM (null e 0 são fatos distintos: título
//     liquidado sem baixa dá cobertura 0 e PMR null);
//   - erro de transporte/SQL ou envelope fora de forma → prazos null + motivo (degradação honesta,
//     a tela mostra "—" dizendo por quê) — EXCETO a deriva de definição (P0001, a guarda de md5
//     da função: alguém mudou uma das views e a cópia ficou velha) e o argumento nulo (22004),
//     que são defeito de deploy e LANÇAM: a edge fecha em 500, alto, como a
//     fin_titulo_baixas_cr_mapa já fecha na deriva de v_titulo_baixas (Codex: "—" permanente
//     sem alarme não é aceitável).
import { codigoDoErro, FalhaLeituraCritica, type RespostaLeitura, tolerarLeitura } from "../_shared/leitura-critica.ts";

export const FONTE_PRAZOS = "fin_capital_giro_prazos_empresa";

export type Prazos = {
  pmr: number | null;
  pmp: number | null;
  pmr_cobertura: number | null;
  pmp_cobertura: number | null;
};

const CAMPOS = ["pmr", "pmp", "pmr_cobertura", "pmp_cobertura"] as const;
const CHAVES = ["existe", ...CAMPOS].sort().join(",");

/** Defeito de deploy, não intermitência: lança em vez de degradar. */
const CODIGOS_FATAIS = new Set(["P0001", "22004"]);

const numeroOuNull = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isFinite(v));

function motivo(codigo: string): string {
  return `Leitura de ${FONTE_PRAZOS} falhou (código ${codigo}) — indisponível, não zero.`;
}

export function lerPrazosEmpresa(
  res: RespostaLeitura<unknown>,
): { dados: Prazos | null; motivo: string | null } {
  if (res.error && CODIGOS_FATAIS.has(codigoDoErro(res.error))) {
    throw new FalhaLeituraCritica(FONTE_PRAZOS, res.error);
  }
  const lido = tolerarLeitura(res, FONTE_PRAZOS);
  if (lido.motivo) return { dados: null, motivo: lido.motivo };
  const d = lido.dados as Record<string, unknown> | null;
  if (
    d == null || typeof d !== "object" || Array.isArray(d) ||
    Object.keys(d).sort().join(",") !== CHAVES ||
    typeof d.existe !== "boolean" ||
    !CAMPOS.every((c) => numeroOuNull(d[c])) ||
    // Envelope contraditório: "não existe" com métrica preenchida.
    (d.existe === false && CAMPOS.some((c) => d[c] !== null))
  ) {
    return { dados: null, motivo: motivo("MALFORMADA") };
  }
  if (!d.existe) return { dados: null, motivo: null };
  return {
    dados: {
      pmr: d.pmr as number | null,
      pmp: d.pmp as number | null,
      pmr_cobertura: d.pmr_cobertura as number | null,
      pmp_cobertura: d.pmp_cobertura as number | null,
    },
    motivo: null,
  };
}
