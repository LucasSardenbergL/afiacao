import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { spDayRangeUtc } from "@/lib/time/sp-day";
import {
  PackageCheck,
  FileWarning,
  Truck,
  CheckCircle2,
  Inbox,
  Building2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import {
  estadoDeLeitura,
  naoConsegui,
  type EstadoLeitura,
} from "@/lib/leitura/estado-de-leitura";
import { AvisoLeituraFalhou } from "@/components/leitura/AvisoLeituraFalhou";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const Recebimento = lazy(() => import("./Recebimento"));
const NfeReceipt = lazy(() => import("./NfeReceipt"));

const WAREHOUSE_BY_EMPRESA: Record<string, string> = {
  OBEN: "850960ad-b527-43d7-ba3c-f4f20f9412d2",
  COLACOR: "b6d3569b-5952-4547-a118-4ddfe0a85ba3",
};

const TabFallback = () => <PageSkeleton variant="auto" />;

/** Teto de linhas da soma do valor em trânsito: o PostgREST corta em 1.000 SEM avisar. */
const TETO_TRANSITO = 1000;

/**
 * Soma do valor em trânsito que NÃO fabrica: NF-e com `valor_total` nulo não vira R$ 0 somado
 * calado — ela é contada à parte, e a soma passa a ser PARCIAL (um piso, não o total). O mesmo
 * vale para o corte do PostgREST: a página cheia no teto pode ter deixado linhas de fora.
 */
function somarValorTransito(
  linhas: ReadonlyArray<{ valor_total: number | null }>,
  teto = TETO_TRANSITO,
): { total: number; nfsSemValor: number; truncado: boolean } {
  let total = 0;
  let nfsSemValor = 0;
  for (const r of linhas) {
    if (r.valor_total == null || !Number.isFinite(Number(r.valor_total))) nfsSemValor += 1;
    else total += Number(r.valor_total);
  }
  return { total, nfsSemValor, truncado: linhas.length >= teto };
}

type Tom = { tone: string; border: string };

/**
 * Um card, três estados que NÃO se confundem (docs/historico/fase-sem-sinal.md):
 *  - carregando → esqueleto; nunca "0" (o zero do 1º paint era lido como fato);
 *  - sem leitura (erro/sem rede) → "—" tracejado + "Indisponível", sem a cor do zero;
 *  - pronta → o número observado, e aí sim o zero é verdade.
 */
function CardKpi({
  id,
  label,
  icon: Icon,
  estado,
  valor,
  tom,
  nota,
}: {
  id: string;
  label: string;
  icon: typeof Inbox;
  estado: EstadoLeitura;
  valor: string | number | null;
  tom: Tom;
  nota?: string | null;
}) {
  const semLeitura = naoConsegui(estado);
  const pronta = estado === "pronta" && valor != null;
  const tone = pronta ? tom.tone : "text-muted-foreground/60";
  const border = semLeitura ? "border-dashed border-border" : pronta ? tom.border : "border-border";
  return (
    <Card className={border} data-testid={`kpi-receb-${id}`} data-estado={pronta ? "pronta" : estado}>
      <CardContent className="pt-4 flex items-center justify-between">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          {pronta ? (
            <div className={`text-2xl font-bold mt-1 ${tone}`}>{valor}</div>
          ) : semLeitura ? (
            <>
              <div className={`text-2xl font-bold mt-1 ${tone}`}>—</div>
              <div className="text-[11px] text-status-warning">Indisponível</div>
            </>
          ) : (
            <Skeleton className="h-8 w-16 mt-1" aria-label={`Carregando ${label}`} />
          )}
          {pronta && nota && <div className="text-[11px] text-status-warning">{nota}</div>}
        </div>
        <Icon className={`h-8 w-8 ${tone} opacity-60`} />
      </CardContent>
    </Card>
  );
}

const NEUTRO: Tom = { tone: "text-muted-foreground", border: "border-border" };
const tomContagem = (n: number | undefined, tone: string, border: string): Tom =>
  (n ?? 0) > 0 ? { tone, border } : NEUTRO;

function KpiCards({ empresa }: { empresa: string }) {
  const warehouseId = WAREHOUSE_BY_EMPRESA[empresa];

  // As 4 queries LANÇAM: sem o `throw`, a falha virava `count ?? 0` / `data ?? []` e a query
  // ficava `success` com zero — "0 divergências" e "R$ 0,00 em trânsito" ditos como fato.
  const pendentesQuery = useQuery({
    queryKey: ["estoque-receb-pendentes", warehouseId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("nfe_recebimentos")
        .select("*", { count: "exact", head: true })
        .eq("warehouse_id", warehouseId)
        .in("status", ["pendente", "em_conferencia"]);
      if (error) throw error;
      // count nulo sem erro = o PostgREST não contou: ausência, não zero.
      if (count == null) throw new Error("contagem de NF-e pendentes não retornada");
      return count;
    },
    refetchInterval: 60000,
  });

  const divergenciasQuery = useQuery({
    queryKey: ["estoque-receb-divergencias", warehouseId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("nfe_recebimentos")
        .select("*", { count: "exact", head: true })
        .eq("warehouse_id", warehouseId)
        .eq("status", "divergencia");
      if (error) throw error;
      if (count == null) throw new Error("contagem de divergências não retornada");
      return count;
    },
    refetchInterval: 60000,
  });

  const valorTransitoQuery = useQuery({
    queryKey: ["estoque-receb-valor-transito", warehouseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("nfe_recebimentos")
        .select("valor_total")
        .eq("warehouse_id", warehouseId)
        .in("status", ["pendente", "em_conferencia", "divergencia"])
        .range(0, TETO_TRANSITO - 1);
      if (error) throw error;
      return somarValorTransito(data ?? []);
    },
    refetchInterval: 60000,
  });

  const efetivadasHojeQuery = useQuery({
    queryKey: ["estoque-receb-efetivadas-hoje", warehouseId],
    queryFn: async () => {
      // Por efetivado_at (momento da efetivação), não data_emissao (data da nota no fornecedor).
      // Janela [início, fim) do dia em America/Sao_Paulo (recalculada a cada refetch → robusta à virada de dia).
      const { startUtc, endUtc } = spDayRangeUtc();
      const { count, error } = await supabase
        .from("nfe_recebimentos")
        .select("*", { count: "exact", head: true })
        .eq("warehouse_id", warehouseId)
        .eq("status", "efetivado")
        .gte("efetivado_at", startUtc)
        .lt("efetivado_at", endUtc);
      if (error) throw error;
      if (count == null) throw new Error("contagem de NF-e efetivadas hoje não retornada");
      return count;
    },
    refetchInterval: 60000,
  });

  const fmtBRL = (v: number) =>
    v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const estados = [
    estadoDeLeitura(pendentesQuery),
    estadoDeLeitura(divergenciasQuery),
    estadoDeLeitura(valorTransitoQuery),
    estadoDeLeitura(efetivadasHojeQuery),
  ] as const;
  const [estadoPendentes, estadoDivergencias, estadoTransito, estadoEfetivadas] = estados;
  // Um card mudo já tira o painel da condição de base de decisão; `sem-rede` tem precedência
  // na mensagem por ser a única causa sobre a qual o usuário pode agir (mesmo critério do Picking).
  const semLeitura = estados.filter(naoConsegui);
  const estadoBloco = semLeitura.find((e) => e === "sem-rede") ?? semLeitura[0];

  const pendentes = pendentesQuery.data;
  const divergencias = divergenciasQuery.data;
  const transito = valorTransitoQuery.data;
  const efetivadasHoje = efetivadasHojeQuery.data;

  // Soma parcial é PISO: "≥ R$ X" + o porquê, nunca o total afirmado.
  const transitoParcial = !!transito && (transito.nfsSemValor > 0 || transito.truncado);
  const notaTransito = !transito
    ? null
    : transito.truncado
      ? `Soma parcial — mais de ${TETO_TRANSITO} NF-e em trânsito`
      : transito.nfsSemValor > 0
        ? `Soma parcial — ${transito.nfsSemValor} NF-e sem valor`
        : null;

  return (
    <div className="space-y-3">
      {estadoBloco && (
        <AvisoLeituraFalhou
          oque="os indicadores de recebimento"
          estado={estadoBloco}
          testId="aviso-receb-kpis"
        />
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <CardKpi
          id="pendentes"
          label="NF-es Pendentes"
          icon={Inbox}
          estado={estadoPendentes}
          valor={pendentes ?? null}
          tom={tomContagem(pendentes, "text-warning", "border-warning/40")}
        />
        <CardKpi
          id="divergencias"
          label="Divergências"
          icon={FileWarning}
          estado={estadoDivergencias}
          valor={divergencias ?? null}
          tom={tomContagem(divergencias, "text-destructive", "border-destructive/40")}
        />
        <CardKpi
          id="transito"
          label="Valor em Trânsito"
          icon={Truck}
          estado={estadoTransito}
          valor={transito ? `${transitoParcial ? "≥ " : ""}${fmtBRL(transito.total)}` : null}
          tom={{ tone: "text-primary", border: "border-border" }}
          nota={notaTransito}
        />
        <CardKpi
          id="efetivadas"
          label="Efetivadas Hoje"
          icon={CheckCircle2}
          estado={estadoEfetivadas}
          valor={efetivadasHoje ?? null}
          tom={tomContagem(efetivadasHoje, "text-success", "border-success/40")}
        />
      </div>
    </div>
  );
}

export default function AdminEstoqueRecebimento() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "nfes";
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
          <PackageCheck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Recebimento de NF-e</h1>
            <p className="text-sm text-muted-foreground">
              Conferência, histórico e processamento de notas fiscais de entrada.
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
        <TabsList className="grid grid-cols-2 sm:grid-cols-4 w-full">
          <TabsTrigger value="nfes">NF-es</TabsTrigger>
          <TabsTrigger value="conferencia">Em Conferência</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
          <TabsTrigger value="manual">Manual</TabsTrigger>
        </TabsList>

        <TabsContent value="nfes" className="m-0">
          <Suspense fallback={<TabFallback />}>
            {/* falha_efetivacao/efetivacao_parcial entram aqui (NFs que precisam de ação) — A1 as produz */}
            <Recebimento statusFilter={['pendente', 'divergencia', 'falha_efetivacao', 'efetivacao_parcial']} />
          </Suspense>
        </TabsContent>

        <TabsContent value="conferencia" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <Recebimento key="conferencia" statusFilter={['em_conferencia']} />
          </Suspense>
        </TabsContent>

        <TabsContent value="historico" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <Recebimento key="historico" statusFilter={['efetivado', 'conferido']} />
          </Suspense>
        </TabsContent>

        <TabsContent value="manual" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <NfeReceipt />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
