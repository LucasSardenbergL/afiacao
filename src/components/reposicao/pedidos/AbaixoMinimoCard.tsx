import { useState } from 'react';
import { Ban, ChevronDown, ChevronRight, Eye } from 'lucide-react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBRL } from './shared';
import { OverrideMinimoButton } from './OverrideMinimoButton';
import type { PedidoSugerido } from './types';

// Seção NEUTRA (recolhida) da fila de atenção: pedidos barrados pelo gate de
// mínimo de faturamento Sayerlack (< R$3k). São benignos — o motor re-sugere o
// SKU no próximo ciclo se ele seguir abaixo do ponto, ou o estoque normaliza —
// então NÃO ficam no vermelho de "precisa de atenção". Mas seguem VISÍVEIS
// (contador + total + mais antigo + ação), porque o risco residual é stockout
// silencioso, não compra-dupla.
//
// ⚠️ Copy honesta (Codex xhigh): NÃO prometemos "vai acumular até R$3k" — nos
// dados reais, pedidos já tinham normalizado sem aguardar nada. Só descrevemos o
// estado factual (barrado; pode reaparecer OU sumir).
export function AbaixoMinimoCard({
  pedidos,
  podeOverride,
  onDetalhes,
  onOverride,
  disparandoLinha,
}: {
  pedidos: PedidoSugerido[];
  podeOverride: boolean;
  onDetalhes: (p: PedidoSugerido) => void;
  onOverride: (id: number) => void;
  disparandoLinha: (id: number) => boolean;
}) {
  const [aberto, setAberto] = useState(false);
  if (pedidos.length === 0) return null;

  const total = pedidos.reduce((s, p) => s + Number(p.valor_total ?? 0), 0);
  // Mais antigo pela data do ciclo (YYYY-MM-DD ordena lexicograficamente).
  const maisAntigo = pedidos.reduce(
    (min, p) => (p.data_ciclo < min ? p.data_ciclo : min),
    pedidos[0].data_ciclo,
  );

  return (
    <Card className="border-border">
      <CardHeader className="cursor-pointer select-none" onClick={() => setAberto((v) => !v)}>
        <CardTitle className="text-base flex items-center gap-2 text-muted-foreground">
          {aberto ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <Ban className="w-4 h-4" />
          Barrados pelo mínimo de faturamento ({pedidos.length})
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Não enviados porque ficaram abaixo do mínimo do fornecedor (R$3k). Podem reaparecer
          sozinhos se o SKU continuar abaixo do ponto — ou somem quando o estoque normaliza. Não
          exigem ação. Total {formatBRL(total)} · mais antigo{' '}
          {format(new Date(maisAntigo + 'T12:00:00'), 'dd/MM/yyyy')}.
        </p>
      </CardHeader>
      {aberto && (
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ciclo</TableHead>
                <TableHead>Fornecedor / Grupo</TableHead>
                <TableHead className="text-right">Nº SKUs</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pedidos.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-xs tabular-nums whitespace-nowrap">
                    {format(new Date(p.data_ciclo + 'T12:00:00'), 'dd/MM/yyyy')}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{p.fornecedor_nome}</div>
                    <div className="text-xs text-muted-foreground">{p.grupo_codigo ?? '—'}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.num_skus}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatBRL(p.valor_total)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => onDetalhes(p)}>
                        <Eye className="w-4 h-4 mr-1" />Detalhes
                      </Button>
                      {podeOverride && (
                        <OverrideMinimoButton
                          fornecedorNome={p.fornecedor_nome}
                          valorTotal={p.valor_total}
                          onConfirm={() => onOverride(p.id)}
                          disabled={disparandoLinha(p.id) || p.status_envio_portal === 'enviando_portal'}
                        />
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
  );
}
