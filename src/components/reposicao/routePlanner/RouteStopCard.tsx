// Card de uma parada na rota otimizada (planejador de rotas).
// Extraído de src/pages/AdminRoutePlanner.tsx (god-component split).
// Presentational: recebe a parada + estado de check-in/timer já resolvidos + callbacks.
import { Clock, CheckCircle2, XCircle, ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { RouteStop } from './types';
import { STOP_CONFIG, STOP_DURATION_MIN, PRIORITY_CONFIG } from './constants';
import { getStopIcon, getCTALabel } from './renderHelpers';
import { RadarOutcomeMenu } from '@/components/radar/RadarOutcomeMenu';
import { BotaoLigar } from '@/components/call/BotaoLigar';

export function RouteStopCard({
  stop,
  idx,
  isCheckedIn,
  timerLabel,
  onStopCTA,
  onCheckIn,
  onCheckout,
  onOpenWaze,
  onOpenGoogleMaps,
}: {
  stop: RouteStop;
  idx: number;
  isCheckedIn: boolean;
  timerLabel: string;
  onStopCTA: () => void;
  onCheckIn: () => void;
  onCheckout: () => void;
  onOpenWaze: () => void;
  onOpenGoogleMaps: () => void;
}) {
  const cfg = STOP_CONFIG[stop.stopType];
  return (
    <Card className={`hover:shadow-md transition-shadow ${isCheckedIn ? 'border-status-success/60 bg-status-success-bg/40' : ''}`}>
      <CardContent className="py-3 px-4">
        <div className="flex items-start gap-3">
          {/* Number circle colored by type */}
          <div
            className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm text-white"
            style={{ backgroundColor: cfg.markerColor }}
          >
            {idx + 1}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <p className="font-semibold text-foreground truncate">{stop.customerName}</p>
              <Badge className={`text-[10px] px-1.5 py-0 ${cfg.bgClass} border-0`}>
                {getStopIcon(stop.stopType)}
                <span className="ml-1">{cfg.label}</span>
              </Badge>
              {(() => {
                const pCfg = PRIORITY_CONFIG[stop.priorityLabel];
                const PIcon = pCfg.icon;
                return (
                  <Badge className={`text-[10px] px-1.5 py-0 ${pCfg.bgClass} border-0 gap-0.5`} title={stop.priorityFactors.join(', ')}>
                    <PIcon className="w-3 h-3" />
                    {pCfg.label}
                  </Badge>
                );
              })()}
            </div>
            <p className="text-sm text-muted-foreground truncate">
              {stop.address.street}, {stop.address.number} - {stop.address.neighborhood}
            </p>
            <p className="text-xs text-muted-foreground/80 mt-0.5 line-clamp-2">
              {stop.visitReason}
            </p>
            <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                ~{STOP_DURATION_MIN[stop.stopType]}min
              </span>
              {stop.timeSlot && (
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {stop.timeSlot === 'manha' ? 'Manhã' : 'Tarde'}
                </span>
              )}
              {stop.businessHoursOpen && (
                <span>Funciona: {stop.businessHoursOpen} - {stop.businessHoursClose || '?'}</span>
              )}
              {!stop.lat && <span className="text-destructive">Sem coordenadas</span>}
            </div>
            {/* CTAs — prospect_visit não tem CTA/check-in/checkout (customerUserId vazio bloquearia route_visits) */}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {stop.stopType !== 'prospect_visit' && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onStopCTA}>
                  {getCTALabel(stop)}
                </Button>
              )}
              {stop.phone && (
                <BotaoLigar telefone={stop.phone} nomeCliente={stop.customerName} />
              )}
              {stop.stopType === 'prospect_visit' ? (
                stop.radarCnpj ? <RadarOutcomeMenu cnpj={stop.radarCnpj} /> : null
              ) : !isCheckedIn ? (
                <Button
                  size="sm" variant="outline"
                  className="h-7 text-xs gap-1 border-status-success text-status-success hover:bg-status-success-bg"
                  onClick={onCheckIn}
                >
                  <CheckCircle2 className="w-3 h-3" /> Check-in
                </Button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-mono text-status-success">
                    {timerLabel}
                  </span>
                  <Button
                    size="sm" variant="outline"
                    className="h-7 text-xs gap-1 border-status-warning text-status-warning hover:bg-status-warning-bg"
                    onClick={onCheckout}
                  >
                    <XCircle className="w-3 h-3" /> Check-out
                  </Button>
                </div>
              )}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="outline" className="flex-shrink-0 h-9 w-9">
                <ExternalLink className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpenWaze}>Abrir no Waze</DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenGoogleMaps}>Abrir no Google Maps</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );
}
