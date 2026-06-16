// Painel "Embalagem econômica" no modal de pedido: mostra, por SKU multi-embalagem,
// a recomendação (menor custo por unidade-base) e permite informar o preço manualmente.
// O dialog de preço é compartilhado com a tela avulsa (PrecoEmbalagemDialog).
// Spec: docs/superpowers/specs/2026-06-04-embalagem-economica-design.md
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Package } from 'lucide-react';
import { formatBRL } from './shared';
import type { PedidoItem } from './types';
import { useEmbalagemPedido } from './useEmbalagemPedido';
import { PrecoEmbalagemDialog } from '@/components/reposicao/embalagem/PrecoEmbalagemDialog';

export function EmbalagemPanel({ empresa, itens }: { empresa: string; itens: PedidoItem[] }) {
  const { porSku, isLoading } = useEmbalagemPedido(empresa, itens);
  const [precoDialog, setPrecoDialog] = useState<null | { skus: string[] }>(null);

  const itensComGrupo = (itens ?? []).filter((i) => porSku[String(i.sku_codigo_omie)]);
  if (isLoading || itensComGrupo.length === 0) return null; // só aparece quando há item multi-embalagem

  return (
    <>
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Package className="h-4 w-4" /> Embalagem econômica
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {itensComGrupo.map((item) => {
            const info = porSku[String(item.sku_codigo_omie)];
            const d = info.decisao;
            return (
              <div key={item.id} className="border rounded p-3 text-sm space-y-1">
                <div className="font-medium">{item.sku_descricao ?? item.sku_codigo_omie}</div>
                {d.status === 'indisponivel' ? (
                  <div className="text-muted-foreground">Informe os preços de cada embalagem pra ver a recomendação.</div>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {d.opcoes.map((o) => (
                        <Badge key={o.sku_codigo_omie} variant={o.sku_codigo_omie === d.recomendada ? 'default' : 'outline'}>
                          {o.sku_codigo_omie}: {formatBRL(o.custo_por_base)}/un-base{o.preco_status === 'stale' ? ' ⚠' : ''}
                        </Badge>
                      ))}
                    </div>
                    <div className="text-muted-foreground">
                      Recomendado: <span className="font-medium text-foreground">{d.recomendada}</span>
                      {d.economia_vs_alternativa > 0 && (
                        <> · economia {formatBRL(d.economia_vs_alternativa)}
                          {d.flags.includes('sobra_antecipa_compra') ? ' (ao preço de hoje, contando a sobra como estoque)' : ''}</>
                      )}
                      {d.excedente_base > 0 && (
                        <>
                          {' '}· sobra {d.excedente_base} un-base
                          {d.flags.includes('sobra_antecipa_compra') && d.dias_escoamento_sobra != null
                            ? ` — vira estoque, escoa em ~${Math.ceil(d.dias_escoamento_sobra)}d`
                            : ''}
                        </>
                      )}
                      {d.status === 'marginal' && <> · <span className="text-status-warning">ganho marginal — confira</span></>}
                    </div>
                    {d.flags.includes('preco_desatualizado') && (
                      <div className="text-status-warning text-xs">Preço pode estar desatualizado — confira/atualize.</div>
                    )}
                    {d.flags.includes('escoamento_nao_estimado') && (
                      <div className="text-muted-foreground text-xs">Sem giro registrado — recomendado pelo menor custo por unidade-base; confira se o item gira.</div>
                    )}
                  </>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-1"
                  onClick={() => setPrecoDialog({ skus: info.skusGrupo })}
                >
                  Atualizar preços
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <PrecoEmbalagemDialog
        empresa={empresa}
        skus={precoDialog?.skus ?? []}
        open={!!precoDialog}
        onOpenChange={(o) => !o && setPrecoDialog(null)}
      />
    </>
  );
}
