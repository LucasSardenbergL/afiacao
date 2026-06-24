// Cabeçalho (breadcrumb + hero com avatar, badges, status chips e ações) do Customer 360.
// Extraído de src/pages/Customer360.tsx (god-component split).
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
import { whatsappLink } from '@/lib/phone';
import {
  formatPctMaybe, formatDateOrDash, initials, healthTone, churnTone, formatDocument,
} from './format';
import type { Customer, CustomerScore } from './viewTypes';

export function CustomerHero({
  customer, score: s, isPj, onBack,
}: {
  customer: Customer;
  score: CustomerScore;
  isPj: boolean;
  onBack: () => void;
}) {
  const health = healthTone(s?.health_class ?? null, s?.sales_history_status ?? null);
  const churn = churnTone(s?.churn_risk ?? null);
  const waHref = whatsappLink(customer.phone);

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
          <ArrowLeft className="w-3.5 h-3.5 mr-1" />
          Clientes
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
                {health.label}
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
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border',
                    s.gross_margin_pct >= 0.3
                      ? 'bg-status-success-bg text-status-success-bold border-status-success/20'
                      : s.gross_margin_pct >= 0.15
                        ? 'bg-status-warning-bg text-status-warning-bold border-status-warning/20'
                        : 'bg-status-error-bg text-status-error-bold border-status-error/20',
                  )}
                >
                  <Activity className="w-3 h-3" />
                  {formatPctMaybe(s.gross_margin_pct)} margem
                </span>
              )}
            </div>
          </div>
          {/* Ações rápidas */}
          <div className="flex flex-wrap gap-2">
            {customer.phone && (
              <CallButton phone={customer.phone} customerName={customer.name} />
            )}
            {waHref && (
              <Button asChild variant="outline" size="sm">
                <a href={waHref} target="_blank" rel="noopener noreferrer">
                  <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
                  WhatsApp
                </a>
              </Button>
            )}
            <Button asChild size="sm">
              <Link to={`/sales/new?customer=${customer.user_id}`}>
                <ShoppingBag className="w-3.5 h-3.5 mr-1.5" />
                Novo pedido
              </Link>
            </Button>
            <AgendarVisitaDialog
              customerUserId={customer.user_id}
              customerName={customer.name}
              trigger={
                <Button variant="outline" size="sm">
                  <Calendar className="w-3.5 h-3.5 mr-1.5" />
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
