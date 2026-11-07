// Radar D2 — "Prospectar hoje": 3 leads perto da carteira do vendedor, com Assumir e o link para a ficha.
// Mesma escolha do e-mail semanal (D1): território = municípios onde o vendedor tem mais clientes. Migration 20261106181000.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, Hand, Loader2, MapPin, Radar } from 'lucide-react';
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
  linkFichaRadar, nomeDoLead, resumoTerritorio, textoSemTerritorio, tituloMunicipio, type LeadProspectarHoje,
} from '@/lib/radar/prospectar-hoje';
import { useRadarAtendimentosAtivos, useRadarDefinirAtendimento } from '@/queries/useRadarAtendimentos';
import { useRadarProspectarHoje } from '@/queries/useRadarProspectarHoje';
import { registrarAberturaEmpurrada, registrarCardServido } from '@/queries/useRadarRegistroEmpurrado';

/** "Meus atendimentos" no /radar (a visão do pacote B2). */
const LINK_MEUS_ATENDIMENTOS = '/radar?visao=meus';

/**
 * O sensor do card (`registrarCardServido`, da sessão H) muda de "dispara e esquece" (void) para
 * `Promise<ResultadoSensor>` = `{ ok: true; registrado } | { ok: false; motivo; transitorio }`. Aceito também o void de
 * hoje (não sei → marca, para não registrar em laço) e boolean. `ok: false`/rejeição = não gravou: libera nova tentativa
 * na próxima leitura (pacote F, achado 9).
 */
async function sensorConfirmou(r: unknown): Promise<boolean> {
  try {
    const v: unknown = await r;
    if (v === false) return false;
    if (typeof v === 'object' && v !== null && 'ok' in v) return (v as { ok: unknown }).ok === true;
    return true;
  } catch {
    return false;
  }
}

export function ProspectarHojeCard() {
  const { displayRole, displayCommercialRole } = useDisplayAccess();
  const visivel = podeProspectarRadar({ role: displayRole, commercialRole: displayCommercialRole });
  const q = useRadarProspectarHoje(visivel);
  const { isImpersonating } = useImpersonation();
  const navigate = useNavigate();
  const definir = useRadarDefinirAtendimento();
  // Posse viva (a mesma leitura dos selos do /radar): lead que já é do vendedor mostra "com você", nunca "Assumir" —
  // senão o 2º clique vira "Atendimento renovado". O pacote E tira o lead do card depois do refetch; até lá, e para
  // o caso de a RPC o devolver marcado (`comVoce`), vale também o estado local da mutação.
  const posse = useRadarAtendimentosAtivos();
  const [assumidosAqui, setAssumidosAqui] = useState<ReadonlySet<string>>(new Set());
  const comVoce = (l: LeadProspectarHoje) => l.comVoce || assumidosAqui.has(l.cnpj) || posse.data?.get(l.cnpj)?.ehMeu === true;
  // 'enviando' segura o efeito enquanto o sensor não responde; 'feito' só depois da confirmação.
  const servido = useRef<'nao' | 'enviando' | 'feito'>('nao');

  const leads = q.data?.leads ?? [];
  const nLeads = q.data?.leads.length ?? 0;
  const elegiveis = q.data?.leads[0]?.elegiveis ?? null;
  useEffect(() => {
    if (!q.isSuccess || nLeads === 0 || isImpersonating || servido.current !== 'nao') return;
    servido.current = 'enviando';
    track('radar.prospectar_hoje_visto', { leads: nLeads, elegiveis });
    void sensorConfirmou(registrarCardServido(nLeads)).then((ok) => {
      // Falha já foi reportada pelo próprio hook (track 'radar.sensor_falhou' + ledger, contrato da sessão H): aqui só
      // libera a nova tentativa na próxima leitura. `{ ok: true, registrado: false }` = já gravado hoje → conta como feito.
      servido.current = ok ? 'feito' : 'nao';
    });
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
      setAssumidosAqui((s) => new Set(s).add(l.cnpj));
      track('radar.prospectar_hoje_assumido', { posicao: l.posicao, atribuido: l.atribuido });
      toast.success(r.renovado ? 'Atendimento renovado' : 'Lead assumido', {
        description: r.expiraEm ? `Fica com você até ${diaMes(r.expiraEm)} — está em "Meus atendimentos" no Radar` : undefined,
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
            description={textoSemTerritorio(q.data.territorioMotivo)}
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
                  <p className="text-sm truncate flex items-center gap-1.5">
                    <span className="truncate">{nomeDoLead(l)}</span>
                    {l.atribuido && (
                      <Badge variant="outline" className="shrink-0 text-[10px]" data-testid="prospectar-hoje-atribuido">passado pelo gestor</Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {tituloMunicipio(l.municipioNome)}{l.uf ? `/${l.uf}` : ''} · score {l.score}
                    {l.motivos.length > 0 ? ` · ${l.motivos.slice(0, 2).join('; ')}` : ''}
                  </p>
                </div>
                {comVoce(l) ? (
                  <Link to={LINK_MEUS_ATENDIMENTOS} data-testid="prospectar-hoje-com-voce"
                    className="shrink-0 inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-status-success"
                    title='Está em "Meus atendimentos" no Radar'>
                    <Check className="w-3 h-3" /> com você
                  </Link>
                ) : (
                  <Button
                    size="sm"
                    disabled={definir.isPending || isImpersonating}
                    title={isImpersonating ? 'Indisponível em modo Ver como' : undefined}
                    onClick={() => void assumir(l)}
                  >
                    {definir.isPending && definir.variables?.cnpj === l.cnpj
                      ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Hand className="w-4 h-4 mr-1" />}
                    Assumir
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => abrirFicha(l)}>
                  Abrir ficha
                </Button>
              </li>
            ))}
          </ul>
        )}
        {q.isSuccess && q.data.territorio.some((t) => t.compartilhado) && (
          <p className="mt-2 text-[11px] text-muted-foreground" data-testid="prospectar-hoje-compartilhado">
            Você não é o vendedor com mais clientes em nenhuma cidade, então estes municípios são divididos com colegas.
          </p>
        )}
        {q.isSuccess && (
          <Link to={LINK_MEUS_ATENDIMENTOS} className="mt-2 inline-block text-xs text-primary hover:underline" data-testid="prospectar-hoje-meus">
            Ver meus atendimentos{assumidosAqui.size > 0 ? ` (${assumidosAqui.size} assumido${assumidosAqui.size === 1 ? '' : 's'} agora)` : ''}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
