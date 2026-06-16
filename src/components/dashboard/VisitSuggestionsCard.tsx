/**
 * Card "Visitas sugeridas hoje" no /meu-dia.
 * Renderizado apenas pra Master/Closer (não Farmer).
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  LifeBuoy,
  TrendingUp,
  Handshake,
  Sprout,
  MapPin,
  Route,
  Loader2,
  Users,
} from 'lucide-react';
import { useMyVisitSuggestions } from '@/hooks/useMyVisitSuggestions';
import type { MissionType } from '@/lib/visit-scoring/types';

interface MissionMeta {
  label: string;
  icon: typeof LifeBuoy;
  color: string;
  bg: string;
}

const MISSION_META: Record<MissionType, MissionMeta> = {
  recuperacao: { label: 'Recuperação', icon: LifeBuoy, color: 'text-status-error', bg: 'bg-status-error-bg' },
  expansao: { label: 'Expansão', icon: TrendingUp, color: 'text-status-success', bg: 'bg-status-success-bg' },
  relacionamento: { label: 'Relacionamento', icon: Handshake, color: 'text-status-info', bg: 'bg-status-info-bg' },
  prospeccao: { label: 'Prospecção', icon: Sprout, color: 'text-status-warning', bg: 'bg-status-warning-bg' },
};

export function VisitSuggestionsCard() {
  const [city, setCity] = useState<string | undefined>();
  const { cities, suggestions, selectedCity, isLoading } = useMyVisitSuggestions({ city });

  if (isLoading) {
    return (
      <Card className="p-6 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }

  // Não renderiza se não tem visit_scores ainda
  if (cities.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
        <div>
          <h2 className="text-base font-medium">Visitas sugeridas — equipes de campo</h2>
          <p className="text-2xs text-muted-foreground">
            Top {suggestions.length} clientes em {selectedCity} — mix balanceado entre 4 missões
          </p>
        </div>
        <Select value={selectedCity} onValueChange={setCity}>
          <SelectTrigger className="w-[220px]">
            <MapPin className="w-3.5 h-3.5 mr-1.5" />
            <SelectValue placeholder="Escolher cidade" />
          </SelectTrigger>
          <SelectContent>
            {cities.map(c => (
              <SelectItem key={c.city} value={c.city}>
                {c.city} ({c.count} candidatos)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <div className="divide-y divide-border">
        {suggestions.map(s => {
          const meta = MISSION_META[s.primary_mission];
          const Icon = meta.icon;
          const days = s.days_since_last_visit;
          const visitLabel = s.last_visit_at == null
            ? <span className="text-status-info">nunca visitado</span>
            : days === 0 ? 'visitado hoje' : days === 1 ? 'ontem' : `há ${days}d`;

          return (
            <div key={s.customer_user_id} className="p-3 flex items-center gap-3 hover:bg-muted/30">
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className={`p-1.5 rounded ${meta.bg} ${meta.color} shrink-0 cursor-help`}>
                      <Icon className="w-4 h-4" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <div className="text-2xs space-y-1">
                      <div className="font-medium">{meta.label} — score {Math.round(s.visit_score)}</div>
                      <div className="text-muted-foreground">
                        Recuperação: {Math.round(s.scores.recuperacao)} · Expansão: {Math.round(s.scores.expansao)}
                      </div>
                      <div className="text-muted-foreground">
                        Relacionamento: {Math.round(s.scores.relacionamento)} · Prospecção: {Math.round(s.scores.prospeccao)}
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <Link to={`/admin/customers/${s.customer_user_id}/360`} className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{s.customer_name}</div>
                <div className="text-2xs text-muted-foreground flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={`${meta.color} text-2xs`}>{meta.label}</Badge>
                  {s.coberto_de && (
                    <Badge variant="outline" className="text-status-info text-2xs gap-1">
                      <Users className="w-3 h-3" />
                      Cobertura{s.coberto_de_nome ? ` — ${s.coberto_de_nome}` : ''}
                    </Badge>
                  )}
                  <span>score: {Math.round(s.visit_score)}</span>
                  {s.neighborhood && <span>{s.neighborhood}</span>}
                  <span>{visitLabel}</span>
                </div>
              </Link>

              <Button size="sm" variant="outline" asChild>
                <Link to={`/admin/route-planner?customer=${s.customer_user_id}`}>
                  <Route className="w-3.5 h-3.5 mr-1" />
                  Planejar
                </Link>
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
