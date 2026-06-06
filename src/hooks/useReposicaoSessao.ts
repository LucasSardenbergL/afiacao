import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import type { PedidoItem } from "@/types/reposicao";

export const REPOSICAO_EMPRESA = "OBEN";

/**
 * Paths canônicos das 5 etapas da sessão de Reposição, em ordem.
 * Single source of truth — ProcessoComprasStepper importa daqui para montar
 * REPOSICAO_STEPS (label + ícone + to).
 */
export const REPOSICAO_STEP_PATHS = [
  "/admin/reposicao/sessao/mercado",
  "/admin/reposicao/sessao/parametros",
  "/admin/reposicao/sessao/pedidos",
  "/admin/reposicao/sessao/aplicacao",
  "/admin/reposicao/sessao/confirmacao",
] as const;

/**
 * Deriva a etapa (1-based) correspondente à URL atual. Retorna 0 quando
 * nenhuma etapa casa (ex.: cockpit index /admin/reposicao/sessao, ou rota
 * fora da sessão). Ignora query string e barra final.
 *
 * Esta é a "etapa em foco" (onde o usuário ESTÁ) — distinta de
 * deriveCurrentStep (a etapa de PROGRESSO derivada dos dados).
 */
export function deriveActiveStep(pathname: string): number {
  const clean = pathname.split("?")[0].replace(/\/+$/, "");
  const idx = REPOSICAO_STEP_PATHS.findIndex((p) => p === clean);
  return idx === -1 ? 0 : idx + 1;
}

export function useItensDoDia() {
  const today = format(new Date(), "yyyy-MM-dd");
  return useQuery({
    queryKey: ["cockpit-itens-dia", REPOSICAO_EMPRESA, today],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pedido_compra_sugerido")
        .select(
          "id,fornecedor_nome,grupo_codigo,num_skus,valor_total,pedido_anterior_valor,status,aprovado_em,cancelado_em,horario_disparo_real",
        )
        .eq("empresa", REPOSICAO_EMPRESA)
        .eq("data_ciclo", today)
        .order("fornecedor_nome");
      if (error) throw error;
      return ((data ?? []) as unknown) as PedidoItem[];
    },
    staleTime: 30_000,
  });
}

export type ReposicaoStatus = {
  current: number;
  oportunidadesCount: number;
  pedidosTotal: number;
  pedidosPendentes: number;
  pedidosBloqueados: number;
  pedidosAprovados: number;
  pedidosDisparados: number;
};

const DEFAULT: ReposicaoStatus = {
  current: 3,
  oportunidadesCount: 0,
  pedidosTotal: 0,
  pedidosPendentes: 0,
  pedidosBloqueados: 0,
  pedidosAprovados: 0,
  pedidosDisparados: 0,
};

/**
 * Pure derivation of the "current step" from cycle metrics. Extracted so it can
 * be unit-tested independently of the Supabase query.
 *
 * A Etapa 2 (Parâmetros) NÃO entra mais na derivação: os parâmetros são ajustados
 * automaticamente todo dia (aprovação manual aposentada) — nunca é uma tarefa humana
 * que trava o progresso da sessão. A etapa segue navegável (ajuste manual opcional).
 */
export function deriveCurrentStep(m: {
  oportunidadesCount: number;
  pedidosPendentes: number;
  pedidosAprovados: number;
  pedidosDisparados: number;
}): number {
  if (m.oportunidadesCount > 0) return 1;
  if (m.pedidosPendentes > 0) return 3;
  if (m.pedidosAprovados > 0) return 4;
  if (m.pedidosDisparados > 0) return 5;
  return 3;
}

export function useReposicaoStatus() {
  const today = format(new Date(), "yyyy-MM-dd");

  return useQuery<ReposicaoStatus>({
    queryKey: ["cockpit-current-step", REPOSICAO_EMPRESA, today],
    queryFn: async () => {
      const oport = await supabase
        .from("v_oportunidade_economica_hoje")
        .select("*", { count: "exact", head: true })
        .eq("empresa", REPOSICAO_EMPRESA);
      if (oport.error) throw oport.error;

      // Etapa 2 (Parâmetros) é automática — sem contagem de "pendentes de aprovação".

      const pedidos = await supabase
        .from("pedido_compra_sugerido")
        .select("status")
        .eq("empresa", REPOSICAO_EMPRESA)
        .eq("data_ciclo", today);
      if (pedidos.error) throw pedidos.error;

      const statuses = (((pedidos.data ?? []) as unknown) as Array<{ status: string | null }>).map(
        (r) => r.status,
      );
      const pedidosPendentes = statuses.filter(
        (s) => s === "pendente_aprovacao" || s === "bloqueado_guardrail",
      ).length;
      const pedidosBloqueados = statuses.filter((s) => s === "bloqueado_guardrail").length;
      const pedidosAprovados = statuses.filter((s) => s === "aprovado_aguardando_disparo").length;
      const pedidosDisparados = statuses.filter((s) => s === "disparado").length;

      const oportunidadesCount = oport.count ?? 0;

      const current = deriveCurrentStep({
        oportunidadesCount,
        pedidosPendentes,
        pedidosAprovados,
        pedidosDisparados,
      });

      return {
        current,
        oportunidadesCount,
        pedidosTotal: statuses.length,
        pedidosPendentes,
        pedidosBloqueados,
        pedidosAprovados,
        pedidosDisparados,
      };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/**
 * Per-step lock and status. A step is "locked" when its prerequisite isn't met
 * (e.g. step 4 needs all pendentes resolved). A locked step is still navigable —
 * the lock surfaces as visual feedback + tooltip + guarded confirm on actions.
 */
export type StepLock = { locked: boolean; reason?: string };

export function getStepLocks(status: ReposicaoStatus | undefined): StepLock[] {
  if (!status) return Array.from({ length: 5 }, () => ({ locked: false }));
  const s = status;
  return [
    { locked: false },
    { locked: false },
    {
      locked: s.pedidosTotal === 0,
      reason:
        s.pedidosTotal === 0
          ? "Nenhum pedido foi gerado para hoje. Rode 'Gerar agora' primeiro."
          : undefined,
    },
    {
      locked: s.pedidosTotal === 0 || s.pedidosPendentes > 0,
      reason:
        s.pedidosTotal === 0
          ? "Nenhum pedido foi gerado para hoje."
          : s.pedidosPendentes > 0
            ? `Ainda há ${s.pedidosPendentes} pedido(s) aguardando revisão na etapa 3.`
            : undefined,
    },
    {
      locked: s.pedidosDisparados === 0 && s.pedidosAprovados === 0,
      reason:
        s.pedidosDisparados === 0 && s.pedidosAprovados === 0
          ? "Aprove pedidos na etapa 3 ou aguarde o disparo."
          : undefined,
    },
  ];
}

// Backwards-compatible thin wrapper returning just the current step number.
export function useCurrentStep() {
  const q = useReposicaoStatus();
  return { ...q, data: q.data?.current ?? DEFAULT.current };
}
