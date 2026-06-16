import { useEffect } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fmt } from '@/hooks/useUnifiedOrder';
import type { ReguaPrecoResult } from '@/lib/regua-preco/types';

interface ReguaPrecoSinalProps {
  result: ReguaPrecoResult;
  precoAtual: number;
  contexto: { produto: string; cliente: string | null; qty: number };
  onAplicar: (preco: number) => void;
  /** chamado quando o sinal está visível ≥800ms (debounce) — log de exibição. */
  onExibido?: (result: ReguaPrecoResult) => void;
}

export function ReguaPrecoSinal({ result, precoAtual, contexto, onAplicar, onExibido }: ReguaPrecoSinalProps) {
  const ehPiso = result.sinal === 'piso';
  const ehFolga = result.sinal === 'auto_ref' || result.sinal === 'benchmark';
  const visivel = ehPiso || ehFolga; // nenhum/discordância/preço-acima = invisível
  const temBotao = result.precoReferencia != null; // helper já zera em proxy/baixa/discordância
  const pct = result.suggestedGapPct != null ? Math.round(result.suggestedGapPct * 100) : 0;

  useEffect(() => {
    if (!visivel || !onExibido) return;
    const t = setTimeout(() => onExibido(result), 800);
    return () => clearTimeout(t);
    // re-dispara o debounce se o sinal/alvo mudar
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visivel, result.sinal, result.precoReferencia]);

  if (!visivel) return null;

  const cls = ehPiso ? 'text-status-error border-status-error/40' : 'text-status-info border-status-info/40';
  const label = ehPiso
    ? (temBotao ? `MC<0 · piso ${fmt(result.precoReferencia!)}` : 'MC<0 · confira custo')
    : (temBotao ? `💰 ${fmt(result.precoReferencia!)} (+${pct}%)` : '💰 ⓘ');

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn('inline-flex items-center rounded border px-1 py-0 text-[9px] font-medium leading-none', cls)}
          aria-label="Detalhes da Régua de Preço"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-xs space-y-1.5">
        <p className="font-medium leading-tight">
          {contexto.produto}{contexto.cliente ? ` · ${contexto.cliente}` : ''} · {contexto.qty}un
        </p>
        {temBotao && (
          <p className="text-muted-foreground">
            Você: {fmt(precoAtual)}/un · Referência: <span className="font-mono">{fmt(result.precoReferencia!)}/un</span>
          </p>
        )}
        {result.recibos.map((r, i) => (
          <p key={i} className="text-muted-foreground leading-snug">{r}</p>
        ))}
        {result.disclaimers.length > 0 && (
          <p className="text-[10px] text-muted-foreground/80 leading-snug border-t pt-1">
            ⓘ {result.disclaimers.join(' · ')}
          </p>
        )}
        {temBotao && (
          <Button
            size="sm"
            variant="outline"
            className="w-full h-7 text-xs"
            onClick={() => onAplicar(result.precoReferencia!)}
          >
            {ehPiso ? 'Aplicar piso' : 'Aplicar referência'} · {fmt(result.precoReferencia!)}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
