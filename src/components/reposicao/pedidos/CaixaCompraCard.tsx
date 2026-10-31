import { useEffect, useReducer } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { chaveFrescorDaLeitura, msAteMudarChaveFrescor } from "@/lib/financeiro/saldo-contas";
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
  // A RPC julga o saldo pela régua do instante da leitura, no relógio do BANCO (`minimo` = dia SP
  // de agora − 4 h). Na virada das 04h SP a régua muda: a leitura das 03:59 aceitou o saldo de
  // ontem, que das 04h em diante já é velho (#3401). A chave carrega o `minimo` e vale `null` na
  // janela 03:55–04:05 SP (folga para o relógio do aparelho divergir do banco): aí o card não lê
  // nem exibe o que tinha. Sem placeholderData, a chave nova começa vazia. O timer e a volta da aba
  // re-renderizam o card na hora certa — sem eles, staleTime e a falta de refetch no foco deixavam
  // o número velho parado na tela.
  const [tick, forcarRender] = useReducer((n: number) => n + 1, 0);
  const chaveFrescor = chaveFrescorDaLeitura(new Date());
  useEffect(() => {
    // O efeito roda DEPOIS do render: se a chave mudou nesse intervalo (render 03:54:59.990, efeito
    // 03:55:00.010), agendar a partir de agora pularia a entrada da janela e o número de antes
    // ficaria na tela até 04:05 (Codex, revisão do código). Chave divergente → render já.
    if (chaveFrescorDaLeitura(new Date()) !== chaveFrescor) {
      forcarRender();
      return;
    }
    // `tick` nas deps: um timer que dispare cedo demais (chave ainda igual) reagenda em vez de parar.
    const id = setTimeout(forcarRender, msAteMudarChaveFrescor(new Date()) + 250);
    return () => clearTimeout(id);
  }, [chaveFrescor, tick]);
  useEffect(() => {
    // setTimeout atrasa em aba suspensa; ao voltar, a chave é recalculada na hora.
    document.addEventListener("visibilitychange", forcarRender);
    return () => document.removeEventListener("visibilitychange", forcarRender);
  }, []);

  // Projeção 13 semanas (RPC gated employee|master — mesmo público desta tela).
  const projecao = useQuery({
    queryKey: ["fin-projecao-13s", companyDoFinanceiro(EMPRESA), chaveFrescor],
    enabled: chaveFrescor != null,
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

  const naVirada = chaveFrescor == null;
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
        {naVirada ? (
          <p className="text-sm text-muted-foreground">
            Virada diária do saldo bancário (04h): a projeção de caixa volta às 04h05, quando o
            saldo de hoje passa a ser exigido.
          </p>
        ) : projecao.isLoading ? (
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
                <div className="text-xs text-muted-foreground">Piso projetado (hoje e fechamentos semanais)</div>
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
              (pendentes + aprovados a disparar); pagamento à vista hoje (projeção encadeada); o
              piso olha o saldo de hoje e o fechamento de cada semana, não o dia a dia — um
              pagamento antes de um recebimento da mesma semana pode furar o caixa sem aparecer
              aqui; títulos vencidos antes desta semana ficam fora da projeção; referência de veto R$0 (piso de runway não configurado); a projeção lê só
              títulos já emitidos no Omie — compras já disparadas e ainda não faturadas não
              aparecem nela.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
