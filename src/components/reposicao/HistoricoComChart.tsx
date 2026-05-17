import { lazy, memo, Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import { toast } from "sonner";
import { CalendarRange, GitCompare, Loader2 } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { formatBRL, formatDate } from "@/lib/reposicao";
import { REPOSICAO_EMPRESA } from "@/hooks/useReposicaoSessao";
import { TabFallback } from "./TabFallback";

const AdminReposicaoHistorico = lazy(() => import("@/pages/AdminReposicaoHistorico"));

function useHistoricoChart() {
  const fim = useMemo(() => new Date(), []);
  const inicio = useMemo(() => subDays(fim, 60), [fim]);
  return useQuery({
    queryKey: ["cockpit-historico-chart", REPOSICAO_EMPRESA, format(fim, "yyyy-MM-dd")],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pedido_compra_sugerido")
        .select("data_ciclo,num_skus,valor_total")
        .eq("empresa", REPOSICAO_EMPRESA)
        .gte("data_ciclo", format(inicio, "yyyy-MM-dd"))
        .lte("data_ciclo", format(fim, "yyyy-MM-dd"));
      if (error) throw error;
      const rows = ((data ?? []) as unknown) as Array<{
        data_ciclo: string;
        num_skus: number | null;
        valor_total: number | null;
      }>;
      const map = new Map<string, { data: string; total: number; skus: number; valor: number }>();
      for (const r of rows) {
        const acc = map.get(r.data_ciclo) ?? {
          data: r.data_ciclo,
          total: 0,
          skus: 0,
          valor: 0,
        };
        acc.total += 1;
        acc.skus += Number(r.num_skus ?? 0);
        acc.valor += Number(r.valor_total ?? 0);
        map.set(r.data_ciclo, acc);
      }
      return Array.from(map.values())
        .sort((a, b) => a.data.localeCompare(b.data))
        .slice(-12)
        .map((x) => {
          const [, m, d] = x.data.split("-");
          return { ...x, label: `${d}/${m}` };
        });
    },
  });
}

type CompareRow = {
  fornecedor_nome: string;
  num_skus: number;
  valor_total: number;
};

type CompareDiff = {
  novos: CompareRow[];
  removidos: CompareRow[];
  alterados: Array<{
    fornecedor_nome: string;
    a: CompareRow;
    b: CompareRow;
    deltaQty: number;
    deltaVal: number;
  }>;
};

function CompareCyclesSection({ cycles }: { cycles: string[] }) {
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  const [diff, setDiff] = useState<CompareDiff | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchCycle = async (data_ciclo: string): Promise<CompareRow[]> => {
    const { data, error } = await supabase
      .from("pedido_compra_sugerido")
      .select("fornecedor_nome,num_skus,valor_total")
      .eq("empresa", REPOSICAO_EMPRESA)
      .eq("data_ciclo", data_ciclo);
    if (error) throw error;
    const rows = ((data ?? []) as unknown) as Array<{
      fornecedor_nome: string | null;
      num_skus: number | null;
      valor_total: number | null;
    }>;
    const map = new Map<string, CompareRow>();
    for (const r of rows) {
      const key = r.fornecedor_nome ?? "—";
      const acc = map.get(key) ?? { fornecedor_nome: key, num_skus: 0, valor_total: 0 };
      acc.num_skus += Number(r.num_skus ?? 0);
      acc.valor_total += Number(r.valor_total ?? 0);
      map.set(key, acc);
    }
    return Array.from(map.values());
  };

  const compare = async () => {
    if (!a || !b || a === b) {
      toast.error("Selecione dois ciclos diferentes");
      return;
    }
    setLoading(true);
    try {
      const [arows, brows] = await Promise.all([fetchCycle(a), fetchCycle(b)]);
      const amap = new Map(arows.map((r) => [r.fornecedor_nome, r]));
      const bmap = new Map(brows.map((r) => [r.fornecedor_nome, r]));
      const novos = brows.filter((r) => !amap.has(r.fornecedor_nome));
      const removidos = arows.filter((r) => !bmap.has(r.fornecedor_nome));
      const alterados: CompareDiff["alterados"] = [];
      for (const br of brows) {
        const ar = amap.get(br.fornecedor_nome);
        if (!ar) continue;
        if (ar.num_skus !== br.num_skus || ar.valor_total !== br.valor_total) {
          alterados.push({
            fornecedor_nome: br.fornecedor_nome,
            a: ar,
            b: br,
            deltaQty: br.num_skus - ar.num_skus,
            deltaVal: br.valor_total - ar.valor_total,
          });
        }
      }
      setDiff({ novos, removidos, alterados });
    } catch {
      toast.error("Falha ao comparar ciclos");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="py-3">
        <div className="flex items-center gap-2">
          <GitCompare className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Comparar ciclos</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={a} onValueChange={setA}>
            <SelectTrigger className="w-[180px] h-9">
              <SelectValue placeholder="Ciclo A" />
            </SelectTrigger>
            <SelectContent>
              {cycles.map((c) => (
                <SelectItem key={c} value={c}>
                  {formatDate(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={b} onValueChange={setB}>
            <SelectTrigger className="w-[180px] h-9">
              <SelectValue placeholder="Ciclo B" />
            </SelectTrigger>
            <SelectContent>
              {cycles.map((c) => (
                <SelectItem key={c} value={c}>
                  {formatDate(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={compare} disabled={loading || !a || !b}>
            {loading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
            Comparar
          </Button>
        </div>

        {diff && (
          <div className="space-y-3">
            <div>
              <div className="text-xs font-semibold text-status-success mb-1">
                Novos no Ciclo B ({diff.novos.length})
              </div>
              {diff.novos.length === 0 ? (
                <div className="text-xs text-muted-foreground">Nenhum.</div>
              ) : (
                <div className="rounded-md border bg-status-success-bg/40 divide-y">
                  {diff.novos.map((r) => (
                    <div key={r.fornecedor_nome} className="px-3 py-1.5 text-sm flex justify-between">
                      <span>{r.fornecedor_nome}</span>
                      <span className="text-muted-foreground">
                        {r.num_skus} SKUs · {formatBRL(r.valor_total)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="text-xs font-semibold text-destructive mb-1">
                Removidos vs Ciclo A ({diff.removidos.length})
              </div>
              {diff.removidos.length === 0 ? (
                <div className="text-xs text-muted-foreground">Nenhum.</div>
              ) : (
                <div className="rounded-md border bg-destructive/5 divide-y">
                  {diff.removidos.map((r) => (
                    <div key={r.fornecedor_nome} className="px-3 py-1.5 text-sm flex justify-between">
                      <span>{r.fornecedor_nome}</span>
                      <span className="text-muted-foreground">
                        {r.num_skus} SKUs · {formatBRL(r.valor_total)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="text-xs font-semibold text-status-warning mb-1">
                Alterados ({diff.alterados.length})
              </div>
              {diff.alterados.length === 0 ? (
                <div className="text-xs text-muted-foreground">Nenhum.</div>
              ) : (
                <div className="rounded-md border bg-status-warning-bg divide-y">
                  {diff.alterados.map((r) => (
                    <div key={r.fornecedor_nome} className="px-3 py-1.5 text-sm flex justify-between gap-2">
                      <span>{r.fornecedor_nome}</span>
                      <span className="text-xs text-muted-foreground">
                        Δ SKUs: {r.deltaQty > 0 ? "+" : ""}
                        {r.deltaQty} · Δ valor: {r.deltaVal >= 0 ? "+" : ""}
                        {formatBRL(r.deltaVal)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HistoricoComChartImpl() {
  const { data = [], isLoading } = useHistoricoChart();
  const cycles = useMemo(() => data.map((d) => d.data).reverse(), [data]);
  return (
    <div className="space-y-4">
      <CompareCyclesSection cycles={cycles} />
      <Card>
        <CardHeader className="py-3">
          <div className="flex items-center gap-2">
            <CalendarRange className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Últimos 12 ciclos</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TabFallback />
          ) : data.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Sem ciclos no período.
            </div>
          ) : (
            <div className="h-[220px] w-full">
              <ResponsiveContainer>
                <BarChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="label" className="text-xs" />
                  <YAxis className="text-xs" />
                  <ReTooltip
                    formatter={(value: number, name: string) => {
                      if (name === "valor") return [formatBRL(value), "Valor"];
                      if (name === "skus") return [value, "SKUs"];
                      return [value, name];
                    }}
                    labelFormatter={(l) => `Ciclo ${l}`}
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const p = payload[0].payload as {
                        label: string;
                        total: number;
                        skus: number;
                        valor: number;
                      };
                      return (
                        <div className="rounded-md border bg-popover p-2 text-xs shadow-md">
                          <div className="font-medium mb-1">{label}</div>
                          <div>Total pedidos: {p.total}</div>
                          <div>SKUs: {p.skus}</div>
                          <div>Valor: {formatBRL(p.valor)}</div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="total" className="fill-primary" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Suspense fallback={<TabFallback />}>
        <AdminReposicaoHistorico />
      </Suspense>
    </div>
  );
}


export const HistoricoComChart = memo(HistoricoComChartImpl);
