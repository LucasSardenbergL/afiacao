// supabase/functions/fin-next-best-action/orquestracao.ts
// A4 — composição PURA das respostas cruas de A1/A2/A3 na fila (sem IO, sem Deno.env). O handler
// (index.ts) só invoca as edges e entrega o JSON cru aqui — assim o teste Deno prova o caminho
// "resposta da A1 → JSON da A4" que chega à tela, e não só o helper isolado (plano v6 C1, Codex).
// Edge-only (não tem espelho em src/): o helper da fila é ./fila.ts (MIRROR).
import { type AcaoCandidata, type CaixaEmpresa, caixaDaA1, montarFilaAcoes, type ProximaAcaoResult, type RespostaA1Caixa, type TipoAcao } from "./fila.ts";

export type RespostaA2 = { reportado?: { wacc?: number | null; spread?: number | null } };
export type RespostaA3 = { recomendacoesCliente?: Array<{ cliente: string; recomendacoes: Array<{ acao: string; motivo: string; impacto_rs: number | null }> }> };

export function montarRespostaA4(input: {
  empresas: string[];
  reservaDiasMin: number;
  cashResults: Array<RespostaA1Caixa | null>;
  valorResults: Array<RespostaA2 | null>;
  cockpit: RespostaA3 | null;
}): ProximaAcaoResult {
  const caixaPorEmpresa: Record<string, CaixaEmpresa> = {};
  const hurdlePorEmpresa: Record<string, number> = {};
  const candidatos: AcaoCandidata[] = [];
  const falhas: string[] = [];

  input.empresas.forEach((empresa, i) => {
    const cash = input.cashResults[i] ?? null;
    if (cash == null) falhas.push(`caixa (${empresa})`);
    // Sem `?? 0`: cobertura null ("sem base de saída") ou saldo ausente → disponível null + motivo da A1.
    caixaPorEmpresa[empresa] = caixaDaA1(cash, input.reservaDiasMin);
    const valor = input.valorResults[i] ?? null;
    if (valor == null) falhas.push(`valor/hurdle (${empresa})`);
    const wacc = valor?.reportado?.wacc ?? null;
    if (wacc != null) hurdlePorEmpresa[empresa] = wacc;
    const spread = valor?.reportado?.spread ?? null;
    // Sleeve company-level (sem cockpit granular): crescer sem custo estimado → cai em 'falta_dado'.
    if (empresa !== "oben") {
      candidatos.push({
        empresa, descricao: `${empresa} — sleeve de crescimento (definir ação concreta: margem/NCG/payback)`,
        tipo: "crescer", impacto_eva: null, caixa_consumido: null, payback_meses: null,
        spread_positivo: spread != null ? spread > 0 : null, confianca: "baixa",
      });
    }
  });

  // A3 (Oben): recomendações de cliente viram ações. Vocabulário CONTROLADO da A3 (5 ações fixas).
  if (input.cockpit == null) falhas.push("cockpit Oben (A3)");
  for (const rc of input.cockpit?.recomendacoesCliente ?? []) {
    for (const rec of rc.recomendacoes) {
      const acaoLower = rec.acao.toLowerCase();
      const tipo: TipoAcao = acaoLower.includes("prazo") || acaoLower.includes("antecip") ? "liberar_caixa"
        : acaoLower.includes("crescer") ? "crescer"
        : "consertar_valor"; // cortar desconto / subir preço / despriorizar = consertar valor (custo de caixa ~0)
      candidatos.push({
        empresa: "oben", descricao: `Oben — ${rec.acao} (cliente ${rc.cliente})`,
        // crescer consome caixa via NCG mas A3 não estima o ticket → null → 'falta_dado' (dimensionar antes).
        tipo, impacto_eva: rec.impacto_rs, caixa_consumido: tipo === "crescer" ? null : 0, payback_meses: null,
        spread_positivo: tipo === "crescer" ? true : null, confianca: "alta",
      });
    }
  }

  const result = montarFilaAcoes({ candidatos, caixaPorEmpresa, hurdlePorEmpresa });
  // Degradação honesta: insumo interno falhou → rebaixa a confiança (pior dos dois) e diz o quê.
  if (falhas.length > 0) {
    const rank = { alta: 3, media: 2, baixa: 1 } as const;
    const piso: "media" | "baixa" = falhas.length >= 3 ? "baixa" : "media";
    const nivel = rank[result.confianca.nivel] <= rank[piso] ? result.confianca.nivel : piso;
    result.confianca = { nivel, motivos: [...result.confianca.motivos, `Insumos indisponíveis (function falhou): ${falhas.join(", ")} — fila parcial.`] };
  }
  return result;
}
