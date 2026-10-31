import { exigirEmpresaReposicao } from "@/lib/reposicao/linha-view";
import { useState, useMemo } from "react";
import { useUrlState } from "@/hooks/useUrlState";
import { track } from "@/lib/analytics";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ilikeOr, isSearchablePostgrestTerm } from "@/lib/postgrest";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import {
  PAGE_SIZE, tiposDaVisao, podeAceitarEmLote,
  type EventoOutlier, type SkuInfo, type AcaoConfirm, type Visao,
} from "@/components/reposicao/alertas/types";
import { buscarStats, atribuirGrupoAosSkus } from "@/components/reposicao/alertas/api";
import { SemGrupoLote } from "@/components/reposicao/alertas/SemGrupoLote";
import { StatsCards } from "@/components/reposicao/alertas/StatsCards";
import { AlertasFiltros } from "@/components/reposicao/alertas/AlertasFiltros";
import { AlertasTable } from "@/components/reposicao/alertas/AlertasTable";
import { AlertaDrillSheet } from "@/components/reposicao/alertas/AlertaDrillSheet";
import { ConfirmacaoDialog } from "@/components/reposicao/alertas/ConfirmacaoDialog";

export default function AdminReposicaoAlertas() {
  const { user } = useAuth();
  // Sem `useReposicaoEmpresa`: a empresa do contexto só alimentava o recálculo
  // pós-exclusão (removido). A lista nunca filtrou por ela — o que, aliás, deixava o
  // recálculo ainda mais solto: dava para decidir um alerta de uma empresa e recalcular
  // outra, a do seletor.
  const qc = useQueryClient();

  // Filtros na URL: sobrevivem ao F5 e dão link direto (ex.: ?visao=registro). Chaves sem colisão com o
  // `?tab=` da Sessão de parâmetros, que embute esta tela como aba.
  const [filtros, setFiltros] = useUrlState({
    visao: "fila",
    tipo: "__all__",
    sev: "__all__",
    status: "pendente",
    q: "",
    pagina: 1,
  });
  const visao: Visao = filtros.visao === "registro" ? "registro" : "fila";
  const page = filtros.pagina;
  const setPage = (v: number | ((prev: number) => number)) =>
    setFiltros((prev) => ({ ...prev, pagina: typeof v === "function" ? v(prev.pagina) : v }));
  // Cada filtro volta à página 1 NA MESMA escrita: o setter do useUrlState mescla sobre o estado do
  // render, então duas chamadas no mesmo evento (filtro, depois página) se sobrescreveriam.
  const filtroTipo = filtros.tipo;
  const setFiltroTipo = (tipo: string) => setFiltros({ tipo, pagina: 1 });
  const filtroSev = filtros.sev;
  const setFiltroSev = (sev: string) => setFiltros({ sev, pagina: 1 });
  const filtroStatus = filtros.status;
  const setFiltroStatus = (status: string) => setFiltros({ status, pagina: 1 });
  const busca = filtros.q;
  const setBusca = (q: string) => setFiltros({ q, pagina: 1 });
  // Trocar de visão zera tipo e página: o tipo de uma visão não existe na outra.
  const setVisao = (v: Visao) => {
    setFiltros({ visao: v, tipo: "__all__", pagina: 1 });
    setSelecionados(new Set());
  };
  const [selecionados, setSelecionados] = useState<Set<number>>(new Set());

  const [drillEvento, setDrillEvento] = useState<EventoOutlier | null>(null);
  const [acaoConfirm, setAcaoConfirm] = useState<AcaoConfirm | null>(null);
  const [justificativa, setJustificativa] = useState("");

  // Stats do cabeçalho
  const { data: stats } = useQuery({
    queryKey: ["outlier-stats"],
    queryFn: () => buscarStats(),
    refetchInterval: 60000,
  });

  // Sem grupo pendentes, inteiros (são poucos e é o bloco de ação da fila — não depende da página).
  const { data: semGrupoPendentes } = useQuery({
    enabled: visao === "fila",
    queryKey: ["outliers-sem-grupo"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eventos_outlier")
        .select("*")
        .eq("tipo", "sku_sem_grupo")
        .eq("status", "pendente")
        .order("detectado_em", { ascending: true })
        .range(0, 999);
      if (error) throw error;
      return (data ?? []) as EventoOutlier[];
    },
  });

  // Na fila, com status=pendente e sem tipo escolhido, o sem-grupo sai da TABELA: o bloco de lote acima
  // já lista cada um com a ação. Escolher o tipo "SKU sem grupo" (ou outro status) traz de volta.
  const blocoSemGrupoCobre = visao === "fila" && filtroStatus === "pendente" && filtroTipo === "__all__";
  const tiposTabela = blocoSemGrupoCobre
    ? tiposDaVisao(visao).filter((t) => t !== "sku_sem_grupo")
    : tiposDaVisao(visao);

  // Lista paginada
  const { data: lista, isLoading } = useQuery({
    queryKey: ["outliers-lista", visao, page, filtroTipo, filtroSev, filtroStatus, busca],
    queryFn: async () => {
      let q = supabase
        .from("eventos_outlier")
        .select("*", { count: "exact" })
        .order("severidade", { ascending: true }) // critico < atencao < info alfabeticamente
        .order("desvios_padrao", { ascending: false, nullsFirst: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

      if (filtroTipo !== "__all__") q = q.eq("tipo", filtroTipo);
      else q = q.in("tipo", [...tiposTabela]);
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
  // Só venda e LT têm série para desenhar; os tipos do Omie caíam no ramo de LT e plotavam leadtime à toa.
  const temHistorico = drillEvento?.tipo === "venda_atipica" || drillEvento?.tipo === "lt_atipico";

  // Drill-down: histórico de vendas (90d) ou LT
  const { data: historico } = useQuery({
    enabled: !!drillEvento && temHistorico,
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
        const { data, error } = await supabase
          .from("v_sku_leadtime_efetivo")
          .select("t1_data_pedido, lt_bruto_dias_uteis")
          .eq("empresa", exigirEmpresaReposicao(drillEvento.empresa, "v_sku_leadtime_efetivo"))
          .eq("sku_codigo_omie", Number(drillEvento.sku_codigo_omie))
          .not("t1_data_pedido", "is", null)
          .not("lt_bruto_dias_uteis", "is", null)
          .order("t1_data_pedido", { ascending: true });
        if (error) throw error;
        const outlierDay = drillEvento.data_evento.slice(0, 10);
        const rows = (data ?? []);
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
      // Fonte = v_sku_parametros_sugeridos: sku_parametros NÃO tem demanda_sigma_diario nem
      // preco_compra_real (a query antiga dava 400 e o `error` era descartado — o painel ficava vazio
      // em silêncio). `lead_time_medio` da view é o LT médio em dias úteis aplicado pelo motor.
      const { data, error } = await supabase
        .from("v_sku_parametros_sugeridos")
        .select("classe_consolidada, demanda_media_diaria, demanda_sigma_diario, lead_time_medio, preco_compra_real")
        .eq("empresa", drillEvento.empresa)
        .eq("sku_codigo_omie", Number(drillEvento.sku_codigo_omie))
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        classe_consolidada: data.classe_consolidada,
        demanda_media_diaria: data.demanda_media_diaria,
        demanda_sigma_diario: data.demanda_sigma_diario,
        lt_medio_dias_uteis: data.lead_time_medio,
        preco_compra_real: data.preco_compra_real,
      };
    },
  });

  // Média do LT para a linha de referência do gráfico. Derivada do MESMO histórico que
  // desenha os pontos — antes vinha da RPC estimar_impacto_exclusao_outlier (removida do
  // fluxo), cuja fórmula e janela divergiam do que o gráfico plota.
  const mediaLt = useMemo(() => {
    if (drillEvento?.tipo === "venda_atipica") return null;
    const rows = (historico as Array<{ lt: number }> | null) ?? [];
    if (rows.length === 0) return null;
    return rows.reduce((acc, r) => acc + r.lt, 0) / rows.length;
  }, [historico, drillEvento?.tipo]);

  // Grupos disponíveis do fornecedor (só para sku_sem_grupo)
  const { data: gruposFornecedor } = useQuery({
    enabled: !!drillEvento && isSemGrupo,
    queryKey: ["grupos-fornecedor", drillEvento?.empresa, drillEvento?.detalhes?.fornecedor],
    queryFn: async () => {
      if (!drillEvento) return [];
      const { data, error } = await supabase
        .from("fornecedor_grupo_producao")
        .select("id, grupo_codigo, descricao, lt_producao_dias")
        .eq("empresa", drillEvento.empresa)
        .eq("fornecedor_nome", drillEvento.detalhes?.fornecedor ?? "")
        .order("grupo_codigo");
      if (error) throw error;
      return (data ?? []);
    },
  });

  const [grupoEscolhido, setGrupoEscolhido] = useState<string>("");

  const invalidarAlertas = () => {
    qc.invalidateQueries({ queryKey: ["outliers-lista"] });
    qc.invalidateQueries({ queryKey: ["outliers-sem-grupo"] });
    qc.invalidateQueries({ queryKey: ["outlier-stats"] });
    qc.invalidateQueries({ queryKey: ["outlier-pendentes-count"] });
  };

  // Mutation: atribuir grupo (um SKU, pelo drill-down) — mesma escrita do lote.
  const atribuirGrupoMut = useMutation({
    mutationFn: async () => {
      if (!drillEvento || !grupoEscolhido) throw new Error("Selecione um grupo");
      // O Select devolve o id como TEXTO (SelectItem value é string); compara pelo texto, sem cast.
      const grupo = (gruposFornecedor ?? []).find((g) => String(g.id) === grupoEscolhido);
      if (!grupo) throw new Error("Grupo inválido");
      const r = await atribuirGrupoAosSkus({
        empresa: drillEvento.empresa, eventos: [drillEvento], grupo, usuarioEmail: user?.email,
      });
      if (r.falha) throw new Error(r.falha.mensagem);
      return r;
    },
    onSuccess: (r) => {
      track("reposicao.alerta_grupo_atribuido", {
        quantidade: r.atribuidos, lote: false, falhou: false, recalculo_falhou: r.recalculoFalhou,
      });
      if (r.recalculoFalhou) toast.warning("SKU classificado, mas o recálculo de parâmetros falhou");
      else toast.success("SKU classificado e parâmetros recalculados");
      invalidarAlertas();
      setDrillEvento(null);
      setGrupoEscolhido("");
    },
    onError: (err: Error) => toast.error(err.message ?? "Erro ao atribuir grupo"),
  });

  const resolverMut = useMutation({
    mutationFn: async ({ ids, just }: { ids: number[]; just: string }) => {
      const results = [];
      for (const id of ids) {
        const { data, error } = await supabase.rpc("resolver_outlier", {
          p_evento_id: id,
          p_decisao: "aceitar",
          p_justificativa: just || undefined,
          p_usuario_email: user?.email || undefined,
        });
        if (error) throw error;
        results.push(data);
      }
      // Sem recálculo aqui: o que existia rodava sobre a MESMA base, sem relação com a
      // decisão (teatro). O recálculo do fluxo sku_sem_grupo fica — ali o LT muda de fato.
      return results;
    },
    onSuccess: (_, vars) => {
      track("reposicao.alerta_revisado", { quantidade: vars.ids.length, lote: vars.ids.length > 1 });
      toast.success(`${vars.ids.length} alerta(s) marcado(s) como revisado(s)`);
      invalidarAlertas();
      setSelecionados(new Set());
      setDrillEvento(null);
      setAcaoConfirm(null);
      setJustificativa("");
    },
    onError: (err: Error) => toast.error(err.message ?? "Erro ao resolver alerta"),
  });

  const todosSelecionavel = useMemo(
    () =>
      (lista?.rows ?? []).filter(podeAceitarEmLote),
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
    resolverMut.mutate({ ids, just: justificativa });
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-warning" />
            Alertas de Outlier
          </h1>
          <p className="text-sm text-muted-foreground">
            {visao === "fila"
              ? "Fila de ação: o que muda dado do motor (grupo de produção, leadtime do fornecedor)"
              : "Registro: venda atípica e mudanças no Omie — informativo, não altera o motor"}
          </p>
        </div>
      </div>

      {/* Estatísticas */}
      <StatsCards stats={stats} visao={visao} onVisao={setVisao} />

      {visao === "fila" && (
        <SemGrupoLote
          eventos={semGrupoPendentes ?? []}
          usuarioEmail={user?.email}
          onConcluido={invalidarAlertas}
        />
      )}

      {/* Filtros */}
      <AlertasFiltros
        visao={visao}
        busca={busca}
        setBusca={setBusca}
        filtroTipo={filtroTipo}
        setFiltroTipo={setFiltroTipo}
        filtroSev={filtroSev}
        setFiltroSev={setFiltroSev}
        filtroStatus={filtroStatus}
        setFiltroStatus={setFiltroStatus}
        selecionadosCount={selecionados.size}
        onAceitarLote={() => setAcaoConfirm({ lote: true })}
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
        mensagemVazia={
          visao === "fila"
            ? "Nada pede decisão aqui com estes filtros. Venda atípica fica no Registro."
            : "Nenhum alerta encontrado"
        }
      />

      {/* Drill-down */}
      <AlertaDrillSheet
        drillEvento={drillEvento}
        onClose={() => setDrillEvento(null)}
        isSemGrupo={!!isSemGrupo}
        skuInfo={skuInfo}
        historico={historico}
        mediaLt={mediaLt}
        gruposFornecedor={gruposFornecedor}
        grupoEscolhido={grupoEscolhido}
        setGrupoEscolhido={setGrupoEscolhido}
        atribuirGrupoPending={atribuirGrupoMut.isPending}
        onAtribuirGrupo={() => atribuirGrupoMut.mutate()}
        justificativa={justificativa}
        setJustificativa={setJustificativa}
        onAcao={() => setAcaoConfirm({ lote: false })}
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
