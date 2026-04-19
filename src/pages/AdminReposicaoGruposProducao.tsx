import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Plus, Pencil, Search, Loader2, Factory } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const EMPRESA = "OBEN";
const ALL = "__all__";
const SEM_GRUPO = "__sem_grupo__";
const PAGE_SIZE = 50;

type Grupo = {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  grupo_codigo: string;
  descricao: string | null;
  lt_producao_dias: number;
  lt_producao_unidade: string;
  horario_corte: string | null;
  observacoes: string | null;
};

type SkuRow = {
  empresa: string;
  sku_codigo_omie: number;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  grupo_codigo: string | null;
};

const emptyGrupo = (): Partial<Grupo> => ({
  empresa: EMPRESA,
  fornecedor_nome: "",
  grupo_codigo: "",
  descricao: "",
  lt_producao_dias: 5,
  lt_producao_unidade: "uteis",
  horario_corte: null,
  observacoes: "",
});

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
        .from("fornecedor_grupo_producao" as any)
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
        .from("sku_grupo_producao" as any)
        .select("grupo_codigo")
        .eq("empresa", EMPRESA);
      if (error) throw error;
      const counts: Record<string, number> = {};
      ((data || []) as any[]).forEach((r) => {
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
      if (busca.trim()) {
        const t = busca.trim();
        q = q.or(`sku_descricao.ilike.%${t}%,sku_codigo_omie.eq.${/^\d+$/.test(t) ? t : 0}`);
      }

      const { data, error, count } = await q
        .order("sku_descricao")
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) throw error;

      // Buscar associações para esses SKUs
      const skuCodes = (data || []).map((r: any) => String(r.sku_codigo_omie));
      let assocMap: Record<string, string> = {};
      if (skuCodes.length > 0) {
        const { data: assoc } = await supabase
          .from("sku_grupo_producao" as any)
          .select("sku_codigo_omie, grupo_codigo")
          .eq("empresa", EMPRESA)
          .in("sku_codigo_omie", skuCodes);
        ((assoc || []) as any[]).forEach((a) => {
          assocMap[String(a.sku_codigo_omie)] = a.grupo_codigo;
        });
      }

      const rows: SkuRow[] = (data || []).map((r: any) => ({
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
    const { error } = await supabase.rpc("atualizar_parametros_numericos_skus" as any, {
      p_empresa: EMPRESA,
    });
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
          .from("fornecedor_grupo_producao" as any)
          .update(payload)
          .eq("id", g.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("fornecedor_grupo_producao" as any)
          .insert(payload as any);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Grupo salvo");
      qc.invalidateQueries({ queryKey: ["fornecedor-grupos"] });
      setEditing(null);
    },
    onError: (e: any) => toast.error(e.message || "Erro ao salvar"),
  });

  const moverSku = useMutation({
    mutationFn: async (params: { sku: number; novoGrupo: string | null }) => {
      const { sku, novoGrupo } = params;
      if (!novoGrupo) {
        const { error } = await supabase
          .from("sku_grupo_producao" as any)
          .delete()
          .eq("empresa", EMPRESA)
          .eq("sku_codigo_omie", String(sku));
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("sku_grupo_producao" as any)
          .upsert(
            {
              empresa: EMPRESA,
              sku_codigo_omie: String(sku),
              grupo_codigo: novoGrupo,
              atualizado_em: new Date().toISOString(),
            } as any,
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
    onError: (e: any) => toast.error(e.message || "Erro ao mover SKU"),
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
        .from("sku_grupo_producao" as any)
        .upsert(rows as any, { onConflict: "empresa,sku_codigo_omie" });
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
    onError: (e: any) => toast.error(e.message || "Erro no lote"),
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
          {loadingGrupos ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fornecedor</TableHead>
                    <TableHead>Código</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead className="text-right">LT (dias)</TableHead>
                    <TableHead>Unidade</TableHead>
                    <TableHead>Corte</TableHead>
                    <TableHead className="text-right">SKUs</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grupos.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                        Nenhum grupo cadastrado.
                      </TableCell>
                    </TableRow>
                  )}
                  {grupos.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="font-medium">{g.fornecedor_nome}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{g.grupo_codigo}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {g.descricao || "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {g.lt_producao_dias}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-xs">
                          {g.lt_producao_unidade === "uteis" ? "úteis" : "corridos"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {g.horario_corte ? g.horario_corte.slice(0, 5) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {contagensSku[g.grupo_codigo] || 0}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(g)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* SEÇÃO 2 - ASSOCIAÇÃO SKU→GRUPO */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Associação SKU → Grupo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Filtros */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Select value={filtroFornecedor} onValueChange={(v) => { setFiltroFornecedor(v); setPage(0); }}>
              <SelectTrigger>
                <SelectValue placeholder="Fornecedor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos os fornecedores</SelectItem>
                {fornecedoresDisponiveis.map((f) => (
                  <SelectItem key={f} value={f}>{f}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filtroGrupo} onValueChange={(v) => { setFiltroGrupo(v); setPage(0); }}>
              <SelectTrigger>
                <SelectValue placeholder="Grupo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos os grupos</SelectItem>
                <SelectItem value={SEM_GRUPO}>Sem grupo</SelectItem>
                {grupos.map((g) => (
                  <SelectItem key={g.id} value={g.grupo_codigo}>
                    {g.grupo_codigo} ({g.fornecedor_nome})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="md:col-span-2 relative">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar por SKU ou descrição…"
                className="pl-9"
                value={busca}
                onChange={(e) => { setBusca(e.target.value); setPage(0); }}
              />
            </div>
          </div>

          {/* Ação em lote */}
          {selecionados.size > 0 && (
            <div className="flex items-center gap-3 rounded-md border bg-muted/40 p-3">
              <span className="text-sm font-medium">{selecionados.size} selecionado(s)</span>
              <Select value={bulkGrupo} onValueChange={setBulkGrupo}>
                <SelectTrigger className="max-w-xs">
                  <SelectValue placeholder="Mover para grupo…" />
                </SelectTrigger>
                <SelectContent>
                  {grupos.map((g) => (
                    <SelectItem key={g.id} value={g.grupo_codigo}>
                      {g.grupo_codigo} — {g.fornecedor_nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={aplicarLote}
                disabled={!bulkGrupo || moverLote.isPending}
              >
                {moverLote.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Aplicar
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setSelecionados(new Set()); setBulkGrupo(""); }}
              >
                Cancelar
              </Button>
            </div>
          )}

          {/* Tabela SKUs */}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40px]">
                    <Checkbox
                      checked={skus.length > 0 && selecionados.size === skus.length}
                      onCheckedChange={toggleAll}
                    />
                  </TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Fornecedor</TableHead>
                  <TableHead className="w-[260px]">Grupo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingSkus && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Carregando…
                    </TableCell>
                  </TableRow>
                )}
                {!loadingSkus && skus.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      Nenhum SKU encontrado.
                    </TableCell>
                  </TableRow>
                )}
                {!loadingSkus && skus.map((r) => {
                  const opts = gruposParaSku(r.fornecedor_nome);
                  const k = String(r.sku_codigo_omie);
                  return (
                    <TableRow key={k}>
                      <TableCell>
                        <Checkbox
                          checked={selecionados.has(k)}
                          onCheckedChange={() => toggleSel(r.sku_codigo_omie)}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.sku_codigo_omie}</TableCell>
                      <TableCell className="max-w-[320px] truncate">{r.sku_descricao || "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.fornecedor_nome || "—"}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={r.grupo_codigo || SEM_GRUPO}
                          onValueChange={(v) =>
                            moverSku.mutate({
                              sku: r.sku_codigo_omie,
                              novoGrupo: v === SEM_GRUPO ? null : v,
                            })
                          }
                          disabled={opts.length === 0 || moverSku.isPending}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder={opts.length === 0 ? "Sem grupos do fornecedor" : "Selecionar…"} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SEM_GRUPO}>— Sem grupo —</SelectItem>
                            {opts.map((g) => (
                              <SelectItem key={g.id} value={g.grupo_codigo}>
                                {g.grupo_codigo} ({g.lt_producao_dias}d)
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Paginação */}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Mostrando {skus.length} de {totalSkus} SKUs
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Anterior
              </Button>
              <span>Página {page + 1}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={(page + 1) * PAGE_SIZE >= totalSkus}
                onClick={() => setPage((p) => p + 1)}
              >
                Próxima
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* MODAL */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isNew ? "Novo grupo" : "Editar grupo"}</DialogTitle>
            <DialogDescription>
              Define o lead time de produção e janela de corte do fornecedor.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <Label>Fornecedor *</Label>
                <Input
                  value={editing.fornecedor_nome || ""}
                  onChange={(e) => setEditing({ ...editing, fornecedor_nome: e.target.value })}
                  placeholder="Ex.: RENNER SAYERLACK S/A"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Código do grupo *</Label>
                  <Input
                    value={editing.grupo_codigo || ""}
                    onChange={(e) => setEditing({ ...editing, grupo_codigo: e.target.value })}
                    placeholder="ex.: sayerlack_rapido"
                  />
                </div>
                <div>
                  <Label>LT produção (dias) *</Label>
                  <Input
                    type="number"
                    min={1}
                    value={editing.lt_producao_dias ?? 5}
                    onChange={(e) =>
                      setEditing({ ...editing, lt_producao_dias: Number(e.target.value) })
                    }
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Unidade</Label>
                  <Select
                    value={editing.lt_producao_unidade || "uteis"}
                    onValueChange={(v) => setEditing({ ...editing, lt_producao_unidade: v })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="uteis">Dias úteis</SelectItem>
                      <SelectItem value="corridos">Dias corridos</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Horário de corte</Label>
                  <Input
                    type="time"
                    value={editing.horario_corte?.slice(0, 5) || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, horario_corte: e.target.value || null })
                    }
                  />
                </div>
              </div>
              <div>
                <Label>Descrição</Label>
                <Input
                  value={editing.descricao || ""}
                  onChange={(e) => setEditing({ ...editing, descricao: e.target.value })}
                />
              </div>
              <div>
                <Label>Observações</Label>
                <Textarea
                  rows={2}
                  value={editing.observacoes || ""}
                  onChange={(e) => setEditing({ ...editing, observacoes: e.target.value })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button
              onClick={() => editing && salvarGrupo.mutate(editing)}
              disabled={salvarGrupo.isPending}
            >
              {salvarGrupo.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
