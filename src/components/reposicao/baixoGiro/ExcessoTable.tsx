import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtBRL } from "@/lib/reposicao/sku-param";
import type { SituacaoExcesso } from "@/lib/reposicao/excesso-helpers";
import type { RowExcesso } from "./types";

const SITUACAO_LABEL: Record<SituacaoExcesso, { label: string; cls: string }> = {
  digerivel: { label: "Venda digere", cls: "text-status-success" },
  estrutural: { label: "Estrutural", cls: "text-status-warning" },
  sem_giro: { label: "Sem giro", cls: "text-status-error" },
};

export function ExcessoTable({ rows, onDescontinuar, onCriarMissao }: {
  rows: RowExcesso[];
  onDescontinuar: (r: RowExcesso) => void;
  onCriarMissao?: (r: RowExcesso) => void; // desova (PR2 Cabreúva): excesso → tarefa comercial
}) {
  if (rows.length === 0) {
    return <div className="rounded-md border p-6 text-sm text-muted-foreground">Nenhum SKU com estoque acima do máximo da política.</div>;
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>SKU</TableHead>
            <TableHead className="text-center">Classe</TableHead>
            <TableHead className="text-right">Saldo / Máx</TableHead>
            <TableHead className="text-right">Excedente</TableHead>
            <TableHead className="text-right">Capital excedente</TableHead>
            <TableHead className="text-right">Digere em</TableHead>
            <TableHead className="text-right">Últ. venda</TableHead>
            <TableHead className="text-center">Situação</TableHead>
            <TableHead className="text-right">Ação</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const sit = SITUACAO_LABEL[r.situacao_excesso];
            const reposicaoDesligada = r.habilitado_reposicao_automatica === false || r.tipo_reposicao === "descontinuado";
            return (
              <TableRow key={r.id}>
                <TableCell>
                  <div className="font-medium">{r.sku_descricao ?? r.sku_codigo_omie}</div>
                  <div className="font-mono text-xs text-muted-foreground">{r.sku_codigo_omie}{r.fornecedor_nome ? ` · ${r.fornecedor_nome}` : ""}</div>
                </TableCell>
                <TableCell className="text-center"><Badge variant="outline">{r.classe_consolidada ?? "—"}</Badge></TableCell>
                <TableCell className="text-right tnum">{r.saldo ?? "—"} / {r.estoque_maximo ?? "—"}</TableCell>
                <TableCell className="text-right tnum font-medium">{r.excedente_un}</TableCell>
                <TableCell className="text-right tnum font-medium">
                  {r.capital_excedente != null ? fmtBRL(r.capital_excedente) : <span className="text-status-warning">sem custo</span>}
                </TableCell>
                <TableCell className="text-right tnum">
                  {r.tempo_digerir_dias != null ? `${r.tempo_digerir_dias}d` : "—"}
                </TableCell>
                <TableCell className="text-right tnum">
                  {r.dias_sem_vender != null ? `há ${r.dias_sem_vender}d` : "nunca"}
                </TableCell>
                <TableCell className="text-center">
                  <span className={`text-xs font-medium ${sit.cls}`}>{sit.label}</span>
                  {reposicaoDesligada && (
                    <div className="text-xs text-muted-foreground">reposição off</div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {onCriarMissao && (
                      <Button variant="outline" size="sm" onClick={() => onCriarMissao(r)}>
                        Desovar
                      </Button>
                    )}
                    {!reposicaoDesligada && (
                      <Button variant="outline" size="sm" onClick={() => onDescontinuar(r)}>
                        Descontinuar
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
