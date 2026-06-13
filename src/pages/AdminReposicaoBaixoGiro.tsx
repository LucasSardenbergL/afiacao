import { useMemo, useState } from "react";
import { useBaixoGiro } from "@/components/reposicao/baixoGiro/useBaixoGiro";
import { BaixoGiroKpis } from "@/components/reposicao/baixoGiro/BaixoGiroKpis";
import { BaixoGiroFiltros } from "@/components/reposicao/baixoGiro/BaixoGiroFiltros";
import { BaixoGiroTable } from "@/components/reposicao/baixoGiro/BaixoGiroTable";
import { ManterEmEstoqueDialog } from "@/components/reposicao/baixoGiro/ManterEmEstoqueDialog";
import { Button } from "@/components/ui/button";
import type { FiltrosBaixoGiro, RowBaixoGiro } from "@/components/reposicao/baixoGiro/types";
import { toast } from "sonner";

export default function AdminReposicaoBaixoGiro() {
  const { rows, kpis, isLoading, manterEmEstoque, descontinuar } = useBaixoGiro();
  const [filtros, setFiltros] = useState<FiltrosBaixoGiro>({ situacao: "todos", estoque: "todos", busca: "" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dialogAlvos, setDialogAlvos] = useState<RowBaixoGiro[] | null>(null);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filtros.situacao !== "todos" && r.situacao_tipo !== filtros.situacao) return false;
      if (filtros.estoque === "com_estoque" && !(r.saldo && r.saldo > 0)) return false;
      if (filtros.estoque === "sem_estoque" && r.saldo && r.saldo > 0) return false;
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
      <BaixoGiroKpis {...kpis} />
      <BaixoGiroFiltros filtros={filtros} onChange={setFiltros} />
      {selected.size > 0 && (
        <Button
          onClick={() =>
            setDialogAlvos(filtered.filter((r) => selected.has(r.sku_codigo_omie)))
          }
        >
          Manter em estoque — {selected.size} selecionado(s)
        </Button>
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
        onDescontinuar={(r) => descontinuar.mutate(r.sku_codigo_omie)}
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
      {isLoading && (
        <div className="text-sm text-muted-foreground">Carregando…</div>
      )}
    </div>
  );
}
