// Card de um item do pedido (qtd/valor editáveis + remover).
// Extraído verbatim de src/pages/SalesOrderEdit.tsx (god-component split).
import { useEffect, useState, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type OrderItem } from './types';
import { formatPrecoOuAusente } from '@/lib/format';
import { lerDecimalPtBr } from './priceGuard';

interface OrderItemCardProps {
  item: OrderItem;
  index: number;
  isBlocked: boolean;
  /** Marca o preço como inválido (≤ 0): destaca o input e mostra aviso. Calculado pelo hook. */
  isPriceInvalid?: boolean;
  /** Quantidade ausente/≤ 0: destaca o input e mostra aviso. Calculado pelo hook. */
  isQuantityInvalid?: boolean;
  onUpdate: (index: number, field: 'quantidade' | 'valor_unitario', value: number | null) => void;
  onRemove: (index: number) => void;
}

/** Número em pt-BR para o campo ("12,5"), ou '' quando não há número sabido. */
const textoDoNumero = (v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) ? String(v).replace('.', ',') : '';

/**
 * O campo guarda o TEXTO digitado e só sobe o número lido. Controlar o input pelo número fazia
 * "12." voltar como "12" (o ponto sumia e o próximo dígito virava 125 — P0, 2026-11-25).
 * Mudança de FORA (ex.: preço vindo do seletor de cor) reescreve o texto.
 */
function useCampoDecimal(valor: number | null | undefined, subir: (n: number | null) => void) {
  const [texto, setTexto] = useState(() => textoDoNumero(valor));
  useEffect(() => {
    const lido = lerDecimalPtBr(texto);
    const mesmo = lido === valor || (lido === null && (valor === null || valor === undefined || Number.isNaN(valor)));
    if (!mesmo) setTexto(textoDoNumero(valor));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só a mudança do VALOR reescreve o texto
  }, [valor]);
  return {
    value: texto,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setTexto(e.target.value);
      subir(lerDecimalPtBr(e.target.value));
    },
  };
}

export function OrderItemCard({ item, index, isBlocked, isPriceInvalid = false, isQuantityInvalid = false, onUpdate, onRemove }: OrderItemCardProps) {
  // Quantidade ilegível vira NaN (não 1): o guard do salvar recusa, em vez de inventar 1 unidade.
  const qtd = useCampoDecimal(item.quantidade, (n) => onUpdate(index, 'quantidade', n === null ? Number.NaN : n));
  // Preço ilegível vira null (não 0): "preço não sabido", que o guard já barra.
  const preco = useCampoDecimal(item.valor_unitario, (n) => onUpdate(index, 'valor_unitario', n));
  return (
    <div className="border rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{item.descricao}</p>
          {item.codigo && <p className="text-xs text-muted-foreground">Cód: {item.codigo}</p>}
          {item.tint_nome_cor && (
            <p className="text-xs text-muted-foreground">
              🎨 {item.tint_cor_id} - {item.tint_nome_cor}
            </p>
          )}
        </div>
        {!isBlocked && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            onClick={() => onRemove(index)}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-xs text-muted-foreground">Qtd</label>
          <Input
            type="text"
            inputMode="decimal"
            value={qtd.value}
            onFocus={(e) => e.target.select()}
            onChange={qtd.onChange}
            disabled={isBlocked}
            aria-label="Quantidade"
            aria-invalid={isQuantityInvalid || undefined}
            className={cn('h-8 text-sm', isQuantityInvalid && 'border-status-error focus-visible:ring-status-error')}
          />
          {isQuantityInvalid && (
            <p className="text-xs text-status-error mt-1">Quantidade maior que zero.</p>
          )}
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Valor Unit.</label>
          {/* Campo vazio = "preço não informado" (null), que o guard já barra no salvar. */}
          <Input
            type="text"
            inputMode="decimal"
            value={preco.value}
            onFocus={(e) => e.target.select()}
            onChange={preco.onChange}
            aria-label="Valor unitário"
            disabled={isBlocked}
            aria-invalid={isPriceInvalid || undefined}
            className={cn('h-8 text-sm', isPriceInvalid && 'border-status-error focus-visible:ring-status-error')}
          />
          {isPriceInvalid && (
            <p className="text-xs text-status-error mt-1">Valor inválido. Use vírgula nos centavos (ex.: 12,50).</p>
          )}
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Total</label>
          <p className="h-8 flex items-center text-sm font-medium">
            {/* `.toFixed()` em null LANCA. Sem preco unitario nao ha total: mostra "-". */}
            {formatPrecoOuAusente(item.valor_total)}
          </p>
        </div>
      </div>
    </div>
  );
}
