// Tipos do registro de execuções de ações globais (tabela acoes_execucoes).
import type { Tables } from "@/integrations/supabase/types";

type LinhaExecucao = Tables<"acoes_execucoes">;

const ORIGENS = ["manual", "automatica"] as const;
const STATUS = ["executando", "sucesso", "erro"] as const;

/** A linha com `origem`/`status` estreitados ao vocabulário dos CHECKs de prod (o gerador os dá como `string`). */
export type AcaoExecucao = Omit<LinhaExecucao, "origem" | "status"> & {
  origem: (typeof ORIGENS)[number];
  status: (typeof STATUS)[number];
};

/** Borda: lança se `origem`/`status` saírem do CHECK — não inventa rótulo para o que não conhece. */
export function execucaoDaLinha(linha: LinhaExecucao): AcaoExecucao {
  const origem = ORIGENS.find((o) => o === linha.origem);
  const status = STATUS.find((s) => s === linha.status);
  if (!origem || !status) {
    throw new Error(`acoes_execucoes ${linha.id}: origem/status fora do CHECK (${linha.origem}/${linha.status})`);
  }
  return { ...linha, origem, status };
}

export const ULTIMA_EXECUCAO_QUERY_KEY = "ultima-execucao";
