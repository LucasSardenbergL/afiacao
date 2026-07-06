// Dialog "Consolidar demanda em outro SKU" (Frente C — UX do de-para N→1).
// Abre a partir do SkuDetailSheet (aba Ajuste manual). Chama a RPC money-path
// consolidar_demanda_sku (em prod desde 2026-07-05): descontinua ESTE SKU e leva
// seu histórico de demanda para o destino, que passa a ser comprado pelo giro somado.
// Padrão espelhado de SubstituicaoModal.tsx. Domínio: docs/agent/reposicao.md.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { eqInt, ilike, isSearchablePostgrestTerm, orFilter } from '@/lib/postgrest';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, GitMerge } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { mensagemErroConsolidacao, type ConsolidacaoErro } from '@/lib/reposicao/consolidacao';

interface SkuOpcao {
  sku_codigo_omie: number;
  sku_descricao: string | null;
}

interface Props {
  empresa: string;
  skuAntigoCodigo: number;
  skuAntigoDescricao: string | null;
  onClose: () => void;
  onDone: () => void;
}

export function ConsolidarDemandaDialog({
  empresa,
  skuAntigoCodigo,
  skuAntigoDescricao,
  onClose,
  onDone,
}: Props) {
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState('');
  const [destino, setDestino] = useState<SkuOpcao | null>(null);

  const { data: opcoes } = useQuery({
    queryKey: ['consolidar-sku-busca', empresa, busca],
    enabled: busca.length >= 2,
    queryFn: async () => {
      if (busca.length < 2 || !isSearchablePostgrestTerm(busca)) return [];
      const { data } = await supabase
        .from('sku_parametros')
        .select('sku_codigo_omie, sku_descricao')
        .eq('empresa', empresa)
        .or(orFilter(eqInt('sku_codigo_omie', busca), ilike('sku_descricao', busca)))
        .limit(20);
      // não oferece consolidar em si mesmo (a RPC barra ZR001; some da lista p/ UX)
      return ((data ?? []) as SkuOpcao[]).filter(
        (o) => Number(o.sku_codigo_omie) !== skuAntigoCodigo,
      );
    },
  });

  const consolidar = useMutation({
    mutationFn: async () => {
      if (!destino) throw new Error('Selecione o SKU destino');
      // as never: a RPC (RETURNS void) ainda não está nos types gerados do Supabase.
      const { error } = await supabase.rpc('consolidar_demanda_sku' as never, {
        p_empresa: empresa,
        p_sku_antigo: String(skuAntigoCodigo),
        p_sku_novo: String(destino.sku_codigo_omie),
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(
        `Demanda consolidada no SKU ${destino?.sku_codigo_omie}. Este SKU foi descontinuado.`,
      );
      queryClient.invalidateQueries({ queryKey: ['sku_parametros_revisao'] });
      onDone();
    },
    onError: (e: Error) => toast.error(mensagemErroConsolidacao(e as unknown as ConsolidacaoErro)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-4 w-4" /> Consolidar demanda em outro SKU
          </DialogTitle>
          <DialogDescription>
            Este SKU <span className="font-mono">{skuAntigoCodigo}</span>
            {skuAntigoDescricao ? ` — ${skuAntigoDescricao}` : ''} será{' '}
            <strong>descontinuado</strong>, e todo o seu histórico de demanda passará a dimensionar a
            compra do SKU destino.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>SKU destino (que herda a demanda)</Label>
            <Input
              placeholder="Buscar por código ou descrição"
              value={busca}
              onChange={(e) => {
                setBusca(e.target.value);
                setDestino(null);
              }}
            />
            {opcoes && opcoes.length > 0 && !destino && (
              <div className="mt-2 border rounded max-h-44 overflow-auto text-sm">
                {opcoes.map((o) => (
                  <button
                    key={o.sku_codigo_omie}
                    type="button"
                    onClick={() => {
                      setDestino(o);
                      setBusca(`${o.sku_codigo_omie} — ${o.sku_descricao ?? ''}`);
                    }}
                    className="block w-full text-left px-3 py-1.5 hover:bg-muted"
                  >
                    <span className="font-mono">{o.sku_codigo_omie}</span> — {o.sku_descricao ?? '—'}
                  </button>
                ))}
              </div>
            )}
            {destino && (
              <p className="text-xs text-status-info mt-1">
                Destino: <span className="font-mono">{destino.sku_codigo_omie}</span> —{' '}
                {destino.sku_descricao ?? '—'}
              </p>
            )}
          </div>

          <div className="rounded-md border border-status-warning/40 bg-status-warning/5 p-3 text-xs text-muted-foreground">
            Enquanto ativa: o destino é comprado pelo giro <strong>somado</strong> dos dois e este SKU
            sai da compra automática (segue vendável no Omie até zerar). O estoque <strong>não</strong>{' '}
            é consolidado — só a demanda.
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => consolidar.mutate()} disabled={!destino || consolidar.isPending}>
            {consolidar.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Consolidar e descontinuar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
