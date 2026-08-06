// Lista de assinaturas Prime (staff): filtro por status (URL), busca local,
// criação e ações de ciclo de vida. Volume do piloto é baixo (15–25) — a busca
// é client-side sobre a lista já carregada (≤500, ordenada estável no servidor).
import { useMemo, useState } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { useUrlState } from '@/hooks/useUrlState';
import { formatBRL, formatData } from '@/lib/prime/format';
import { PRIME_STATUS_CLASSES, PRIME_STATUS_LABEL } from '@/types/prime';
import {
  usePrimeAssinaturas,
  usePrimePlanos,
  type PrimeAssinaturaComCliente,
} from '@/queries/usePrimeAdmin';
import { NovaAssinaturaDialog } from './NovaAssinaturaDialog';
import { CancelarDialog, ReativarDialog, SuspenderDialog } from './CicloVidaDialogs';

type AcaoCicloVida = 'suspender' | 'reativar' | 'cancelar';

export function PrimeAssinaturasTab() {
  const { data: assinaturas, isLoading } = usePrimeAssinaturas();
  const { data: planos } = usePrimePlanos();
  const [filtros, setFiltros] = useUrlState({ status: 'all', busca: '' });
  const [novaAberta, setNovaAberta] = useState(false);
  const [acao, setAcao] = useState<{ tipo: AcaoCicloVida; alvo: PrimeAssinaturaComCliente } | null>(
    null,
  );

  const planoNome = useMemo(() => {
    const mapa: Record<string, string> = {};
    for (const p of planos ?? []) mapa[p.id] = p.nome;
    return mapa;
  }, [planos]);

  const filtradas = useMemo(() => {
    const termo = filtros.busca.trim().toLowerCase();
    return (assinaturas ?? []).filter((a) => {
      if (filtros.status !== 'all' && a.status !== filtros.status) return false;
      if (!termo) return true;
      const alvo = [a.cliente?.name, a.cliente?.razao_social, a.cliente?.document]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return alvo.includes(termo);
    });
  }, [assinaturas, filtros]);

  if (isLoading) {
    return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mx-auto my-10" />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Buscar por cliente ou documento…"
          className="h-9 w-64"
          value={filtros.busca}
          onChange={(e) => setFiltros({ busca: e.target.value })}
        />
        <Select value={filtros.status} onValueChange={(v) => setFiltros({ status: v })}>
          <SelectTrigger className="h-9 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos status</SelectItem>
            <SelectItem value="ativa">Ativas</SelectItem>
            <SelectItem value="suspensa">Suspensas</SelectItem>
            <SelectItem value="cancelada">Canceladas</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button size="sm" onClick={() => setNovaAberta(true)}>
          <UserPlus className="w-4 h-4 mr-2" />
          Nova assinatura
        </Button>
      </div>

      {filtradas.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title={
            (assinaturas ?? []).length === 0
              ? 'Nenhuma assinatura ainda'
              : 'Nada com esses filtros'
          }
          description={
            (assinaturas ?? []).length === 0
              ? 'O piloto começa aqui: venda por convite (spec §6) e crie a assinatura do cliente.'
              : 'Ajuste a busca ou o filtro de status.'
          }
          actionLabel="Nova assinatura"
          onAction={() => setNovaAberta(true)}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Plano</TableHead>
                <TableHead className="text-right">Mensalidade</TableHead>
                <TableHead className="text-right">Franquia</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Início</TableHead>
                <TableHead>Suspensa/Fim</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtradas.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <div className="font-medium">{a.cliente?.name ?? '—'}</div>
                    {a.cliente?.document && (
                      <div className="text-xs text-muted-foreground">{a.cliente.document}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{planoNome[a.plano_id] ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatBRL(a.preco_contratado)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {a.franquia_dentes_contratada} dentes
                  </TableCell>
                  <TableCell>
                    <Badge className={PRIME_STATUS_CLASSES[a.status]}>
                      {PRIME_STATUS_LABEL[a.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">{formatData(a.data_inicio)}</TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {a.status === 'suspensa' && a.suspensa_em && `susp. ${formatData(a.suspensa_em)}`}
                    {a.status === 'cancelada' && a.data_fim && `fim ${formatData(a.data_fim)}`}
                    {a.status === 'ativa' && '—'}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {a.status === 'ativa' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAcao({ tipo: 'suspender', alvo: a })}
                      >
                        Suspender
                      </Button>
                    )}
                    {a.status === 'suspensa' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAcao({ tipo: 'reativar', alvo: a })}
                      >
                        Reativar
                      </Button>
                    )}
                    {a.status !== 'cancelada' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-status-error hover:text-status-error"
                        onClick={() => setAcao({ tipo: 'cancelar', alvo: a })}
                      >
                        Cancelar
                      </Button>
                    )}
                    {a.status === 'cancelada' && (
                      <span className="text-xs text-muted-foreground">encerrada</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <NovaAssinaturaDialog open={novaAberta} onOpenChange={setNovaAberta} />
      {acao?.tipo === 'suspender' && (
        <SuspenderDialog assinatura={acao.alvo} onFechar={() => setAcao(null)} />
      )}
      {acao?.tipo === 'reativar' && (
        <ReativarDialog assinatura={acao.alvo} onFechar={() => setAcao(null)} />
      )}
      {acao?.tipo === 'cancelar' && (
        <CancelarDialog assinatura={acao.alvo} onFechar={() => setAcao(null)} />
      )}
    </div>
  );
}
