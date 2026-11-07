// Radar D2 — "Prospectar hoje": 3 leads perto da carteira do vendedor, com Assumir e o link para a ficha.
// Mesma escolha do e-mail semanal (D1): território = municípios onde o vendedor tem mais clientes. Migration 20261106181000.
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Hand, Loader2, MapPin, Radar } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { track } from '@/lib/analytics';
import { podeProspectarRadar } from '@/lib/nav/acesso-radar';
import { diaMes, mensagemRecusa } from '@/lib/radar/atendimento';
import {
  linkFichaRadar, nomeDoLead, resumoTerritorio, tituloMunicipio, type LeadProspectarHoje,
} from '@/lib/radar/prospectar-hoje';
import { useRadarDefinirAtendimento } from '@/queries/useRadarAtendimentos';
import { useRadarProspectarHoje } from '@/queries/useRadarProspectarHoje';
import { registrarAberturaEmpurrada, registrarCardServido } from '@/queries/useRadarRegistroEmpurrado';

export function ProspectarHojeCard() {
  const { displayRole, displayCommercialRole } = useDisplayAccess();
  const visivel = podeProspectarRadar({ role: displayRole, commercialRole: displayCommercialRole });
  const q = useRadarProspectarHoje(visivel);
  const { isImpersonating } = useImpersonation();
  const navigate = useNavigate();
  const definir = useRadarDefinirAtendimento();
  const servidoRegistrado = useRef(false);

  const leads = q.data?.leads ?? [];
  const nLeads = q.data?.leads.length ?? 0;
  const elegiveis = q.data?.leads[0]?.elegiveis ?? null;
  useEffect(() => {
    if (!q.isSuccess || nLeads === 0 || isImpersonating || servidoRegistrado.current) return;
    servidoRegistrado.current = true;
    registrarCardServido(nLeads);
    track('radar.prospectar_hoje_visto', { leads: nLeads, elegiveis });
  }, [q.isSuccess, nLeads, elegiveis, isImpersonating]);

  if (!visivel) return null;
  if (q.isLoading) return <div className="h-32 rounded-lg bg-muted/40 animate-pulse" data-testid="prospectar-hoje-carregando" />;

  const abrirFicha = (l: LeadProspectarHoje) => {
    if (!isImpersonating) void registrarAberturaEmpurrada({ origem: 'card', cnpj: l.cnpj });
    track('radar.prospectar_hoje_ficha', { posicao: l.posicao });
    navigate(linkFichaRadar(l.cnpj));
  };

  const assumir = async (l: LeadProspectarHoje) => {
    try {
      const r = await definir.mutateAsync({ cnpj: l.cnpj, acao: 'assumir' });
      if (!r.ok) { toast.info(mensagemRecusa(r)); return; }
      toast.success(r.renovado ? 'Atendimento renovado' : 'Lead assumido', {
        description: r.expiraEm ? `Fica com você até ${diaMes(r.expiraEm)} (renova a cada contato)` : undefined,
      });
    } catch (e) {
      toast.error('Não foi possível assumir o lead', { description: e instanceof Error ? e.message : undefined });
    }
  };

  return (
    <Card data-testid="prospectar-hoje">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Radar className="w-4 h-4 text-status-info" />
          Prospectar hoje
          {q.isSuccess && leads.length > 0 && (
            <Badge variant="outline" className="ml-auto text-[10px] font-tabular">
              {leads.length} de {leads[0].elegiveis}
            </Badge>
          )}
        </CardTitle>
        {q.isSuccess && q.data.territorio.length > 0 && (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <MapPin className="w-3 h-3 shrink-0" />
            Perto dos seus clientes: {resumoTerritorio(q.data.territorio)}
          </p>
        )}
      </CardHeader>
      <CardContent>
        {q.isError ? (
          <div role="alert" className="space-y-2" data-testid="prospectar-hoje-erro">
            <p className="text-sm text-status-error">
              Não consegui ler os leads do Radar. Isto não quer dizer que não há leads perto da sua carteira.
            </p>
            <Button variant="outline" size="sm" onClick={() => void q.refetch()}>Tentar de novo</Button>
          </div>
        ) : q.data && q.data.territorio.length === 0 ? (
          <EmptyState
            icon={MapPin}
            title="Sem território no Radar"
            description="Sua carteira não tem clientes com endereço num município do Radar, então não há onde procurar leads perto dela."
            tone="operational"
          />
        ) : leads.length === 0 ? (
          <EmptyState
            icon={Radar}
            title="Nenhum lead a contatar perto da sua carteira"
            description="Todos os leads com score nesses municípios já foram trabalhados ou estão com outro vendedor."
            tone="operational"
          />
        ) : (
          <ul className="divide-y divide-border -my-1">
            {leads.map((l) => (
              <li key={l.cnpj} className="py-2 flex items-center gap-3" data-testid="prospectar-hoje-lead">
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{nomeDoLead(l)}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {tituloMunicipio(l.municipioNome)}{l.uf ? `/${l.uf}` : ''} · score {l.score}
                    {l.motivos.length > 0 ? ` · ${l.motivos.slice(0, 2).join('; ')}` : ''}
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={definir.isPending || isImpersonating}
                  title={isImpersonating ? 'Indisponível em modo Ver como' : undefined}
                  onClick={() => void assumir(l)}
                >
                  {definir.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Hand className="w-4 h-4 mr-1" />}
                  Assumir
                </Button>
                <Button size="sm" variant="outline" onClick={() => abrirFicha(l)}>
                  Abrir ficha
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
