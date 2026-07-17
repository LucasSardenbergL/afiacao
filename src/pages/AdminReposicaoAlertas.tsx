import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ilikeOr, isSearchablePostgrestTerm } from "@/lib/postgrest";
import { useAuth } from "@/contexts/AuthContext";
import { useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import {
  PAGE_SIZE,
  type EventoOutlier, type SkuInfo, type ImpactoData, type GrupoRow, type AcaoConfirm,
} from "@/components/reposicao/alertas/types";
import { StatsCards } from "@/components/reposicao/alertas/StatsCards";
import { AlertasFiltros } from "@/components/reposicao/alertas/AlertasFiltros";
import { AlertasTable } from "@/components/reposicao/alertas/AlertasTable";
import { AlertaDrillSheet } from "@/components/reposicao/alertas/AlertaDrillSheet";
import { ConfirmacaoDialog } from "@/components/reposicao/alertas/ConfirmacaoDialog";

export default function AdminReposicaoAlertas() {
  const { user } = useAuth();
  const { empresa } = useReposicaoEmpresa();
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const [filtroTipo, setFiltroTipo] = useState<string>("__all__");
  const [filtroSev, setFiltroSev] = useState<string>("__all__");
  const [filtroStatus, setFiltroStatus] = useState<string>("pendente");
  const [busca, setBusca] = useState("");
  const [selecionados, setSelecionados] = useState<Set<number>>(new Set());

  const [drillEvento, setDrillEvento] = useState<EventoOutlier | null>(null);
  const [acaoConfirm, setAcaoConfirm] = useState<AcaoConfirm | null>(null);
  const [justificativa, setJustificativa] = useState("");

  // Stats do cabeçalho
  const { data: stats } = useQuery({
    queryKey: ["outlier-stats"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eventos_outlier")
        .select("severidade, status, decidido_em");
      if (error) throw error;
      const rows = data ?? [];
      const hoje = new Date().toISOString().slice(0, 10);
      return {
        pendentes: rows.filter((r) => r.status === "pendente").length,
        criticos: rows.filter((r) => r.status === "pendente" && r.severidade === "critico").length,
        atencao: rows.filter((r) => r.status === "pendente" && r.severidade === "atencao").length,
        info: rows.filter((r) => r.status === "pendente" && r.severidade === "info").length,
        aceitosHoje: rows.filter((r) => r.status === "aceito" && r.decidido_em?.startsWith(hoje)).length,
        excluidosHoje: rows.filter((r) => r.status === "excluido" && r.decidido_em?.startsWith(hoje)).length,
      };
    },
    refetchInterval: 30000,
  });

  // Lista paginada
  const { data: lista, isLoading } = useQuery({
    queryKey: ["outliers-lista", page, filtroTipo, filtroSev, filtroStatus, busca],
    queryFn: async () => {
      let q = supabase
        .from("eventos_outlier")
        .select("*", { count: "exact" })
        .order("severidade", { ascending: true }) // critico < atencao < info alfabeticamente
        .order("desvios_padrao", { ascending: false, nullsFirst: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

      if (filtroTipo !== "__all__") q = q.eq("tipo", filtroTipo);
      if (filtroSev !== "__all__") q = q.eq("severidade", filtroSev);
      if (filtroStatus !== "__all__") q = q.eq("status", filtroStatus);
      // Termo só-wildcard (`*`/`%%`) sanitiza pra vazio → `.or()` viraria match-all (#1062).
      // Não-pesquisável = pula o filtro (mostra a lista base), igual ao demais filtros opcionais.
      if (isSearchablePostgrestTerm(busca.trim())) {
        q = q.or(ilikeOr(["sku_codigo_omie", "sku_descricao"], busca.trim()));
      }

      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as EventoOutlier[], total: count ?? 0 };
    },
  });

  const totalPages = Math.max(1, Math.ceil((lista?.total ?? 0) / PAGE_SIZE));

  const isSemGrupo = drillEvento?.tipo === "sku_sem_grupo";

  // Drill-down: histórico de vendas (90d) ou LT
  const { data: historico } = useQuery({
    enabled: !!drillEvento && !isSemGrupo,
    queryKey: ["outlier-historico", drillEvento?.id],
    queryFn: async () => {
      if (!drillEvento) return null;
      if (drillEvento.tipo === "venda_atipica") {
        const desde = new Date();
        desde.setDate(desde.getDate() - 90);
        const { data, error } = await supabase
          .from("venda_items_history")
          .select("data_emissao, quantidade, nfe_chave_acesso")
          .eq("empresa", drillEvento.empresa)
          .eq("sku_codigo_omie", Number(drillEvento.sku_codigo_omie))
          .gte("data_emissao", desde.toISOString())
          .order("data_emissao", { ascending: true });
        if (error) throw error;
        // Agrega por dia
        const porDia = new Map<string, number>();
        (data ?? []).forEach((r) => {
          const dia = String(r.data_emissao).slice(0, 10);
          porDia.set(dia, (porDia.get(dia) ?? 0) + Number(r.quantidade));
        });
        const outlierDay = drillEvento.data_evento.slice(0, 10);
        return Array.from(porDia.entries())
          .map(([dia, q]) => ({ dia, qtde: q, isOutlier: dia === outlierDay }))
          .sort((a, b) => a.dia.localeCompare(b.dia));
      } else {
        // A coluna é `t1_data_pedido` — `data_pedido` NUNCA existiu (conferido na prod:
        // `column "data_pedido" does not exist`). O drill-down de lt_atipico levava 400
        // e lançava; ninguém notava porque o próprio viés do leadtime escondia o bug —
        // cópias idênticas zeram o desvio e `z = (lt-media)/NULLIF(desvio,0)` vira NULL,
        // então o detector quase não emitia lt_atipico. Corrigir a fonte EXPÕE a tela.
        // Fonte = v_sku_leadtime_efetivo: 1 ponto por NFe, não por linha-de-pedido.
        // t1 NOT NULL: a view emite t1 NULL quando as cópias divergem e
        // sem data não há eixo X — a observação é omitida do gráfico, não inventada.
        type LeadtimeRow = { t1_data_pedido: string; lt_bruto_dias_uteis: number };
        const { data, error } = await supabase
          .from("v_sku_leadtime_efetivo")
          .select("t1_data_pedido, lt_bruto_dias_uteis" as never)
          .eq("empresa", drillEvento.empresa as never)
          .eq("sku_codigo_omie", drillEvento.sku_codigo_omie as never)
          .not("t1_data_pedido", "is", null)
          .not("lt_bruto_dias_uteis", "is", null)
          .order("t1_data_pedido", { ascending: true });
        if (error) throw error;
        const outlierDay = drillEvento.data_evento.slice(0, 10);
        const rows = (data ?? []) as unknown as LeadtimeRow[];
        return rows.map((r, i: number) => ({
          idx: i + 1,
          dia: String(r.t1_data_pedido).slice(0, 10),
          lt: Number(r.lt_bruto_dias_uteis),
          isOutlier: String(r.t1_data_pedido).slice(0, 10) === outlierDay,
        }));
      }
    },
  });

  // Dados do SKU (drill seção 2)
  const { data: skuInfo } = useQuery<SkuInfo | null>({
    enabled: !!drillEvento,
    queryKey: ["outlier-sku", drillEvento?.sku_codigo_omie, drillEvento?.empresa],
    queryFn: async () => {
      if (!drillEvento) return null;
      // NOTE: schema gerado parcial — usar cast pra row local
      const { data } = await supabase
        .from("sku_parametros")
        .select("classe_consolidada, demanda_media_diaria, demanda_sigma_diario, lt_medio_dias_uteis, preco_compra_real" as never)
        .eq("empresa", drillEvento.empresa)
        .eq("sku_codigo_omie", Number(drillEvento.sku_codigo_omie))
        .maybeSingle();
      return (data ?? null) as unknown as SkuInfo | null;
    },
  });

  // Impacto previsto
  const { data: impacto } = useQuery<ImpactoData>({
    enabled: !!drillEvento && !isSemGrupo,
    queryKey: ["outlier-impacto", drillEvento?.id],
    queryFn: async () => {
      if (!drillEvento) return null;
      const { data, error } = await supabase.rpc("estimar_impacto_exclusao_outlier", {
        p_evento_id: drillEvento.id,
      });
      if (error) throw error;
      return (data ?? null) as unknown as ImpactoData;
    },
  });

  // Grupos disponíveis do fornecedor (só para sku_sem_grupo)
  const { data: gruposFornecedor } = useQuery({
    enabled: !!drillEvento && isSemGrupo,
    queryKey: ["grupos-fornecedor", drillEvento?.empresa, drillEvento?.detalhes?.fornecedor],
    queryFn: async () => {
      if (!drillEvento) return [];
      // NOTE: `codigo_grupo` no schema gerado é `grupo_codigo`; cast pra row local.
      const { data, error } = await supabase
        .from("fornecedor_grupo_producao")
        .select("id, codigo_grupo, descricao, lt_producao_dias" as never)
        .eq("empresa", drillEvento.empresa)
        .eq("fornecedor_nome", drillEvento.detalhes?.fornecedor ?? "")
        .order("codigo_grupo" as never);
      if (error) throw error;
      return (data ?? []) as unknown as GrupoRow[];
    },
  });

  const [grupoEscolhido, setGrupoEscolhido] = useState<string>("");

  // Mutation: atribuir grupo
  const atribuirGrupoMut = useMutation({
    mutationFn: async () => {
      if (!drillEvento || !grupoEscolhido) throw new Error("Selecione um grupo");
      const grupo = (gruposFornecedor ?? []).find((g) => g.id === (grupoEscolhido as unknown as number));
      if (!grupo) throw new Error("Grupo inválido");
      // Insere associação — payload diverge do schema gerado (fornecedor_grupo_id, codigo_grupo)
      const { error: insErr } = await supabase
        .from("sku_grupo_producao")
        .insert({
          empresa: drillEvento.empresa,
          sku_codigo_omie: drillEvento.sku_codigo_omie,
          fornecedor_grupo_id: grupo.id,
          fornecedor_nome: drillEvento.detalhes?.fornecedor,
          codigo_grupo: grupo.codigo_grupo,
        } as never);
      if (insErr) throw insErr;
      // Marca evento como aceito
      const { error: resErr } = await supabase.rpc("resolver_outlier", {
        p_evento_id: drillEvento.id,
        p_decisao: "aceitar",
        p_justificativa: `Atribuído ao grupo ${grupo.codigo_grupo} — ${grupo.descricao}`,
        p_usuario_email: user?.email || undefined,
      });
      if (resErr) throw resErr;
      // Recalcula parâmetros (LT mudou)
      try {
        await supabase.rpc("atualizar_parametros_numericos_skus", { p_empresa: drillEvento.empresa });
      } catch (e) {
        console.warn("Recálculo falhou:", e);
      }
    },
    onSuccess: () => {
      toast.success("SKU classificado e parâmetros recalculados");
      qc.invalidateQueries({ queryKey: ["outliers-lista"] });
      qc.invalidateQueries({ queryKey: ["outlier-stats"] });
      qc.invalidateQueries({ queryKey: ["outlier-pendentes-count"] });
      setDrillEvento(null);
      setGrupoEscolhido("");
    },
    onError: (err: Error) => toast.error(err.message ?? "Erro ao atribuir grupo"),
  });

  const resolverMut = useMutation({
    mutationFn: async ({ ids, decisao, just }: { ids: number[]; decisao: string; just: string }) => {
      const results = [];
      for (const id of ids) {
        const { data, error } = await supabase.rpc("resolver_outlier", {
          p_evento_id: id,
          p_decisao: decisao,
          p_justificativa: just || undefined,
          p_usuario_email: user?.email || undefined,
        });
        if (error) throw error;
        results.push(data);
      }
      // Recálculo automático após exclusão
      if (decisao === "excluir") {
        try {
          await supabase.rpc("atualizar_parametros_numericos_skus", { p_empresa: empresa });
        } catch (e) {
          console.warn("Recálculo falhou:", e);
        }
      }
      return results;
    },
    onSuccess: (_, vars) => {
      toast.success(`${vars.ids.length} alerta(s) ${vars.decisao === "aceitar" ? "aceito(s)" : vars.decisao === "excluir" ? "excluído(s)" : "ignorado(s)"}`);
      qc.invalidateQueries({ queryKey: ["outliers-lista"] });
      qc.invalidateQueries({ queryKey: ["outlier-stats"] });
      qc.invalidateQueries({ queryKey: ["outlier-pendentes-count"] });
      setSelecionados(new Set());
      setDrillEvento(null);
      setAcaoConfirm(null);
      setJustificativa("");
    },
    onError: (err: Error) => toast.error(err.message ?? "Erro ao resolver alerta"),
  });

  const todosSelecionavel = useMemo(
    () =>
      (lista?.rows ?? []).filter(
        (r) => r.status === "pendente" && r.severidade !== "critico" && r.tipo !== "sku_sem_grupo",
      ),
    [lista],
  );
  const todosMarcados = todosSelecionavel.length > 0 && todosSelecionavel.every((r) => selecionados.has(r.id));

  const toggleAll = () => {
    if (todosMarcados) setSelecionados(new Set());
    else setSelecionados(new Set(todosSelecionavel.map((r) => r.id)));
  };
  const toggleOne = (id: number) => {
    const next = new Set(selecionados);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelecionados(next);
  };

  const executarAcao = () => {
    if (!acaoConfirm) return;
    const ids = acaoConfirm.lote ? Array.from(selecionados) : drillEvento ? [drillEvento.id] : [];
    if (ids.length === 0) return;
    resolverMut.mutate({ ids, decisao: acaoConfirm.tipo, just: justificativa });
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-warning" />
            Alertas de Outlier
          </h1>
          <p className="text-sm text-muted-foreground">Triagem humana de eventos estatísticos atípicos</p>
        </div>
      </div>

      {/* Estatísticas */}
      <StatsCards stats={stats} />

      {/* Filtros */}
      <AlertasFiltros
        busca={busca}
        setBusca={setBusca}
        filtroTipo={filtroTipo}
        setFiltroTipo={setFiltroTipo}
        filtroSev={filtroSev}
        setFiltroSev={setFiltroSev}
        filtroStatus={filtroStatus}
        setFiltroStatus={setFiltroStatus}
        setPage={setPage}
        selecionadosCount={selecionados.size}
        onAceitarLote={() => setAcaoConfirm({ tipo: "aceitar", lote: true })}
        onExcluirLote={() => setAcaoConfirm({ tipo: "excluir", lote: true })}
        onLimparSelecao={() => setSelecionados(new Set())}
      />

      {/* Lista */}
      <AlertasTable
        lista={lista}
        isLoading={isLoading}
        selecionados={selecionados}
        todosMarcados={todosMarcados}
        selecionavelCount={todosSelecionavel.length}
        toggleAll={toggleAll}
        toggleOne={toggleOne}
        onDrill={setDrillEvento}
        page={page}
        totalPages={totalPages}
        setPage={setPage}
      />

      {/* Drill-down */}
      <AlertaDrillSheet
        drillEvento={drillEvento}
        onClose={() => setDrillEvento(null)}
        isSemGrupo={!!isSemGrupo}
        skuInfo={skuInfo}
        historico={historico}
        impacto={impacto}
        gruposFornecedor={gruposFornecedor}
        grupoEscolhido={grupoEscolhido}
        setGrupoEscolhido={setGrupoEscolhido}
        atribuirGrupoPending={atribuirGrupoMut.isPending}
        onAtribuirGrupo={() => atribuirGrupoMut.mutate()}
        justificativa={justificativa}
        setJustificativa={setJustificativa}
        onAcao={(tipo) => setAcaoConfirm({ tipo, lote: false })}
      />

      {/* Confirmação */}
      <ConfirmacaoDialog
        acaoConfirm={acaoConfirm}
        onClose={() => setAcaoConfirm(null)}
        selecionadosCount={selecionados.size}
        justificativa={justificativa}
        setJustificativa={setJustificativa}
        onConfirm={executarAcao}
        isPending={resolverMut.isPending}
      />
    </div>
  );
}
