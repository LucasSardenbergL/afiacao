import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ShieldCheck,
  Users,
  KeyRound,
  Sliders,
  ScrollText,
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

const GovernanceUsers = lazy(() => import("./GovernanceUsers"));
const GovernancePermissions = lazy(() => import("./GovernancePermissions"));
const GovernanceMath = lazy(() => import("./GovernanceMathParams"));
const GovernanceAudit = lazy(() => import("./GovernanceAudit"));
const GovernanceIniciativas = lazy(() => import("./GovernanceIniciativas"));
const Settings = lazy(() => import("./SettingsConfig"));

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
    queryKey: ["gestao-governanca-kpis", empresa],
    queryFn: async () => {
      type HeadCountBuilder = PromiseLike<{ count: number | null }> & {
        eq(column: string, value: string | number | boolean | undefined): HeadCountBuilder;
      };
      const client = supabase as unknown as {
        from(table: string): {
          select(columns: string, options: { count: "exact"; head: true }): HeadCountBuilder;
        };
      };

      const countWhere = (table: string, col?: string, val?: string | number | boolean) =>
        safeQuery(async () => {
          let q = client.from(table).select("id", { count: "exact", head: true });
          if (col !== undefined) q = q.eq(col, val);
          const { count } = await q;
          return count ?? 0;
        }, 0);

      const [usuarios, permissoes, parametros, auditoria] = await Promise.all([
        countWhere("governance_users", "active", true),
        countWhere("governance_permissions"),
        countWhere("governance_math_params"),
        countWhere("governance_audit_logs"),
      ]);

      return { usuarios, permissoes, parametros, auditoria };
    },
  });

  const cards = [
    { label: "Usuários Ativos", value: data?.usuarios ?? 0, icon: Users },
    { label: "Permissões Definidas", value: data?.permissoes ?? 0, icon: KeyRound },
    { label: "Parâmetros Configurados", value: data?.parametros ?? 0, icon: Sliders },
    { label: "Eventos Auditoria", value: data?.auditoria ?? 0, icon: ScrollText },
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

export default function GestaoGovernanca() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "usuarios";
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
          <ShieldCheck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Governança</h1>
            <p className="text-sm text-muted-foreground">
              Usuários, permissões, parâmetros, auditoria e configurações do sistema.
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
        <TabsList className="grid grid-cols-2 sm:grid-cols-6 w-full">
          <TabsTrigger value="usuarios">Usuários</TabsTrigger>
          <TabsTrigger value="permissoes">Permissões</TabsTrigger>
          <TabsTrigger value="parametros">Parâmetros</TabsTrigger>
          <TabsTrigger value="auditoria">Auditoria</TabsTrigger>
          <TabsTrigger value="iniciativas">Iniciativas</TabsTrigger>
          <TabsTrigger value="configuracoes">Configurações</TabsTrigger>
        </TabsList>

        <TabsContent value="usuarios" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <GovernanceUsers />
          </Suspense>
        </TabsContent>
        <TabsContent value="permissoes" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <GovernancePermissions />
          </Suspense>
        </TabsContent>
        <TabsContent value="parametros" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <GovernanceMath />
          </Suspense>
        </TabsContent>
        <TabsContent value="auditoria" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <GovernanceAudit />
          </Suspense>
        </TabsContent>
        <TabsContent value="iniciativas" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <GovernanceIniciativas />
          </Suspense>
        </TabsContent>
        <TabsContent value="configuracoes" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <Settings />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
