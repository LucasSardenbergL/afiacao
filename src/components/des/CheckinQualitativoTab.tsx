import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Save, Loader2, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface Props {
  empresa: string;
  ano: number;
  trimestre: number;
}

interface Criterio {
  id: number;
  codigo: string;
  nome: string;
  descricao: string | null;
  ordem: number;
  tipo: "qualitativo" | "bonus" | string;
}

interface CriterioPercentual {
  criterio_id: number;
  faixa_id: number;
  percentual: number;
}

interface DescontoCheckin {
  checkin_id: number;
  data_avaliacao: string;
  tipo: string;
  faixa_numero: number | null;
  estrelas: number | null;
  desconto_padrao: number | null;
  qualitativos_atingidos_perc: number | null;
  bonus_atingido_perc: number | null;
  desconto_total_projetado: number | null;
  desconto_total_maximo: number | null;
  avaliado_por?: string | null;
}

interface CheckinAtualRow {
  checkin_id: number;
  data_avaliacao: string;
  tipo: string;
  avaliado_com: string | null;
  avaliado_por: string | null;
  codigo: string;
  nome: string;
  criterio_tipo: string;
  atingido: boolean;
  observacao_criterio: string | null;
}

const fmtPct = (v: number | null | undefined) =>
  v == null ? "—" : `${Number(v).toFixed(2).replace(".", ",")}%`;

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("pt-BR") : "—";

export function CheckinQualitativoTab({ empresa, ano, trimestre }: Props) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [respostas, setRespostas] = useState<Record<number, { atingido: boolean; observacao: string }>>({});
  const [saving, setSaving] = useState(false);
  const [confirmAndreOpen, setConfirmAndreOpen] = useState(false);

  // Critérios cadastrados
  const criteriosQuery = useQuery({
    queryKey: ["des-criterios"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("des_criterio_qualitativo")
        .select("id, codigo, nome, descricao, ordem, tipo")
        .order("ordem", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Criterio[];
    },
  });

  // Posição ao vivo (para descobrir faixa atual e percentuais)
  const posicaoQuery = useQuery({
    queryKey: ["des-posicao-checkin", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_posicao_trimestre_ao_vivo" as any)
        .select("faixa_conservadora, faixa_otimista")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as { faixa_conservadora: any; faixa_otimista: any } | null;
    },
  });

  // Percentuais por critério para a faixa atual
  const faixaConservId = (posicaoQuery.data?.faixa_conservadora as any)?.faixa_id ?? null;

  const percentuaisQuery = useQuery({
    queryKey: ["des-percentuais", faixaConservId],
    enabled: !!faixaConservId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("des_criterio_percentual")
        .select("criterio_id, faixa_id, percentual")
        .eq("faixa_id", faixaConservId);
      if (error) throw error;
      return (data ?? []) as CriterioPercentual[];
    },
  });

  // Checkin atual (mais recente do trimestre)
  const checkinAtualQuery = useQuery({
    queryKey: ["des-checkin-atual", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_checkin_atual" as any)
        .select("*")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre);
      if (error) throw error;
      return (data ?? []) as unknown as CheckinAtualRow[];
    },
  });

  // Desconto projetado para o checkin atual
  const descontoQuery = useQuery({
    queryKey: ["des-desconto", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_desconto_por_checkin" as any)
        .select("*")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .order("data_avaliacao", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as DescontoCheckin | null;
    },
  });

  // Histórico de checkins do trimestre
  const historicoQuery = useQuery({
    queryKey: ["des-checkin-historico", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_desconto_por_checkin" as any)
        .select("*")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .order("data_avaliacao", { ascending: false });
      if (error) throw error;
      // join avaliado_por via des_checkin_qualitativo
      const ids = (data ?? []).map((d: any) => d.checkin_id).filter(Boolean);
      let porMap: Record<number, string | null> = {};
      if (ids.length) {
        const { data: chs } = await supabase
          .from("des_checkin_qualitativo")
          .select("id, avaliado_por")
          .in("id", ids);
        chs?.forEach((c: any) => { porMap[c.id] = c.avaliado_por; });
      }
      return (data ?? []).map((d: any) => ({
        ...d,
        avaliado_por: porMap[d.checkin_id] ?? null,
      })) as DescontoCheckin[];
    },
  });

  // Inicializa respostas a partir do checkin atual
  useEffect(() => {
    const criterios = criteriosQuery.data ?? [];
    const rows = checkinAtualQuery.data ?? [];
    if (!criterios.length) return;

    const next: Record<number, { atingido: boolean; observacao: string }> = {};
    criterios.forEach((c) => {
      const row = rows.find((r) => r.codigo === c.codigo);
      next[c.id] = {
        atingido: row?.atingido ?? false,
        observacao: row?.observacao_criterio ?? "",
      };
    });
    setRespostas(next);
  }, [criteriosQuery.data, checkinAtualQuery.data]);

  const percentualPorCriterio = useMemo(() => {
    const map: Record<number, number> = {};
    (percentuaisQuery.data ?? []).forEach((p) => {
      map[p.criterio_id] = Number(p.percentual);
    });
    return map;
  }, [percentuaisQuery.data]);

  const desconto = descontoQuery.data;
  const max = Number(desconto?.desconto_total_maximo ?? 0);
  const total = Number(desconto?.desconto_total_projetado ?? 0);
  const ratio = max > 0 ? total / max : 0;
  const cardColor =
    ratio >= 1
      ? "bg-green-500/5 border-green-500/30"
      : ratio >= 0.5
        ? "bg-amber-500/5 border-amber-500/30"
        : "bg-red-500/5 border-red-500/30";
  const totalColor =
    ratio >= 1 ? "text-green-700" : ratio >= 0.5 ? "text-amber-700" : "text-red-700";

  async function salvarCheckin(tipo: "projecao" | "confirmacao_andre") {
    if (!user) {
      toast.error("Sessão expirada. Faça login novamente.");
      return;
    }
    setSaving(true);
    try {
      const hoje = new Date().toISOString().slice(0, 10);
      const avaliadoCom = tipo === "confirmacao_andre" ? "André (Sayerlack)" : null;
      const avaliadoPor = user.email ?? user.id;

      // 1. Procura checkin existente do mesmo tipo
      const { data: existentes, error: errFind } = await supabase
        .from("des_checkin_qualitativo")
        .select("id")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .eq("tipo", tipo)
        .order("criado_em", { ascending: false })
        .limit(1);
      if (errFind) throw errFind;

      let checkinId: number;
      if (existentes && existentes.length > 0) {
        checkinId = existentes[0].id;
        const { error: errUpd } = await supabase
          .from("des_checkin_qualitativo")
          .update({
            data_avaliacao: hoje,
            avaliado_por: avaliadoPor,
            avaliado_com: avaliadoCom,
            atualizado_em: new Date().toISOString(),
          })
          .eq("id", checkinId);
        if (errUpd) throw errUpd;
      } else {
        const { data: novo, error: errIns } = await supabase
          .from("des_checkin_qualitativo")
          .insert({
            empresa,
            ano,
            trimestre,
            data_avaliacao: hoje,
            tipo,
            avaliado_por: avaliadoPor,
            avaliado_com: avaliadoCom,
          })
          .select("id")
          .single();
        if (errIns) throw errIns;
        checkinId = novo.id;
      }

      // 2. Apaga respostas antigas e insere novas
      const { error: errDel } = await supabase
        .from("des_checkin_qualitativo_resposta")
        .delete()
        .eq("checkin_id", checkinId);
      if (errDel) throw errDel;

      const novasRespostas = Object.entries(respostas).map(([critId, val]) => ({
        checkin_id: checkinId,
        criterio_id: Number(critId),
        atingido: val.atingido,
        observacao: val.observacao || null,
      }));

      if (novasRespostas.length) {
        const { error: errInsR } = await supabase
          .from("des_checkin_qualitativo_resposta")
          .insert(novasRespostas);
        if (errInsR) throw errInsR;
      }

      toast.success(
        tipo === "projecao"
          ? "Projeção atualizada."
          : "Confirmação com André registrada."
      );

      // Refetch
      qc.invalidateQueries({ queryKey: ["des-checkin-atual", empresa, ano, trimestre] });
      qc.invalidateQueries({ queryKey: ["des-desconto", empresa, ano, trimestre] });
      qc.invalidateQueries({ queryKey: ["des-checkin-historico", empresa, ano, trimestre] });
    } catch (err: any) {
      console.error(err);
      toast.error("Erro ao salvar checkin: " + (err?.message ?? "desconhecido"));
    } finally {
      setSaving(false);
      setConfirmAndreOpen(false);
    }
  }

  const isLoading = criteriosQuery.isLoading || checkinAtualQuery.isLoading;
  const criterios = criteriosQuery.data ?? [];
  const qualitativos = criterios.filter((c) => c.tipo === "qualitativo");
  const bonusItems = criterios.filter((c) => c.tipo === "bonus");

  return (
    <div className="space-y-6">
      {/* Topo: card de desconto projetado */}
      <Card className={cn("border-2", cardColor)}>
        <CardContent className="pt-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex-1 min-w-[280px]">
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
                Desconto projetado para o próximo trimestre
              </p>
              <p className={cn("text-3xl font-bold mt-2", totalColor)}>
                Se confirmar os critérios, será {fmtPct(total)}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Padrão da faixa: <strong>{fmtPct(desconto?.desconto_padrao)}</strong> + Qualitativos atingidos:{" "}
                <strong>{fmtPct(desconto?.qualitativos_atingidos_perc)}</strong> + Bônus:{" "}
                <strong>{fmtPct(desconto?.bonus_atingido_perc)}</strong>
              </p>
              {max > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Máximo possível desta faixa: {fmtPct(max)}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button disabled={saving || isLoading}>
                    {saving ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    Salvar
                    <ChevronDown className="h-4 w-4 ml-2" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => salvarCheckin("projecao")}>
                    Salvar como Projeção
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setConfirmAndreOpen(true)}>
                    Salvar como Confirmação (com André)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Critérios */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {qualitativos.map((c) => {
              const r = respostas[c.id] ?? { atingido: false, observacao: "" };
              const pct = percentualPorCriterio[c.id] ?? 0;
              return (
                <Card
                  key={c.id}
                  className={cn(
                    "transition-colors",
                    r.atingido && "bg-green-500/5 border-green-500/30"
                  )}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-sm leading-tight">{c.nome}</CardTitle>
                        {c.descricao && (
                          <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                            {c.descricao}
                          </p>
                        )}
                      </div>
                      <Badge variant="outline" className="shrink-0 text-xs">
                        Vale {fmtPct(pct)}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={r.atingido}
                        onCheckedChange={(v) =>
                          setRespostas((prev) => ({ ...prev, [c.id]: { ...r, atingido: v } }))
                        }
                      />
                      <label className="text-sm font-medium cursor-pointer">
                        {r.atingido ? "Atingido" : "Não atingido"}
                      </label>
                    </div>
                    {r.atingido && (
                      <Textarea
                        placeholder="Observação (opcional)..."
                        value={r.observacao}
                        onChange={(e) =>
                          setRespostas((prev) => ({
                            ...prev,
                            [c.id]: { ...r, observacao: e.target.value },
                          }))
                        }
                        className="text-xs min-h-[60px]"
                      />
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {bonusItems.length > 0 && (
            <>
              <div className="flex items-center gap-3 pt-2">
                <Sparkles className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-semibold text-foreground">Bônus extra</span>
                <Separator className="flex-1" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {bonusItems.map((c) => {
                  const r = respostas[c.id] ?? { atingido: false, observacao: "" };
                  const pct = percentualPorCriterio[c.id] ?? 0;
                  return (
                    <Card
                      key={c.id}
                      className={cn(
                        "transition-colors border-amber-500/30",
                        r.atingido && "bg-amber-500/10"
                      )}
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <CardTitle className="text-sm leading-tight">{c.nome}</CardTitle>
                            {c.descricao && (
                              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                                {c.descricao}
                              </p>
                            )}
                          </div>
                          <Badge variant="outline" className="shrink-0 text-xs bg-amber-500/10 border-amber-500/40 text-amber-700">
                            Vale {fmtPct(pct)}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={r.atingido}
                            onCheckedChange={(v) =>
                              setRespostas((prev) => ({ ...prev, [c.id]: { ...r, atingido: v } }))
                            }
                          />
                          <label className="text-sm font-medium cursor-pointer">
                            {r.atingido ? "Atingido" : "Não atingido"}
                          </label>
                        </div>
                        {r.atingido && (
                          <Textarea
                            placeholder="Observação (opcional)..."
                            value={r.observacao}
                            onChange={(e) =>
                              setRespostas((prev) => ({
                                ...prev,
                                [c.id]: { ...r, observacao: e.target.value },
                              }))
                            }
                            className="text-xs min-h-[60px]"
                          />
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {/* Histórico do trimestre */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Checkins anteriores neste trimestre</CardTitle>
        </CardHeader>
        <CardContent>
          {historicoQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (historicoQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              Nenhum checkin registrado ainda neste trimestre.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Avaliado por</TableHead>
                  <TableHead className="text-right">Qualitativos</TableHead>
                  <TableHead className="text-right">Desconto projetado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historicoQuery.data!.map((h) => (
                  <TableRow key={h.checkin_id}>
                    <TableCell className="text-xs">{fmtDate(h.data_avaliacao)}</TableCell>
                    <TableCell>
                      <Badge variant={h.tipo === "confirmacao_andre" ? "default" : "secondary"} className="text-xs">
                        {h.tipo === "confirmacao_andre" ? "Confirmação" : "Projeção"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {h.avaliado_por ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {fmtPct(h.qualitativos_atingidos_perc)}
                    </TableCell>
                    <TableCell className="text-right text-xs font-medium">
                      {fmtPct(h.desconto_total_projetado)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Dialog confirmação com André */}
      <AlertDialog open={confirmAndreOpen} onOpenChange={setConfirmAndreOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmação final com André</AlertDialogTitle>
            <AlertDialogDescription>
              Esta é a avaliação final do trimestre feita com André. Substituirá a projeção atual. Confirmar?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                salvarCheckin("confirmacao_andre");
              }}
              disabled={saving}
            >
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Confirmar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
