import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Star, Info } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Props {
  empresa: string;
  ano: number;
  trimestre: number;
}

const fmtBRL = (v: number | null | undefined) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("pt-BR") : "—";

interface PosicaoRow {
  empresa: string;
  ano: number;
  trimestre: number;
  gooddata_data_referencia: string | null;
  gooddata_objetivo: number | null;
  fat_bruto_confirmado: number | null;
  gooddata_pedidos_abertos: number | null;
  meta_pessoal: number | null;
  faixa_des_alvo: number | null;
  valor_em_transito_seguro: number | null;
  valor_em_transito_risco: number | null;
  valor_fora_trimestre: number | null;
  qtd_pedidos_no_trimestre: number | null;
  qtd_pedidos_fora_trimestre: number | null;
  posicao_ao_vivo_conservadora: number | null;
  posicao_ao_vivo_otimista: number | null;
  faixa_conservadora: { faixa_numero?: number; estrelas?: number } | null;
  faixa_otimista: { faixa_numero?: number; estrelas?: number } | null;
  gap_para_meta_pessoal: number | null;
  inicio_trimestre: string | null;
  fim_trimestre: string | null;
  dias_restantes: number | null;
}

interface PedidoTransito {
  pedido_id: number;
  empresa: string;
  fornecedor_nome: string | null;
  grupo_codigo: string | null;
  data_emissao: string | null;
  data_faturamento_prevista: string | null;
  valor_total: number | null;
  status: string | null;
  zona_confianca: "verde" | "amarelo" | "vermelho" | "fora_trimestre" | string | null;
  fatura_no_trimestre: boolean | null;
}

interface SnapshotRow {
  id: number;
  data_referencia: string;
  fat_bruto_valor: number | null;
  pedidos_abertos_valor: number | null;
  objetivo_valor: number | null;
  criado_em: string;
}

function StarsDisplay({ count, max = 6 }: { count: number; max?: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: max }).map((_, i) => (
        <Star
          key={i}
          className={cn(
            "h-4 w-4",
            i < count ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"
          )}
        />
      ))}
    </div>
  );
}

function ZonaConfiancaBadge({ zona }: { zona: string | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    verde: { label: "Segura", cls: "bg-green-500/10 text-green-700 border-green-500/30" },
    amarelo: { label: "Atenção", cls: "bg-amber-500/10 text-amber-700 border-amber-500/30" },
    vermelho: { label: "Risco", cls: "bg-red-500/10 text-red-700 border-red-500/30" },
    fora_trimestre: { label: "Fora trimestre", cls: "bg-muted text-muted-foreground border-border" },
  };
  const cfg = map[zona ?? ""] ?? { label: zona ?? "—", cls: "bg-muted text-muted-foreground" };
  return <Badge variant="outline" className={cn("text-xs", cfg.cls)}>{cfg.label}</Badge>;
}

export function PosicaoAtualTab({ empresa, ano, trimestre }: Props) {
  const navigate = useNavigate();
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);

  const posQuery = useQuery({
    queryKey: ["des-posicao", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_posicao_trimestre_ao_vivo" as any)
        .select("*")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .maybeSingle();
      if (error) throw error;
      return data as PosicaoRow | null;
    },
  });

  const transitoQuery = useQuery({
    queryKey: ["des-transito", empresa, ano, trimestre, posQuery.data?.gooddata_data_referencia],
    enabled: !!posQuery.data,
    queryFn: async () => {
      let q = supabase
        .from("v_des_pedidos_em_transito" as any)
        .select("*")
        .eq("empresa", empresa);
      if (posQuery.data?.gooddata_data_referencia) {
        q = q.gt("data_emissao", posQuery.data.gooddata_data_referencia);
      }
      const { data, error } = await q.order("data_emissao", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PedidoTransito[];
    },
  });

  const snapshotsQuery = useQuery({
    queryKey: ["des-snapshots", empresa, ano, trimestre],
    enabled: snapshotsOpen,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("des_trimestre_snapshot")
        .select("id, data_referencia, fat_bruto_valor, pedidos_abertos_valor, objetivo_valor, criado_em")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .order("data_referencia", { ascending: false });
      if (error) throw error;
      return (data ?? []) as SnapshotRow[];
    },
  });

  const pos = posQuery.data;

  const transitoStats = useMemo(() => {
    const list = transitoQuery.data ?? [];
    const sum = (filterFn: (p: PedidoTransito) => boolean) =>
      list.filter(filterFn).reduce((acc, p) => acc + Number(p.valor_total ?? 0), 0);
    return {
      total: list.length,
      totalValor: sum(() => true),
      seguro: sum((p) => p.zona_confianca === "verde" && p.fatura_no_trimestre !== false),
      risco: sum((p) => (p.zona_confianca === "amarelo" || p.zona_confianca === "vermelho") && p.fatura_no_trimestre !== false),
      foraTrimestre: sum((p) => p.fatura_no_trimestre === false || p.zona_confianca === "fora_trimestre"),
    };
  }, [transitoQuery.data]);

  if (posQuery.isLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
    );
  }

  if (!pos) {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <p className="text-sm text-muted-foreground">
            Nenhum dado disponível para {empresa} · T{trimestre}/{ano}.
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            Configure a meta trimestral e o snapshot do GoodData para ver a posição ao vivo.
          </p>
        </CardContent>
      </Card>
    );
  }

  const conserv = Number(pos.posicao_ao_vivo_conservadora ?? 0);
  const otim = Number(pos.posicao_ao_vivo_otimista ?? 0);
  const meta = Number(pos.meta_pessoal ?? 0);
  const progress = meta > 0 ? Math.min((conserv / meta) * 100, 100) : 0;
  const progressColor =
    progress >= 100 ? "bg-green-500" : progress >= 75 ? "bg-amber-500" : "bg-red-500";

  const faixaConserv = pos.faixa_conservadora?.estrelas ?? 0;
  const faixaOtim = pos.faixa_otimista?.estrelas ?? 0;

  const dias = pos.dias_restantes ?? 0;
  const diasBadge =
    dias < 10 ? "destructive" : dias < 20 ? "default" : "secondary";
  const diasCls =
    dias < 10
      ? "bg-red-500/10 text-red-700 border-red-500/30"
      : dias < 20
        ? "bg-amber-500/10 text-amber-700 border-amber-500/30"
        : "bg-green-500/10 text-green-700 border-green-500/30";

  return (
    <TooltipProvider>
      {/* LINHA 1 - Cards principais */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Posição ao vivo */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Posição ao vivo
              </CardTitle>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="text-xs">
                    <strong>Conservador</strong> = faturado GoodData + pedidos com folga temporal segura.{" "}
                    <strong>Otimista</strong> adiciona pedidos em zona amarela/vermelha.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-green-600">{fmtBRL(conserv)}</p>
            <p className="text-xs text-muted-foreground mt-1.5">
              + {fmtBRL(pos.valor_em_transito_risco)} em pedidos de risco ={" "}
              <span className="font-medium text-foreground">{fmtBRL(otim)}</span> otimista
            </p>
          </CardContent>
        </Card>

        {/* Card 2: Meta pessoal */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Meta pessoal
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground">{fmtBRL(meta)}</p>
            <div className="mt-2 space-y-1.5">
              <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className={cn("h-full transition-all", progressColor)}
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {pos.gap_para_meta_pessoal != null && Number(pos.gap_para_meta_pessoal) > 0
                  ? `Faltam ${fmtBRL(pos.gap_para_meta_pessoal)}`
                  : "Meta atingida! 🎯"}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Card 3: Faixa DES */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Faixa DES atingida
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <p className="text-2xl font-bold text-foreground">{faixaConserv}</p>
              <span className="text-sm text-muted-foreground">estrelas</span>
            </div>
            <div className="mt-2">
              <StarsDisplay count={faixaConserv} />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="text-xs text-muted-foreground mt-1.5 cursor-help">
                  (Faixa conservadora){" "}
                  {faixaOtim !== faixaConserv && (
                    <span className="text-amber-600 font-medium">· otim. {faixaOtim}★</span>
                  )}
                </p>
              </TooltipTrigger>
              {faixaOtim !== faixaConserv && (
                <TooltipContent>
                  <p className="text-xs">Faixa otimista: {faixaOtim} estrelas</p>
                </TooltipContent>
              )}
            </Tooltip>
          </CardContent>
        </Card>

        {/* Card 4: Dias restantes */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Dias restantes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <Badge variant="outline" className={cn("text-2xl font-bold px-3 py-1", diasCls)}>
                {dias}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Trimestre termina em {fmtDate(pos.fim_trimestre)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* LINHA 2 - Pedidos em trânsito */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pedidos em trânsito</CardTitle>
          <p className="text-xs text-muted-foreground">
            Desde o último snapshot GoodData ({fmtDate(pos.gooddata_data_referencia)})
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mt-2">
            <span>
              <strong className="text-foreground">{transitoStats.total}</strong> pedidos totalizando{" "}
              <strong className="text-foreground">{fmtBRL(transitoStats.totalValor)}</strong>
            </span>
            <span>
              · <strong className="text-green-700">{fmtBRL(transitoStats.seguro)}</strong> em zona segura
            </span>
            <span>
              · <strong className="text-amber-700">{fmtBRL(transitoStats.risco)}</strong> em zona de risco
            </span>
            <span>
              · <strong className="text-muted-foreground">{fmtBRL(transitoStats.foraTrimestre)}</strong>{" "}
              previsto fora do trimestre
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {transitoQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (transitoQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              Nenhum pedido em trânsito desde o último snapshot.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pedido</TableHead>
                    <TableHead>Emissão</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                    <TableHead>Grupo</TableHead>
                    <TableHead>Faturamento prev.</TableHead>
                    <TableHead>Zona</TableHead>
                    <TableHead>Status Omie</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(transitoQuery.data ?? []).map((p) => (
                    <TableRow key={p.pedido_id}>
                      <TableCell>
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-xs"
                          onClick={() => navigate(`/admin/reposicao/pedidos/${p.pedido_id}`)}
                        >
                          #{p.pedido_id}
                        </Button>
                      </TableCell>
                      <TableCell className="text-xs">{fmtDate(p.data_emissao)}</TableCell>
                      <TableCell className="text-right text-xs font-medium">
                        {fmtBRL(p.valor_total)}
                      </TableCell>
                      <TableCell className="text-xs">{p.grupo_codigo ?? "—"}</TableCell>
                      <TableCell className="text-xs">{fmtDate(p.data_faturamento_prevista)}</TableCell>
                      <TableCell>
                        <ZonaConfiancaBadge zona={p.zona_confianca} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.status ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* LINHA 3 - Snapshot GoodData */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Último snapshot GoodData</CardTitle>
        </CardHeader>
        <CardContent>
          {!pos.gooddata_data_referencia ? (
            <div className="text-center py-6 space-y-2">
              <p className="text-sm text-muted-foreground">
                Nenhum snapshot do GoodData recebido.
              </p>
              <p className="text-xs text-muted-foreground">
                Configure o polling de emails ou suba PDF manualmente (módulo em desenvolvimento).
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Data de referência</p>
                <p className="text-sm font-medium mt-1">{fmtDate(pos.gooddata_data_referencia)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Fat. bruto confirmado</p>
                <p className="text-sm font-medium text-green-700 mt-1">
                  {fmtBRL(pos.fat_bruto_confirmado)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Pedidos em aberto</p>
                <p className="text-sm font-medium mt-1">{fmtBRL(pos.gooddata_pedidos_abertos)}</p>
              </div>
            </div>
          )}
          <div className="mt-4 pt-4 border-t border-border">
            <Dialog open={snapshotsOpen} onOpenChange={setSnapshotsOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  Ver snapshots anteriores
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-3xl">
                <DialogHeader>
                  <DialogTitle>Snapshots do trimestre · T{trimestre}/{ano}</DialogTitle>
                </DialogHeader>
                {snapshotsQuery.isLoading ? (
                  <Skeleton className="h-40 w-full" />
                ) : (snapshotsQuery.data ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    Nenhum snapshot registrado para este trimestre.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Data referência</TableHead>
                        <TableHead className="text-right">Fat. bruto</TableHead>
                        <TableHead className="text-right">Em aberto</TableHead>
                        <TableHead className="text-right">Objetivo</TableHead>
                        <TableHead>Recebido em</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshotsQuery.data!.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="text-xs font-medium">
                            {fmtDate(s.data_referencia)}
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {fmtBRL(s.fat_bruto_valor)}
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {fmtBRL(s.pedidos_abertos_valor)}
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {fmtBRL(s.objetivo_valor)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {new Date(s.criado_em).toLocaleString("pt-BR")}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </DialogContent>
            </Dialog>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
