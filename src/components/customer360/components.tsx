import type * as React from 'react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Star, Award, Cake, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CARGO_LABEL, type CustomerContact } from '@/lib/customer-contact/types';
import { formatPhone } from './format';
import { CallButton } from '@/components/call/CallButton';
import { whatsappLink } from '@/lib/phone';

export function KpiCard({
  label,
  value,
  hint,
  trend,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  trend?: { value: number; label: string };
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {label}
          </span>
          {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        </div>
        <div className="kpi-value">{value}</div>
        {trend && (
          <div
            className={cn(
              'kpi-delta',
              trend.value > 0 ? 'text-status-success-bold' : trend.value < 0 ? 'text-status-error-bold' : 'text-muted-foreground',
            )}
          >
            {trend.value > 0 ? '↑' : trend.value < 0 ? '↓' : '·'} {Math.abs(trend.value).toFixed(0)}%
            <span className="text-muted-foreground font-normal ml-1">{trend.label}</span>
          </div>
        )}
        {hint && !trend && <div className="text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

export function DataRow({
  icon: Icon,
  label,
  value,
  hint,
  href,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null | undefined;
  hint?: string;
  href?: string;
}) {
  const display = value ?? '—';
  return (
    <div className="flex items-start gap-3">
      {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        {href && value ? (
          <a href={href} className="text-sm text-foreground hover:underline truncate block">
            {display}
          </a>
        ) : (
          <div className="text-sm text-foreground truncate">{display}</div>
        )}
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
    </div>
  );
}

/**
 * Linha compacta de contato extra (dono / gerente / comprador / etc).
 * Mostra nome + cargo, telefone clicável + WhatsApp, badges (primary, decisão,
 * só WhatsApp, aniversário). Edição completa fica em /admin/customers detail
 * tab — aqui é só leitura pra contexto operacional rápido.
 */
export function ContactRow({
  contact,
}: {
  contact: CustomerContact;
}) {
  const displayName = contact.nome ?? formatPhone(contact.phone);
  const cargoLabel = contact.cargo ? CARGO_LABEL[contact.cargo] : null;
  const waHref = whatsappLink(contact.phone);
  // Aniversário esse mês? Destaque sutil pra lembrar de mandar mensagem.
  const isBirthdayMonth = (() => {
    if (!contact.birthday) return false;
    try {
      const d = parseISO(contact.birthday);
      return d.getMonth() === new Date().getMonth();
    } catch {
      return false;
    }
  })();
  return (
    <li className="pt-2 first:pt-0 space-y-1">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-sm truncate">{displayName}</span>
            {cargoLabel && (
              <Badge variant="outline" className="text-[9px] px-1 py-0">
                {cargoLabel}
              </Badge>
            )}
            {contact.is_primary && (
              <Tooltip>
                <TooltipTrigger>
                  <Star className="w-3 h-3 text-status-warning-bold fill-status-warning-bold" />
                </TooltipTrigger>
                <TooltipContent>Contato principal</TooltipContent>
              </Tooltip>
            )}
            {contact.is_decision_maker && (
              <Tooltip>
                <TooltipTrigger>
                  <Award className="w-3 h-3 text-status-info-bold" />
                </TooltipTrigger>
                <TooltipContent>Decision maker (quem decide a compra)</TooltipContent>
              </Tooltip>
            )}
            {isBirthdayMonth && (
              <Tooltip>
                <TooltipTrigger>
                  <Cake className="w-3 h-3 text-status-success-bold" />
                </TooltipTrigger>
                <TooltipContent>
                  Aniversário em {format(parseISO(contact.birthday!), "dd 'de' MMM", { locale: ptBR })}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
            {contact.whatsapp_only ? (
              waHref ? (
                <a
                  href={waHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline hover:text-foreground transition-colors"
                >
                  {formatPhone(contact.phone)} · só WhatsApp
                </a>
              ) : (
                <span>{formatPhone(contact.phone)} · só WhatsApp</span>
              )
            ) : (
              <span className="inline-flex items-center gap-1">
                {formatPhone(contact.phone)}
                <CallButton phone={contact.phone} customerName={displayName} variant="icon" />
              </span>
            )}
          </div>
          {contact.email && (
            <a
              href={`mailto:${contact.email}`}
              className="text-xs text-muted-foreground hover:underline hover:text-foreground transition-colors truncate block mt-0.5"
            >
              {contact.email}
            </a>
          )}
        </div>
        {!contact.whatsapp_only && waHref && (
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-status-success-bold transition-colors shrink-0 mt-0.5"
            aria-label="Enviar WhatsApp"
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
    </li>
  );
}

/**
 * Linha de score (label esquerda, valor à direita em mono). Usada no card "Score
 * comercial" pra densidade tabular — diferente de DataRow que é vertical (form-like).
 */
export function ScoreRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground truncate">{label}</div>
        {hint && <div className="text-[10px] text-muted-foreground/70 mt-0.5">{hint}</div>}
      </div>
      <div className="font-mono text-sm font-medium text-foreground tabular-nums shrink-0">
        {value}
      </div>
    </div>
  );
}
