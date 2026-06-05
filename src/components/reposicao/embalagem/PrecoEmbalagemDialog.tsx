// Dialog de preço manual de embalagem (do portal Sayerlack).
// Compartilhado entre o EmbalagemPanel (modal de pedido sugerido) e a tela avulsa
// de consulta de compra manual (AdminReposicaoEmbalagem).
// Spec: docs/superpowers/specs/2026-06-04-embalagem-economica-design.md
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

export function PrecoEmbalagemDialog({
  empresa,
  skus,
  open,
  onOpenChange,
  labels,
}: {
  empresa: string;
  skus: string[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** rótulo amigável por sku (descrição do Omie); fallback = código */
  labels?: Record<string, string>;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [precos, setPrecos] = useState<Record<string, string>>({});

  const salvar = useMutation({
    mutationFn: async (entries: { sku: string; preco: number }[]) => {
      const rows = entries.map((e) => ({
        empresa: empresa.toLowerCase(), // tabela grava minúsculo — leitura usa o mesmo case
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
      // cobre os dois consumidores (tela avulsa + card do pedido)
      qc.invalidateQueries({ queryKey: ['embalagem-consulta'] });
      qc.invalidateQueries({ queryKey: ['embalagem-pedido'] });
      onOpenChange(false);
      setPrecos({});
    },
    onError: (e: Error) => toast.error(`Erro ao salvar preços: ${e.message}`),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setPrecos({}); onOpenChange(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Atualizar preços (do portal)</DialogTitle>
          <DialogDescription>Cole o preço atual de cada embalagem, consultado no portal Sayerlack.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {skus.map((sku) => (
            <div key={sku}>
              <Label>{labels?.[sku] ?? sku}</Label>
              <Input
                type="text"
                inputMode="decimal"
                placeholder="Preço atual (R$)"
                value={precos[sku] ?? ''}
                onChange={(e) => setPrecos((p) => ({ ...p, [sku]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button
            disabled={salvar.isPending}
            onClick={() => {
              const entries = skus
                .map((sku) => ({ sku, preco: Number(String(precos[sku] ?? '').replace(',', '.')) }))
                .filter((e) => e.preco > 0);
              if (entries.length === 0) {
                toast.error('Informe ao menos um preço > 0');
                return;
              }
              salvar.mutate(entries);
            }}
          >
            {salvar.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
