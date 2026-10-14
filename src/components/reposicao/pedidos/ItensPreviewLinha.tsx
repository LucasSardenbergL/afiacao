import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';
import { quantidadeCompraCanonica } from '@/lib/reposicao/qtde-portal';
import { formatBRL } from './shared';

/**
 * Prévia SÓ-LEITURA dos itens de um pedido, aberta na própria linha da fila — para conferir um
 * pedido pequeno sem abrir o modal. Ajustar e aprovar continuam no modal (é lá que a quantidade é
 * canonizada para gravar e que a aprovação exige os itens lidos).
 *
 * A quantidade exibida é a MESMA do modal (`quantidadeCompraCanonica` sobre qtde_final ?? sugerida
 * e o fator de embalagem do portal) — uma prévia que mostrasse outro número seria pior que nenhuma.
 */
type ItemPreview = {
  id: number;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  qtde_sugerida: number;
  qtde_final: number | null;
  preco_unitario: number | null;
  fator_embalagem_portal: number | null;
};

// Teto da prévia: pedido com mais itens que isto é para o modal, não para a linha.
const MAX_PREVIA = 50;

export function ItensPreviewLinha({
  pedidoId,
  colunas,
  onAbrirDetalhes,
}: {
  pedidoId: number;
  colunas: number;
  onAbrirDetalhes: () => void;
}) {
  // Sob o prefixo ['pedidos-ciclo'] de propósito: o realtime e toda mutation da tela invalidam esse
  // prefixo, então a prévia aberta acompanha uma edição feita no modal. Key PRÓPRIA (não a
  // ['pedido-itens', id] do modal): o shape é outro, e dividir a chave corromperia o cache dele.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['pedidos-ciclo', 'itens-preview', pedidoId],
    queryFn: async () => {
      const { data: itens, error } = await supabase
        .from('pedido_compra_item')
        .select('id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, fator_embalagem_portal')
        .eq('pedido_id', pedidoId)
        .order('id', { ascending: true })
        .range(0, MAX_PREVIA); // MAX_PREVIA+1 linhas: a sobra só diz "tem mais"
      if (error) throw error;
      return (itens ?? []) as ItemPreview[];
    },
  });

  let corpo: React.ReactNode;
  if (isLoading) {
    corpo = (
      <span className="inline-flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Carregando itens…
      </span>
    );
  } else if (isError || !data) {
    corpo = (
      <span className="inline-flex flex-wrap items-center gap-2 text-status-error" data-testid="previa-itens-falhou">
        Não consegui carregar os itens.
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          Tentar de novo
        </Button>
      </span>
    );
  } else if (data.length === 0) {
    corpo = <span className="text-muted-foreground">Pedido sem itens.</span>;
  } else {
    const temMais = data.length > MAX_PREVIA;
    const visiveis = data.slice(0, MAX_PREVIA);
    corpo = (
      <div className="space-y-1">
        <ul className="divide-y divide-border text-sm">
          {visiveis.map((it) => {
            const qtd = quantidadeCompraCanonica(it.qtde_final ?? it.qtde_sugerida, it.fator_embalagem_portal);
            // Preço ausente ≠ R$ 0: sem preço, a linha diz "—", não fabrica um valor.
            const valor = it.preco_unitario == null ? null : qtd * it.preco_unitario;
            return (
              <li key={it.id} className="flex items-baseline gap-3 py-1">
                <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{it.sku_codigo_omie}</span>
                <span className="flex-1 min-w-0 truncate">{it.sku_descricao ?? '—'}</span>
                <span className="tabular-nums w-20 text-right">{qtd}</span>
                <span className="tabular-nums w-28 text-right">{valor == null ? '—' : formatBRL(valor)}</span>
              </li>
            );
          })}
        </ul>
        {temMais && (
          <button type="button" className="text-xs underline text-muted-foreground" onClick={onAbrirDetalhes}>
            Mais itens — abrir os detalhes
          </button>
        )}
      </div>
    );
  }

  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30" data-testid={`previa-itens-${pedidoId}`}>
      <TableCell colSpan={colunas} className="py-2 pl-10">
        {corpo}
      </TableCell>
    </TableRow>
  );
}
