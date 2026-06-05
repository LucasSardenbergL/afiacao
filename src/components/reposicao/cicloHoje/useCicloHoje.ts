// Lógica do painel "Ciclo de hoje" (seleção, aprovação em lote/automática, memos derivados).
// Extraída verbatim de src/components/reposicao/CicloHojePanel.tsx (god-component split).
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/reposicao";
import { calcApprovalSuggestion } from "@/lib/reposicao/approvalSuggestion";
import type { PedidoItem } from "@/types/reposicao";
import { aprovarEDisparar } from "../pedidos/aprovar-disparar";
import { EMPRESA } from "../pedidos/shared";
import { ALL, type CicloFilters } from "./types";

export interface AutoApprovalGroup {
  fornecedor: string;
  qtd: number;
}

export type ManualReviewItem = {
  item: PedidoItem;
  suggestion: ReturnType<typeof calcApprovalSuggestion>;
};

interface UseCicloHojeArgs {
  user: { id?: string; email?: string | null } | null;
  reviewMode: boolean;
  filteredItems: PedidoItem[];
  setFilters: (f: CicloFilters) => void;
}

export function useCicloHoje({ user, reviewMode, filteredItems, setFilters }: UseCicloHojeArgs) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);

  useEffect(() => {
    if (!reviewMode) setSelected(new Set());
  }, [reviewMode]);

  const allChecked = filteredItems.length > 0 && filteredItems.every((i) => selected.has(i.id));
  const toggleAll = () => {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(filteredItems.map((i) => i.id)));
  };
  const toggleOne = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const totalSelectedValue = filteredItems
    .filter((i) => selected.has(i.id))
    .reduce((s, r) => s + Number(r.valor_total ?? 0), 0);

  const eligibleAutoItems = useMemo(
    () =>
      filteredItems.filter(
        (item) =>
          calcApprovalSuggestion(item).mode === "auto" && !item.aprovado_em && !item.cancelado_em,
      ),
    [filteredItems],
  );

  const autoApprovalGroups = useMemo<AutoApprovalGroup[]>(() => {
    const map = new Map<string, number>();
    eligibleAutoItems.forEach((item) => {
      const fornecedor = item.fornecedor_nome ?? "Sem fornecedor";
      map.set(fornecedor, (map.get(fornecedor) ?? 0) + Number(item.num_skus ?? 0));
    });
    return Array.from(map.entries()).map(([fornecedor, qtd]) => ({ fornecedor, qtd }));
  }, [eligibleAutoItems]);

  const manualReviewItems = useMemo<ManualReviewItem[]>(
    () =>
      filteredItems
        .filter((item) => !item.aprovado_em && !item.cancelado_em)
        .map((item) => ({ item, suggestion: calcApprovalSuggestion(item) }))
        .filter(({ suggestion }) => suggestion.mode === "review"),
    [filteredItems],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["cockpit-itens-dia"] });
    queryClient.invalidateQueries({ queryKey: ["cockpit-current-step"] });
    queryClient.invalidateQueries({ queryKey: ["reposicao-pedidos"] });
  };

  const runBatch = async (kind: "approve" | "reject") => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    const ids = Array.from(selected);
    const nowIso = new Date().toISOString();
    const who = user?.email ?? user?.id ?? "cockpit";

    if (kind === "approve") {
      // APROVAR = DISPARAR NA HORA, por pedido SELECIONADO. Loop da trilha canônica
      // (RPC + edge { empresa, pedido_id }) em vez de um invoke empresa-wide:
      // o { empresa } sozinho varreria TODO aprovado_aguardando_disparo do ciclo —
      // inclusive os auto-aprovados que devem esperar o cron (runAutoApprove). Aqui
      // disparamos exatamente o lote que o operador marcou. Sequencial: não martelar
      // a edge/Browserless em paralelo. Best-effort por item: um erro não aborta os demais.
      let aprovados = 0;
      let comErro = 0;
      for (const id of ids) {
        try {
          const r = await aprovarEDisparar({ pedidoId: id, empresa: EMPRESA, usuario: who });
          if (r.ok) aprovados += 1;
          else comErro += 1;
        } catch {
          comErro += 1;
        }
      }
      await logAudit({
        userId: user?.id ?? null,
        action: "Aprovação em lote",
        result: comErro === 0 ? "Sucesso" : `Parcial: ${aprovados} ok, ${comErro} com erro`,
        metadata: { ids, count: ids.length, aprovados, comErro },
      });
      if (comErro === 0) {
        toast.success(`${aprovados} pedido(s) aprovado(s) e disparado(s)`);
      } else if (aprovados > 0) {
        toast.warning(`${aprovados} aprovado(s); ${comErro} com erro. Reveja os que falharam.`);
      } else {
        toast.error("Falha na operação em lote");
      }
      setSelected(new Set());
      invalidate();
      setBusy(false);
      return;
    }

    // Rejeição em lote: UPDATE direto (não passa pela trilha de disparo).
    try {
      const { error } = await supabase
        .from("pedido_compra_sugerido")
        .update({
          cancelado_em: nowIso,
          cancelado_por: who,
          status: "cancelado" as const,
          justificativa_cancelamento: "Rejeitado em lote no Cockpit",
        })
        .in("id", ids);
      if (error) throw error;

      await logAudit({
        userId: user?.id ?? null,
        action: "Rejeição em lote",
        result: "Sucesso",
        metadata: { ids, count: ids.length },
      });
      toast.success(`${ids.length} pedido(s) rejeitado(s)`);
      setSelected(new Set());
      invalidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: "Rejeição em lote",
        result: `Erro: ${msg}`,
        metadata: { ids },
      });
      toast.error("Falha na operação em lote");
    } finally {
      setBusy(false);
    }
  };

  const runAutoApprove = async () => {
    if (eligibleAutoItems.length === 0 || busy) return;
    setBusy(true);
    const ids = eligibleAutoItems.map((item) => item.id);
    const nowIso = new Date().toISOString();
    const who = user?.email ?? user?.id ?? "cockpit";
    try {
      const { error } = await supabase
        .from("pedido_compra_sugerido")
        .update({
          aprovado_em: nowIso,
          aprovado_por: who,
          status: "aprovado_aguardando_disparo",
        })
        .in("id", ids);
      if (error) throw error;
      await logAudit({
        userId: user?.id ?? null,
        action: "Aprovação automática — critérios atingidos",
        result: "Sucesso",
        metadata: { ids, count: ids.length },
      });
      toast.success(`${ids.length} pedido(s) aprovado(s) automaticamente`);
      setConfirmAuto(false);
      invalidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: "Aprovação automática — critérios atingidos",
        result: `Erro: ${msg}`,
        metadata: { ids },
      });
      toast.error("Falha ao aprovar elegíveis");
    } finally {
      setBusy(false);
    }
  };

  const clearFilters = () => setFilters({ search: "", fornecedor: ALL, status: ALL });

  return {
    selected,
    busy,
    confirmAuto,
    setConfirmAuto,
    allChecked,
    toggleAll,
    toggleOne,
    totalSelectedValue,
    eligibleAutoItems,
    autoApprovalGroups,
    manualReviewItems,
    invalidate,
    runBatch,
    runAutoApprove,
    clearFilters,
  };
}
