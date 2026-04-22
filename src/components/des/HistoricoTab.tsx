import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CalendarDays, Star } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Props {
  empresa: string;
  ano: number;
  trimestre: number;
}

interface MetaRow {
  ano: number;
  trimestre: number;
  meta_faturamento: number;
  faixa_des_objetivo: number | null;
}

interface SnapshotRow {
  ano: number;
  trimestre: number;
  data_referencia: string;
  fat_bruto_valor: number | null;
  pedidos_abertos_valor: number | null;
  objetivo_valor: number | null;
}

interface CheckinDescontoRow {
  checkin_id: number;
  ano: number;
  trimestre: number;
  data_avaliacao: string;
  tipo: string;
  faixa_numero: number | null;
  estrelas: number | null;
  desconto_padrao: number | null;
  qualitativos_atingidos_perc: number | null;
  bonus_atingido_perc: number | null;
  desconto_total_projetado: number | null;
  desconto_total_maximo: number | null;
}

interface PosicaoLiveRow {
  ano: number;
  trimestre: number;
  posicao_ao_vivo_conservadora: number | null;
  faixa_conservadora: { faixa_numero?: number; estrelas?: number } | null;
  meta_pessoal: number | null;
  inicio_trimestre: string | null;
  fim_trimestre: string | null;
}

interface QuarterCard {
  ano: number;
  trimestre: number;
  isAtual: boolean;
  meta: number;
  faturado: number;
  faixaEstrelas: number;
  inicio: string | null;
  fim: string | null;
  ultimoCheckin: CheckinDescontoRow | null;
  snapshots: SnapshotRow[];
}

const fmtBRL = (v: number | null | undefined) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

const fmtPct = (v: number | null | undefined) =>
  v == null ? "—" : `${Number(v).toFixed(2).replace(".", ",")}%`;

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("pt-BR") : "—";

function StarsRow({ count, max = 6 }: { count: number; max?: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: max }).map((_, i) => (
        <Star
          key={i}
          className={cn(
            "h-3.5 w-3.5",
            i < count ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30",
          )}
        />
      ))}
    </div>
  );
}

function quarterDates(ano: number, trimestre: number): { inicio: string; fim: string } {
  const startMonth = (trimestre - 1) * 3;
  const inicio = new Date(ano, startMonth, 1);
  const fim = new Date(ano, startMonth + 3, 0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { inicio: iso(inicio), fim: iso(fim) };
}

export function HistoricoTab({ empresa, ano: anoAtual, trimestre: trimestreAtual }: Props) {
  const [filtroAno, setFiltroAno] = useState<string>("__todos__");
  const [filtroStatus, setFiltroStatus] = useState<string>("todos");
  const [detalhesOpen, setDetalhesOpen] = useState<QuarterCard | null>(null);

  // Metas
  const metasQuery = useQuery({
    queryKey: ["des-historico-metas", empresa],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("des_meta_empresa")
        .select("ano, trimestre, meta_faturamento, faixa_des_objetivo")
        .eq("empresa", empresa)
        .order("ano", { ascending: false })
        .order("trimestre", { ascending: false });
      if (error) throw error;
      return (data ?? []) as MetaRow[];
    },
  });

  // Snapshots (todos)
  const snapshotsQuery = useQuery({
    queryKey: ["des-historico-snapshots", empresa],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("des_trimestre_snapshot")
        .select("ano, trimestre, data_referencia, fat_bruto_valor, pedidos_abertos_valor, objetivo_valor")
        .eq("empresa", empresa)
        .order("data_referencia", { ascending: false });
      if (error) throw error;
      return (data ?? []) as SnapshotRow[];
    },
  });

  // Checkins (via view de desconto)
  const checkinsQuery = useQuery({
    queryKey: ["des-historico-checkins", empresa],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_desconto_por_checkin" as any)
        .select("*")
        .eq("empresa", empresa)
        .order("data_avaliacao", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CheckinDescontoRow[];
    },
  });

  // Posição ao vivo (apenas trimestre corrente)
  const posLiveQuery = useQuery({
    queryKey: ["des-historico-poslive", empresa, anoAtual, trimestreAtual],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_posicao_trimestre_ao_vivo" as any)
        .select("ano, trimestre, posicao_ao_vivo_conservadora, faixa_conservadora, meta_pessoal, inicio_trimestre, fim_trimestre")
        .eq("empresa", empresa)
        .eq("ano", anoAtual)
        .eq("trimestre", trimestreAtual)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as PosicaoLiveRow | null;
    },
  });

  const cards: QuarterCard[] = useMemo(() => {
    const metas = metasQuery.data ?? [];
    const snapshots = snapshotsQuery.data ?? [];
    const checkins = checkinsQuery.data ?? [];
    const live = posLiveQuery.data;

    const keys = new Set<string>();
    metas.forEach((m) => keys.add(`${m.ano}-${m.trimestre}`));
    snapshots.forEach((s) => keys.add(`${s.ano}-${s.trimestre}`));
    checkins.forEach((c) => keys.add(`${c.ano}-${c.trimestre}`));
    keys.add(`${anoAtual}-${trimestreAtual}`);

    const list: QuarterCard[] = Array.from(keys).map((k) => {
      const [a, t] = k.split("-").map(Number);
      const isAtual = a === anoAtual && t === trimestreAtual;
      const meta = metas.find((m) => m.ano === a && m.trimestre === t);
      const snapsTri = snapshots.filter((s) => s.ano === a && s.trimestre === t);
      const ultimoSnap = snapsTri[0]; // já vem desc
      // Para trimestre corrente, prioriza posicao ao vivo conservadora
      const faturado = isAtual
        ? Number(live?.posicao_ao_vivo_conservadora ?? ultimoSnap?.fat_bruto_valor ?? 0)
        : Number(ultimoSnap?.fat_bruto_valor ?? 0);

      // Último checkin: confirmacao_andre tem prioridade, senão projecao
      const checkinsTri = checkins.filter((c) => c.ano === a && c.trimestre === t);
      const ultimoCheckin =
        checkinsTri.find((c) => c.tipo === "confirmacao_andre") ??
        checkinsTri[0] ??
        null;

      const faixaEstrelas = isAtual
        ? Number(live?.faixa_conservadora?.estrelas ?? ultimoCheckin?.estrelas ?? 0)
        : Number(ultimoCheckin?.estrelas ?? 0);

      const dates = quarterDates(a, t);
      return {
        ano: a,
        trimestre: t,
        isAtual,
        meta: Number(meta?.meta_faturamento ?? live?.meta_pessoal ?? 0),
        faturado,
        faixaEstrelas,
        inicio: isAtual ? (live?.inicio_trimestre ?? dates.inicio) : dates.inicio,
        fim: isAtual ? (live?.fim_trimestre ?? dates.fim) : dates.fim,
        ultimoCheckin,
        snapshots: snapsTri,
      };
    });

    // Ordena desc (ano, trimestre)
    list.sort((a, b) => (b.ano - a.ano) || (b.trimestre - a.trimestre));
    return list;
  }, [metasQuery.data, snapshotsQuery.data, checkinsQuery.data, posLiveQuery.data, anoAtual, trimestreAtual]);

  const anosDisponiveis = useMemo(() => {
    const set = new Set<number>();
    cards.forEach((c) => set.add(c.ano));
    return Array.from(set).sort((a, b) => b - a);
  }, [cards]);

  const cardsFiltrados = useMemo(() => {
    return cards.filter((c) => {
      if (filtroAno !== "__todos__" && String(c.ano) !== filtroAno) return false;
      if (filtroStatus === "andamento" && !c.isAtual) return false;
      if (filtroStatus === "encerrados" && c.isAtual) return false;
      return true;
    });
  }, [cards, filtroAno, filtroStatus]);

  const chartData = useMemo(() => {
    return [...cardsFiltrados]
      .sort((a, b) => (a.ano - b.ano) || (a.trimestre - b.trimestre))
      .map((c) => ({
        label: `T${c.trimestre}/${String(c.ano).slice(2)}`,
        faturado: c.faturado,
        meta: c.meta,
        isAtual: c.isAtual,
      }));
  }, [cardsFiltrados]);

  const metaMedia = useMemo(() => {
    const metas = chartData.map((d) => d.meta).filter((m) => m > 0);
    if (!metas.length) return 0;
    return metas.reduce((a, b) => a + b, 0) / metas.length;
  }, [chartData]);

  const isLoading =
    metasQuery.isLoading ||
    snapshotsQuery.isLoading ||
    checkinsQuery.isLoading ||
    posLiveQuery.isLoading;

  if (isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (!cards.length || (cards.length === 1 && cards[0].meta === 0 && !cards[0].ultimoCheckin && !cards[0].snapshots.length)) {
    return (
      <Card>
        <CardContent className="p-12 text-center space-y-3">
          <CalendarDays className="h-10 w-10 mx-auto text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            Nenhum trimestre cadastrado ainda.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/des/configuracao">Cadastrar meta trimestral</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Ano:</span>
          <Select value={filtroAno} onValueChange={setFiltroAno}>
            <SelectTrigger className="w-[120px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__todos__">Todos</SelectItem>
              {anosDisponiveis.map((a) => (
                <SelectItem key={a} value={String(a)}>{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ToggleGroup
          type="single"
          value={filtroStatus}
          onValueChange={(v) => v && setFiltroStatus(v)}
          size="sm"
        >
          <ToggleGroupItem value="todos" className="text-xs h-8">Todos</ToggleGroupItem>
          <ToggleGroupItem value="andamento" className="text-xs h-8">Em andamento</ToggleGroupItem>
          <ToggleGroupItem value="encerrados" className="text-xs h-8">Encerrados</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Gráfico */}
      {chartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Faturamento por trimestre</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                    tickFormatter={(v) => `R$ ${(v / 1000).toFixed(0)}k`}
                  />
                  <RTooltip
                    formatter={(v: number) => fmtBRL(v)}
                    contentStyle={{
                      backgroundColor: "hsl(var(--background))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="faturado" name="Faturado" radius={[4, 4, 0, 0]}>
                    {chartData.map((d, i) => (
                      <Cell
                        key={i}
                        fill={
                          d.isAtual
                            ? "hsl(217 91% 60%)"
                            : d.faturado >= d.meta
                              ? "hsl(142 71% 45%)"
                              : "hsl(0 72% 51%)"
                        }
                      />
                    ))}
                  </Bar>
                  {metaMedia > 0 && (
                    <ReferenceLine
                      y={metaMedia}
                      stroke="hsl(var(--foreground))"
                      strokeDasharray="4 4"
                      label={{
                        value: `Meta média: ${fmtBRL(metaMedia)}`,
                        position: "right",
                        fontSize: 10,
                        fill: "hsl(var(--muted-foreground))",
                      }}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Timeline de cards */}
      <div className="space-y-4">
        {cardsFiltrados.map((c) => {
          const progress =
            c.meta > 0 ? Math.min((c.faturado / c.meta) * 100, 100) : 0;
          const atingiu = c.meta > 0 && c.faturado >= c.meta;
          return (
            <Card key={`${c.ano}-${c.trimestre}`} className={cn(c.isAtual && "border-blue-500/40")}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <CardTitle className="text-lg">T{c.trimestre} {c.ano}</CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      de {fmtDate(c.inicio)} a {fmtDate(c.fim)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {c.isAtual && (
                      <Badge variant="outline" className="bg-blue-500/10 border-blue-500/40 text-blue-700 text-xs">
                        Em andamento
                      </Badge>
                    )}
                    {!c.isAtual && c.meta > 0 && (
                      atingiu ? (
                        <Badge variant="outline" className="bg-green-500/10 border-green-500/40 text-green-700 text-xs">
                          Meta atingida
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-red-500/10 border-red-500/40 text-red-700 text-xs">
                          Meta não atingida
                        </Badge>
                      )
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Meta pessoal</p>
                    <p className="text-sm font-medium mt-1">{fmtBRL(c.meta)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {c.isAtual ? "Faturado (ao vivo)" : "Faturado final"}
                    </p>
                    <p className={cn("text-sm font-medium mt-1", atingiu ? "text-green-700" : "text-foreground")}>
                      {fmtBRL(c.faturado)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Faixa DES</p>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span className="text-sm font-medium">{c.faixaEstrelas}★</span>
                      <StarsRow count={c.faixaEstrelas} />
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Desc. próx. trimestre</p>
                    <p className="text-sm font-medium mt-1">
                      {fmtPct(c.ultimoCheckin?.desconto_total_projetado)}
                    </p>
                  </div>
                </div>
                {c.isAtual && c.meta > 0 && (
                  <div className="mt-4 space-y-1">
                    <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                      <div
                        className={cn(
                          "h-full transition-all",
                          progress >= 100 ? "bg-green-500" : progress >= 75 ? "bg-amber-500" : "bg-blue-500",
                        )}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {progress.toFixed(1).replace(".", ",")}% da meta
                    </p>
                  </div>
                )}
                <div className="mt-4 pt-3 border-t border-border">
                  <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setDetalhesOpen(c)}>
                    Ver detalhes
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {cardsFiltrados.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-sm text-muted-foreground">
                Nenhum trimestre corresponde aos filtros.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Modal de detalhes */}
      <Dialog open={!!detalhesOpen} onOpenChange={(o) => !o && setDetalhesOpen(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          {detalhesOpen && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Detalhes T{detalhesOpen.trimestre}/{detalhesOpen.ano}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Período</p>
                    <p>{fmtDate(detalhesOpen.inicio)} a {fmtDate(detalhesOpen.fim)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Meta pessoal</p>
                    <p>{fmtBRL(detalhesOpen.meta)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Faturado</p>
                    <p>{fmtBRL(detalhesOpen.faturado)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Faixa DES</p>
                    <p>{detalhesOpen.faixaEstrelas} estrelas</p>
                  </div>
                </div>

                {detalhesOpen.ultimoCheckin && (
                  <div className="border-t border-border pt-3">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Último checkin ({detalhesOpen.ultimoCheckin.tipo})
                    </p>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <p className="text-muted-foreground">Data</p>
                        <p>{fmtDate(detalhesOpen.ultimoCheckin.data_avaliacao)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Desconto padrão</p>
                        <p>{fmtPct(detalhesOpen.ultimoCheckin.desconto_padrao)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Qualitativos atingidos</p>
                        <p>{fmtPct(detalhesOpen.ultimoCheckin.qualitativos_atingidos_perc)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Bônus</p>
                        <p>{fmtPct(detalhesOpen.ultimoCheckin.bonus_atingido_perc)}</p>
                      </div>
                      <div className="col-span-2">
                        <p className="text-muted-foreground">Desconto total projetado</p>
                        <p className="font-semibold text-base">
                          {fmtPct(detalhesOpen.ultimoCheckin.desconto_total_projetado)}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {detalhesOpen.snapshots.length > 0 && (
                  <div className="border-t border-border pt-3">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Snapshots GoodData ({detalhesOpen.snapshots.length})
                    </p>
                    <div className="space-y-1 text-xs">
                      {detalhesOpen.snapshots.slice(0, 5).map((s, i) => (
                        <div key={i} className="flex items-center justify-between py-1 border-b border-border/40 last:border-0">
                          <span>{fmtDate(s.data_referencia)}</span>
                          <span className="font-medium">{fmtBRL(s.fat_bruto_valor)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
