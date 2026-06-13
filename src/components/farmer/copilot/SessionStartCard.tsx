// Card de início de sessão do copiloto (modo voz/texto + cliente + iniciar).
// Extraído verbatim de src/pages/FarmerCopilot.tsx (god-component split).
import { Mic, Radio, Type, AlertTriangle, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { InputMode } from './types';

interface SessionStartCardProps {
  inputMode: InputMode;
  setInputMode: (m: InputMode) => void;
  selectedCustomer: string;
  setSelectedCustomer: (v: string) => void;
  customers: { id: string; name: string }[];
  isConnecting: boolean;
  onStart: () => void;
  disabled?: boolean;
}

export function SessionStartCard({
  inputMode,
  setInputMode,
  selectedCustomer,
  setSelectedCustomer,
  customers,
  isConnecting,
  onStart,
  disabled,
}: SessionStartCardProps) {
  return (
    <Card className="border-primary/20">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <Radio className="w-5 h-5 text-primary" />
          <h2 className="text-sm font-bold">Iniciar Copiloto</h2>
        </div>
        <p className="text-[10px] text-muted-foreground">
          O copiloto analisa a conversa, detecta intenções e sugere a melhor ação em cada momento.
        </p>

        {/* Mode Toggle */}
        <div className="flex rounded-lg border overflow-hidden">
          <button
            onClick={() => setInputMode('voice')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors',
              inputMode === 'voice'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            )}
          >
            <Mic className="w-3.5 h-3.5" /> Voz
          </button>
          <button
            onClick={() => setInputMode('text')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors',
              inputMode === 'text'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            )}
          >
            <Type className="w-3.5 h-3.5" /> Texto
          </button>
        </div>

        {inputMode === 'text' && (
          <div className="flex items-start gap-1.5 p-2 rounded-md bg-status-warning-bg border border-status-warning/30">
            <AlertTriangle className="w-3.5 h-3.5 text-status-warning mt-0.5 shrink-0" />
            <p className="text-[9px] text-status-warning">
              No modo texto, cole ou digite trechos da conversa e clique em "Analisar" para receber sugestões.
            </p>
          </div>
        )}

        <Select value={selectedCustomer} onValueChange={setSelectedCustomer}>
          <SelectTrigger className="h-9 text-xs">
            <SelectValue placeholder="Selecionar cliente (opcional)" />
          </SelectTrigger>
          <SelectContent>
            {customers.map(c => (
              <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          onClick={onStart}
          disabled={isConnecting || disabled}
          title={disabled ? 'Indisponível em modo Ver como' : undefined}
          className="w-full gap-2"
        >
          {isConnecting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : inputMode === 'voice' ? (
            <Mic className="w-4 h-4" />
          ) : (
            <Type className="w-4 h-4" />
          )}
          {isConnecting ? 'Conectando...' : inputMode === 'voice' ? 'Iniciar Transcrição' : 'Iniciar Modo Texto'}
        </Button>
      </CardContent>
    </Card>
  );
}
