import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Shield,
  CheckCircle2,
  FileBarChart,
  RefreshCw,
  ClipboardList,
  Building2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";

const AdminPanel = lazy(() => import("./Admin"));
const AdminMonthlyReports = lazy(() => import("./AdminMonthlyReports"));
const AdminAnalyticsSync = lazy(() => import("./AdminAnalyticsSync"));

const TabFallback = () => <PageSkeleton variant="auto" />;

const safeQuery = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

function KpiCards({ empresa }: { empresa: string }) {
  void empresa;

  const { data } = useQuery({
    queryKey: ["gestao-admin-kpis", empresa],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = supabase as any;

      const countWhere = (table: string, col?: string, val?: string) =>
        safeQuery(async () => {
          let q = client.from(table).select("id", { count: "exact", head: true });
          if (col && val) q = q.eq(col, val);
          const { count } = await q;
          return count ?? 0;
        }, 0);

      const [aprovacoes, relatorios, syncs, pendencias] = await Promise.all([
        countWhere("admin_approvals", "status", "pending"),
        countWhere("admin_reports"),
        countWhere("admin_sync_runs"),
        countWhere("admin_tasks", "status", "open"),
      ]);

      return { aprovacoes, relatorios, syncs, pendencias };
    },
  });

  const cards = [
    { label: "Aprovações Pendentes", value: data?.aprovacoes ?? 0, icon: CheckCircle2 },
    { label: "Relatórios Gerados", value: data?.relatorios ?? 0, icon: FileBarChart },
    { label: "Syncs Realizados", value: data?.syncs ?? 0, icon: RefreshCw },
    { label: "Pendências Admin", value: data?.pendencias ?? 0, icon: ClipboardList },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c) => (
        <Card key={c.label} className="border-border">
          <CardContent className="pt-4 flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className="text-2xl font-bold mt-1">{c.value}</div>
            </div>
            <c.icon className="h-8 w-8 text-muted-foreground opacity-60" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function GestaoAdmin() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "painel";
  const [empresa, setEmpresa] = useState("OBEN");

  const handleTab = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", v);
    setParams(next, { replace: true });
  };

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <header className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <Shield className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Admin e Relatórios</h1>
            <p className="text-sm text-muted-foreground">
              Painel administrativo, relatórios mensais e analytics de sincronização.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <Select value={empresa} onValueChange={setEmpresa}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Empresa" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="OBEN">OBEN</SelectItem>
              <SelectItem value="COLACOR">COLACOR</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </header>

      <KpiCards empresa={empresa} />

      <Tabs value={tab} onValueChange={handleTab} className="space-y-4">
        <TabsList className="grid grid-cols-3 w-full">
          <TabsTrigger value="painel">Painel</TabsTrigger>
          <TabsTrigger value="relatorios">Relatórios</TabsTrigger>
          <TabsTrigger value="analytics">Analytics e Sync</TabsTrigger>
        </TabsList>

        <TabsContent value="painel" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminPanel />
          </Suspense>
        </TabsContent>
        <TabsContent value="relatorios" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminMonthlyReports />
          </Suspense>
        </TabsContent>
        <TabsContent value="analytics" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminAnalyticsSync />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
