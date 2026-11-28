// Linha de fluxo (mapa curado `fin_categoria_fluxo_mapping` — o mesmo MAPA do DFC realizado; os baldes
// forçados do DFC, pendente_* e transferência por origem, não se aplicam a título em aberto) de cada linha
// da projeção de 13 semanas — antes a linha de CP só carregava o código Omie cru em `desc`.
// Só ROTULA: valores, semanas e saldos não mudam.
//   • categoria ausente (título sem código)   ⇒ null (ausente ≠ classificado; nunca inventa linha)
//   • código fora do mapa da empresa          ⇒ 'nao_classificado' (igual ao DFC: visível, não some)
//   • código no mapa                          ⇒ a linha curada (op_fornecedores, fin_juros, …)
// Comparação EXATA do código, como o PCO (ncg-folha-tributos.ts) e a view do DFC: sem aparo assimétrico.
import type { LinhaMapa } from "./ncg-folha-tributos.ts";

export type ResolverLinhaFluxo = (codigo: string | null | undefined) => string | null;

export function criarResolverLinhaFluxo(mapa: LinhaMapa[]): ResolverLinhaFluxo {
  const porCodigo = new Map(mapa.map((m) => [m.omie_codigo, m.fluxo_linha]));
  return (codigo) => {
    if (typeof codigo !== "string" || codigo.trim() === "") return null;
    return porCodigo.get(codigo) ?? "nao_classificado";
  };
}
