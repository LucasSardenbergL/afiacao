import type { Json } from "@/integrations/supabase/types";
import type { SimResult } from "./types";

type Objeto = { [k: string]: Json | undefined };
const objeto = (j: Json | undefined): Objeto | undefined =>
  j !== null && typeof j === "object" && !Array.isArray(j) ? j : undefined;
const numero = (j: Json | undefined): number | undefined => (typeof j === "number" ? j : undefined);
const booleano = (j: Json | undefined): boolean | undefined => (typeof j === "boolean" ? j : undefined);
const texto = (j: Json | undefined): string | undefined => (typeof j === "string" ? j : undefined);
const faixa = (j: Json | undefined) => {
  const o = objeto(j);
  return o && { faixa_numero: numero(o.faixa_numero), estrelas: numero(o.estrelas) };
};

/**
 * Lê o `Json` devolvido pela RPC `simular_puxar_volume_trimestre` na forma de `SimResult`.
 * Campo fora da forma vira `undefined` (a UI mostra "—"), nunca 0; retorno que não é objeto lança.
 */
export function simResultDeJson(j: Json | null): SimResult {
  const r = objeto(j ?? undefined);
  if (!r) throw new Error("simular_puxar_volume_trimestre: retorno não é um objeto");
  const posicao = objeto(r.posicao);
  const perdas = objeto(r.perdas_pedido_atual);
  const projecao = objeto(r.projecao);
  const descontos = objeto(r.descontos);
  return {
    posicao: posicao && {
      base: numero(posicao.base),
      com_extra: numero(posicao.com_extra),
      nominal_adicional_na_nf: numero(posicao.nominal_adicional_na_nf),
      fator_inflacao: numero(posicao.fator_inflacao),
      mudou_faixa: booleano(posicao.mudou_faixa),
      faixa_atual: faixa(posicao.faixa_atual),
      faixa_nova: faixa(posicao.faixa_nova),
    },
    perdas_pedido_atual: perdas && {
      perda_antecipado_rs: numero(perdas.perda_antecipado_rs),
      encargo_prazo_rs: numero(perdas.encargo_prazo_rs),
      frete_rs: numero(perdas.frete_rs),
      custo_capital_rs: numero(perdas.custo_capital_rs),
      total_rs: numero(perdas.total_rs),
    },
    projecao: projecao && {
      proximo_trimestre_projetado: numero(projecao.proximo_trimestre_projetado),
      ganho_futuro_rs: numero(projecao.ganho_futuro_rs),
    },
    descontos: descontos && {
      base_perc: numero(descontos.base_perc),
      com_extra_perc: numero(descontos.com_extra_perc),
      delta_perc: numero(descontos.delta_perc),
    },
    saldo_liquido_rs: numero(r.saldo_liquido_rs),
    recomendacao: texto(r.recomendacao),
    parametros: objeto(r.parametros),
  };
}
