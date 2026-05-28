// src/components/telefonia/CallHistoryRow.tsx
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Mic } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { formatBrPhone, normalizeBrPhone } from '@/lib/phone';
import { cn } from '@/lib/utils';
import type { CallLogRow } from '@/types/call-log';

const STATUS_LABEL: Record<string, string> = {
  ringing: 'tocando', answered: 'atendida', missed: 'perdida', rejected: 'rejeitada',
  busy: 'ocupado', failed: 'falhou', canceled: 'cancelada', ended: 'encerrada',
};

export function CallHistoryRow({ row, onCallBack }: { row: CallLogRow; onCallBack: (phone: string, name?: string) => void }) {
  const navigate = useNavigate();
  const missed = row.direction === 'inbound' && row.status === 'missed';
  const Icon = missed ? PhoneMissed : row.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;
  const phone = row.phone_raw ?? row.phone_normalized ?? '';
  const canCall = normalizeBrPhone(phone).length >= 10;
  const known = !!row.customer_user_id;
  const name = row.display_name ?? (known ? 'Cliente' : 'Desconhecido');

  return (
    <div className="flex items-center gap-3 border-b border-border py-2.5 text-sm">
      <span className={cn('flex h-7 w-7 items-center justify-center rounded-md',
        missed ? 'bg-status-error-bg text-status-error' :
        row.direction === 'inbound' ? 'bg-status-success-bg text-status-success' : 'bg-status-info-bg text-status-info')}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate flex items-center gap-1.5">
          {name}
          {row.recorded && <Mic className="h-3 w-3 text-muted-foreground" />}
        </p>
        <p className="text-xs text-muted-foreground">{formatBrPhone(phone)}</p>
      </div>
      <div className="text-right text-xs">
        <p className={cn(missed ? 'text-status-error font-medium' : 'text-muted-foreground')}>
          {STATUS_LABEL[row.status]}
        </p>
        <p className="text-muted-foreground">{new Date(row.started_at).toLocaleString('pt-BR')}</p>
      </div>
      <div className="flex gap-1">
        {known && (
          <Button size="sm" variant="ghost" className="h-7 text-xs"
            onClick={() => navigate(`/admin/customers/${row.customer_user_id}`)}>ver cliente</Button>
        )}
        <Button size="sm" variant="outline" className="h-7 text-xs"
          disabled={!canCall}
          title={canCall ? `Religar para ${formatBrPhone(phone)}` : 'Telefone inválido'}
          onClick={() => onCallBack(phone, name)}>religar</Button>
      </div>
    </div>
  );
}
