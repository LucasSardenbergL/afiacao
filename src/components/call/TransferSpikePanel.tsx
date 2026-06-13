import { useState } from 'react';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { useWebRTCCallContextOptional } from '@/contexts/webrtc-call-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * SPIKE (descartável, flag `telefoniaTransferSpike`): valida empiricamente se o Nvoip
 * transfere a chamada ativa via *2-DTMF ou REFER. Aparece SÓ durante chamada established
 * + flag ligada. Abra o DevTools console e filtre por "transfer-spike" pra ver as
 * respostas do Nvoip. Pra ligar a flag, no console:
 *   localStorage.setItem('feature_flag_telefoniaTransferSpike','1')  (depois recarregue)
 */
export function TransferSpikePanel() {
  const [enabled] = useFeatureFlag('telefoniaTransferSpike', false);
  const ctx = useWebRTCCallContextOptional();
  const [ext, setExt] = useState('');

  if (!enabled || !ctx?.isEstablished || !ctx.spikeTransfer) return null;

  return (
    <div className="fixed bottom-24 right-4 z-50 w-64 space-y-2 rounded-lg border border-status-warning/40 bg-card p-3 shadow-lg">
      <p className="text-xs font-medium text-status-warning">⚠ Spike transferência (teste)</p>
      <Input
        value={ext}
        onChange={(e) => setExt(e.target.value.trim())}
        placeholder="ramal destino (ex: 137973002)"
        className="text-sm"
      />
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!ext} onClick={() => ctx.spikeTransfer!(ext, 'dtmf')}>
          *2 DTMF
        </Button>
        <Button size="sm" variant="outline" disabled={!ext} onClick={() => ctx.spikeTransfer!(ext, 'refer')}>
          REFER
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">Console → filtro: transfer-spike</p>
    </div>
  );
}
