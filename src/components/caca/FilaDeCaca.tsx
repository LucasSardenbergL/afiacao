/**
 * FilaDeCaca — fila de trabalho do vendedor "hunter".
 *
 * Componente PURO: recebe os dados via props; sem hook de query, sem supabase,
 * sem useEffect de dados. Determinístico.
 *
 * Padrão visual: segue FilaDoDia.tsx (mesma densidade B2B, mesmos tokens).
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  MoreHorizontal,
  Phone,
  UserRound,
  CheckCircle2,
  XCircle,
  Clock,
  Smile,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { track } from '@/lib/analytics';
import type { CacaCandidatoDisplay } from '@/lib/caca/types';
import {
  labelSabor,
  faixaConfianca,
  classeSabor,
  telLink,
  agruparPorDocumento,
} from '@/lib/caca/apresentacao';

// ─── Tipos internos ────────────────────────────────────────────────────────────

type OutcomeCaca = 'cacei' | 'converteu' | 'sem_fit' | 'nao_agora';

// ─── Labels de confiança ───────────────────────────────────────────────────────

const CONFIANCA_UI: Record<'alta' | 'media' | 'baixa', { label: string; cls: string }> = {
  alta: { label: 'Confiança alta', cls: 'text-status-success' },
  media: { label: 'Confiança média', cls: 'text-status-warning' },
  baixa: { label: 'Confiança baixa', cls: 'text-muted-foreground' },
};

/** Rótulo legível para a empresa-alvo */
function labelEmpresa(id: string): string {
  switch (id) {
    case 'oben':
      return 'Oben';
    case 'colacor':
      return 'Colacor';
    case 'colacor_sc':
      return 'Colacor SC';
    default:
      return id;
  }
}

/**
 * Payload comum de TODOS os eventos `caca.*` — identifica o candidato (documento
 * + empresa-alvo + cliente) pra a métrica de conversão por sabor/empresa do piloto
 * (Codex P1: sem isso, outcome era anônimo e não dava pra cruzar com a 1ª compra).
 * Em card multiempresa, usa a empresa-alvo do representante (melhor do grupo);
 * seletor de empresa por card é follow-up v2.
 */
function eventoBase(display: CacaCandidatoDisplay) {
  return {
    documento: display.features.documento,
    empresa_alvo: display.features.empresaAlvo,
    cliente_user_id: display.clienteUserId,
    sabor: display.sabor,
    confianca: display.confianca,
    rank: display.rankFinal,
  };
}

// ─── Menu de outcome ───────────────────────────────────────────────────────────

interface OutcomeMenuProps {
  documento: string;
  display: CacaCandidatoDisplay;
  onOcultar?: (documento: string) => void;
}

function CacaOutcomeMenu({ documento, display, onOcultar }: OutcomeMenuProps) {
  const registrar = (resultado: OutcomeCaca) => {
    track('caca.outcome', { ...eventoBase(display), resultado });
    if (resultado === 'nao_agora') {
      onOcultar?.(documento);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Opções"
          onClick={() => track('caca.item_aberto', eventoBase(display))}
        >
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => registrar('cacei')}>
          <CheckCircle2 className="w-4 h-4 mr-2 text-status-info-bold" />
          Cacei
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => registrar('converteu')}>
          <Smile className="w-4 h-4 mr-2 text-status-success-bold" />
          Converteu!
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => registrar('sem_fit')}>
          <XCircle className="w-4 h-4 mr-2 text-status-error-bold" />
          Sem fit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => registrar('nao_agora')}>
          <Clock className="w-4 h-4 mr-2" />
          Não agora
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Card de candidato ─────────────────────────────────────────────────────────

interface CandidatoCardProps {
  documento: string;
  empresasAlvo: string[];
  display: CacaCandidatoDisplay;
  onOcultar?: (documento: string) => void;
}

function CandidatoCard({ documento, empresasAlvo, display, onOcultar }: CandidatoCardProps) {
  const faixa = faixaConfianca(display.confianca);
  const conf = CONFIANCA_UI[faixa];
  const tel = telLink(display.telefone);
  const fichaHref = display.clienteUserId
    ? `/admin/customers/${display.clienteUserId}/360`
    : null;

  const nomeExibido = display.nome ?? `Sem nome — doc ${documento}`;
  const multiEmpresa = empresasAlvo.length > 1;

  return (
    <div className="p-3 flex items-start justify-between gap-3 hover:bg-muted/30">
      {/* Coluna principal */}
      <div className="min-w-0 flex-1">
        {/* Título: nome ou doc */}
        {fichaHref ? (
          <Link
            to={fichaHref}
            className="block text-sm font-medium truncate hover:underline"
            onClick={() => track('caca.acao', { ...eventoBase(display), cta: 'ficha' })}
          >
            {nomeExibido}
          </Link>
        ) : (
          <div className="text-sm font-medium truncate">{nomeExibido}</div>
        )}

        {/* Badges: sabor + confiança */}
        <div className="text-2xs text-muted-foreground flex gap-1.5 flex-wrap items-center mt-0.5">
          <Badge variant="outline" className={`text-2xs ${classeSabor(display.sabor)}`}>
            {labelSabor(display.sabor)}
          </Badge>
          <Badge variant="outline" className={`text-2xs ${conf.cls}`}>
            {conf.label}
          </Badge>
          {/* Empresas-alvo: mostra as extras quando há mais de uma */}
          {multiEmpresa && (
            <span className="text-muted-foreground">
              caçar pra: {empresasAlvo.map(labelEmpresa).join(', ')}
            </span>
          )}
        </div>

        {/* Razões (porque[]) — lista curta, máx 3 */}
        {display.porque.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {display.porque.slice(0, 3).map((razao, i) => (
              <li
                key={i}
                className="text-2xs text-muted-foreground flex items-start gap-1"
              >
                <span className="mt-0.5 shrink-0">·</span>
                <span>{razao}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Ações à direita */}
      <div className="shrink-0 flex items-center gap-1">
        {tel && (
          <Button
            asChild
            size="sm"
            variant="outline"
            onClick={() => track('caca.acao', { ...eventoBase(display), cta: 'ligar' })}
          >
            <a href={tel} aria-label="Ligar para o cliente">
              <Phone className="w-3.5 h-3.5 mr-1" />
              Ligar
            </a>
          </Button>
        )}
        {fichaHref && (
          <Button
            asChild
            size="sm"
            variant="ghost"
            onClick={() => track('caca.acao', { ...eventoBase(display), cta: 'ficha' })}
          >
            <Link to={fichaHref}>
              <UserRound className="w-3.5 h-3.5 mr-1" />
              Ver ficha
            </Link>
          </Button>
        )}
        <CacaOutcomeMenu documento={documento} display={display} onOcultar={onOcultar} />
      </div>
    </div>
  );
}

// ─── Componente principal ──────────────────────────────────────────────────────

export interface FilaDeCacaProps {
  candidatos: CacaCandidatoDisplay[];
  isLoading?: boolean;
  onOcultar?: (documento: string) => void;
}

/**
 * Fila de trabalho do hunter: clientes parecidos com os melhores que ainda
 * não compram na empresa-alvo.
 *
 * Agrupa candidatos com o mesmo documento (multi-empresa) num card só.
 * Componente PURO: recebe dados via props, sem query, sem supabase.
 */
export function FilaDeCaca({ candidatos, isLoading, onOcultar }: FilaDeCacaProps) {
  const grupos = useMemo(() => agruparPorDocumento(candidatos), [candidatos]);

  // ─── Estado de loading ──────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <Card className="p-3 space-y-2">
        <Skeleton className="h-4 w-48" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </Card>
    );
  }

  // ─── Empty state ────────────────────────────────────────────────────────────
  if (grupos.length === 0) {
    return (
      <Card className="p-6">
        <p className="text-sm font-medium">Nada pra caçar agora.</p>
        <p className="text-2xs text-muted-foreground mt-1">
          Não há clientes parecidos com seus melhores que ainda não compram aqui. Assim que novos
          candidatos forem identificados, eles aparecerão nesta lista.
        </p>
      </Card>
    );
  }

  // ─── Lista de candidatos ────────────────────────────────────────────────────
  return (
    <Card>
      <CardHeader className="pb-2">
        <h2 className="text-base font-medium">Clientes a caçar</h2>
        <p className="text-2xs text-muted-foreground">
          {grupos.length} cliente{grupos.length !== 1 ? 's' : ''} pareci
          {grupos.length !== 1 ? 'dos' : 'do'} com seus melhores que ainda não compra
          {grupos.length !== 1 ? 'm' : ''} aqui.
        </p>
      </CardHeader>
      <div className="divide-y divide-border">
        {grupos.map((g) => (
          <CandidatoCard
            key={g.documento}
            documento={g.documento}
            empresasAlvo={g.empresasAlvo}
            display={g.display}
            onOcultar={onOcultar}
          />
        ))}
      </div>
    </Card>
  );
}
