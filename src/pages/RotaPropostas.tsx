import { useMemo, useState } from 'react';
import { MessageSquareText, ChevronDown, ChevronUp, Loader2, Lock, Send, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useRouteContactList } from '@/queries/useRouteContactList';
import type { RouteContactItem } from '@/queries/useRouteContactList';
import { usePropostaPreview } from '@/queries/usePropostaPreview';
import type { PropostaPreview } from '@/queries/usePropostaPreview';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  avaliarCotacaoProposta,
  formatarPrazoEntrega,
  montarParamsProposta,
  type CotacaoProposta,
  type CotacaoRow,
  type MotivoTravaLinha,
  type MotivoTravaGeral,
} from '@/lib/whatsapp/proposta-cotacao';
import { renderTemplatePreview } from '@/lib/whatsapp/template-payload';
import { enviarProposta, TEMPLATE_PROPOSTA, type SupabaseWhatsappProposta } from '@/services/whatsappProposta';
import { track } from '@/lib/analytics';

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function fmtBRL(v: number): string { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

const MOTIVO_LINHA_LABEL: Record<MotivoTravaLinha, string> = {
  nao_encontrado: 'fora do catálogo da conta',
  inativo: 'SKU inativo',
  sem_unidade: 'sem unidade',
  sem_preco: 'sem preço válido',
  sem_estoque_info: 'estoque desconhecido',
  estoque_insuficiente: 'estoque insuficiente',
};
const MOTIVO_GERAL_LABEL: Record<MotivoTravaGeral, string> = {
  sem_prazo: 'sem data de entrega derivável da rota',
  sem_nome: 'cliente sem nome para o template',
  sem_telefone: 'cliente sem telefone',
  cesta_vazia: 'cesta vazia',
};

type PrazoEntrega = { iso: string; label: string } | null;

interface Revisao {
  cotacao: CotacaoProposta;
  render: string | null;     // mensagem EXATA que sai (null quando travada)
  templateAtivo: boolean;
}

/** Recotação no CLIQUE (money-path): RPC determinística + travas puras + render fiel. */
async function cotarProposta(
  preview: PropostaPreview,
  cliente: RouteContactItem,
  prazo: PrazoEntrega,
): Promise<Revisao> {
  const enviaveis = [...preview.cesta.principal, ...preview.cesta.secundarios.slice(0, 3)];
  const skus = [...new Set([
    ...enviaveis.map(i => i.omie_codigo_produto),
    ...preview.crossSell.map(c => c.omie_codigo_produto),
  ])];
  const [cotRes, tplRes] = await Promise.all([
    supabase.rpc('get_whatsapp_proposta_cotacao' as never, {
      p_customer_user_id: cliente.customerUserId,
      p_account: preview.account,
      p_skus: skus,
    } as never),
    supabase.from('whatsapp_templates').select('corpo_referencia, ativo').eq('nome', TEMPLATE_PROPOSTA).maybeSingle(),
  ]);
  if (cotRes.error) throw new Error(cotRes.error.message);

  const primeiroNome = preview.nomeCliente ? preview.nomeCliente.split(' ')[0] : null;
  const cotacao = avaliarCotacaoProposta({
    cesta: preview.cesta,
    maxSecundarios: 3,
    crossSell: preview.crossSell,
    cotacao: (cotRes.data ?? []) as unknown as CotacaoRow[],
    nomesPorSku: preview.nomesPorSku,
    prazoEntrega: prazo?.iso ?? null,
    primeiroNome,
    telefone: cliente.phone,
  });

  const tpl = (tplRes.data ?? null) as { corpo_referencia: string; ativo: boolean } | null;
  let render: string | null = null;
  if (!cotacao.travada && tpl && primeiroNome && prazo) {
    render = renderTemplatePreview(tpl.corpo_referencia, montarParamsProposta({
      primeiroNome, prazoLabel: prazo.label, linhas: cotacao.linhas, crossSellOk: cotacao.crossSellOk,
    }));
  }
  return { cotacao, render, templateAtivo: tpl?.ativo ?? false };
}

function PainelRevisao({ rev, onEnviar, enviando, jaEnviada }: {
  rev: Revisao;
  onEnviar: () => void;
  enviando: boolean;
  jaEnviada: boolean;
}) {
  const { cotacao } = rev;
  return (
    <div className="mt-3 space-y-2 border rounded-md p-3 bg-muted/20">
      <div className="text-xs font-medium">Recotação Omie (agora)</div>

      {cotacao.travasGerais.length > 0 && (
        <div className="text-xs text-status-error">
          {cotacao.travasGerais.map(m => MOTIVO_GERAL_LABEL[m]).join(' · ')}
        </div>
      )}

      <div className="space-y-1">
        {cotacao.linhas.map(l => (
          <div key={l.omie_codigo_produto} className="flex items-center gap-2 text-xs">
            <span className="flex-1 min-w-0 truncate">{l.qtd}× {l.nome}</span>
            {l.motivoTrava ? (
              <Badge variant="destructive" className="shrink-0">{MOTIVO_LINHA_LABEL[l.motivoTrava]}</Badge>
            ) : (
              <>
                <span className="font-tabular shrink-0">{fmtBRL((l.preco as number) * l.qtd)}</span>
                <span className="text-muted-foreground shrink-0">({fmtBRL(l.preco as number)}/{l.unidade} · {l.fonte})</span>
              </>
            )}
          </div>
        ))}
      </div>

      {cotacao.crossSellRemovidos.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          sugestão removida (indisponível): {cotacao.crossSellRemovidos.map(x => x.nome).join(', ')}
        </div>
      )}

      {cotacao.total !== null && (
        <div className="flex items-center justify-between text-sm border-t pt-2">
          <span>Total da proposta</span>
          <span className="kpi-value">{fmtBRL(cotacao.total)}</span>
        </div>
      )}

      {rev.render && (
        <div>
          <div className="text-[11px] text-muted-foreground mb-1">Mensagem exata (template Meta):</div>
          <pre className="whitespace-pre-wrap text-xs bg-background border rounded-md p-2 font-sans">{rev.render}</pre>
        </div>
      )}

      {!rev.templateAtivo && !cotacao.travada && (
        <div className="text-xs text-status-warning">
          Template aguardando aprovação da Meta (inativo) — o envio será recusado até o founder ativá-lo.
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" onClick={onEnviar} disabled={cotacao.travada || enviando || jaEnviada}>
          {enviando ? <Loader2 className="w-4 h-4 animate-spin" /> : cotacao.travada ? <Lock className="w-4 h-4" /> : <Send className="w-4 h-4" />}
          {jaEnviada ? 'Enviada' : cotacao.travada ? 'Travada' : 'Enviar via WhatsApp'}
        </Button>
        {cotacao.travada && (
          <span className="text-[11px] text-muted-foreground">proposta não sai parcial — resolva as travas acima</span>
        )}
      </div>
    </div>
  );
}

function PropostaRow({ cliente, prazo }: { cliente: RouteContactItem; prazo: PrazoEntrega }) {
  const [aberto, setAberto] = useState(false);
  const { data, isLoading } = usePropostaPreview(cliente.customerUserId, { enabled: aberto });
  const { user } = useAuth();
  const [rev, setRev] = useState<Revisao | null>(null);
  const [cotando, setCotando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [enviada, setEnviada] = useState(false);

  const cotar = async () => {
    if (!data) return;
    setCotando(true);
    try {
      const r = await cotarProposta(data, cliente, prazo);
      setRev(r);
      track('whatsapp.proposta_cotada', {
        travada: r.cotacao.travada,
        linhas: r.cotacao.linhas.length,
        travas: r.cotacao.linhas.filter(l => l.motivoTrava).map(l => l.motivoTrava),
      });
    } catch (e) {
      toast.error('Recotação falhou: ' + (e instanceof Error ? e.message : 'erro desconhecido'));
    } finally {
      setCotando(false);
    }
  };

  const enviar = async () => {
    if (!data || !rev || !user || !prazo || !cliente.phone || !data.account) return;
    const primeiroNome = data.nomeCliente ? data.nomeCliente.split(' ')[0] : null;
    if (!primeiroNome) return;
    setEnviando(true);
    try {
      const r = await enviarProposta({
        supabase: supabase as unknown as SupabaseWhatsappProposta,
        customerUserId: cliente.customerUserId,
        account: data.account,
        phoneE164: cliente.phone,
        primeiroNome,
        prazo,
        cotacao: rev.cotacao,
        createdBy: user.id,
        customerDocument: data.documentoCliente,
      });
      if (r.ok) {
        setEnviada(true);
        toast.success(r.jaEnviada ? 'Proposta já havia sido enviada para esta rota — registro conferido' : 'Proposta enviada ✓');
        if (r.orcamentoErro) toast.error('Orçamento não registrado: ' + r.orcamentoErro);
        track('whatsapp.proposta_enviada', { jaEnviada: r.jaEnviada, comOrcamento: !!r.orcamentoId });
      } else {
        toast.error(r.motivo === 'travada' ? 'Proposta travada: ' + r.detalhe : 'Envio recusado: ' + r.detalhe);
      }
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Card className="p-3">
      <button type="button" onClick={() => setAberto(a => !a)} className="flex items-center gap-2 w-full text-left">
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">{cliente.name}</div>
          <div className="text-xs text-muted-foreground font-tabular">{cliente.cityKey.city}</div>
        </div>
        {enviada && <CheckCircle2 className="w-4 h-4 text-status-success shrink-0" />}
        <span className="kpi-value text-sm w-24 text-right">R$ {Math.round(cliente.valorDaLigacao)}</span>
        {aberto ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {aberto && (
        <div className="mt-3 border-t pt-3">
          {isLoading && <div className="text-xs text-muted-foreground">Gerando proposta…</div>}
          {!isLoading && data && (
            data.proposta.vazia ? (
              <div className="text-xs text-muted-foreground">
                {data.semHistorico ? 'Sem histórico de pedidos recentes.' : 'Sem cesta de recompra confiável (histórico fino ou só SKUs inativos).'}
              </div>
            ) : (
              <>
                <pre className="whitespace-pre-wrap text-sm bg-muted/40 rounded-md p-3 font-sans">{data.proposta.texto}</pre>
                <div className="flex flex-wrap gap-2 mt-2 text-[11px] text-muted-foreground">
                  <Badge variant="secondary">{data.proposta.itensPrincipais} itens principais</Badge>
                  {data.crossSellCount > 0 && <Badge variant="outline">+{data.crossSellCount} cross-sell</Badge>}
                  {data.removidosInativos > 0 && <Badge variant="outline">{data.removidosInativos} SKU inativo oculto</Badge>}
                  <span>conta: {data.account}</span>
                  <span>· {data.totalPedidos} pedidos</span>
                </div>
                {data.statusesVistos.length > 0 && (
                  <div className="text-[11px] text-muted-foreground mt-1">status no histórico: {data.statusesVistos.join(', ')}</div>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={cotar} disabled={cotando || !cliente.phone}>
                    {cotando ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquareText className="w-4 h-4" />}
                    Cotar & revisar envio
                  </Button>
                  {!cliente.phone && <span className="text-[11px] text-status-warning">cliente sem telefone — envio indisponível</span>}
                </div>
                {rev && <PainelRevisao rev={rev} onEnviar={enviar} enviando={enviando} jaEnviada={enviada} />}
              </>
            )
          )}
        </div>
      )}
    </Card>
  );
}

export default function RotaPropostas() {
  const workday = useMemo(() => todayIso(), []);
  const { data, isLoading } = useRouteContactList(workday);

  if (isLoading) return <PageSkeleton variant="list" />;

  const fila = data?.whatsappQueue ?? [];
  const cidadesLabel = data?.cidades?.length ? data.cidades.join(', ') : null;
  const prazo = data ? formatarPrazoEntrega(workday, data.routeDate, data.dailyOnly) : null;

  return (
    <div className="p-4 space-y-4">
      <header>
        <h1 className="font-display text-2xl">Propostas por WhatsApp</h1>
        <p className="text-sm text-muted-foreground">
          {data?.dailyOnly ? 'Motor diário (Divinópolis + Carmo do Cajuru)' : cidadesLabel ? `Rota de amanhã — ${cidadesLabel}` : 'Sem rota para amanhã'}
          {prazo ? ` · entrega ${prazo.label}` : ''}
          {' · '}recotação Omie no envio — a vendedora decide enviar
        </p>
      </header>

      {fila.length === 0 ? (
        <EmptyState
          icon={MessageSquareText}
          tone="operational"
          title="Nenhum cliente na fila de WhatsApp"
          description="A fila de proposta (accept-a-proposal) vem dos clientes com recompra previsível nas cidades de amanhã."
        />
      ) : (
        <div className="space-y-2">
          {fila.map(c => <PropostaRow key={c.customerUserId} cliente={c} prazo={prazo} />)}
        </div>
      )}
    </div>
  );
}
