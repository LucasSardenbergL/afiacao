import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  History,
  Pencil,
  Plus,
  Repeat,
  Truck,
  X,
} from "lucide-react";
import { Etapa, Fornecedor, HistoricoItem } from "@/components/reposicao/cadeiaLogistica/types";
import { EMPRESA, tipoLabel } from "@/components/reposicao/cadeiaLogistica/shared";
import { EtapaFormDialog } from "@/components/reposicao/cadeiaLogistica/EtapaFormDialog";
import { TrocaParceiroDialog } from "@/components/reposicao/cadeiaLogistica/TrocaParceiroDialog";

export default function AdminReposicaoCadeiaLogistica() {
  const { isAdmin } = useAuth();
  const podeEditar = isAdmin;
  const qc = useQueryClient();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editandoEtapa, setEditandoEtapa] = useState<Etapa | null>(null);
  const [novaEtapaForn, setNovaEtapaForn] = useState<string | null>(null);
  const [trocandoParceiro, setTrocandoParceiro] = useState<Etapa | null>(null);

  // Fornecedores habilitados
  const { data: fornecedores, isLoading: loadingForn } = useQuery({
    queryKey: ["cadeia-fornecedores"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_habilitado_reposicao")
        .select("empresa, fornecedor_nome, habilitado")
        .eq("habilitado", true)
        .order("fornecedor_nome");
      if (error) throw error;
      return (data ?? []) as Fornecedor[];
    },
  });

  // Etapas
  const { data: etapas, isLoading: loadingEt } = useQuery({
    queryKey: ["cadeia-etapas"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_cadeia_logistica")
        .select("*")
        .order("fornecedor_nome")
        .order("ordem");
      if (error) throw error;
      return (data ?? []) as Etapa[];
    },
  });

  // Histórico
  const { data: historico } = useQuery({
    queryKey: ["cadeia-historico"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_cadeia_logistica_historico")
        .select("*")
        .order("criado_em", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as HistoricoItem[];
    },
  });

  // Calcular LT total antes de mudança (para mensurar impacto)
  async function ltTotalAtualForn(fornecedor: string): Promise<number> {
    const { data } = await supabase
      .from("fornecedor_cadeia_logistica")
      .select("lt_dias")
      .eq("empresa", EMPRESA)
      .eq("fornecedor_nome", fornecedor)
      .eq("ativo", true);
    return ((data ?? []) as Array<{ lt_dias: number | string | null }>).reduce(
      (s, r) => s + (Number(r.lt_dias) || 0),
      0,
    );
  }

  // Recalcular parâmetros + log + toast com impacto
  async function recalcularComImpacto(args: {
    fornecedor: string;
    ltAntes: number;
    acao: string;
    descricao: string;
    etapa_codigo?: string | null;
    valoresAnt?: Record<string, unknown> | Etapa | null;
    valoresNov?: Record<string, unknown> | Partial<Etapa> | null;
  }) {
    try {
      const ltDepois = await ltTotalAtualForn(args.fornecedor);
      const delta = ltDepois - args.ltAntes;

      // log histórico — coluna `empresa` existe no DB mas ainda não no generated type
      await supabase.from("fornecedor_cadeia_logistica_historico").insert({
        empresa: EMPRESA,
        fornecedor_nome: args.fornecedor,
        etapa_codigo: args.etapa_codigo ?? null,
        acao: args.acao,
        descricao_mudanca: args.descricao,
        valores_anteriores: args.valoresAnt ?? null,
        valores_novos: args.valoresNov ?? null,
      } as never);

      // chamar recálculo (best-effort)
      const { error: rpcErr } = await supabase.rpc(
        "atualizar_parametros_numericos_skus",
        { p_empresa: EMPRESA },
      );
      if (rpcErr) {
        console.warn("Recalc falhou:", rpcErr);
      }

      const sinal = delta > 0 ? "+" : "";
      const msg =
        delta === 0
          ? "LT teórico inalterado."
          : `LT teórico recalculado (${sinal}${delta} dias úteis). Capital de giro pode variar proporcionalmente.`;
      toast.success(msg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.warning(`Mudança salva mas recálculo falhou: ${msg}`);
    }
  }

  // Salvar etapa (criar/editar)
  const salvarEtapaMut = useMutation({
    mutationFn: async (payload: {
      modo: "criar" | "editar";
      fornecedor: string;
      etapa: Partial<Etapa>;
      etapaOriginal?: Etapa;
    }) => {
      const ltAntes = await ltTotalAtualForn(payload.fornecedor);

      if (payload.modo === "criar") {
        // Calcular próxima ordem
        const ordensExist = (etapas ?? [])
          .filter(
            (e) => e.empresa === EMPRESA && e.fornecedor_nome === payload.fornecedor,
          )
          .map((e) => e.ordem);
        const proxOrdem = ordensExist.length > 0 ? Math.max(...ordensExist) + 1 : 1;
        const codigo = `${payload.fornecedor.slice(0, 4).toUpperCase().replace(/\s/g, "")}_E${proxOrdem}_${Date.now().toString(36)}`;

        // `empresa` field existe no DB mas ainda não no generated type
        const { error } = await supabase
          .from("fornecedor_cadeia_logistica")
          .insert({
            empresa: EMPRESA,
            fornecedor_nome: payload.fornecedor,
            ordem: proxOrdem,
            etapa_codigo: codigo,
            descricao: payload.etapa.descricao,
            lt_dias: payload.etapa.lt_dias,
            lt_unidade: payload.etapa.lt_unidade ?? "uteis",
            parceiro_nome: payload.etapa.parceiro_nome ?? null,
            parceiro_tipo: payload.etapa.parceiro_tipo ?? null,
            parceiro_contato: payload.etapa.parceiro_contato ?? null,
            observacoes: payload.etapa.observacoes ?? null,
            ativo: true,
          } as never);
        if (error) throw error;

        await recalcularComImpacto({
          fornecedor: payload.fornecedor,
          ltAntes,
          acao: "criacao",
          descricao: `Nova etapa "${payload.etapa.descricao}" adicionada (${payload.etapa.lt_dias} dias)`,
          etapa_codigo: codigo,
          valoresNov: payload.etapa,
        });
      } else if (payload.etapaOriginal) {
        const orig = payload.etapaOriginal;
        const { error } = await supabase
          .from("fornecedor_cadeia_logistica")
          .update({
            descricao: payload.etapa.descricao,
            lt_dias: payload.etapa.lt_dias,
            lt_unidade: payload.etapa.lt_unidade,
            parceiro_nome: payload.etapa.parceiro_nome,
            parceiro_tipo: payload.etapa.parceiro_tipo,
            parceiro_contato: payload.etapa.parceiro_contato,
            observacoes: payload.etapa.observacoes,
            atualizado_em: new Date().toISOString(),
          })
          .eq("id", orig.id);
        if (error) throw error;

        await recalcularComImpacto({
          fornecedor: payload.fornecedor,
          ltAntes,
          acao: "edicao",
          descricao: `Etapa "${orig.descricao}" editada: LT ${orig.lt_dias}d → ${payload.etapa.lt_dias}d`,
          etapa_codigo: orig.etapa_codigo,
          valoresAnt: orig,
          valoresNov: payload.etapa,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cadeia-etapas"] });
      qc.invalidateQueries({ queryKey: ["cadeia-historico"] });
      setEditandoEtapa(null);
      setNovaEtapaForn(null);
    },
    onError: (e: Error) => toast.error(`Erro ao salvar: ${e.message}`),
  });

  // Desativar
  const desativarMut = useMutation({
    mutationFn: async (etapa: Etapa) => {
      const ltAntes = await ltTotalAtualForn(etapa.fornecedor_nome);
      const { error } = await supabase
        .from("fornecedor_cadeia_logistica")
        .update({ ativo: false, valido_ate: new Date().toISOString().split("T")[0] })
        .eq("id", etapa.id);
      if (error) throw error;
      await recalcularComImpacto({
        fornecedor: etapa.fornecedor_nome,
        ltAntes,
        acao: "desativacao",
        descricao: `Etapa "${etapa.descricao}" desativada (era ${etapa.lt_dias}d)`,
        etapa_codigo: etapa.etapa_codigo,
        valoresAnt: etapa,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cadeia-etapas"] });
      qc.invalidateQueries({ queryKey: ["cadeia-historico"] });
    },
    onError: (e: Error) => toast.error(`Erro ao desativar: ${e.message}`),
  });

  // Trocar parceiro
  const trocarParceiroMut = useMutation({
    mutationFn: async (args: {
      etapa: Etapa;
      novoParceiro: string;
      novoTipo: string;
      novoContato: string;
      novoLt: number;
      novaUnidade: string;
      dataTroca: string;
    }) => {
      const ltAntes = await ltTotalAtualForn(args.etapa.fornecedor_nome);
      // 1. Marca etapa atual como expirada
      const { error: e1 } = await supabase
        .from("fornecedor_cadeia_logistica")
        .update({ ativo: false, valido_ate: args.dataTroca })
        .eq("id", args.etapa.id);
      if (e1) throw e1;

      // 2. Cria nova etapa com mesma ordem e código novo
      const novoCodigo = `${args.etapa.etapa_codigo}_T${Date.now().toString(36)}`;
      const { error: e2 } = await supabase
        .from("fornecedor_cadeia_logistica")
        .insert({
          empresa: args.etapa.empresa,
          fornecedor_nome: args.etapa.fornecedor_nome,
          ordem: args.etapa.ordem,
          etapa_codigo: novoCodigo,
          descricao: args.etapa.descricao,
          lt_dias: args.novoLt,
          lt_unidade: args.novaUnidade,
          parceiro_nome: args.novoParceiro,
          parceiro_tipo: args.novoTipo,
          parceiro_contato: args.novoContato,
          observacoes: args.etapa.observacoes,
          valido_desde: args.dataTroca,
          ativo: true,
        });
      if (e2) throw e2;

      await recalcularComImpacto({
        fornecedor: args.etapa.fornecedor_nome,
        ltAntes,
        acao: "troca_parceiro",
        descricao: `Parceiro da etapa "${args.etapa.descricao}" trocado: ${args.etapa.parceiro_nome ?? "—"} → ${args.novoParceiro}`,
        etapa_codigo: novoCodigo,
        valoresAnt: {
          parceiro: args.etapa.parceiro_nome,
          lt: args.etapa.lt_dias,
        },
        valoresNov: { parceiro: args.novoParceiro, lt: args.novoLt },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cadeia-etapas"] });
      qc.invalidateQueries({ queryKey: ["cadeia-historico"] });
      setTrocandoParceiro(null);
    },
    onError: (e: Error) => toast.error(`Erro ao trocar: ${e.message}`),
  });

  // Reordenar (move up/down)
  const reordenarMut = useMutation({
    mutationFn: async (args: { etapa: Etapa; direcao: "up" | "down" }) => {
      const lista = (etapas ?? [])
        .filter(
          (e) =>
            e.empresa === EMPRESA &&
            e.fornecedor_nome === args.etapa.fornecedor_nome &&
            e.ativo,
        )
        .sort((a, b) => a.ordem - b.ordem);
      const idx = lista.findIndex((e) => e.id === args.etapa.id);
      const swapIdx = args.direcao === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= lista.length) return;
      const outro = lista[swapIdx];
      // Swap ordens
      const { error: e1 } = await supabase
        .from("fornecedor_cadeia_logistica")
        .update({ ordem: outro.ordem })
        .eq("id", args.etapa.id);
      if (e1) throw e1;
      const { error: e2 } = await supabase
        .from("fornecedor_cadeia_logistica")
        .update({ ordem: args.etapa.ordem })
        .eq("id", outro.id);
      if (e2) throw e2;

      await supabase.from("fornecedor_cadeia_logistica_historico").insert({
        empresa: EMPRESA,
        fornecedor_nome: args.etapa.fornecedor_nome,
        etapa_codigo: args.etapa.etapa_codigo,
        acao: "reordenacao",
        descricao_mudanca: `Etapa "${args.etapa.descricao}" reordenada`,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cadeia-etapas"] });
      qc.invalidateQueries({ queryKey: ["cadeia-historico"] });
    },
    onError: (e: Error) => toast.error(`Erro ao reordenar: ${e.message}`),
  });

  // Agrupar etapas por fornecedor
  const etapasPorForn = useMemo(() => {
    const map = new Map<string, Etapa[]>();
    (etapas ?? []).forEach((e) => {
      const key = e.fornecedor_nome;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    });
    map.forEach((arr) => arr.sort((a, b) => a.ordem - b.ordem));
    return map;
  }, [etapas]);

  function toggleExp(forn: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(forn)) next.delete(forn);
      else next.add(forn);
      return next;
    });
  }

  if (loadingForn || loadingEt) {
    return (
      <div className="container mx-auto p-4 space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Truck className="h-6 w-6" /> Cadeia logística
        </h1>
        <p className="text-sm text-muted-foreground">
          Gestão das etapas logísticas por fornecedor habilitado. Mudanças
          recalculam automaticamente os parâmetros de reposição.
        </p>
      </div>

      {/* Seção 1+2: cards expansíveis */}
      <div className="space-y-4">
        {(fornecedores ?? []).map((f) => {
          const lista = etapasPorForn.get(f.fornecedor_nome) ?? [];
          const ativas = lista.filter((e) => e.ativo);
          const ltTotal = ativas.reduce((s, e) => s + (e.lt_dias || 0), 0);
          const cadeia =
            ativas
              .map((e) => e.parceiro_nome || e.descricao)
              .filter(Boolean)
              .join(" → ") || "—";
          const isOpen = expanded.has(f.fornecedor_nome);

          return (
            <Card key={f.fornecedor_nome}>
              <Collapsible open={isOpen} onOpenChange={() => toggleExp(f.fornecedor_nome)}>
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer hover:bg-muted/40 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2 min-w-0">
                        {isOpen ? (
                          <ChevronDown className="h-5 w-5 mt-0.5 shrink-0" />
                        ) : (
                          <ChevronRight className="h-5 w-5 mt-0.5 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <CardTitle className="text-base">{f.fornecedor_nome}</CardTitle>
                          <p className="text-xs text-muted-foreground mt-1 truncate">
                            {cadeia}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <Badge variant="outline" className="font-mono">
                          {ltTotal}d totais
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {ativas.length} etapa{ativas.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="space-y-3">
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        onClick={() => setNovaEtapaForn(f.fornecedor_nome)}
                        disabled={!podeEditar}
                      >
                        <Plus className="h-4 w-4 mr-1" /> Adicionar etapa
                      </Button>
                    </div>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-20">Ordem</TableHead>
                            <TableHead>Descrição</TableHead>
                            <TableHead>Parceiro</TableHead>
                            <TableHead className="text-right">LT</TableHead>
                            <TableHead>Unidade</TableHead>
                            <TableHead>Contato</TableHead>
                            <TableHead>Válido desde</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Ações</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {lista.length === 0 && (
                            <TableRow>
                              <TableCell
                                colSpan={9}
                                className="text-center text-sm text-muted-foreground py-6"
                              >
                                Nenhuma etapa cadastrada.
                              </TableCell>
                            </TableRow>
                          )}
                          {lista.map((e) => (
                            <TableRow
                              key={e.id}
                              className={!e.ativo ? "opacity-60" : ""}
                            >
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  <span className="font-mono text-sm">{e.ordem}</span>
                                  {e.ativo && podeEditar && (
                                    <div className="flex flex-col">
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-4 w-4 p-0"
                                        onClick={() =>
                                          reordenarMut.mutate({ etapa: e, direcao: "up" })
                                        }
                                      >
                                        <ArrowUp className="h-3 w-3" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-4 w-4 p-0"
                                        onClick={() =>
                                          reordenarMut.mutate({
                                            etapa: e,
                                            direcao: "down",
                                          })
                                        }
                                      >
                                        <ArrowDown className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-sm">{e.descricao}</TableCell>
                              <TableCell>
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-sm">
                                    {e.parceiro_nome ?? "—"}
                                  </span>
                                  <Badge
                                    variant="secondary"
                                    className="text-[10px] w-fit"
                                  >
                                    {tipoLabel(e.parceiro_tipo)}
                                  </Badge>
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                {e.lt_dias}
                              </TableCell>
                              <TableCell className="text-xs">
                                {e.lt_unidade}
                              </TableCell>
                              <TableCell className="text-xs">
                                {e.parceiro_contato ?? "—"}
                              </TableCell>
                              <TableCell className="text-xs">
                                {e.valido_desde
                                  ? new Date(e.valido_desde).toLocaleDateString("pt-BR")
                                  : "—"}
                              </TableCell>
                              <TableCell>
                                {e.ativo ? (
                                  <Badge variant="default">Ativo</Badge>
                                ) : (
                                  <Badge variant="outline">Inativo</Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-right space-x-1">
                                {e.ativo && podeEditar && (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setEditandoEtapa(e)}
                                      title="Editar"
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setTrocandoParceiro(e)}
                                      title="Trocar parceiro"
                                    >
                                      <Repeat className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => {
                                        if (
                                          confirm(
                                            `Desativar etapa "${e.descricao}"? Isso irá recalcular os parâmetros.`,
                                          )
                                        )
                                          desativarMut.mutate(e);
                                      }}
                                      title="Desativar"
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </Button>
                                  </>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          );
        })}
        {(!fornecedores || fornecedores.length === 0) && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Nenhum fornecedor habilitado para reposição.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Seção 3: histórico */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4" /> Histórico de mudanças
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(historico ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem mudanças registradas.</p>
          ) : (
            <ul className="space-y-2">
              {(historico ?? []).map((h) => (
                <li
                  key={h.id}
                  className="text-sm border-l-2 border-muted pl-3 py-1"
                >
                  <span className="text-muted-foreground text-xs">
                    {new Date(h.criado_em).toLocaleString("pt-BR")}
                  </span>{" "}
                  — <span className="font-medium">{h.fornecedor_nome}</span>:{" "}
                  {h.descricao_mudanca}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Modal Adicionar/Editar */}
      <EtapaFormDialog
        open={!!novaEtapaForn || !!editandoEtapa}
        modo={editandoEtapa ? "editar" : "criar"}
        fornecedor={editandoEtapa?.fornecedor_nome ?? novaEtapaForn ?? ""}
        etapa={editandoEtapa}
        onClose={() => {
          setNovaEtapaForn(null);
          setEditandoEtapa(null);
        }}
        onSave={(payload) => {
          salvarEtapaMut.mutate({
            modo: editandoEtapa ? "editar" : "criar",
            fornecedor: editandoEtapa?.fornecedor_nome ?? novaEtapaForn ?? "",
            etapa: payload,
            etapaOriginal: editandoEtapa ?? undefined,
          });
        }}
        saving={salvarEtapaMut.isPending}
      />

      {/* Modal Trocar parceiro */}
      <TrocaParceiroDialog
        etapa={trocandoParceiro}
        onClose={() => setTrocandoParceiro(null)}
        onConfirm={(args) =>
          trocarParceiroMut.mutate({ etapa: trocandoParceiro!, ...args })
        }
        saving={trocarParceiroMut.isPending}
      />
    </div>
  );
}
