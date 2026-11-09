// Atribuir grupo de produção em LOTE, por fornecedor. Medido em prod (2026-10-31): 13 SKUs sem grupo
// parados desde maio, 12 da Sayerlack — que tem grupos cadastrados. Um a um pelo drill-down eram 12
// aberturas de painel; aqui é marcar os SKUs do mesmo grupo e atribuir de uma vez.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Layers } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { track } from "@/lib/analytics";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { atribuirGrupoAosSkus } from "./api";
import { agruparPorFornecedor, idadeDias, type EventoOutlier, type LoteSemGrupo } from "./types";

function LoteFornecedor({
  lote, usuarioEmail, onConcluido,
}: {
  lote: LoteSemGrupo;
  usuarioEmail?: string | null;
  onConcluido: () => void;
}) {
  const [marcados, setMarcados] = useState<Set<number>>(() => new Set(lote.eventos.map((e) => e.id)));
  const [grupoId, setGrupoId] = useState("");

  const { data: grupos, isLoading: carregandoGrupos, error: erroGrupos } = useQuery({
    enabled: !!lote.fornecedor,
    queryKey: ["grupos-fornecedor", lote.empresa, lote.fornecedor],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_grupo_producao")
        .select("id, grupo_codigo, descricao, lt_producao_dias")
        .eq("empresa", lote.empresa)
        .eq("fornecedor_nome", lote.fornecedor)
        .order("grupo_codigo");
      if (error) throw error;
      return data ?? [];
    },
  });

  const mut = useMutation({
    mutationFn: async () => {
      const grupo = (grupos ?? []).find((g) => String(g.id) === grupoId);
      if (!grupo) throw new Error("Selecione um grupo");
      const eventos = lote.eventos.filter((e) => marcados.has(e.id));
      if (eventos.length === 0) throw new Error("Marque ao menos um SKU");
      return atribuirGrupoAosSkus({ empresa: lote.empresa, eventos, grupo, usuarioEmail });
    },
    onSuccess: (r) => {
      track("reposicao.alerta_grupo_atribuido", {
        quantidade: r.atribuidos,
        lote: true,
        falhou: !!r.falha,
        recalculo_falhou: r.recalculoFalhou,
      });
      if (r.falha) {
        toast.error(`${r.atribuidos} SKU(s) classificado(s); parou no ${r.falha.sku}: ${r.falha.mensagem}`);
      } else if (r.recalculoFalhou) {
        toast.warning(`${r.atribuidos} SKU(s) classificado(s), mas o recálculo de parâmetros falhou — rode-o de novo na Revisão de parâmetros`);
      } else {
        toast.success(`${r.atribuidos} SKU(s) classificado(s) e parâmetros recalculados`);
      }
      setGrupoId("");
      onConcluido();
    },
    onError: (err: Error) => toast.error(err.message ?? "Erro ao atribuir grupo"),
  });

  const toggle = (id: number) => {
    const next = new Set(marcados);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setMarcados(next);
  };

  const qtd = lote.eventos.filter((e) => marcados.has(e.id)).length;
  const semGrupoCadastrado = !carregandoGrupos && !erroGrupos && (grupos ?? []).length === 0;

  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium">{lote.fornecedor || "Fornecedor não informado"}</div>
        <div className="text-xs text-muted-foreground">
          {lote.empresa} · {lote.eventos.length} SKU(s) sem grupo
        </div>
      </div>

      <ul className="grid gap-1 sm:grid-cols-2">
        {lote.eventos.map((e) => {
          const idade = idadeDias(e.detectado_em);
          return (
            <li key={e.id} className="flex items-start gap-2 text-sm">
              <Checkbox
                id={`sg-${e.id}`}
                checked={marcados.has(e.id)}
                onCheckedChange={() => toggle(e.id)}
                className="mt-0.5"
              />
              <label htmlFor={`sg-${e.id}`} className="leading-tight cursor-pointer">
                {e.sku_descricao ?? e.sku_codigo_omie}
                <span className="block text-xs text-muted-foreground font-mono">
                  {e.sku_codigo_omie}{idade !== null ? ` · há ${idade} d` : ""}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[240px] flex-1">
          <Label className="text-xs">Grupo de produção</Label>
          <Select value={grupoId} onValueChange={setGrupoId} disabled={!grupos?.length}>
            <SelectTrigger>
              <SelectValue placeholder={carregandoGrupos ? "Carregando grupos…" : "Selecione o grupo"} />
            </SelectTrigger>
            <SelectContent>
              {(grupos ?? []).map((g) => (
                <SelectItem key={g.id} value={String(g.id)}>
                  {g.grupo_codigo} — {g.descricao} (LT {g.lt_producao_dias}d)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button disabled={!grupoId || qtd === 0 || mut.isPending} onClick={() => mut.mutate()}>
          {mut.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          Atribuir {qtd} SKU(s)
        </Button>
      </div>
      {erroGrupos && (
        <p className="text-xs text-status-error">Não foi possível carregar os grupos deste fornecedor.</p>
      )}
      {semGrupoCadastrado && (
        <p className="text-xs text-muted-foreground">
          Nenhum grupo cadastrado para este fornecedor — cadastre o grupo de produção antes de classificar.
        </p>
      )}
    </div>
  );
}

export function SemGrupoLote({
  eventos, usuarioEmail, onConcluido,
}: {
  eventos: EventoOutlier[];
  usuarioEmail?: string | null;
  onConcluido: () => void;
}) {
  const lotes = useMemo(() => agruparPorFornecedor(eventos), [eventos]);
  if (lotes.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Layers className="h-4 w-4" />
          Classificar SKUs sem grupo de produção
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          O grupo define o LT de produção usado pelo motor. Marque os SKUs do mesmo grupo e atribua de uma vez;
          o alerta fecha e os parâmetros são recalculados.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {lotes.map((l) => (
          <LoteFornecedor key={l.chave} lote={l} usuarioEmail={usuarioEmail} onConcluido={onConcluido} />
        ))}
      </CardContent>
    </Card>
  );
}
