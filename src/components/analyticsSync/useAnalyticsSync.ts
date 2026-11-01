// Lógica da tela de Sincronização & Analytics (queries, mutations, sync orquestrado).
// Extraída verbatim de src/pages/AdminAnalyticsSync.tsx (god-component split).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { useMutationComRegistro } from "@/components/execucoes/useMutationComRegistro";
import { ULTIMA_EXECUCAO_QUERY_KEY } from "@/components/execucoes/tipos";
import { OmieAccount, SyncState } from "./types";
import { ACOES_ANALYTICS_SYNC } from "./acoes";
import { mensagemDeErro } from '@/lib/erro-mensagem';
import {
  CONTAS_PEDIDOS,
  haJanelaAberta,
  janelaRecentes,
  janelaTodos,
  janelasRelevantes,
  rotuloSemeadura,
  statusJanelas,
  type ContaPedidos,
  type DesfechoSemeadura,
  type JanelaCursorRow,
  type JanelaImportacao,
  type StatusJanelaConta,
} from "./janelas";
import { haRodadaAberta, rodadasRelevantes, statusRodada, type RodadaClientesRow } from "./rodadaClientes";

const JANELAS_CURSOR_QUERY_KEY = "vendas-sync-cursor-janelas";
const RODADAS_CLIENTES_QUERY_KEY = "clientes-import-rodadas";

export type RecConfigs = ReturnType<typeof useAnalyticsSync>["recConfigs"];

export function useAnalyticsSync() {
  const [selectedAccount, setSelectedAccount] = useState<OmieAccount>("vendas");
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Check if user has the master CPF for sync health access
  const { data: profileData } = useQuery({
    queryKey: ["profile-doc", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from("profiles")
        .select("document")
        .eq("user_id", user.id)
        .maybeSingle();
      return data;
    },
    enabled: !!user?.id,
  });

  const userDoc = (profileData?.document || "").replace(/\D/g, "");
  const showSyncHealth = userDoc === "01363383647";

  const { data: syncStates, isLoading } = useQuery({
    queryKey: ["sync-state"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sync_state")
        .select("*")
        .order("entity_type");
      if (error) throw error;
      return data as SyncState[];
    },
    refetchInterval: 5000,
  });

  const { data: recConfigs } = useQuery({
    queryKey: ["recommendation-config"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recommendation_config")
        .select("*")
        .order("key");
      if (error) throw error;
      return data;
    },
  });

  const syncMutation = useMutation({
    mutationFn: async ({ action, account }: { action: string; account: OmieAccount }) => {
      const { data, error } = await supabase.functions.invoke("omie-analytics-sync", {
        body: { action, account },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data, variables) => {
      toast.success(`Sync ${variables.action} concluído`, {
        description: JSON.stringify(data?.data || {}).substring(0, 100),
      });
      queryClient.invalidateQueries({ queryKey: ["sync-state"] });
    },
    onError: (error) => {
      toast.error("Erro no sync", { description: mensagemDeErro(error) ?? "Erro sem mensagem — tente de novo ou avise a equipe." });
    },
    // Quem grava é a EDGE (sync_completo + motores por dentro do sync_all) — aqui só re-lê a caption.
    onSettled: () => queryClient.invalidateQueries({ queryKey: [ULTIMA_EXECUCAO_QUERY_KEY] }),
  });

  const computeCostsMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("omie-analytics-sync", {
        body: { action: "compute_costs" },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success("Custos recalculados", {
        description: `${data?.data?.updated || 0} produtos atualizados`,
      });
    },
    onError: (error) => {
      toast.error("Erro ao calcular custos", { description: mensagemDeErro(error) ?? "Erro sem mensagem — tente de novo ou avise a equipe." });
    },
    // Quem grava é a EDGE (analytics_sync.recalcular_custos) — aqui só re-lê a caption na hora.
    onSettled: () => queryClient.invalidateQueries({ queryKey: [ULTIMA_EXECUCAO_QUERY_KEY] }),
  });

  const assocRulesMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("omie-analytics-sync", {
        body: { action: "compute_association_rules" },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success("Regras de associação geradas", {
        description: `${data?.data?.rules_generated || 0} regras a partir de ${data?.data?.total_transactions || 0} transações`,
      });
    },
    onError: (error) => {
      toast.error("Erro ao gerar regras", { description: mensagemDeErro(error) ?? "Erro sem mensagem — tente de novo ou avise a equipe." });
    },
    // Quem grava é a EDGE (analytics_sync.recalcular_regras) — aqui só re-lê a caption na hora.
    onSettled: () => queryClient.invalidateQueries({ queryKey: [ULTIMA_EXECUCAO_QUERY_KEY] }),
  });

  const updateConfigMutation = useMutation({
    mutationFn: async ({ id, value }: { id: string; value: number }) => {
      const { error } = await supabase
        .from("recommendation_config")
        .update({ value, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Parâmetro atualizado");
      queryClient.invalidateQueries({ queryKey: ["recommendation-config"] });
    },
    onError: (error) => {
      toast.error("Erro ao atualizar", { description: mensagemDeErro(error) ?? "Erro sem mensagem — tente de novo ou avise a equipe." });
    },
  });

  // Import de clientes NO SERVIDOR (migration 20261101200000_clientes_import_servidor): o botão só
  // SEMEIA a rodada; o cron de 1 min chama a edge, que avança o cursor guardado no banco. Antes era
  // um laço nesta aba — recarregar/perder a rede matava o import no meio e o próximo clique
  // recomeçava da página 1. O registro do clique passa a significar "rodada solicitada"; andamento e
  // desfecho vêm da própria rodada (query abaixo).
  const bulkClientSyncMutation = useMutationComRegistro({
    acao: ACOES_ANALYTICS_SYNC.importarClientes,
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("clientes_import_semear");
      if (error) throw error;
      const r = data as { desfecho?: string; rodada_id?: string } | null;
      if (!r || (r.desfecho !== "semeada" && r.desfecho !== "ja_aberta")) {
        throw new Error(`clientes_import_semear: resposta fora do contrato (${JSON.stringify(data)})`);
      }
      return r as { desfecho: "semeada" | "ja_aberta"; rodada_id: string };
    },
    detalhes: (r) => ({ desfecho: r.desfecho, rodada_id: r.rodada_id }),
    onSuccess: (r) => {
      toast.success(r.desfecho === "semeada" ? "Importação iniciada no servidor" : "Já há uma importação em andamento", {
        description: "Pode fechar esta aba — o servidor continua de onde parar.",
      });
    },
    onError: (error) => {
      toast.error("Não foi possível iniciar a importação de clientes", {
        description: mensagemDeErro(error) ?? "Erro sem mensagem — tente de novo ou avise a equipe.",
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [RODADAS_CLIENTES_QUERY_KEY] }),
  });

  const rodadasClientesQuery = useQuery({
    queryKey: [RODADAS_CLIENTES_QUERY_KEY],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clientes_import_rodada")
        .select("*")
        .order("criado_em", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as unknown as RodadaClientesRow[];
    },
    // Aberta: acompanha de perto. Sem aberta: segue descobrindo (o cron semanal pode abrir uma).
    refetchInterval: (q) => (haRodadaAberta(q.state.data ?? []) ? 8000 : 60000),
  });
  const rodadasClientes = rodadasRelevantes(rodadasClientesQuery.data ?? []).map((r) => statusRodada(r));
  const importacaoClientesAberta = haRodadaAberta(rodadasClientesQuery.data ?? []);

  const rearmarRodadaClientesMutation = useMutation({
    mutationFn: async (rodadaId: string) => {
      const { data, error } = await supabase.rpc("clientes_import_rearmar", { p_rodada_id: rodadaId });
      if (error) throw error;
      return (data as { desfecho?: string } | null)?.desfecho ?? "desconhecido";
    },
    onSuccess: (desfecho) => {
      if (desfecho === "rearmada") toast.success("Importação retomada de onde parou");
      else if (desfecho === "outra_aberta") toast.info("Já há outra importação em andamento");
      else toast.error("Esta rodada não pode ser retomada", { description: `Desfecho: ${desfecho}` });
    },
    onError: (error) => {
      toast.error("Falha ao retomar a importação", { description: mensagemDeErro(error) ?? "Erro sem mensagem." });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [RODADAS_CLIENTES_QUERY_KEY] }),
  });

  const addressSyncMutation = useMutationComRegistro({
    acao: ACOES_ANALYTICS_SYNC.sincronizarEnderecos,
    detalhes: (d) => ({ criados: d.synced, ignorados: d.skipped, erros: d.errors, pendentes: d.totalNeeding }),
    mutationFn: async () => {
      let totalSynced = 0;
      let totalSkipped = 0;
      let totalErrors = 0;
      let totalNeeding = 0;
      let hasMore = true;
      let iteration = 0;

      while (hasMore) {
        iteration++;
        setAddressSyncProgress(`Sincronizando endereços... (lote ${iteration}, ${totalSynced} criados)`);
        const { data, error } = await supabase.functions.invoke("omie-cliente", {
          body: { action: "sync_addresses", batch_size: 30 },
        });
        if (error) throw error;

        // Resposta malformada (sem `hasMore` booleano) NÃO é fim (classe #1338→#1564): o
        // `|| false` de antes encerrava com toast de sucesso e endereços ainda pendentes.
        if (data == null || typeof data.hasMore !== 'boolean') {
          throw new Error('sync_addresses: resposta sem hasMore booleano — malformada, não é fim');
        }
        totalSynced += data.synced || 0;
        totalSkipped += data.skipped || 0;
        totalErrors += data.errors || 0;
        totalNeeding = data.totalNeeding || 0;
        hasMore = data.hasMore;

        // Safety: if batch produced 0 synced AND 0 skipped AND 0 errors, stop to avoid infinite loop
        if ((data?.synced || 0) === 0 && (data?.skipped || 0) === 0 && (data?.errors || 0) === 0) {
          hasMore = false;
        }
      }

      setAddressSyncProgress(null);
      return { synced: totalSynced, skipped: totalSkipped, errors: totalErrors, totalNeeding };
    },
    onSuccess: (data) => {
      toast.success("Sincronização de endereços concluída", {
        description: `${data?.synced || 0} endereços criados, ${data?.skipped || 0} ignorados, ${data?.errors || 0} erros (de ${data?.totalNeeding || 0} pendentes)`,
        duration: 10000,
      });
    },
    onError: (error) => {
      setAddressSyncProgress(null);
      toast.error("Erro na sincronização de endereços", { description: mensagemDeErro(error) ?? "Erro sem mensagem — tente de novo ou avise a equipe." });
    },
  });

  const [editingConfig, setEditingConfig] = useState<Record<string, string>>({});
  const [addressSyncProgress, setAddressSyncProgress] = useState<string | null>(null);

  // Importação de pedidos = SEMEADURA server-side (refactor do incidente 2026-07-20/21):
  // o loop client-side de 40-60 min morria quando o Chrome suspendia a aba (Memory Saver),
  // deixando órfãos 'executando'. Agora o clique ARMA as DUAS contas numa ÚNICA chamada
  // ATÔMICA (RPC staff-gated, ON CONFLICT DO NOTHING, advisory lock por conta — provada em
  // db/test-vendas_sync_semear_janela.sh; uma chamada = sem janela parcial se a aba morrer)
  // e o cron vendas-sync-continuacao-6min + edge omie-vendas-sync importam no servidor
  // (lease + heartbeat por página + retomada). A aba pode fechar; o progresso é LEITURA.
  const semearJanelaNasContas = async (janela: JanelaImportacao) => {
    const { data, error } = await supabase.rpc("vendas_sync_semear_janela", {
      p_date_from: janela.de,
      p_date_to: janela.ate,
    });
    if (error) throw new Error(error.message);
    const r = data as { contas?: Array<{ account?: string; desfecho?: string }> } | null;
    const resultado = {} as Record<ContaPedidos, DesfechoSemeadura | undefined>;
    for (const conta of CONTAS_PEDIDOS) {
      resultado[conta] = r?.contas?.find((c) => c.account === conta)?.desfecho as DesfechoSemeadura | undefined;
    }
    return { janela, resultado };
  };

  // Progresso da importação em segundo plano: polling do cursor enquanto houver janela aberta.
  // A MV customer_metrics NÃO é atualizada aqui (a aba pode nem existir no fim) — o cron de
  // refresh a cada 6h cobre, como já cobre as importações dos crons de 2h.
  const { data: janelasCursor } = useQuery({
    queryKey: [JANELAS_CURSOR_QUERY_KEY],
    queryFn: async () => {
      // As 12 mais recentes + TODAS as terminais (falhou e não completou): a terminal é a única via de
      // "Re-tentar" e não pode sumir do card por ser antiga ou por ficar fora do top-12 (Codex 2º, P5).
      const [recentes, terminais] = await Promise.all([
        supabase.from("vendas_sync_cursor").select("*").order("updated_at", { ascending: false }).limit(12),
        supabase.from("vendas_sync_cursor").select("*").not("falhou_em", "is", null).is("completed_at", null)
          .order("falhou_em", { ascending: false }).limit(200),
      ]);
      if (recentes.error) throw recentes.error;
      if (terminais.error) throw terminais.error;
      const porChave = new Map<string, JanelaCursorRow>();
      for (const r of [...(terminais.data ?? []), ...(recentes.data ?? [])] as JanelaCursorRow[]) {
        porChave.set(`${r.account}|${r.date_from}|${r.date_to}`, r);
      }
      return [...porChave.values()];
    },
    refetchInterval: (query) => (haJanelaAberta(query.state.data ?? []) ? 8000 : false),
  });

  const janelasImportacao = statusJanelas(janelasRelevantes(janelasCursor ?? []));
  const importacaoEmAndamento = haJanelaAberta(janelasCursor ?? []);

  const descricaoSemeadura = (resultado: Record<ContaPedidos, DesfechoSemeadura | undefined>) =>
    `oben: ${rotuloSemeadura(resultado.oben)} · colacor: ${rotuloSemeadura(resultado.colacor)}. ` +
    `Roda no servidor — pode fechar a aba e acompanhar aqui.`;

  const bulkOrdersSyncMutation = useMutationComRegistro({
    acao: ACOES_ANALYTICS_SYNC.importarPedidosTodos,
    detalhes: (d) => ({ modo: "semeadura_cursor", janela_de: d.janela.de, janela_ate: d.janela.ate, ...d.resultado }),
    mutationFn: () => semearJanelaNasContas(janelaTodos()),
    onSuccess: (d) => {
      toast.success("Histórico completo armado no servidor", {
        description: descricaoSemeadura(d.resultado),
        duration: 10000,
      });
    },
    onError: (error) => {
      toast.error("Erro ao armar a importação de pedidos", { description: mensagemDeErro(error) ?? "Erro sem mensagem — tente de novo ou avise a equipe." });
    },
    // onSettled (não onSuccess): erro também re-lê o cursor — o estado REAL vem do banco.
    onSettled: () => queryClient.invalidateQueries({ queryKey: [JANELAS_CURSOR_QUERY_KEY] }),
  });

  const recentOrdersSyncMutation = useMutationComRegistro({
    acao: ACOES_ANALYTICS_SYNC.importarPedidosRecentes,
    detalhes: (d) => ({ modo: "semeadura_cursor", janela_de: d.janela.de, janela_ate: d.janela.ate, ...d.resultado }),
    mutationFn: () => semearJanelaNasContas(janelaRecentes()),
    onSuccess: (d) => {
      toast.success("Janela de 180 dias armada no servidor", {
        description: descricaoSemeadura(d.resultado),
        duration: 10000,
      });
    },
    onError: (error) => {
      toast.error("Erro ao armar a importação recente", { description: mensagemDeErro(error) ?? "Erro sem mensagem — tente de novo ou avise a equipe." });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [JANELAS_CURSOR_QUERY_KEY] }),
  });

  // Re-armar uma janela TERMINAL (falhou): ação sobre UM registro — o estado vive no próprio cursor,
  // então useMutation simples (não registra em acoes_execucoes). Staff-gated na RPC (20261015221700).
  const rearmarJanelaMutation = useMutation({
    mutationFn: async (j: StatusJanelaConta) => {
      const { data, error } = await supabase.rpc("vendas_sync_rearmar_janela", {
        p_account: j.account,
        p_date_from: j.dateFrom,
        p_date_to: j.dateTo,
      });
      if (error) throw new Error(error.message);
      return { janela: j, r: data as { rearmada?: boolean; motivo?: string | null } | null };
    },
    onSuccess: ({ janela, r }) => {
      if (r?.rearmada) {
        toast.success(`Janela ${janela.account} ${janela.janela} re-armada`, {
          description: "Volta à fila do servidor e é varrida de novo desde a página 1.",
        });
      } else {
        toast.warning("Janela não re-armada", {
          description:
            r?.motivo === "ja_pendente_outra"
              ? "Há outra importação em andamento nesta conta — re-tente quando ela terminar."
              : "A janela não está mais no estado de falha (alguém já re-armou ou ela mudou).",
        });
      }
    },
    onError: (error) => {
      toast.error("Erro ao re-armar a janela", { description: mensagemDeErro(error) ?? "Erro sem mensagem — tente de novo ou avise a equipe." });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [JANELAS_CURSOR_QUERY_KEY] }),
  });

  const getStateFor = (entity: string, account: string) =>
    syncStates?.find((s) => s.entity_type === entity && s.account === account);

  const formatDate = (d: string | null) => {
    if (!d) return "Nunca";
    return new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  };

  const isRunning = syncMutation.isPending || computeCostsMutation.isPending || assocRulesMutation.isPending || bulkClientSyncMutation.isPending || bulkOrdersSyncMutation.isPending || recentOrdersSyncMutation.isPending || addressSyncMutation.isPending;

  const handleConfigSave = (id: string) => {
    const val = parseFloat(editingConfig[id]);
    if (!isNaN(val)) {
      updateConfigMutation.mutate({ id, value: val });
      setEditingConfig(prev => { const n = { ...prev }; delete n[id]; return n; });
    }
  };

  return {
    selectedAccount,
    setSelectedAccount,
    showSyncHealth,
    syncStates,
    isLoading,
    recConfigs,
    syncMutation,
    computeCostsMutation,
    assocRulesMutation,
    bulkClientSyncMutation,
    addressSyncMutation,
    bulkOrdersSyncMutation,
    recentOrdersSyncMutation,
    rodadasClientes,
    importacaoClientesAberta,
    rearmarRodadaClientesMutation,
    addressSyncProgress,
    janelasImportacao,
    importacaoEmAndamento,
    rearmarJanelaMutation,
    editingConfig,
    setEditingConfig,
    getStateFor,
    formatDate,
    isRunning,
    handleConfigSave,
  };
}
