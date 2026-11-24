// Cabeçalho (breadcrumb + hero com avatar, badges, status chips e ações) do Customer 360.
// Extraído de src/pages/Customer360.tsx (god-component split).
import { useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, Building2, Calendar, MessageSquare, ShoppingBag, AlertCircle, Activity,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CallButton } from '@/components/call/CallButton';
import { AgendarVisitaDialog } from '@/components/visitas/AgendarVisitaDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { DICA_COBERTURA_LINHAS, formatMargemPct, legendaCoberturaItens, legendaMargemSemCompraNaJanela } from '@/lib/format';
import { coberturaCustoCliente } from '@/lib/scoring/margin';
import { whatsappLink } from '@/lib/phone';
import { useIsMobile } from '@/hooks/use-mobile';
import { useLenteAtiva } from '@/lib/impersonation/useLenteAtiva';
import { useRegisterShortcuts, type Shortcut } from '@/components/shell/ShortcutsRegistry';
import { urlNovoPedido } from '@/lib/nav/clientes';
import { estadoSensorDestino, registrarFimDaLigacao, registrarUsoClientes } from '@/lib/nav/sensor-clientes';
import {
  formatDateOrDash, initials, healthTone, churnTone, formatDocument, margemTone,
} from './format';
import type { Customer, CustomerScore } from './viewTypes';
import type { EstadoSemLeitura } from '@/lib/leitura/estado-de-leitura';

export function CustomerHero({
  customer, score: s, isPj, onBack, rotuloVoltar = 'Clientes', scoreSemLeitura = null,
}: {
  customer: Customer;
  score: CustomerScore;
  isPj: boolean;
  onBack: () => void;
  /** Rótulo do voltar: a tela de onde a 360 foi aberta (Clientes, Meu dia, Telefonia…). */
  rotuloVoltar?: string;
  /** Leitura do score que NÃO aconteceu (sem score em mãos): o chip não pode dizer "Sem score". */
  scoreSemLeitura?: EstadoSemLeitura | null;
}) {
  const health = healthTone(s?.health_class ?? null, s?.sales_history_status ?? null);
  const rotuloSaude = scoreSemLeitura
    ? (scoreSemLeitura === 'sem-rede' ? 'Score: sem rede' : 'Score indisponível')
    : health.label;
  const churn = churnTone(s?.churn_risk ?? null);
  const coberturaItens = legendaCoberturaItens(coberturaCustoCliente(s));
  // Sem margem E sem cobertura: se o motivo é a janela (nenhuma compra em 12m), a tela diz — em vez
  // de sumir com a margem como se nunca tivesse existido, ou de mostrar um número velho.
  // Sem `cap_custo_ler` o servidor não concede o número (FU4-F): a tela não fala de margem — nem
  // "não apurada" nem "sem compra na janela", que seriam afirmações falsas sobre o cliente.
  const margemOculta = s?.margem_oculta === true;
  const semCompraNaJanela = !margemOculta && s?.gross_margin_pct == null && !coberturaItens
    ? legendaMargemSemCompraNaJanela(s?.days_since_last_purchase)
    : null;
  const waHref = whatsappLink(customer.phone);
  // Onda C: no celular as ações são alvos de toque (44px); no desktop, compactas.
  const tamanhoAcao = useIsMobile() ? 'touch' : 'sm';
  const isImpersonating = useLenteAtiva();
  // L liga (atalho da 360): aciona o botão Ligar de verdade — mesma trava de lente/telefone inválido.
  const ligarRef = useRef<HTMLSpanElement>(null);
  const atalhos = useMemo<Shortcut[]>(() => (customer.phone ? [{
    keys: 'l',
    label: 'Ligar para o cliente',
    group: 'Cliente 360',
    enabled: () => {
      const botao = ligarRef.current?.querySelector('button');
      return !!botao && !botao.disabled;
    },
    handler: () => ligarRef.current?.querySelector('button')?.click(),
  }] : []), [customer.phone]);
  useRegisterShortcuts(atalhos);

  return (
    <>
      {/* ─── Breadcrumb + voltar ─── */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={onBack}
        >
          <ArrowLeft className="w-3.5 h-3.5 mr-1" aria-hidden />
          {rotuloVoltar}
        </Button>
        <span>/</span>
        <span className="text-foreground">360°</span>
      </div>

      {/* ─── Hero ─── */}
      <header className="bg-cockpit-hero relative overflow-hidden rounded-lg border border-border p-6">
        <div className="noise" />
        <div className="relative flex flex-col md:flex-row md:items-start gap-4">
          <div className="w-16 h-16 rounded-full border border-border bg-muted flex items-center justify-center overflow-hidden shrink-0">
            {customer.avatar_url ? (
              <img
                src={customer.avatar_url}
                alt={customer.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-xl font-semibold tracking-tight text-foreground">
                {initials(customer.name)}
              </span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Nome do cliente: line-clamp-2 em vez de truncate, p/ acomodar razao
                  social longa em viewport estreito (Lovable preview split, mobile).
                  Em viewport wide cabe em 1 linha; em estreito quebra sem truncar. */}
              <h1 className="font-display text-3xl font-medium tracking-[-0.04em] leading-tight line-clamp-2 break-words min-w-0">
                {customer.name}
              </h1>
              {isPj && (
                <Badge variant="outline" className="font-tabular text-[10px] uppercase">
                  <Building2 className="w-3 h-3 mr-1" />
                  PJ
                </Badge>
              )}
              {!isPj && customer.document && (
                <Badge variant="outline" className="font-tabular text-[10px] uppercase">
                  PF
                </Badge>
              )}
              {customer.requires_po && (
                <Badge variant="outline" className="text-[10px] uppercase">
                  Exige PO
                </Badge>
              )}
            </div>
            <div className="mt-1 flex items-center gap-3 flex-wrap text-sm text-muted-foreground">
              {customer.document && (
                <span className="font-tabular">{formatDocument(customer.document)}</span>
              )}
              {customer.cnae && (
                <Tooltip>
                  <TooltipTrigger>
                    <span className="font-tabular cursor-help">CNAE {customer.cnae}</span>
                  </TooltipTrigger>
                  <TooltipContent>Atividade econômica principal (CNAE)</TooltipContent>
                </Tooltip>
              )}
              <span>·</span>
              <span>Cliente desde {formatDateOrDash(customer.created_at)}</span>
            </div>
            {/* Status chips — peso visual maior que texto solto, p/ o estado do cliente
                competir com o CTA "Novo pedido". Cliente crítico precisa puxar o olho. */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border',
                  s?.sales_history_status === 'sem_historico'
                    ? 'bg-muted text-muted-foreground border-border'
                    : s?.health_class === 'critico' || s?.health_class === 'risco'
                      ? 'bg-status-error-bg text-status-error-bold border-status-error/20'
                      : s?.health_class === 'atencao'
                        ? 'bg-status-warning-bg text-status-warning-bold border-status-warning/20'
                        : s?.health_class === 'saudavel'
                          ? 'bg-status-success-bg text-status-success-bold border-status-success/20'
                          : 'bg-muted text-muted-foreground border-border',
                )}
              >
                <span className={cn('inline-block w-1.5 h-1.5 rounded-full', health.dot)} />
                {rotuloSaude}
              </span>
              {s?.churn_risk != null && (
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border',
                    churn.className.replace('text-', 'border-').replace('-bold', '/20'),
                    churn.className,
                  )}
                >
                  <AlertCircle className="w-3 h-3" />
                  {churn.label}
                </span>
              )}
              {s?.gross_margin_pct != null && (
                <span
                  title={coberturaItens ? DICA_COBERTURA_LINHAS : undefined}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border',
                    // Cortes 55 / 30 em percentual — decisão de produto, ver MARGEM_BOA_MIN.
                    margemTone(s.gross_margin_pct).className,
                  )}
                >
                  <Activity className="w-3 h-3" />
                  {formatMargemPct(s.gross_margin_pct)} margem
                  {/* Confiança da margem: "53%" sozinho parece apurado sobre o cliente inteiro. */}
                  {coberturaItens && <span className="font-normal opacity-80">· {coberturaItens}</span>}
                </span>
              )}
              {/* Sem margem MAS com cobertura computada: o cliente tem compras e nenhuma (ou quase
                  nenhuma) linha com custo. Antes este caso sumia da tela, indistinguível de "sem
                  venda" — e é justamente o que o cadastro de custo resolveria. Neutro, não vermelho:
                  margem desconhecida não é margem ruim. */}
              {!margemOculta && s?.gross_margin_pct == null && coberturaItens && (
                <span
                  title={DICA_COBERTURA_LINHAS}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border bg-muted text-muted-foreground"
                >
                  <Activity className="w-3 h-3" />
                  margem não apurada · {coberturaItens}
                </span>
              )}
              {semCompraNaJanela && (
                <span
                  title={DICA_COBERTURA_LINHAS}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border bg-muted text-muted-foreground"
                >
                  <Activity className="w-3 h-3" />
                  margem: {semCompraNaJanela}
                </span>
              )}
            </div>
          </div>
          {/* Ações rápidas — sensor com tentativa (o toque) e sucesso (atendida / pedido enviado) separados */}
          <div className="flex flex-wrap gap-2">
            {customer.phone && (
              <span
                ref={ligarRef}
                className="inline-flex"
                aria-keyshortcuts="l"
                onClickCapture={() => registrarUsoClientes({ acao: 'ficha_acao', ficha: '360', tipo: 'ligar', fase: 'tentativa' })}
              >
                <CallButton
                  phone={customer.phone}
                  customerName={customer.name}
                  customerId={customer.user_id}
                  onCallEnd={(fim) => registrarFimDaLigacao('360', fim)}
                />
              </span>
            )}
            {waHref && (
              isImpersonating ? (
                <Button variant="outline" size={tamanhoAcao} disabled title="WhatsApp indisponível em modo Ver como">
                  <MessageSquare className="w-3.5 h-3.5 mr-1.5" aria-hidden />
                  WhatsApp
                </Button>
              ) : (
                <Button asChild variant="outline" size={tamanhoAcao}>
                  <a
                    href={waHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => registrarUsoClientes({ acao: 'ficha_acao', ficha: '360', tipo: 'whatsapp', fase: 'tentativa' })}
                  >
                    <MessageSquare className="w-3.5 h-3.5 mr-1.5" aria-hidden />
                    WhatsApp
                  </a>
                </Button>
              )
            )}
            <Button asChild size={tamanhoAcao}>
              <Link
                to={urlNovoPedido(customer.user_id)}
                state={estadoSensorDestino('360', 'novo_pedido')}
                onClick={() => registrarUsoClientes({ acao: 'ficha_acao', ficha: '360', tipo: 'novo_pedido', fase: 'tentativa' })}
              >
                <ShoppingBag className="w-3.5 h-3.5 mr-1.5" aria-hidden />
                Novo pedido
              </Link>
            </Button>
            <AgendarVisitaDialog
              customerUserId={customer.user_id}
              customerName={customer.name}
              trigger={
                <Button variant="outline" size={tamanhoAcao}>
                  <Calendar className="w-3.5 h-3.5 mr-1.5" aria-hidden />
                  Agendar visita
                </Button>
              }
            />
          </div>
        </div>
      </header>
    </>
  );
}
