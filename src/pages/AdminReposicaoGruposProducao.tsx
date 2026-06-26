import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { eqInt, ilike, isSearchablePostgrestTerm, orFilter } from "@/lib/postgrest";
import { toast } from "sonner";
import { Plus, Factory } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EMPRESA, ALL, SEM_GRUPO, PAGE_SIZE, emptyGrupo,
  type Grupo, type SkuRow, type SkuGrupoRow, type SkuParametroRow,
} from "@/components/reposicao/gruposProducao/types";
import { GruposTable } from "@/components/reposicao/gruposProducao/GruposTable";
import { SkuFilters } from "@/components/reposicao/gruposProducao/SkuFilters";
import { SkuTable } from "@/components/reposicao/gruposProducao/SkuTable";
import { GrupoDialog } from "@/components/reposicao/gruposProducao/GrupoDialog";

export default function AdminReposicaoGruposProducao() {
  const qc = useQueryClient();

  // Modal state
  const [editing, setEditing] = useState<Partial<Grupo> | null>(null);
  const isNew = editing !== null && !editing.id;

  // Filters
  const [filtroFornecedor, setFiltroFornecedor] = useState<string>(ALL);
  const [filtroGrupo, setFiltroGrupo] = useState<string>(ALL);
  const [busca, setBusca] = useState("");
  const [page, setPage] = useState(0);
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [bulkGrupo, setBulkGrupo] = useState<string>("");

  // ============ QUERIES ============
  const { data: grupos = [], isLoading: loadingGrupos } = useQuery({
    queryKey: ["fornecedor-grupos", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_grupo_producao")
        .select("*")
        .eq("empresa", EMPRESA)
        .order("fornecedor_nome")
        .order("grupo_codigo");
      if (error) throw error;
      return (data || []) as unknown as Grupo[];
    },
  });

  const { data: contagensSku = {} } = useQuery({
    queryKey: ["sku-grupo-contagens", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sku_grupo_producao")
        .select("grupo_codigo")
        .eq("empresa", EMPRESA);
      if (error) throw error;
      const counts: Record<string, number> = {};
      ((data || []) as SkuGrupoRow[]).forEach((r) => {
        counts[r.grupo_codigo] = (counts[r.grupo_codigo] || 0) + 1;
      });
      return counts;
    },
  });

  const { data: skusData, isLoading: loadingSkus } = useQuery({
    queryKey: ["skus-grupo-list", EMPRESA, filtroFornecedor, filtroGrupo, busca, page],
    queryFn: async () => {
      let q = supabase
        .from("sku_parametros")
        .select("empresa, sku_codigo_omie, sku_descricao, fornecedor_nome", { count: "exact" })
        .eq("empresa", EMPRESA)
        .eq("ativo", true);

      if (filtroFornecedor !== ALL) q = q.eq("fornecedor_nome", filtroFornecedor);
      // Termo só-wildcard sanitiza pra vazio → o ilike do `.or()` viraria match-all (#1062);
      // o eqInt já cairia em `eq.0` (inerte). Não-pesquisável = pula o filtro (lista base).
      const t = busca.trim();
      if (isSearchablePostgrestTerm(t)) {
        q = q.or(orFilter(ilike("sku_descricao", t), eqInt("sku_codigo_omie", t)));
      }

      const { data, error, count } = await q
        .order("sku_descricao")
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) throw error;

      // Buscar associações para esses SKUs
      const rawRows = (data || []) as SkuParametroRow[];
      const skuCodes = rawRows.map((r) => String(r.sku_codigo_omie));
      const assocMap: Record<string, string> = {};
      if (skuCodes.length > 0) {
        const { data: assoc } = await supabase
          .from("sku_grupo_producao")
          .select("sku_codigo_omie, grupo_codigo")
          .eq("empresa", EMPRESA)
          .in("sku_codigo_omie", skuCodes);
        ((assoc || []) as SkuGrupoRow[]).forEach((a) => {
          assocMap[String(a.sku_codigo_omie)] = a.grupo_codigo;
        });
      }

      // Esconde Produto Acabado ('04' = fabricado, não comprado → não precisa de grupo de produção).
      // Sinal CANÔNICO = omie_products.tipo_produto (account 'oben') — o MESMO do motor e do
      // gerador de alerta no backend (evita divergência tipo_reposicao×tipo_produto).
      const set04 = new Set<string>();
      if (skuCodes.length > 0) {
        const codigos = skuCodes.map(Number).filter(Number.isFinite);
        if (codigos.length > 0) {
          const { data: prod } = await supabase
            .from("omie_products")
            .select("omie_codigo_produto, tipo_produto")
            .eq("account", "oben")
            .in("omie_codigo_produto", codigos)
            .in("tipo_produto", ["04", "4"]);
          ((prod || []) as Array<{ omie_codigo_produto: number }>).forEach((p) =>
            set04.add(String(p.omie_codigo_produto)),
          );
        }
      }

      const rows: SkuRow[] = rawRows
        .filter((r) => !set04.has(String(r.sku_codigo_omie)))
        .map((r) => ({
          empresa: r.empresa,
          sku_codigo_omie: Number(r.sku_codigo_omie),
          sku_descricao: r.sku_descricao,
          fornecedor_nome: r.fornecedor_nome,
          grupo_codigo: assocMap[String(r.sku_codigo_omie)] || null,
        }));

      // Filtro por grupo (client-side, aplicado depois do fetch da página)
      const filtered = filtroGrupo === ALL
        ? rows
        : filtroGrupo === SEM_GRUPO
          ? rows.filter((r) => !r.grupo_codigo)
          : rows.filter((r) => r.grupo_codigo === filtroGrupo);

      return { rows: filtered, total: count || 0 };
    },
  });

  const skus = skusData?.rows || [];
  const totalSkus = skusData?.total || 0;

  // Lista de fornecedores únicos para filtros
  const fornecedoresDisponiveis = useMemo(() => {
    const set = new Set<string>();
    grupos.forEach((g) => set.add(g.fornecedor_nome));
    return Array.from(set).sort();
  }, [grupos]);

  // Grupos disponíveis para um fornecedor específico
  const gruposPorFornecedor = useMemo(() => {
    const map: Record<string, Grupo[]> = {};
    grupos.forEach((g) => {
      if (!map[g.fornecedor_nome]) map[g.fornecedor_nome] = [];
      map[g.fornecedor_nome].push(g);
    });
    return map;
  }, [grupos]);

  // ============ MUTATIONS ============
  const recalcular = async () => {
    const { error } = await supabase.rpc("atualizar_parametros_numericos_skus" as never, {
      p_empresa: EMPRESA,
    } as never);
    if (error) {
      toast.error("Erro ao recalcular parâmetros: " + error.message);
      return false;
    }
    toast.success("Parâmetros recalculados. Ver alterações em /admin/reposicao/revisao");
    return true;
  };

  const salvarGrupo = useMutation({
    mutationFn: async (g: Partial<Grupo>) => {
      const payload = {
        empresa: EMPRESA,
        fornecedor_nome: (g.fornecedor_nome || "").trim(),
        grupo_codigo: (g.grupo_codigo || "").trim(),
        descricao: g.descricao || null,
        lt_producao_dias: Number(g.lt_producao_dias) || 1,
        lt_producao_unidade: g.lt_producao_unidade || "uteis",
        horario_corte: g.horario_corte || null,
        observacoes: g.observacoes || null,
      };
      if (!payload.fornecedor_nome || !payload.grupo_codigo) {
        throw new Error("Fornecedor e código do grupo são obrigatórios");
      }
      if (g.id) {
        const { error } = await supabase
          .from("fornecedor_grupo_producao")
          .update(payload)
          .eq("id", g.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("fornecedor_grupo_producao")
          .insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Grupo salvo");
      qc.invalidateQueries({ queryKey: ["fornecedor-grupos"] });
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao salvar"),
  });

  const moverSku = useMutation({
    mutationFn: async (params: { sku: number; novoGrupo: string | null }) => {
      const { sku, novoGrupo } = params;
      if (!novoGrupo) {
        const { error } = await supabase
          .from("sku_grupo_producao")
          .delete()
          .eq("empresa", EMPRESA)
          .eq("sku_codigo_omie", String(sku));
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("sku_grupo_producao")
          .upsert(
            {
              empresa: EMPRESA,
              sku_codigo_omie: String(sku),
              grupo_codigo: novoGrupo,
              atualizado_em: new Date().toISOString(),
            },
            { onConflict: "empresa,sku_codigo_omie" },
          );
        if (error) throw error;
      }
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["skus-grupo-list"] });
      qc.invalidateQueries({ queryKey: ["sku-grupo-contagens"] });
      await recalcular();
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao mover SKU"),
  });

  const moverLote = useMutation({
    mutationFn: async (params: { skus: number[]; grupo: string }) => {
      const { skus, grupo } = params;
      const rows = skus.map((s) => ({
        empresa: EMPRESA,
        sku_codigo_omie: String(s),
        grupo_codigo: grupo,
        atualizado_em: new Date().toISOString(),
      }));
      const { error } = await supabase
        .from("sku_grupo_producao")
        .upsert(rows, { onConflict: "empresa,sku_codigo_omie" });
      if (error) throw error;
    },
    onSuccess: async (_, vars) => {
      toast.success(`${vars.skus.length} SKUs movidos`);
      setSelecionados(new Set());
      setBulkGrupo("");
      qc.invalidateQueries({ queryKey: ["skus-grupo-list"] });
      qc.invalidateQueries({ queryKey: ["sku-grupo-contagens"] });
      await recalcular();
    },
    onError: (e: Error) => toast.error(e.message || "Erro no lote"),
  });

  // ============ UI helpers ============
  const toggleSel = (sku: number) => {
    const s = new Set(selecionados);
    const k = String(sku);
    if (s.has(k)) s.delete(k);
    else s.add(k);
    setSelecionados(s);
  };

  const toggleAll = () => {
    if (selecionados.size === skus.length) setSelecionados(new Set());
    else setSelecionados(new Set(skus.map((r) => String(r.sku_codigo_omie))));
  };

  const aplicarLote = () => {
    if (!bulkGrupo || selecionados.size === 0) return;
    moverLote.mutate({
      skus: Array.from(selecionados).map(Number),
      grupo: bulkGrupo,
    });
  };

  // Para o dropdown da linha: grupos do fornecedor daquele SKU
  const gruposParaSku = (fornecedor: string | null) =>
    fornecedor ? gruposPorFornecedor[fornecedor] || [] : [];

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Factory className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Grupos de produção</h1>
            <p className="text-sm text-muted-foreground">
              Gerencie grupos por fornecedor e associações SKU→grupo
            </p>
          </div>
        </div>
      </header>

      {/* SEÇÃO 1 - GRUPOS CADASTRADOS */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Grupos cadastrados</CardTitle>
          <Button size="sm" onClick={() => setEditing(emptyGrupo())}>
            <Plus className="h-4 w-4" /> Novo grupo
          </Button>
        </CardHeader>
        <CardContent>
          <GruposTable
            grupos={grupos}
            loading={loadingGrupos}
            contagensSku={contagensSku}
            onEdit={setEditing}
          />
        </CardContent>
      </Card>

      {/* SEÇÃO 2 - ASSOCIAÇÃO SKU→GRUPO */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Associação SKU → Grupo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <SkuFilters
            filtroFornecedor={filtroFornecedor}
            setFiltroFornecedor={setFiltroFornecedor}
            filtroGrupo={filtroGrupo}
            setFiltroGrupo={setFiltroGrupo}
            busca={busca}
            setBusca={setBusca}
            setPage={setPage}
            fornecedoresDisponiveis={fornecedoresDisponiveis}
            grupos={grupos}
            selecionadosCount={selecionados.size}
            bulkGrupo={bulkGrupo}
            setBulkGrupo={setBulkGrupo}
            onAplicarLote={aplicarLote}
            onLimparSelecao={() => { setSelecionados(new Set()); setBulkGrupo(""); }}
            moverLotePending={moverLote.isPending}
          />

          <SkuTable
            skus={skus}
            loadingSkus={loadingSkus}
            selecionados={selecionados}
            toggleSel={toggleSel}
            toggleAll={toggleAll}
            gruposParaSku={gruposParaSku}
            onMoverSku={(sku, novoGrupo) => moverSku.mutate({ sku, novoGrupo })}
            moverSkuPending={moverSku.isPending}
            page={page}
            setPage={setPage}
            totalSkus={totalSkus}
          />
        </CardContent>
      </Card>

      {/* MODAL */}
      <GrupoDialog
        editing={editing}
        setEditing={setEditing}
        isNew={isNew}
        onSalvar={(g) => salvarGrupo.mutate(g)}
        salvarPending={salvarGrupo.isPending}
      />
    </div>
  );
}
