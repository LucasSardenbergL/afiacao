import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronLeft, ChevronRight, ArrowLeft, Loader2 } from "lucide-react";

const PAGE_SIZE = 50;

type Hist = {
  id: string;
  sku_parametro_id: string;
  snapshot_em: string;
  classe_consolidada: string | null;
  demanda_media_diaria: number | null;
  lt_medio_dias_uteis: number | null;
  estoque_seguranca: number | null;
  ponto_pedido: number | null;
  trigger: string | null;
  sku?: { sku_codigo_omie: number; sku_descricao: string | null; aprovado_por: string | null } | null;
};

const fmt = (v: number | null | undefined, dec = 2) =>
  v == null ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });

const triggerVariant = (t: string | null) => {
  if (t === "aprovacao_humana") return "default";
  if (t === "edicao_manual") return "destructive";
  return "secondary";
};

const triggerLabel = (t: string | null) => {
  if (t === "aprovacao_humana") return "Aprovação humana";
  if (t === "edicao_manual") return "Edição manual";
  return t ?? "—";
};

export default function AdminReposicaoHistorico() {
  const [page, setPage] = useState(0);

  const { data, isLoading } = useQuery({
    queryKey: ["sku_param_historico", page],
    queryFn: async () => {
      const { data, error, count } = await supabase
        .from("sku_parametros_historico")
        .select(
          `id, sku_parametro_id, snapshot_em, classe_consolidada,
           demanda_media_diaria, lt_medio_dias_uteis, estoque_seguranca,
           ponto_pedido, trigger,
           sku:sku_parametros!sku_parametros_historico_sku_parametro_id_fkey(sku_codigo_omie, sku_descricao, aprovado_por)`,
          { count: "exact" }
        )
        .order("snapshot_em", { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data ?? []) as unknown as Hist[], total: count ?? 0 };
    },
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1">
            <Link to="/admin/reposicao/revisao">
              <ArrowLeft className="mr-1 h-4 w-4" /> Voltar à revisão
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold">Histórico de alterações</h1>
          <p className="text-sm text-muted-foreground">
            Registros automáticos de alterações em parâmetros de reposição.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {total} alteração(ões) — página {page + 1} de {totalPages}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Classe</TableHead>
                  <TableHead className="text-right">D/dia</TableHead>
                  <TableHead className="text-right">LT</TableHead>
                  <TableHead className="text-right">EM</TableHead>
                  <TableHead className="text-right">PP</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead>Usuário</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {new Date(r.snapshot_em).toLocaleString("pt-BR")}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.sku?.sku_codigo_omie ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-xs">
                      {r.sku?.sku_descricao ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.classe_consolidada ?? "—"}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{fmt(r.demanda_media_diaria)}</TableCell>
                    <TableCell className="text-right">{fmt(r.lt_medio_dias_uteis, 1)}</TableCell>
                    <TableCell className="text-right">{fmt(r.estoque_seguranca, 0)}</TableCell>
                    <TableCell className="text-right">{fmt(r.ponto_pedido, 0)}</TableCell>
                    <TableCell>
                      <Badge variant={triggerVariant(r.trigger) as any}>
                        {triggerLabel(r.trigger)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{r.sku?.aprovado_por ?? "—"}</TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                      Sem alterações registradas ainda.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}

          <div className="flex items-center justify-end gap-2 pt-4">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground">
              {page + 1}/{totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
