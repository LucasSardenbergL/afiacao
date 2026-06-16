// src/pages/RotaPainelLigacoes.tsx
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useRoutePanel } from '@/queries/useRoutePanel';
import { useSalespeople } from '@/hooks/useCoverage';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { GrupoEficacia, TaxaGated, GapCliente } from '@/lib/route/painel/types';

const fmtBRL = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const fmtTaxa = (t: TaxaGated) => t.exibivel && t.valor != null
  ? `${(t.valor * 100).toFixed(0)}%`
  : `${t.fracao} · amostra baixa`;

const BUCKET_LABEL: Record<string, string> = { top: 'Prioridade', winback: 'Recuperar', coldstart: 'Novo cliente', '—': '—' };
const CANAL_LABEL: Record<string, string> = { ligacao: 'Ligação', whatsapp: 'WhatsApp' };

export default function RotaPainelLigacoes() {
  const { isMaster, isGestorComercial } = useAuth();
  const [dias, setDias] = useState(30);
  const { data: p, isLoading } = useRoutePanel(dias);
  const { data: salespeople = [] } = useSalespeople();
  const nomeVend = (id: string) => salespeople.find((s) => s.user_id === id)?.name ?? id.slice(0, 8);

  if (!isMaster && !isGestorComercial) return <Navigate to="/" replace />;
  if (isLoading || !p) return <PageSkeleton variant="cockpit" />;

  const semDado = p.elegiveis_n === 0 && p.contatos_total === 0;

  return (
    <div className="container py-6 space-y-4 max-w-4xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl">Painel das ligações da rota</h1>
          <p className="text-2xs text-muted-foreground">
            Cobertura × eficácia do programa de ligações. <Badge variant="outline" className="text-status-warning">piloto · direcional</Badge>
          </p>
        </div>
        <Select value={String(dias)} onValueChange={(v) => setDias(Number(v))}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">7 dias</SelectItem>
            <SelectItem value="30">30 dias</SelectItem>
            <SelectItem value="90">90 dias</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {semDado ? (
        <Card className="p-6 text-sm text-muted-foreground">Sem dados no período ainda. O painel preenche conforme as vendedoras abrem a lista e registram as ligações.</Card>
      ) : (
        <>
          {/* Headline: cobertura + gap + capacidade */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card className="p-4">
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">Cobertura da fila</div>
              <div className="kpi-value text-2xl">{fmtTaxa(p.cobertura_count)}</div>
              <div className="text-2xs text-muted-foreground">{p.contatados_n} de {p.elegiveis_n} elegíveis contatados</div>
              <div className="text-2xs text-muted-foreground">por valor: {fmtBRL(p.contatados_valor)} de {fmtBRL(p.elegiveis_valor)}</div>
            </Card>
            <Card className="p-4 border-status-warning/40">
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">Valor esperado sem contato</div>
              <div className="kpi-value text-2xl text-status-warning">{fmtBRL(p.gap_valor)}</div>
              <div className="text-2xs text-muted-foreground">valor esperado da fila não contatada (projeção · não é receita realizada)</div>
            </Card>
            <Card className="p-4">
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">Capacidade</div>
              <div className="kpi-value text-2xl">{p.contatos_por_dia.toFixed(1)}<span className="text-sm">/dia</span></div>
              <div className="text-2xs text-muted-foreground">{p.contatos_total} ligações em {p.dias_com_dado} dia(s)</div>
              {p.dias_sem_denominador > 0 && <div className="text-2xs text-status-warning">{p.dias_sem_denominador} dia(s) sem denominador (lista não aberta)</div>}
            </Card>
          </div>

          {/* Gap acionável: clientes de alto valor sem contato */}
          {p.gap_clientes.length > 0 && (
            <GapClientesCard
              clientes={p.gap_clientes}
              total={p.gap_clientes_total}
              nomeVend={nomeVend}
            />
          )}

          {/* Eficácia global */}
          <Card className="p-4">
            <div className="text-sm font-semibold mb-2">Eficácia das ligações (reportada pela vendedora)</div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div><div className="text-2xs text-muted-foreground">Atendimento</div><div className="kpi-value text-lg">{fmtTaxa(p.global.resposta)}</div></div>
              <div><div className="text-2xs text-muted-foreground">Conversão reportada</div><div className="kpi-value text-lg">{fmtTaxa(p.global.conversao)}</div></div>
              <div><div className="text-2xs text-muted-foreground">Opt-out (guardrail)</div><div className="kpi-value text-lg text-status-error">{fmtTaxa(p.global.optout)}</div></div>
            </div>
            <div className="text-2xs text-muted-foreground mt-2">Valor esperado convertido: {fmtBRL(p.global.valor_capturado)} · atendimento inclui convertidos.</div>
          </Card>

          {/* Cortes */}
          <CorteCard titulo="Por vendedora" aviso="comparação crua engana se o mix de cidade/bucket difere" grupos={p.por_vendedora} rotulo={nomeVend} />
          <CorteCard titulo="Por bucket" grupos={p.por_bucket} rotulo={(k) => BUCKET_LABEL[k] ?? k} />
          <CorteCard titulo="Por canal" grupos={p.por_canal} rotulo={(k) => CANAL_LABEL[k] ?? k} />
        </>
      )}
    </div>
  );
}

function GapClientesCard({ clientes, total, nomeVend }: {
  clientes: GapCliente[];
  total: number;
  nomeVend: (id: string) => string;
}) {
  return (
    <Card className="p-4 border-status-warning/40">
      <div className="text-sm font-semibold mb-1">
        Clientes valiosos sem contato
        {' '}
        <span className="font-normal text-muted-foreground">
          (top {clientes.length}{total > clientes.length ? ` de ${total}` : ''})
        </span>
      </div>
      <div className="text-2xs text-muted-foreground mb-2">
        Elegíveis não contatados na janela — ordenados por valor esperado.
      </div>
      <div className="divide-y divide-border">
        {clientes.map((g) => (
          <div key={`${g.data_rota}|${g.farmer_id}|${g.customer_user_id}`}
            className="py-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{g.cliente_nome ?? '(sem nome)'}</div>
              <div className="text-2xs text-muted-foreground">{g.cidade ?? '—'} · {nomeVend(g.farmer_id)} · {g.data_rota}</div>
            </div>
            <div className="text-sm font-tabular text-status-warning shrink-0">{fmtBRL(g.valor)}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function CorteCard({ titulo, aviso, grupos, rotulo }: {
  titulo: string; aviso?: string; grupos: GrupoEficacia[]; rotulo: (k: string) => string;
}) {
  const fmtTaxaLocal = (t: TaxaGated) => t.exibivel && t.valor != null ? `${(t.valor * 100).toFixed(0)}%` : `${t.fracao}·baixa`;
  return (
    <Card className="p-4">
      <div className="text-sm font-semibold">{titulo}</div>
      {aviso && <div className="text-2xs text-status-warning mb-1">⚠ {aviso}</div>}
      <div className="divide-y divide-border">
        {grupos.length === 0 && <div className="text-2xs text-muted-foreground py-2">sem dados</div>}
        {grupos.map((g) => (
          <div key={g.chave} className="py-2 flex items-center justify-between gap-2 text-sm">
            <span className="font-medium truncate">{rotulo(g.chave)}</span>
            <div className="flex items-center gap-3 text-2xs text-muted-foreground shrink-0">
              <span>{g.contatos} contatos</span>
              <span>conv {fmtTaxaLocal(g.conversao)}</span>
              <span>opt-out {fmtTaxaLocal(g.optout)}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
