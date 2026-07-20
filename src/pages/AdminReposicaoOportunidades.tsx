import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Sparkles, RefreshCw, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sheet, SheetContent } from "@/components/ui/sheet";

import { Cenario, Oportunidade, OportunidadeComDecisao, OrdemKey } from "@/components/reposicao/oportunidades/types";
import { EMPRESA, ALL, CENARIOS, formatBRL, diasEntre } from "@/components/reposicao/oportunidades/shared";
import { avaliarComprarMais, type InsumoSku } from "@/lib/reposicao/compras-otimizador-helpers";
import { DrawerConteudo } from "@/components/reposicao/oportunidades/components";
import { KpiCards } from "@/components/reposicao/oportunidades/KpiCards";
import { NegociacaoBanner } from "@/components/reposicao/oportunidades/NegociacaoBanner";
import { OportunidadesFiltros } from "@/components/reposicao/oportunidades/OportunidadesFiltros";
import { OportunidadesTable } from "@/components/reposicao/oportunidades/OportunidadesTable";
import { GerarCicloDialog } from "@/components/reposicao/oportunidades/GerarCicloDialog";
import { UltimaExecucao } from "@/components/execucoes/UltimaExecucao";
import { ULTIMA_EXECUCAO_QUERY_KEY } from "@/components/execucoes/tipos";

// Escritor deste slug é a PRÓPRIA função SQL ciclo_oportunidade_do_dia (migration
// 20260722110000): captura o clique manual E o cron das 11:05. O frontend só LÊ.
const ACAO_GERAR_CICLO = "reposicao.gerar_ciclo_oportunidade";

// Monta o InsumoSku consumido pelo helper de decisão net-R$ a partir da linha da view.
function montarInsumo(o: Oportunidade): InsumoSku {
  const qtdeOportunidade = Number(o.qtde_oportunidade ?? 0);
  const descPromo = Number(o.desconto_promo_perc ?? 0);
  // curva fase 1: 1 faixa — o desconto promocional vale a partir de qtde_oportunidade (qtd que o
  // sistema já sugere pra capturar a oportunidade). Sem desconto/qtd → curva vazia.
  const curva =
    descPromo > 0 && qtdeOportunidade > 0
      ? [{ volume_minimo: qtdeOportunidade, desconto_promo_perc: descPromo }]
      : [];
  return {
    empresa: o.empresa,
    sku: String(o.sku_codigo_omie),
    fornecedor: o.fornecedor_nome ?? "—",
    preco_unit: Number(o.preco_item_eoq ?? 0),
    demanda_diaria: o.demanda_diaria != null ? Number(o.demanda_diaria) : null,
    qtde_base: o.qtde_base != null ? Number(o.qtde_base) : null,
    lote_minimo_fornecedor:
      o.lote_minimo_fornecedor != null ? Number(o.lote_minimo_fornecedor) : null,
    minimo_forcado_manual:
      o.minimo_forcado_manual != null ? Number(o.minimo_forcado_manual) : null, // Frente B — fonte: sku_parametros via view
    cm_anual: Number(o.custo_capital_efetivo_perc ?? 0) / 100, // view expõe em %/ano → fração
    prazo_padrao_perc: o.prazo_padrao_perc != null ? Number(o.prazo_padrao_perc) : null,
    frete_perc_valor: o.frete_perc_valor != null ? Number(o.frete_perc_valor) : null,
    frete_fixo: o.frete_fixo != null ? Number(o.frete_fixo) : null,
    frete_taxa_pedido: o.frete_taxa_pedido != null ? Number(o.frete_taxa_pedido) : null,
    aumento_evitado_perc:
      o.aumento_evitado_perc != null ? Number(o.aumento_evitado_perc) : null,
    dias_ate_aumento: diasEntre(o.proxima_vigencia_aumento), // helper de shared.tsx (pode ser null)
    ruptura_valor_estimado: null,
    ruptura_dias: null,
    curva_desconto: curva,
    qtd_oportunidade: o.qtde_oportunidade != null ? Number(o.qtde_oportunidade) : null,
    escopo: "sku", // fase 1
  };
}

export default function AdminReposicaoOportunidades() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [cenariosSelecionados, setCenariosSelecionados] = useState<Set<Cenario>>(
    new Set(CENARIOS.map((c) => c.value)),
  );
  const [filtroFornecedor, setFiltroFornecedor] = useState<string>(ALL);
  const [ordenacao, setOrdenacao] = useState<OrdemKey>("net");
  const [apenasComEconomia, setApenasComEconomia] = useState(true);
  const [ignoradosLocal, setIgnoradosLocal] = useState<Set<number>>(new Set());
  const [drawerSku, setDrawerSku] = useState<OportunidadeComDecisao | null>(null);
  const [confirmCicloOpen, setConfirmCicloOpen] = useState(false);
  const [executandoCiclo, setExecutandoCiclo] = useState(false);
  const [bannerNegociacaoFechado, setBannerNegociacaoFechado] = useState(
    () => typeof window !== 'undefined' && sessionStorage.getItem('banner-negociacao-fechado') === '1',
  );

  // Contador de sugestões "novas" de negociação paralela (banner)
  const { data: negociacaoNovasCount = 0 } = useQuery({
    queryKey: ["negociacao-paralela-sugestoes-count"],
    queryFn: async () => {
      const { count } = await supabase
        .from("v_sugestao_negociacao_ativa" as never)
        .select("*", { count: "exact", head: true })
        .eq("empresa", EMPRESA)
        .eq("status", "nova");
      return count ?? 0;
    },
    staleTime: 30_000,
  });

  // ============ QUERIES ============
  const { data: oportunidades = [], isLoading, isFetching } = useQuery({
    queryKey: ["oportunidades-hoje", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_otimizador_compras_insumos" as never)
        .select("*")
        .eq("empresa", EMPRESA);
      if (error) throw error;
      const base = ((data || []) as unknown) as Oportunidade[];
      // Decisão net-R$ marginal por SKU via helper puro (compras-otimizador-helpers).
      return base.map((o): OportunidadeComDecisao => ({
        ...o,
        decisao: avaliarComprarMais(montarInsumo(o)),
      }));
    },
  });

  const { data: totalSkusAtivos = 0 } = useQuery({
    queryKey: ["sku-parametros-count", EMPRESA],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("sku_parametros")
        .select("*", { count: "exact", head: true })
        .eq("empresa", EMPRESA)
        .eq("ativo", true);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const { data: cicloHoje = 0 } = useQuery({
    queryKey: ["ciclo-hoje", EMPRESA],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

      const [promo, aumento] = await Promise.all([
        supabase
          .from("promocao_campanha")
          .select("id", { count: "exact", head: true })
          .eq("empresa", EMPRESA)
          .eq("estado", "ativa")
          .eq("data_corte_pedido", today),
        supabase
          .from("fornecedor_aumento_anunciado")
          .select("id", { count: "exact", head: true })
          .eq("empresa", EMPRESA)
          .in("estado", ["ativo", "vigente"])
          .eq("data_vigencia", tomorrow),
      ]);

      return (promo.count ?? 0) + (aumento.count ?? 0);
    },
  });

  // Quick reference: histórico total de campanhas de promoção
  const { data: historicoPromocoes } = useQuery({
    queryKey: ["historico-promocoes-count", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("promocao_campanha")
        .select("data_inicio")
        .eq("empresa", EMPRESA);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<{ data_inicio: string | null }>;
      const meses = new Set<string>();
      for (const r of rows) {
        const k = r.data_inicio?.slice(0, 7);
        if (k) meses.add(k);
      }
      return { campanhas: rows.length, meses: meses.size };
    },
  });

  // ============ DERIVED STATE ============
  const fornecedoresUnicos = useMemo(() => {
    const set = new Set<string>();
    oportunidades.forEach((o) => {
      if (o.fornecedor_nome) set.add(o.fornecedor_nome);
    });
    return Array.from(set).sort();
  }, [oportunidades]);

  const oportunidadesFiltradas = useMemo(() => {
    let arr = oportunidades.filter((o) => !ignoradosLocal.has(o.sku_codigo_omie));
    arr = arr.filter((o) => cenariosSelecionados.has(o.cenario));
    if (filtroFornecedor !== ALL) {
      arr = arr.filter((o) => o.fornecedor_nome === filtroFornecedor);
    }
    if (apenasComEconomia) {
      arr = arr.filter((o) => Number(o.economia_bruta_estimada ?? 0) > 0);
    }
    arr.sort((a, b) => {
      switch (ordenacao) {
        case "net":
          return b.decisao.beneficio_liquido_rs - a.decisao.beneficio_liquido_rs;
        case "economia":
          return Number(b.economia_bruta_estimada ?? 0) - Number(a.economia_bruta_estimada ?? 0);
        case "data_limite":
          return (a.dias_ate_limite ?? 9999) - (b.dias_ate_limite ?? 9999);
        case "desconto":
          return Number(b.desconto_total_perc ?? 0) - Number(a.desconto_total_perc ?? 0);
        case "sku":
          return (a.sku_descricao ?? "").localeCompare(b.sku_descricao ?? "");
      }
    });
    return arr;
  }, [oportunidades, ignoradosLocal, cenariosSelecionados, filtroFornecedor, apenasComEconomia, ordenacao]);

  // ============ KPIs ============
  const totalEconomia = useMemo(
    () =>
      oportunidades.reduce(
        (acc, o) => acc + Number(o.economia_bruta_estimada ?? 0),
        0,
      ),
    [oportunidades],
  );

  // Ganho líquido potencial = soma do net-R$ apenas dos SKUs com recomendação "comprar_mais".
  const ganhoLiquidoPotencial = useMemo(
    () =>
      oportunidades.reduce(
        (acc, o) =>
          o.decisao.recomendacao === "comprar_mais"
            ? acc + o.decisao.beneficio_liquido_rs
            : acc,
        0,
      ),
    [oportunidades],
  );

  const dataLimiteMaisProxima = useMemo(() => {
    const datas = oportunidades
      .map((o) => o.data_limite_acao)
      .filter((d): d is string => !!d)
      .sort();
    return datas[0] ?? null;
  }, [oportunidades]);

  const diasAteLimite = useMemo(
    () => diasEntre(dataLimiteMaisProxima),
    [dataLimiteMaisProxima],
  );

  // ============ HANDLERS ============
  const toggleCenario = (c: Cenario, checked: boolean) => {
    setCenariosSelecionados((prev) => {
      const next = new Set(prev);
      if (checked) next.add(c);
      else next.delete(c);
      return next;
    });
  };

  const handleAtualizar = () => {
    queryClient.invalidateQueries({ queryKey: ["oportunidades-hoje"] });
    queryClient.invalidateQueries({ queryKey: ["sku-parametros-count"] });
    queryClient.invalidateQueries({ queryKey: ["ciclo-hoje"] });
    toast.success("Posição atualizada");
  };

  const handleIgnorar = (sku: number) => {
    setIgnoradosLocal((prev) => new Set(prev).add(sku));
    toast.info("SKU oculto até o próximo refresh");
  };

  const handleGerarCiclo = async () => {
    setExecutandoCiclo(true);
    try {
      const { data, error } = await supabase.rpc("ciclo_oportunidade_do_dia" as never, {
        p_empresa: EMPRESA,
      } as never);
      if (error) throw error;

      const result = (data ?? {}) as {
        pedidos_criados?: number;
        skus_incluidos?: number;
        valor_total?: number;
      };
      toast.success(
        `Ciclo gerado: ${result.pedidos_criados ?? 0} pedidos · ${
          result.skus_incluidos ?? 0
        } SKUs · ${formatBRL(result.valor_total ?? 0)}`,
      );
      setConfirmCicloOpen(false);
      queryClient.invalidateQueries({ queryKey: ["oportunidades-hoje"] });
      queryClient.invalidateQueries({ queryKey: ["ciclo-hoje"] });
      // O registro foi gravado pelo SQL — refresca a caption <UltimaExecucao>.
      queryClient.invalidateQueries({ queryKey: [ULTIMA_EXECUCAO_QUERY_KEY] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao gerar ciclo de oportunidade");
    } finally {
      setExecutandoCiclo(false);
    }
  };

  const cenariosLabel =
    cenariosSelecionados.size === CENARIOS.length
      ? "Todos os cenários"
      : `${cenariosSelecionados.size} cenário${cenariosSelecionados.size === 1 ? "" : "s"}`;

  return (
    <TooltipProvider>
      <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <Sparkles className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Oportunidades</h1>
              <p className="text-sm text-muted-foreground">
                Promoções e aumentos com janela de captura ativa hoje
              </p>
            </div>
          </div>
          <div className="flex flex-col items-start sm:items-end gap-1">
            <div className="flex flex-wrap items-center gap-2">
              {cicloHoje > 0 && (
                <Button size="sm" onClick={() => setConfirmCicloOpen(true)}>
                  <PlayCircle className="h-4 w-4" /> Gerar ciclo oportunidade
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={handleAtualizar}>
                <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
                Atualizar posição
              </Button>
            </div>
            {/* Fora do condicional: mostra também o "automática" diário do cron das 11:05. */}
            <UltimaExecucao acao={ACAO_GERAR_CICLO} />
          </div>
        </header>

        {!bannerNegociacaoFechado && negociacaoNovasCount > 0 && (
          <NegociacaoBanner
            count={negociacaoNovasCount}
            onVerSugestoes={() => navigate('/admin/reposicao/negociacao-paralela')}
            onFechar={() => {
              sessionStorage.setItem('banner-negociacao-fechado', '1');
              setBannerNegociacaoFechado(true);
            }}
          />
        )}

        {historicoPromocoes && historicoPromocoes.campanhas > 0 && (
          <div className="text-xs text-muted-foreground -mt-2">
            Histórico de promoções:{" "}
            <button
              type="button"
              onClick={() => navigate("/admin/reposicao/promocoes")}
              className="font-medium text-foreground hover:underline"
            >
              {historicoPromocoes.campanhas}{" "}
              {historicoPromocoes.campanhas === 1 ? "campanha" : "campanhas"}
            </button>{" "}
            em {historicoPromocoes.meses}{" "}
            {historicoPromocoes.meses === 1 ? "mês" : "meses"}
          </div>
        )}

        {/* KPI Cards */}
        <KpiCards
          totalEconomia={totalEconomia}
          ganhoLiquidoPotencial={ganhoLiquidoPotencial}
          oportunidadesCount={oportunidades.length}
          totalSkusAtivos={totalSkusAtivos}
          dataLimiteMaisProxima={dataLimiteMaisProxima}
          diasAteLimite={diasAteLimite}
          cicloHoje={cicloHoje}
          onGerarCiclo={() => setConfirmCicloOpen(true)}
        />

        {/* Filtros + Tabela */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Oportunidades ativas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <OportunidadesFiltros
              cenariosSelecionados={cenariosSelecionados}
              cenariosLabel={cenariosLabel}
              toggleCenario={toggleCenario}
              filtroFornecedor={filtroFornecedor}
              setFiltroFornecedor={setFiltroFornecedor}
              fornecedoresUnicos={fornecedoresUnicos}
              ordenacao={ordenacao}
              setOrdenacao={setOrdenacao}
              apenasComEconomia={apenasComEconomia}
              setApenasComEconomia={setApenasComEconomia}
            />

            <OportunidadesTable
              isLoading={isLoading}
              totalCount={oportunidades.length}
              rows={oportunidadesFiltradas}
              navigate={navigate}
              onOpenDrawer={setDrawerSku}
              onIgnorar={handleIgnorar}
            />
          </CardContent>
        </Card>

        {/* Drawer de detalhes */}
        <Sheet open={!!drawerSku} onOpenChange={(o) => !o && setDrawerSku(null)}>
          <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
            {drawerSku && <DrawerConteudo o={drawerSku} navigate={navigate} />}
          </SheetContent>
        </Sheet>

        {/* Confirmação ciclo */}
        <GerarCicloDialog
          open={confirmCicloOpen}
          onOpenChange={setConfirmCicloOpen}
          oportunidadesCount={oportunidades.length}
          totalEconomia={totalEconomia}
          executando={executandoCiclo}
          onConfirm={handleGerarCiclo}
        />
      </div>
    </TooltipProvider>
  );
}
