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
} from "./janelas";

const JANELAS_CURSOR_QUERY_KEY = "vendas-sync-cursor-janelas";

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

  const [clientSyncProgress, setClientSyncProgress] = useState<string | null>(null);

  const bulkClientSyncMutation = useMutationComRegistro({
    acao: ACOES_ANALYTICS_SYNC.importarClientes,
    // Só há `detalhes` de sucesso quando as 3 contas foram percorridas: import parcial lança, e
    // aí quem grava é o ramo de erro do useMutationComRegistro (status 'erro' + a mensagem que
    // nomeia as contas interrompidas).
    detalhes: (d) => ({ importados: d.totalImported, ja_existiam: d.totalSkipped, erros: d.totalErrors }),
    mutationFn: async () => {
      let accountIndex = 0;
      let startPage = 1;
      let totalImported = 0;
      let totalSkipped = 0;
      let totalErrors = 0;
      // Contas que a edge INTERROMPEU (credencial revogada, erro que persistiu além do teto de
      // retentativas). A edge pula a conta para que as demais sincronizem — o que só é honesto
      // se a falha chegar aqui e à tela: pular em silêncio viraria "importação concluída" sobre
      // um import parcial (money-path §8). Acumulamos e o toast final nomeia as contas.
      const falhas: Array<{ conta: string; account: string; pagina: number; classe: string; motivo: string }> = [];
      // Guard de PROGRESSO, independente da edge: se duas invocações seguidas devolverem o mesmo
      // (account_index, start_page), o cursor não andou — e reinvocar é o laço quente original.
      // A edge tem defesa própria, mas uma edge revertida pelo deploy do Lovable, antiga ou
      // malformada voltaria a produzir exatamente esse cursor; aqui o laço morre de qualquer jeito.
      let cursorAnterior = '';
      // Contas do grupo sem credencial configurada na edge: não entram no laço, então sem isto
      // sumiriam do relatório e o import sairia "concluído" com um terço da base fora.
      const semCredencial = new Map<string, string>();
      // Piso de páginas da conta em curso, devolvido pela edge e REPASSADO na próxima chamada.
      // Sem transportá-lo, o teto reiniciava em `start_page` a cada invocação e uma resposta
      // retomada COM clientes mas SEM `total_de_paginas` encerrava a conta na hora, deixando a
      // cauda por importar (achado Codex do PR da classe de paginação; a edge tem defesa
      // própria pela página cheia, mas ela é o cinto — este é o suspensório).
      let totalPaginas = 0;

      while (true) {
        setClientSyncProgress(`Conta ${accountIndex + 1}/3 — página ${startPage}...`);
        const { data, error } = await supabase.functions.invoke("omie-cliente", {
          body: {
            action: "sync_all_clients",
            account_index: accountIndex,
            start_page: startPage,
            total_paginas: totalPaginas,
          },
        });
        if (error) throw error;

        totalImported += data?.imported || 0;
        totalSkipped += data?.skipped || 0;
        totalErrors += data?.errors || 0;

        // ANTES de qualquer `break`: a última resposta do laço também pode trazer a conta que
        // falhou (a última conta abandonada zera o hasMore), e ler a falha depois do break a
        // perderia justamente no caso em que ela é a única coisa a reportar.
        for (const c of (data?.contas_sem_credencial ?? []) as Array<{ account?: string; name?: string }>) {
          if (c?.account) semCredencial.set(String(c.account), String(c.name ?? c.account));
        }
        if (data?.falha?.conta_abandonada === true) {
          falhas.push({
            conta: String(data.falha.conta ?? data.falha.account ?? 'conta desconhecida'),
            account: String(data.falha.account ?? ''),
            pagina: Number(data.falha.pagina) || 0,
            classe: String(data.falha.classe ?? 'indeterminada'),
            motivo: String(data.falha.motivo ?? '').slice(0, 240),
          });
        }

        if (data?.account) {
          setClientSyncProgress(`${data.account}: +${data.imported} importados (pág ${data.lastPage}/${data.totalPages})`);
        }

        // Fim-sentinela da edge: accountIndex além da última conta devolve {done:true}
        // SEM hasMore (omie-cliente:909) — é fim LEGÍTIMO, não malformação (Codex xhigh).
        if (data?.done === true) break;
        // Resposta malformada (sem `hasMore` booleano) NÃO é fim (classe #1338→#1564):
        // colapsá-la com fim dava toast "Importação concluída" sobre um sync PARCIAL.
        // Fim legítimo é exclusivamente `hasMore === false` / `done` vindos da edge.
        if (data == null || typeof data.hasMore !== 'boolean') {
          throw new Error('sync_all_clients: resposta sem hasMore booleano — malformada, não é fim');
        }
        if (!data.hasMore) break;
        accountIndex = data.next.account_index;
        startPage = data.next.start_page;
        // A edge zera `total_paginas` ao trocar de conta (o total é por conta); `?? 0` cobre
        // uma edge ainda não deployada, que não devolve o campo — aí vale a defesa da página
        // cheia do lado de lá.
        totalPaginas = data.next.total_paginas ?? 0;

        // Cursor que NÃO andou = reinvocar a mesma conta/página = o laço quente original. A edge
        // tem defesa própria, mas ela vive no código deployado; este guard não depende dele.
        const cursorAtual = `${accountIndex}:${startPage}`;
        if (cursorAtual === cursorAnterior) {
          throw new Error(
            `sync_all_clients: cursor parado em conta ${accountIndex} página ${startPage} — a edge não avançou (versão antiga/revertida?)`,
          );
        }
        cursorAnterior = cursorAtual;
      }

      setClientSyncProgress(null);

      // Conta sem credencial nunca entra no laço: entra aqui, como falha permanente de
      // configuração, para não sumir do relatório.
      for (const [account, nome] of semCredencial) {
        falhas.push({
          conta: nome,
          account,
          pagina: 0,
          classe: 'permanente',
          motivo: 'credencial Omie não configurada nesta edge — a conta inteira ficou fora do import',
        });
      }

      // ⚠️ Import parcial LANÇA. `useMutationComRegistro` fecha o registro como 'sucesso' sempre
      // que a Promise resolve — então resolver com `falhas` deixaria `acoes_execucoes` gravado
      // como sucesso, e depois de um reload o card <UltimaExecucao> mostraria ✓ sobre um import
      // que deixou uma conta inteira para trás (achado Codex P1). O toast de 30s desapareceria e
      // só o ✓ ficaria. Um import que não percorreu tudo não é sucesso: o estado durável tem de
      // dizer isso. Os números vão na mensagem, que o registro persiste em `detalhes.erro`.
      if (falhas.length > 0) {
        const resumo = falhas
          .map((f) => `${f.conta} (pág ${f.pagina}, ${f.classe}: ${f.motivo})`)
          .join(' · ');
        throw new Error(
          `Importação PARCIAL — ${falhas.length} conta(s) não sincronizaram. ` +
            `${totalImported} importados, ${totalSkipped} já existiam, ${totalErrors} erros. Interrompidas: ${resumo}`,
        );
      }

      return { totalImported, totalSkipped, totalErrors };
    },
    // `onSuccess` só roda quando TODAS as contas foram percorridas: import parcial lança acima,
    // de propósito, para que o registro durável em acoes_execucoes fique 'erro' e o card não
    // mostre ✓ sobre uma conta que ficou de fora.
    onSuccess: (data) => {
      toast.success("Importação de clientes concluída", {
        description: `${data.totalImported} importados, ${data.totalSkipped} já existiam, ${data.totalErrors} erros`,
        duration: 10000,
      });
    },
    onError: (error) => {
      setClientSyncProgress(null);
      // A mensagem do parcial já nomeia as contas interrompidas, as páginas e as classes.
      // O `.replace(/^Error:\s*/)` de antes existia só para tirar o prefixo que o
      // `String(error)` acrescenta; mensagemDeErro() lê `.message`, que já vem sem ele.
      toast.error("Importação de clientes não concluída", {
        description: mensagemDeErro(error) ?? "Erro sem mensagem — tente de novo ou avise a equipe.",
        duration: 30000,
      });
    },
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
      const { data, error } = await supabase
        .from("vendas_sync_cursor")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(12);
      if (error) throw error;
      return data as JanelaCursorRow[];
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
    clientSyncProgress,
    addressSyncProgress,
    janelasImportacao,
    importacaoEmAndamento,
    editingConfig,
    setEditingConfig,
    getStateFor,
    formatDate,
    isRunning,
    handleConfigSave,
  };
}
