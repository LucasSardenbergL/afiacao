import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import {
  avaliarFilaNoCaixa,
  companyDoFinanceiro,
  custoCapitalMensal,
  pisoProjecao,
  somarFilaCompras,
  type SemanaProjecao,
} from "@/lib/reposicao/caixa-compra-helpers";
import { EMPRESA, formatBRL } from "./shared";

/**
 * Advisory de CAIXA na tela de aprovação de compras (P4 do programa de ciclo financeiro).
 * A projeção de 13 semanas não enxerga pedido de compra (só vira título no Omie depois do
 * faturamento) e a Oben paga à vista — este card soma a fila de compras ao piso projetado
 * ANTES de o founder aprovar. ADVISORY: informa, nunca bloqueia (aprovação é humana).
 */
export function CaixaCompraCard({ pedidos }: {
  pedidos: Array<{ status: string | null; valor_total: number | null }>;
}) {
  // Projeção 13 semanas (RPC gated employee|master — mesmo público desta tela).
  const projecao = useQuery({
    queryKey: ["fin-projecao-13s", companyDoFinanceiro(EMPRESA)],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SemanaProjecao[]> => {
      const { data, error } = await supabase.rpc("fin_projecao_13_semanas", {
        p_company: companyDoFinanceiro(EMPRESA),
      });
      if (error) throw error;
      return (data ?? []) as SemanaProjecao[];
    },
  });

  // Custo de capital anual da config (a MESMA taxa que alimenta o EOQ do motor).
  const config = useQuery({
    queryKey: ["empresa-config-custos-cm", EMPRESA],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<number | null> => {
      const { data, error } = await supabase
        .from("empresa_configuracao_custos")
        .select("selic_anual, spread_oportunidade, armazenagem_fisica")
        .eq("empresa", EMPRESA)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const soma = Number(data.selic_anual ?? NaN) + Number(data.spread_oportunidade ?? NaN) + Number(data.armazenagem_fisica ?? NaN);
      return Number.isFinite(soma) && soma > 0 ? soma : null;
    },
  });

  const fila = somarFilaCompras(pedidos);
  const piso = projecao.data ? pisoProjecao(projecao.data) : null;
  const custoMes = custoCapitalMensal(fila.totalRs, config.data ?? null);

  // Sem fila não há decisão de caixa a informar — o card some (menos ruído na tela).
  if (fila.totalRs <= 0) return null;

  const indisponivel = projecao.isError || (!projecao.isLoading && piso == null);
  const impacto = piso ? avaliarFilaNoCaixa({ pisoRs: piso.pisoRs, filaRs: fila.totalRs }) : null;

  return (
    <Card className={impacto?.furaCaixa ? "border-status-warning/40" : undefined}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Wallet className="w-4 h-4" />
          Caixa × fila de compras
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {projecao.isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando projeção de caixa…</p>
        ) : indisponivel ? (
          <p className="text-sm text-muted-foreground">
            Projeção de caixa indisponível no momento — o impacto da fila não pôde ser calculado
            (isso não impede aprovar; confira o caixa no módulo Financeiro).
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div>
                <div className="text-xs text-muted-foreground">Piso projetado (13 sem)</div>
                <div className="kpi-value text-lg font-semibold tnum">{formatBRL(piso!.pisoRs)}</div>
                {piso!.semanaLabel && (
                  <div className="text-xs text-muted-foreground">{piso!.semanaLabel}</div>
                )}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Fila do ciclo de hoje (à vista)</div>
                <div className="kpi-value text-lg font-semibold tnum">{formatBRL(fila.totalRs)}</div>
                <div className="text-xs text-muted-foreground">
                  {formatBRL(fila.pendentesRs)} a aprovar · {formatBRL(fila.aprovadosRs)} a disparar
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Piso após a fila</div>
                <div className={`kpi-value text-lg font-semibold tnum ${impacto!.furaCaixa ? "text-status-warning" : ""}`}>
                  {formatBRL(impacto!.pisoDepoisRs)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Custo de capital da fila</div>
                <div className="kpi-value text-lg font-semibold tnum">
                  {custoMes != null ? `${formatBRL(custoMes)}/mês` : "—"}
                </div>
              </div>
            </div>
            {impacto!.furaCaixa && (
              <p className="flex items-start gap-2 text-sm text-status-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                A fila de compras leva o piso projetado abaixo de R$0 — considere priorizar por
                classe, reduzir lote ou negociar prazo antes de aprovar tudo.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Advisory — não bloqueia aprovação. Premissas: fila = pedidos do ciclo de HOJE
              (pendentes + aprovados a disparar); pagamento à vista na semana corrente (projeção
              encadeada); referência de veto R$0 (piso de runway não configurado); a projeção lê
              só títulos já emitidos no Omie — compras já disparadas e ainda não faturadas não
              aparecem nela.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
