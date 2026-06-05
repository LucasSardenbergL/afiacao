// Painel "Embalagem econômica" no modal de pedido: mostra, por SKU multi-embalagem,
// a recomendação (menor custo por unidade-base) e permite informar o preço manualmente.
// Spec: docs/superpowers/specs/2026-06-04-embalagem-economica-design.md
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Package, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { formatBRL } from './shared';
import type { PedidoItem } from './types';
import { useEmbalagemPedido } from './useEmbalagemPedido';

export function EmbalagemPanel({ empresa, itens }: { empresa: string; itens: PedidoItem[] }) {
  const { porSku, isLoading } = useEmbalagemPedido(empresa, itens);
  const { user } = useAuth();
  const qc = useQueryClient();
  const [precoDialog, setPrecoDialog] = useState<null | { skus: string[] }>(null);
  const [precos, setPrecos] = useState<Record<string, string>>({});

  const salvarPrecos = useMutation({
    mutationFn: async (entries: { sku: string; preco: number }[]) => {
      const rows = entries.map((e) => ({
        empresa,
        sku_codigo_omie: e.sku,
        fornecedor_nome: 'Sayerlack',
        preco: e.preco,
        moeda: 'BRL',
        preco_tipo: 'liquido',
        fonte: 'manual_usuario',
        status: 'ok',
        criado_por: user?.email ?? 'sistema',
      }));
      const { error } = await supabase.from('sku_preco_fornecedor_capturado' as never).insert(rows as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Preços atualizados');
      qc.invalidateQueries({ queryKey: ['embalagem-pedido'] });
      setPrecoDialog(null);
      setPrecos({});
    },
    onError: (e: Error) => toast.error(`Erro ao salvar preços: ${e.message}`),
  });

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
                      {d.economia_vs_alternativa > 0 && <> · economia {formatBRL(d.economia_vs_alternativa)}</>}
                      {d.excedente_base > 0 && <> · excedente {d.excedente_base} un-base</>}
                      {d.status === 'marginal' && <> · <span className="text-status-warning">ganho marginal — confira</span></>}
                    </div>
                    {d.flags.includes('preco_desatualizado') && (
                      <div className="text-status-warning text-xs">Preço pode estar desatualizado — confira/atualize.</div>
                    )}
                    {d.flags.includes('escoamento_nao_estimado') && (
                      <div className="text-muted-foreground text-xs">Escoamento do excedente não estimado (sem demanda).</div>
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

      <Dialog open={!!precoDialog} onOpenChange={(o) => !o && setPrecoDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Atualizar preços (do portal)</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {precoDialog?.skus.map((sku) => (
              <div key={sku}>
                <Label>{sku}</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="Preço atual"
                  value={precos[sku] ?? ''}
                  onChange={(e) => setPrecos((p) => ({ ...p, [sku]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrecoDialog(null)}>Cancelar</Button>
            <Button
              disabled={salvarPrecos.isPending}
              onClick={() => {
                const entries = (precoDialog?.skus ?? [])
                  .map((sku) => ({ sku, preco: Number(String(precos[sku] ?? '').replace(',', '.')) }))
                  .filter((e) => e.preco > 0);
                if (entries.length === 0) {
                  toast.error('Informe ao menos um preço > 0');
                  return;
                }
                salvarPrecos.mutate(entries);
              }}
            >
              {salvarPrecos.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
