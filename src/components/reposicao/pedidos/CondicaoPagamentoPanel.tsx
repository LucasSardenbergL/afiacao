// Painel: seleção/edição da condição de pagamento Omie (obrigatória p/ disparo).
// Extraído verbatim de src/components/reposicao/pedidos/DetalhesModal.tsx (god-component split).
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PedidoSugerido, CondicaoPagamento } from './types';

interface CondicaoPagamentoPanelProps {
  pedido: PedidoSugerido;
  podeEditarCondicao: boolean;
  condicaoCodigo: string;
  onCondicaoChange: (codigo: string) => void;
  condicoes: CondicaoPagamento[];
  condicaoSelecionada: CondicaoPagamento | null;
  condicaoMudou: boolean;
  salvarCondicaoPending: boolean;
  onSalvarCondicao: () => void;
}

export function CondicaoPagamentoPanel({
  pedido,
  podeEditarCondicao,
  condicaoCodigo,
  onCondicaoChange,
  condicoes,
  condicaoSelecionada,
  condicaoMudou,
  salvarCondicaoPending,
  onSalvarCondicao,
}: CondicaoPagamentoPanelProps) {
  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">
          Condição de pagamento Omie
          {!condicaoSelecionada && <span className="text-destructive ml-1">*</span>}
        </label>
        {pedido.condicao_origem && (
          <Badge variant="outline" className="text-[10px] h-4">
            origem: {pedido.condicao_origem}
          </Badge>
        )}
      </div>
      {podeEditarCondicao ? (
        <div className="flex gap-2">
          <Select value={condicaoCodigo || undefined} onValueChange={onCondicaoChange}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Selecione a condição (obrigatório p/ disparar ao Omie)" />
            </SelectTrigger>
            <SelectContent className="max-h-[300px]">
              {condicoes.map((c) => (
                <SelectItem key={c.codigo} value={c.codigo}>
                  <span className="font-mono text-xs mr-2">{c.codigo}</span>
                  {c.descricao}
                  {c.num_parcelas ? <span className="text-muted-foreground ml-2">({c.num_parcelas}x)</span> : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {pedido.status === 'aprovado_aguardando_disparo' && condicaoMudou && condicaoSelecionada && (
            <Button
              size="sm"
              variant="secondary"
              disabled={salvarCondicaoPending}
              onClick={onSalvarCondicao}
            >
              {salvarCondicaoPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Salvar
            </Button>
          )}
        </div>
      ) : (
        <div className="text-sm">
          {pedido.condicao_pagamento_codigo
            ? <><span className="font-mono text-xs mr-2">{pedido.condicao_pagamento_codigo}</span>{pedido.condicao_pagamento_descricao}</>
            : <span className="text-muted-foreground italic">não definida</span>}
        </div>
      )}
      {!condicaoSelecionada && podeEditarCondicao && (
        <p className="text-xs text-destructive">
          Sem condição selecionada o disparo ao Omie falhará.
        </p>
      )}
    </div>
  );
}
