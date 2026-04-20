import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useUserRole } from "@/hooks/useUserRole";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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

type Etapa = {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  ordem: number;
  etapa_codigo: string;
  descricao: string;
  lt_dias: number;
  lt_unidade: string;
  parceiro_nome: string | null;
  parceiro_tipo: string | null;
  parceiro_contato: string | null;
  ativo: boolean;
  valido_desde: string | null;
  valido_ate: string | null;
  observacoes: string | null;
};

type Fornecedor = {
  empresa: string;
  fornecedor_nome: string;
};

type HistoricoItem = {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  etapa_codigo: string | null;
  acao: string;
  descricao_mudanca: string;
  criado_em: string;
};

const TIPOS_PARCEIRO = [
  { value: "fabricante", label: "Fabricante" },
  { value: "transportadora_terceira", label: "Transportadora terceira" },
  { value: "transportadora_propria", label: "Transportadora própria" },
  { value: "agente_cambio", label: "Agente câmbio" },
  { value: "outros", label: "Outros" },
];

function tipoLabel(t: string | null) {
  return TIPOS_PARCEIRO.find((x) => x.value === t)?.label ?? t ?? "—";
}

const EMPRESA = "OBEN";

export default function AdminReposicaoCadeiaLogistica() {
  const { isAdmin } = useUserRole();
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
      const { data, error } = await (supabase as any)
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
      const { data, error } = await (supabase as any)
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
      const { data, error } = await (supabase as any)
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
    const { data } = await (supabase as any)
      .from("fornecedor_cadeia_logistica")
      .select("lt_dias")
      .eq("empresa", EMPRESA)
      .eq("fornecedor_nome", fornecedor)
      .eq("ativo", true);
    return ((data ?? []) as any[]).reduce(
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
    valoresAnt?: any;
    valoresNov?: any;
  }) {
    try {
      const ltDepois = await ltTotalAtualForn(args.fornecedor);
      const delta = ltDepois - args.ltAntes;

      // log histórico
      await (supabase as any).from("fornecedor_cadeia_logistica_historico").insert({
        empresa: EMPRESA,
        fornecedor_nome: args.fornecedor,
        etapa_codigo: args.etapa_codigo ?? null,
        acao: args.acao,
        descricao_mudanca: args.descricao,
        valores_anteriores: args.valoresAnt ?? null,
        valores_novos: args.valoresNov ?? null,
      });

      // chamar recálculo (best-effort)
      const { error: rpcErr } = await (supabase as any).rpc(
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
    } catch (e: any) {
      toast.warning(`Mudança salva mas recálculo falhou: ${e.message}`);
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

        const { error } = await (supabase as any)
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
          });
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
        const { error } = await (supabase as any)
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
    onError: (e: any) => toast.error(`Erro ao salvar: ${e.message}`),
  });

  // Desativar
  const desativarMut = useMutation({
    mutationFn: async (etapa: Etapa) => {
      const ltAntes = await ltTotalAtualForn(etapa.fornecedor_nome);
      const { error } = await (supabase as any)
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
    onError: (e: any) => toast.error(`Erro ao desativar: ${e.message}`),
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
      const { error: e1 } = await (supabase as any)
        .from("fornecedor_cadeia_logistica")
        .update({ ativo: false, valido_ate: args.dataTroca })
        .eq("id", args.etapa.id);
      if (e1) throw e1;

      // 2. Cria nova etapa com mesma ordem e código novo
      const novoCodigo = `${args.etapa.etapa_codigo}_T${Date.now().toString(36)}`;
      const { error: e2 } = await (supabase as any)
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
    onError: (e: any) => toast.error(`Erro ao trocar: ${e.message}`),
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
      const { error: e1 } = await (supabase as any)
        .from("fornecedor_cadeia_logistica")
        .update({ ordem: outro.ordem })
        .eq("id", args.etapa.id);
      if (e1) throw e1;
      const { error: e2 } = await (supabase as any)
        .from("fornecedor_cadeia_logistica")
        .update({ ordem: args.etapa.ordem })
        .eq("id", outro.id);
      if (e2) throw e2;

      await (supabase as any).from("fornecedor_cadeia_logistica_historico").insert({
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
    onError: (e: any) => toast.error(`Erro ao reordenar: ${e.message}`),
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

// =================== Subcomponentes ===================

function EtapaFormDialog({
  open,
  modo,
  fornecedor,
  etapa,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  modo: "criar" | "editar";
  fornecedor: string;
  etapa: Etapa | null;
  onClose: () => void;
  onSave: (e: Partial<Etapa>) => void;
  saving: boolean;
}) {
  const [descricao, setDescricao] = useState(etapa?.descricao ?? "");
  const [parceiroNome, setParceiroNome] = useState(etapa?.parceiro_nome ?? "");
  const [parceiroTipo, setParceiroTipo] = useState(etapa?.parceiro_tipo ?? "outros");
  const [parceiroContato, setParceiroContato] = useState(etapa?.parceiro_contato ?? "");
  const [ltDias, setLtDias] = useState<number>(etapa?.lt_dias ?? 1);
  const [unidade, setUnidade] = useState(etapa?.lt_unidade ?? "uteis");
  const [observacoes, setObservacoes] = useState(etapa?.observacoes ?? "");

  // resetar quando muda etapa
  useMemo(() => {
    if (open) {
      setDescricao(etapa?.descricao ?? "");
      setParceiroNome(etapa?.parceiro_nome ?? "");
      setParceiroTipo(etapa?.parceiro_tipo ?? "outros");
      setParceiroContato(etapa?.parceiro_contato ?? "");
      setLtDias(etapa?.lt_dias ?? 1);
      setUnidade(etapa?.lt_unidade ?? "uteis");
      setObservacoes(etapa?.observacoes ?? "");
    }
  }, [open, etapa]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {modo === "criar" ? "Adicionar etapa" : "Editar etapa"}
          </DialogTitle>
          <DialogDescription>{fornecedor}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Descrição</Label>
            <Input
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder="Ex: Sayerlack → Intermediária"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Parceiro</Label>
              <Input
                value={parceiroNome}
                onChange={(e) => setParceiroNome(e.target.value)}
                placeholder="Nome"
              />
            </div>
            <div>
              <Label>Tipo</Label>
              <Select value={parceiroTipo} onValueChange={setParceiroTipo}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIPOS_PARCEIRO.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Contato (email ou telefone)</Label>
            <Input
              value={parceiroContato}
              onChange={(e) => setParceiroContato(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>LT (dias)</Label>
              <Input
                type="number"
                min={0}
                value={ltDias}
                onChange={(e) => setLtDias(Number(e.target.value) || 0)}
                onFocus={(e) => e.target.select()}
              />
            </div>
            <div>
              <Label>Unidade</Label>
              <RadioGroup
                value={unidade}
                onValueChange={setUnidade}
                className="flex gap-4 mt-2"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="uteis" id="u-uteis" />
                  <Label htmlFor="u-uteis" className="font-normal text-sm">
                    Úteis
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="corridos" id="u-corridos" />
                  <Label htmlFor="u-corridos" className="font-normal text-sm">
                    Corridos
                  </Label>
                </div>
              </RadioGroup>
            </div>
          </div>
          <div>
            <Label>Observações</Label>
            <Textarea
              value={observacoes}
              onChange={(e) => setObservacoes(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() =>
              onSave({
                descricao,
                parceiro_nome: parceiroNome || null,
                parceiro_tipo: parceiroTipo,
                parceiro_contato: parceiroContato || null,
                lt_dias: ltDias,
                lt_unidade: unidade,
                observacoes: observacoes || null,
              })
            }
            disabled={saving || !descricao.trim() || ltDias < 0}
          >
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TrocaParceiroDialog({
  etapa,
  onClose,
  onConfirm,
  saving,
}: {
  etapa: Etapa | null;
  onClose: () => void;
  onConfirm: (args: {
    novoParceiro: string;
    novoTipo: string;
    novoContato: string;
    novoLt: number;
    novaUnidade: string;
    dataTroca: string;
  }) => void;
  saving: boolean;
}) {
  const [novoParceiro, setNovoParceiro] = useState("");
  const [novoTipo, setNovoTipo] = useState("transportadora_terceira");
  const [novoContato, setNovoContato] = useState("");
  const [novoLt, setNovoLt] = useState(etapa?.lt_dias ?? 1);
  const [unidade, setUnidade] = useState(etapa?.lt_unidade ?? "uteis");
  const [dataTroca, setDataTroca] = useState(
    new Date().toISOString().split("T")[0],
  );

  useMemo(() => {
    if (etapa) {
      setNovoParceiro("");
      setNovoTipo("transportadora_terceira");
      setNovoContato("");
      setNovoLt(etapa.lt_dias);
      setUnidade(etapa.lt_unidade);
      setDataTroca(new Date().toISOString().split("T")[0]);
    }
  }, [etapa]);

  return (
    <Dialog open={!!etapa} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Trocar parceiro</DialogTitle>
          <DialogDescription>
            Mantém a estrutura da etapa, registra o histórico do parceiro anterior e
            cria nova entrada com a nova vigência.
          </DialogDescription>
        </DialogHeader>
        {etapa && (
          <div className="space-y-3">
            <Card className="bg-muted/40">
              <CardContent className="pt-4 text-sm space-y-1">
                <div>
                  <span className="text-muted-foreground">Etapa atual:</span>{" "}
                  <span className="font-medium">{etapa.descricao}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Parceiro atual:</span>{" "}
                  {etapa.parceiro_nome ?? "—"} ({tipoLabel(etapa.parceiro_tipo)})
                </div>
                <div>
                  <span className="text-muted-foreground">LT atual:</span>{" "}
                  {etapa.lt_dias} {etapa.lt_unidade}
                </div>
              </CardContent>
            </Card>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Novo parceiro</Label>
                <Input
                  value={novoParceiro}
                  onChange={(e) => setNovoParceiro(e.target.value)}
                />
              </div>
              <div>
                <Label>Tipo</Label>
                <Select value={novoTipo} onValueChange={setNovoTipo}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIPOS_PARCEIRO.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Contato</Label>
              <Input
                value={novoContato}
                onChange={(e) => setNovoContato(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Novo LT</Label>
                <Input
                  type="number"
                  min={0}
                  value={novoLt}
                  onChange={(e) => setNovoLt(Number(e.target.value) || 0)}
                  onFocus={(e) => e.target.select()}
                />
              </div>
              <div>
                <Label>Unidade</Label>
                <Select value={unidade} onValueChange={setUnidade}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="uteis">Úteis</SelectItem>
                    <SelectItem value="corridos">Corridos</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Data da troca</Label>
                <Input
                  type="date"
                  value={dataTroca}
                  onChange={(e) => setDataTroca(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() =>
              onConfirm({
                novoParceiro,
                novoTipo,
                novoContato,
                novoLt,
                novaUnidade: unidade,
                dataTroca,
              })
            }
            disabled={saving || !novoParceiro.trim() || novoLt < 0}
          >
            {saving ? "Salvando..." : "Confirmar troca"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
