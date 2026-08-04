import { useMemo, useState } from "react";
import { useBaixoGiro } from "@/components/reposicao/baixoGiro/useBaixoGiro";
import { useExcessoEstoque } from "@/components/reposicao/baixoGiro/useExcessoEstoque";
import { BaixoGiroKpis } from "@/components/reposicao/baixoGiro/BaixoGiroKpis";
import { BaixoGiroFiltros } from "@/components/reposicao/baixoGiro/BaixoGiroFiltros";
import { BaixoGiroTable } from "@/components/reposicao/baixoGiro/BaixoGiroTable";
import { ExcessoKpis } from "@/components/reposicao/baixoGiro/ExcessoKpis";
import { ExcessoTable } from "@/components/reposicao/baixoGiro/ExcessoTable";
import { ManterEmEstoqueDialog } from "@/components/reposicao/baixoGiro/ManterEmEstoqueDialog";
import { DesovaMissaoDialog } from "@/components/reposicao/baixoGiro/DesovaMissaoDialog";
import { useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import type { FiltrosBaixoGiro, RowBaixoGiro, RowExcesso } from "@/components/reposicao/baixoGiro/types";
import { track } from "@/lib/analytics";
import { toast } from "sonner";

/** Alvo comum dos dois fluxos de descontinuação (baixo giro e excesso). */
type AlvoDescontinuar = Pick<RowBaixoGiro, "sku_codigo_omie" | "sku_descricao">;

function exportarCsvExcesso(rows: RowExcesso[]) {
  const head = ["sku", "descricao", "fornecedor", "classe", "saldo", "estoque_maximo", "excedente_un", "capital_excedente_rs", "digere_em_dias", "dias_sem_vender", "situacao"];
  const linhas = rows.map((r) =>
    [
      r.sku_codigo_omie,
      JSON.stringify(r.sku_descricao ?? ""),
      JSON.stringify(r.fornecedor_nome ?? ""),
      r.classe_consolidada ?? "",
      r.saldo ?? "",
      r.estoque_maximo ?? "",
      r.excedente_un,
      r.capital_excedente ?? "",
      r.tempo_digerir_dias ?? "",
      r.dias_sem_vender ?? "",
      r.situacao_excesso,
    ].join(","),
  );
  const blob = new Blob([head.join(",") + "\n" + linhas.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `excesso-estoque-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AdminReposicaoBaixoGiro() {
  const { rows, kpis, isLoading, manterEmEstoque, descontinuar, descontinuarLote, sobEncomendaLote } = useBaixoGiro();
  const excesso = useExcessoEstoque();
  const [filtros, setFiltros] = useState<FiltrosBaixoGiro>({ situacao: "todos", estoque: "todos", giro: "todos", busca: "" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dialogAlvos, setDialogAlvos] = useState<RowBaixoGiro[] | null>(null);
  const [descontinuarAlvo, setDescontinuarAlvo] = useState<AlvoDescontinuar | null>(null);
  const [loteAlvos, setLoteAlvos] = useState<RowBaixoGiro[] | null>(null);
  const [missaoAlvos, setMissaoAlvos] = useState<RowExcesso[] | null>(null); // desova (PR2 Cabreúva)
  const { empresa } = useReposicaoEmpresa();
  const [sobEncomendaAlvos, setSobEncomendaAlvos] = useState<RowBaixoGiro[] | null>(null);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filtros.situacao !== "todos" && r.situacao_tipo !== filtros.situacao) return false;
      if (filtros.estoque === "com_estoque" && !(r.saldo && r.saldo > 0)) return false;
      if (filtros.estoque === "sem_estoque" && r.saldo && r.saldo > 0) return false;
      if (filtros.giro === "morto" && !r.giro_morto) return false;
      if (filtros.giro === "sob_encomenda_candidato" && !r.candidato_sob_encomenda) return false;
      const s = filtros.busca.trim().toLowerCase();
      if (s) {
        const byCode = /^\d+$/.test(s) ? String(r.sku_codigo_omie).includes(s) : false;
        const byDesc = (r.sku_descricao ?? "").toLowerCase().includes(s);
        if (!byCode && !byDesc) return false;
      }
      return true;
    });
  }, [rows, filtros]);

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="font-display text-3xl">Baixo giro &amp; estoque parado</h1>
      </header>
      <Tabs
        defaultValue="baixo-giro"
        onValueChange={(v) => {
          if (v === "excesso") track("reposicao.excesso_aba_aberta");
        }}
      >
        <TabsList>
          <TabsTrigger value="baixo-giro">Baixo giro</TabsTrigger>
          <TabsTrigger value="excesso">Excesso de estoque{excesso.kpis.skusN > 0 ? ` (${excesso.kpis.skusN})` : ""}</TabsTrigger>
        </TabsList>

        <TabsContent value="baixo-giro" className="space-y-4">
          <BaixoGiroKpis {...kpis} />
          <BaixoGiroFiltros filtros={filtros} onChange={setFiltros} />
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() =>
                  setDialogAlvos(filtered.filter((r) => selected.has(r.sku_codigo_omie)))
                }
              >
                Manter em estoque — {selected.size} selecionado(s)
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  setLoteAlvos(filtered.filter((r) => selected.has(r.sku_codigo_omie)))
                }
              >
                Descontinuar — {selected.size} selecionado(s)
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  setSobEncomendaAlvos(filtered.filter((r) => selected.has(r.sku_codigo_omie)))
                }
              >
                Sob encomenda — {selected.size} selecionado(s)
              </Button>
            </div>
          )}
          <BaixoGiroTable
            rows={filtered}
            selected={selected}
            onToggle={(c) =>
              setSelected((prev) => {
                const n = new Set(prev);
                if (n.has(c)) n.delete(c);
                else n.add(c);
                return n;
              })
            }
            onToggleAll={(codes) =>
              setSelected((prev) =>
                prev.size === codes.length ? new Set() : new Set(codes)
              )
            }
            onResolverBloqueio={(r) =>
              toast.info(
                `Resolver: ${r.situacao_label} — ${r.sku_descricao ?? r.sku_codigo_omie}`
              )
            }
            onManter={(r) => setDialogAlvos([r])}
            onDescontinuar={(r) => setDescontinuarAlvo(r)}
          />
          {isLoading && (
            <div className="text-sm text-muted-foreground">Carregando…</div>
          )}
        </TabsContent>

        <TabsContent value="excesso" className="space-y-4">
          <ExcessoKpis {...excesso.kpis} />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Estoque acima do máximo da política. Tempo de digestão pela demanda média (90d) — o motor não
              compra estes SKUs enquanto estiverem acima do ponto; a saída é comercial (queima/kit) ou descontinuar.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={excesso.rows.length === 0}
                onClick={() => setMissaoAlvos(excesso.rows)}
              >
                Criar missão de desova ({excesso.rows.length})
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={excesso.rows.length === 0}
                onClick={() => {
                  exportarCsvExcesso(excesso.rows);
                  track("reposicao.excesso_export_csv", { skus: excesso.rows.length });
                }}
              >
                Exportar CSV
              </Button>
            </div>
          </div>
          <ExcessoTable
            rows={excesso.rows}
            onDescontinuar={(r) => setDescontinuarAlvo(r)}
            onCriarMissao={(r) => setMissaoAlvos([r])}
          />
          {excesso.isLoading && (
            <div className="text-sm text-muted-foreground">Carregando…</div>
          )}
          {excesso.error != null && (
            <div className="text-sm text-status-error">
              Não consegui ler a posição de estoque — a fila pode estar incompleta. Recarregue a página.
            </div>
          )}
        </TabsContent>
      </Tabs>

      <DesovaMissaoDialog
        open={!!missaoAlvos}
        onOpenChange={(v) => { if (!v) setMissaoAlvos(null); }}
        alvos={missaoAlvos ?? []}
        empresa={empresa.toLowerCase()}
      />
      <ManterEmEstoqueDialog
        open={!!dialogAlvos}
        onOpenChange={(v) => {
          if (!v) setDialogAlvos(null);
        }}
        alvos={dialogAlvos ?? []}
        saving={manterEmEstoque.isPending}
        onConfirm={({ motivo: _motivo, ...rest }) => {
          manterEmEstoque.mutate(rest, {
            onSuccess: () => {
              setDialogAlvos(null);
              setSelected(new Set());
            },
          });
        }}
      />
      <AlertDialog open={!!descontinuarAlvo} onOpenChange={(v) => { if (!v) setDescontinuarAlvo(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descontinuar SKU?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono">{descontinuarAlvo?.sku_codigo_omie}</span>
              {descontinuarAlvo?.sku_descricao ? ` — ${descontinuarAlvo.sku_descricao}` : ""}
              <br />
              O item sai dos próximos ciclos de reposição automática. Você pode reativá-lo depois pela tela de Revisão.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (descontinuarAlvo) descontinuar.mutate(descontinuarAlvo.sku_codigo_omie);
                setDescontinuarAlvo(null);
              }}
            >
              Descontinuar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!loteAlvos} onOpenChange={(v) => { if (!v) setLoteAlvos(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descontinuar {loteAlvos?.length ?? 0} SKU(s)?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <div className="max-h-48 overflow-y-auto rounded-md border p-2 text-xs">
                  {(loteAlvos ?? []).map((r) => (
                    <div key={r.sku_codigo_omie} className="flex justify-between gap-2 py-0.5">
                      <span className="truncate">{r.sku_descricao ?? r.sku_codigo_omie}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {r.dias_sem_vender != null ? `${r.dias_sem_vender}d s/ venda` : r.vendas_registradas <= 0 ? "sem venda no histórico" : "—"}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-2">
                  Os itens saem dos próximos ciclos de reposição automática. Reativação individual pela tela de Revisão.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const codes = (loteAlvos ?? []).map((r) => r.sku_codigo_omie);
                if (codes.length > 0) {
                  descontinuarLote.mutate(codes, { onSuccess: () => setSelected(new Set()) });
                  track("reposicao.giro_morto_descontinuar_lote", { skus: codes.length });
                }
                setLoteAlvos(null);
              }}
            >
              Descontinuar {loteAlvos?.length ?? 0} SKU(s)
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!sobEncomendaAlvos} onOpenChange={(v) => { if (!v) setSobEncomendaAlvos(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Marcar {sobEncomendaAlvos?.length ?? 0} SKU(s) como sob encomenda?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <div className="max-h-48 overflow-y-auto rounded-md border p-2 text-xs">
                  {(sobEncomendaAlvos ?? []).map((r) => (
                    <div key={r.sku_codigo_omie} className="flex justify-between gap-2 py-0.5">
                      <span className="truncate">{r.sku_descricao ?? r.sku_codigo_omie}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {r.vendas_registradas} venda(s) no histórico
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-2">
                  O motor para de repor (o item vira order-driven: compra-se quando o cliente pede e ele
                  espera o lead time). O estoque atual escoa normalmente. Reversível pela tela de Revisão.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const codes = (sobEncomendaAlvos ?? []).map((r) => r.sku_codigo_omie);
                if (codes.length > 0) {
                  sobEncomendaLote.mutate(codes, { onSuccess: () => setSelected(new Set()) });
                  track("reposicao.sob_encomenda_lote", { skus: codes.length });
                }
                setSobEncomendaAlvos(null);
              }}
            >
              Marcar sob encomenda
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
