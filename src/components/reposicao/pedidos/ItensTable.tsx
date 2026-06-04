// Tabela de itens do pedido (com edição de quantidade e ações de remover/descontinuar).
// Extraída verbatim de src/components/reposicao/pedidos/DetalhesModal.tsx (god-component split).
import { Ban, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { getEstoqueZoneClass, formatBRL } from './shared';
import { type Linha } from './useDetalhesModal';
import { precoEditavelDaLinha } from './preco-edit';

interface ItensTableProps {
  linhas: Linha[];
  podeEditar: boolean;
  totalAtual: number;
  onEditQty: (id: number, raw: string) => void;
  podeEditarPreco: boolean;
  onEditPreco: (id: number, raw: string) => void;
  onRemover: (l: Linha) => void;
  onDescontinuar: (l: Linha) => void;
  removerPending: boolean;
  descontinuarPending: boolean;
}

export function ItensTable({
  linhas,
  podeEditar,
  totalAtual,
  onEditQty,
  podeEditarPreco,
  onEditPreco,
  onRemover,
  onDescontinuar,
  removerPending,
  descontinuarPending,
}: ItensTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[34%] min-w-[300px]">SKU / Descrição</TableHead>
          <TableHead className="text-right">Estoque atual</TableHead>
          <TableHead className="text-right">EM</TableHead>
          <TableHead className="text-right">PP</TableHead>
          <TableHead className="text-right">Emax</TableHead>
          <TableHead className="text-right">Qtde sugerida</TableHead>
          <TableHead className="text-right">Qtde final</TableHead>
          <TableHead className="text-right">Preço</TableHead>
          <TableHead className="text-right">Valor linha</TableHead>
          {podeEditar && <TableHead className="text-right">Ações</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {linhas.map((l) => {
          const estoque = Number(l.estoque_atual ?? 0);
          const minimo = Number(l.estoque_minimo ?? 0);
          const pp = Number(l.ponto_pedido ?? 0);
          const zoneClass = getEstoqueZoneClass(estoque, minimo, pp);
          const sugerida = Number(l.qtde_sugerida ?? 0);
          return (
          <TableRow key={l.id}>
            <TableCell className="align-top whitespace-normal">
              <div className="font-mono text-xs text-muted-foreground">{l.sku_codigo_omie}</div>
              <div className="text-sm font-medium whitespace-normal break-words leading-snug">
                {l.sku_descricao ?? '—'}
              </div>
              <div className="flex gap-1 mt-1">
                {l.primeira_compra && (
                  <Badge variant="destructive" className="text-[10px] h-4">primeira compra</Badge>
                )}
                {l.ajustado_humano && (
                  <Badge variant="outline" className="text-[10px] h-4">ajustado</Badge>
                )}
              </div>
            </TableCell>
            <TableCell className={`text-right tabular-nums ${zoneClass}`}>{estoque.toFixed(0)}</TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">{minimo.toFixed(0)}</TableCell>
            <TableCell className="text-right tabular-nums">{pp.toFixed(0)}</TableCell>
            <TableCell className="text-right tabular-nums">{Number(l.estoque_maximo ?? 0).toFixed(0)}</TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">{sugerida.toFixed(0)}</TableCell>
            <TableCell className="text-right">
              {podeEditar ? (
                <Input
                  type="number"
                  min={0}
                  step="1"
                  className="h-8 w-24 ml-auto text-right tabular-nums"
                  value={l._qtd}
                  onChange={(e) => onEditQty(l.id, e.target.value)}
                />
              ) : (
                <span className={cn(
                  "tabular-nums",
                  l._qtd !== sugerida && "font-semibold text-status-warning",
                )}>{l._qtd.toFixed(0)}</span>
              )}
            </TableCell>
            <TableCell className="text-right">
              {precoEditavelDaLinha(podeEditarPreco, l) ? (
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="custo"
                  className="h-8 w-24 ml-auto text-right tabular-nums border-status-warning/60"
                  value={l._preco || ''}
                  onChange={(e) => onEditPreco(l.id, e.target.value)}
                />
              ) : (
                <span className="tabular-nums">{formatBRL(l._preco)}</span>
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums font-medium">{formatBRL(l._valor)}</TableCell>
            {podeEditar && (
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Remover linha deste pedido"
                    onClick={() => onRemover(l)}
                    disabled={removerPending || descontinuarPending}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Remover linha + descontinuar SKU"
                    className="text-destructive hover:text-destructive"
                    onClick={() => onDescontinuar(l)}
                    disabled={removerPending || descontinuarPending}
                  >
                    <Ban className="w-4 h-4" />
                  </Button>
                </div>
              </TableCell>
            )}
          </TableRow>
          );
        })}
        <TableRow>
          <TableCell colSpan={8} className="text-right font-medium">Total</TableCell>
          <TableCell className="text-right font-bold tabular-nums">{formatBRL(totalAtual)}</TableCell>
          {podeEditar && <TableCell />}
        </TableRow>
      </TableBody>
    </Table>
  );
}
