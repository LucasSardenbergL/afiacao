import { useEffect, useRef } from 'react';
import { AlertTriangle, Users } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { AbaRepasses } from '@/components/venda-cliente/painel/AbaRepasses';
import { AvisoNaoCausal } from '@/components/venda-cliente/painel/AvisoNaoCausal';
import { PainelOndas } from '@/components/venda-cliente/painel/PainelOndas';
import { TabelaAdocao } from '@/components/venda-cliente/painel/TabelaAdocao';
import { useAuth } from '@/contexts/AuthContext';
import { useUrlState } from '@/hooks/useUrlState';
import { useVendaPainel } from '@/hooks/useVendaPainel';
import { registrarNoLedger } from '@/lib/analytics-ledger';
import { hojeSP } from '@/lib/dashboard/sp-date';
import { somarDias } from '@/lib/venda-cliente/painel';

const PERIODOS = [4, 12, 26, 52] as const;


/**
 * Painel do founder — Venda por cliente (Task 7). Adoção das farmers por semana (quantos tinham
 * para ligar, quantos contataram, quantos compraram), conversão de recompra × linha de base,
 * estado das ondas e a aprovação de repasses. Master-only (a RPC também barra: 42501).
 */
export default function VendaClientePainel() {
  const { isMaster } = useAuth();
  const [url, setUrl] = useUrlState({ semanas: 12, aba: 'adocao' });
  const semanas = (PERIODOS as readonly number[]).includes(url.semanas) ? url.semanas : 12;
  // hoje no calendário de São Paulo; o servidor alinha o período às semanas seg–dom
  const ate = hojeSP();
  const de = somarDias(ate, -(semanas * 7 - 1));
  const painel = useVendaPainel(de, ate);

  // Sensor de uso no LEDGER (PostHog é censurado no Chrome do founder): 1x por montagem com dado;
  // a RPC deduplica por dia.
  const registrou = useRef(false);
  useEffect(() => {
    if (registrou.current || !painel.data) return;
    registrou.current = true;
    void registrarNoLedger('venda.painel_aberto', 'painel', {
      semanas,
      farmers: new Set(painel.data.linhas.map((l) => l.farmer_user_id)).size,
      base_confiavel: painel.data.base_confiavel,
    });
  }, [painel.data, semanas]);

  if (!isMaster) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Acesso restrito — o painel de venda por cliente é visível apenas para master.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl">Venda por cliente</h1>
          <p className="text-sm text-muted-foreground">
            Quem cada farmer tinha para ligar, quem contatou e quem comprou — e os repasses de preço a aprovar.
          </p>
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          value={String(semanas)}
          onValueChange={(v) => v && setUrl({ semanas: Number(v) })}
          aria-label="Período"
        >
          {PERIODOS.map((p) => (
            <ToggleGroupItem key={p} value={String(p)} className="tabular-nums">
              {p} sem
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <AvisoNaoCausal />

      <Tabs value={url.aba} onValueChange={(v) => setUrl({ aba: v })}>
        <TabsList>
          <TabsTrigger value="adocao">Adoção</TabsTrigger>
          <TabsTrigger value="repasses">Repasses</TabsTrigger>
        </TabsList>

        <TabsContent value="adocao" className="space-y-5">
          {painel.isLoading ? (
            <PageSkeleton variant="cockpit" />
          ) : painel.isError || !painel.data ? (
            <EmptyState
              icon={AlertTriangle}
              title="Não consegui carregar o painel"
              description={`Erro ao ler venda_painel: ${(painel.error as { message?: string } | null)?.message ?? 'sem detalhe'}. Isto não é "zero adoção".`}
              actionLabel="Tentar de novo"
              onAction={() => void painel.refetch()}
            />
          ) : (
            <>
              {!painel.data.base_confiavel && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Badge variant="outline">linha de base não confiável</Badge>
                  A Onda 1 ainda não ligou pela condição de lista idêntica — as colunas de base mostram “não consegui medir”.
                </p>
              )}
              <PainelOndas ondas={painel.data.ondas} />
              {painel.data.linhas.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title="Nenhuma farmer no programa"
                  description="O gerador roda só para donos de carteira com papel comercial de farmer."
                />
              ) : (
                <TabelaAdocao linhas={painel.data.linhas} baseConfiavel={painel.data.base_confiavel} />
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="repasses">
          {painel.data ? (
            <AbaRepasses disponivel={painel.data.repasse_disponivel} hoje={painel.data.hoje} />
          ) : painel.isLoading ? (
            <PageSkeleton variant="list" />
          ) : (
            <EmptyState
              icon={AlertTriangle}
              title="Não consegui carregar o painel"
              description="Sem o painel não sei se a lista de repasse está instalada no banco."
              actionLabel="Tentar de novo"
              onAction={() => void painel.refetch()}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
