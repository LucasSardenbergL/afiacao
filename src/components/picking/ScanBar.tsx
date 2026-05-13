import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ScanLine, Keyboard } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Barra de scan sticky para picking. Foco automático ao montar (separador chega na tela e já bipa).
 *
 * Suporta dois modos:
 *  1. **Wedge / leitor HID** — leitor configurado como teclado físico envia os caracteres
 *     terminados em Enter. Detectamos pela velocidade (chars consecutivos rápidos).
 *  2. **Manual** — operador digita e pressiona Enter.
 *
 * Padrão de detecção do payload:
 *  - Endereço de armazenagem: `Z.P.P` (zona.prateleira.posição), ex: `A.03.05`
 *  - SKU: numérico ou alfanumérico — qualquer outro formato cai como SKU.
 *
 * Latência alvo: <100ms entre bip e callback (não há awaits no caminho crítico).
 */
export interface ScanResult {
  raw: string;
  kind: 'address' | 'sku';
  /** Heurística do método: "wedge" (rápido, autocompleta com Enter) ou "manual". */
  method: 'wedge' | 'manual';
}

const ADDRESS_REGEX = /^[A-Z]{1,2}\.[0-9]{1,3}\.[0-9]{1,3}$/i;
const WEDGE_THRESHOLD_MS = 30; // chars enviados < 30ms entre eventos = leitor de barcode

interface ScanBarProps {
  onScan: (result: ScanResult) => void;
  placeholder?: string;
  /** Reseta input automaticamente após onScan (default true). */
  autoReset?: boolean;
  className?: string;
}

export function ScanBar({
  onScan,
  placeholder = 'Bipe ou digite endereço (A.03.05) ou código do produto...',
  autoReset = true,
  className,
}: ScanBarProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastKeyAt = useRef<number>(0);
  const isWedgeStream = useRef<boolean>(false);

  // foco automático ao montar
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // mantém foco — re-foca após blur curto (acidental). Hide quando usuário clica fora intencionalmente
  // (heurística simples: se foco voltar pra body, re-foca).
  useEffect(() => {
    const onBodyFocus = () => {
      if (document.activeElement === document.body) {
        inputRef.current?.focus();
      }
    };
    window.addEventListener('focus', onBodyFocus, true);
    return () => window.removeEventListener('focus', onBodyFocus, true);
  }, []);

  function classifyAndEmit(raw: string, method: 'wedge' | 'manual') {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const kind: ScanResult['kind'] = ADDRESS_REGEX.test(trimmed) ? 'address' : 'sku';
    onScan({ raw: trimmed, kind, method });
    if (autoReset) setValue('');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const now = performance.now();
    const elapsed = now - lastKeyAt.current;
    lastKeyAt.current = now;
    if (elapsed > 0 && elapsed < WEDGE_THRESHOLD_MS) {
      isWedgeStream.current = true;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const method: 'wedge' | 'manual' = isWedgeStream.current ? 'wedge' : 'manual';
      classifyAndEmit(value, method);
      isWedgeStream.current = false;
    } else if (e.key === 'Escape') {
      setValue('');
      isWedgeStream.current = false;
    }
  }

  return (
    <div
      className={cn(
        'sticky top-topbar z-20 -mx-4 lg:-mx-6 px-4 lg:px-6 py-3 bg-card border-b border-border',
        className,
      )}
    >
      <div className="flex items-center gap-2 max-w-2xl mx-auto">
        <ScanLine className="w-5 h-5 text-primary shrink-0" />
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-11 text-base font-mono"
        />
        <Button
          type="button"
          size="touch"
          variant="default"
          onClick={() => classifyAndEmit(value, 'manual')}
          disabled={!value.trim()}
        >
          <Keyboard className="w-4 h-4 mr-1.5" />
          OK
        </Button>
      </div>
    </div>
  );
}
