import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Percent, Upload, FilePlus, Handshake, AlertTriangle } from "lucide-react";
import { agruparPorMes, chavesUltimosNMeses } from "@/lib/agruparPorMes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EMPRESA, ALL, type Campanha, type CampanhaComContagem } from "@/components/reposicao/promocoes/types";
import { useUploadPromocoes } from "@/components/reposicao/promocoes/useUploadPromocoes";
import { CampanhasFiltros } from "@/components/reposicao/promocoes/CampanhasFiltros";
import { CampanhasTable } from "@/components/reposicao/promocoes/CampanhasTable";
import { UploadDialog } from "@/components/reposicao/promocoes/UploadDialog";

export default function AdminReposicaoPromocoes() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [filtroEstado, setFiltroEstado] = useState<string>(ALL);
  const [filtroFornecedor, setFiltroFornecedor] = useState<string>(ALL);
  const [busca, setBusca] = useState("");

  const [uploadOpen, setUploadOpen] = useState(false);

  // ============ QUERIES ============
  const { data: campanhas = [], isLoading } = useQuery({
    queryKey: ["promocao-campanhas", filtroEstado, filtroFornecedor, busca],
    queryFn: async () => {
      let q = supabase
        .from("promocao_campanha")
        .select(
          "id, nome, fornecedor_nome, tipo_origem, data_inicio, data_fim, estado, extracao_confianca, criado_em",
        )
        .eq("empresa", EMPRESA)
        .order("criado_em", { ascending: false });

      if (filtroEstado !== ALL) q = q.eq("estado", filtroEstado);
      if (filtroFornecedor !== ALL) q = q.eq("fornecedor_nome", filtroFornecedor);
      if (busca.trim()) q = q.ilike("nome", `%${busca.trim()}%`);

      const { data, error } = await q;
      if (error) throw error;
      const rows = (data || []) as unknown as Campanha[];

      // Buscar contagem de itens em batch
      const ids = rows.map((c) => c.id);
      const counts: Record<number, number> = {};
      if (ids.length > 0) {
        const { data: itens } = await supabase
          .from("promocao_item")
          .select("campanha_id")
          .in("campanha_id", ids);
        ((itens || []) as Array<{ campanha_id: number }>).forEach((it) => {
          counts[it.campanha_id] = (counts[it.campanha_id] || 0) + 1;
        });
      }

      return rows.map<CampanhaComContagem>((c) => ({
        ...c,
        num_itens: counts[c.id] || 0,
      }));
    },
  });

  const { data: fornecedores = [] } = useQuery({
    queryKey: ["promocao-fornecedores", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("promocao_campanha")
        .select("fornecedor_nome")
        .eq("empresa", EMPRESA);
      if (error) throw error;
      const set = new Set<string>();
      ((data || []) as Array<{ fornecedor_nome: string | null }>).forEach((r) => {
        if (r.fornecedor_nome) set.add(r.fornecedor_nome);
      });
      return Array.from(set).sort();
    },
  });

  const aguardandoRevisao = useMemo(
    () => campanhas.filter((c) => c.estado === "rascunho").length,
    [campanhas],
  );

  // Agrupa campanhas por mês (data_inicio), com meses vazios entre o mais antigo e o atual
  const grupos = useMemo(
    () => agruparPorMes(campanhas, (c) => c.data_inicio),
    [campanhas],
  );

  // Default: últimos 3 meses expandidos, demais recolhidos
  const [collapsedMeses, setCollapsedMeses] = useState<Record<string, boolean>>({});
  const ultimos3 = useMemo(() => chavesUltimosNMeses(3), []);
  const isCollapsed = useCallback(
    (chave: string) =>
      chave in collapsedMeses ? collapsedMeses[chave] : !ultimos3.has(chave),
    [collapsedMeses, ultimos3],
  );
  const toggleMes = useCallback((chave: string) => {
    setCollapsedMeses((prev) => ({ ...prev, [chave]: !(prev[chave] ?? false) }));
  }, []);

  // ============ UPLOAD MULTIPLO ============
  const upload = useUploadPromocoes(() => qc.invalidateQueries({ queryKey: ["promocao-campanhas"] }));

  const fecharModal = () => {
    if (upload.processando) return;
    setUploadOpen(false);
    upload.resetUpload();
  };

  const irParaLista = () => {
    if (upload.concluidos > 0) {
      toast.success(
        `${upload.concluidos} ${upload.concluidos === 1 ? "campanha criada" : "campanhas criadas"}`,
      );
    }
    setUploadOpen(false);
    upload.resetUpload();
    qc.invalidateQueries({ queryKey: ["promocao-campanhas"] });
  };

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <Percent className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Promoções</h1>
            <p className="text-sm text-muted-foreground">
              Campanhas promocionais de fornecedores e negociações com clientes
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="h-4 w-4" /> Upload PDF/imagem
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              navigate("/admin/reposicao/promocoes/novo?tipo=fornecedor_impoe")
            }
          >
            <FilePlus className="h-4 w-4" /> Cadastro manual
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              navigate("/admin/reposicao/promocoes/novo?tipo=negociacao_cliente")
            }
          >
            <Handshake className="h-4 w-4" /> Nova negociação
          </Button>
        </div>
      </header>

      {/* Alerta de campanhas aguardando revisão */}
      {aguardandoRevisao > 0 && filtroEstado !== "rascunho" && (
        <Card className="border-status-warning/40 bg-status-warning/5">
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-status-warning" />
              <div>
                <p className="font-medium">
                  {aguardandoRevisao}{" "}
                  {aguardandoRevisao === 1
                    ? "campanha aguardando revisão"
                    : "campanhas aguardando revisão"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Itens em rascunho precisam de confirmação de SKU antes de ativar.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFiltroEstado("rascunho")}
            >
              Ver rascunhos
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Campanhas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <CampanhasFiltros
            filtroEstado={filtroEstado}
            setFiltroEstado={setFiltroEstado}
            filtroFornecedor={filtroFornecedor}
            setFiltroFornecedor={setFiltroFornecedor}
            busca={busca}
            setBusca={setBusca}
            fornecedores={fornecedores}
          />

          <CampanhasTable
            isLoading={isLoading}
            grupos={grupos}
            isCollapsed={isCollapsed}
            toggleMes={toggleMes}
            onOpenUpload={() => setUploadOpen(true)}
            onNavigate={(id) => navigate(`/admin/reposicao/promocoes/${id}`)}
          />
        </CardContent>
      </Card>

      {/* Modal de Upload — múltiplos arquivos */}
      <UploadDialog
        open={uploadOpen}
        onOpenChange={(o) => (o ? setUploadOpen(true) : fecharModal())}
        upload={upload}
        onIrParaLista={irParaLista}
        onCancelar={fecharModal}
      />
    </div>
  );
}
