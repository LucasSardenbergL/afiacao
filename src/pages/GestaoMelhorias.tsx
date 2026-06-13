// src/pages/GestaoMelhorias.tsx
// Fila master de melhorias: lista com filtros, thread expansível, prompt copiável e ações de status.
import { useState, useMemo } from 'react';
import { Lock, ClipboardCopy, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { MelhoriaThread } from '@/components/melhorias/MelhoriaThread';
import {
  useGestaoMelhorias,
  useMelhoriaThread,
  useAlterarStatusMelhoria,
  useRetriarMelhoria,
} from '@/hooks/useMelhorias';
import { montarPromptClaudeCode } from '@/lib/melhorias/prompt-claude';
import { useAuth } from '@/contexts/AuthContext';
import { useUrlState } from '@/hooks/useUrlState';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import type { MelhoriaItem, MelhoriaStatus, MelhoriaUrgencia } from '@/lib/melhorias/types';

// ── Utilitários de exibição ──────────────────────────────────────────────────

const STATUS_LABEL: Record<MelhoriaStatus, string> = {
  aberto: 'Aberto',
  em_andamento: 'Em andamento',
  resolvido: 'Resolvido',
  descartado: 'Descartado',
};

const STATUS_CLASSES: Record<MelhoriaStatus, string> = {
  aberto: 'bg-status-info-bg text-status-info border-transparent',
  em_andamento: 'bg-status-warning-bg text-status-warning border-transparent',
  resolvido: 'bg-status-success-bg text-status-success border-transparent',
  descartado: 'bg-muted text-muted-foreground border-transparent',
};

const URGENCIA_CLASSES: Record<MelhoriaUrgencia, string> = {
  alta: 'bg-status-error-bg text-status-error border-transparent',
  media: 'bg-status-warning-bg text-status-warning border-transparent',
  baixa: 'bg-muted text-muted-foreground border-transparent',
};

const URGENCIA_ORDER: Record<MelhoriaUrgencia, number> = { alta: 0, media: 1, baixa: 2 };

function badgeStatusClass(item: MelhoriaItem) {
  return STATUS_CLASSES[item.status];
}

function fmtData(iso: string) {
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

// ── Resolução de nomes de autores ────────────────────────────────────────────

function useAutoresNomes(autorIds: string[]) {
  return useQuery({
    queryKey: ['profiles', 'autores-melhorias', autorIds.sort().join(',')],
    enabled: autorIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Record<string, string>> => {
      if (!autorIds.length) return {};
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', autorIds);
      if (error) return {};
      const map: Record<string, string> = {};
      for (const p of data ?? []) {
        if (p.user_id) map[p.user_id] = (p.name as string | null) ?? 'Funcionário';
      }
      return map;
    },
  });
}

// ── Card expansível ──────────────────────────────────────────────────────────

function GestaoCard({
  item,
  autorNome,
}: {
  item: MelhoriaItem;
  autorNome: string;
}) {
  const [aberto, setAberto] = useState(false);
  const [respostaTexto, setRespostaTexto] = useState(item.resposta_founder ?? '');

  const { data: thread, isLoading: loadingThread } = useMelhoriaThread(aberto ? item.id : null);
  const alterarStatus = useAlterarStatusMelhoria();
  const retriar = useRetriarMelhoria();

  const handleCopiarPrompt = async () => {
    const prompt = montarPromptClaudeCode(item, thread ?? [], autorNome);
    try {
      await navigator.clipboard.writeText(prompt);
      track('melhoria.prompt_copiado', { item_id: item.id });
      toast.success('Prompt copiado! Cole no Claude Code.');
    } catch {
      toast.error('Não foi possível copiar — verifique as permissões do navegador.');
    }
  };

  const handleStatus = (status: MelhoriaStatus) => {
    alterarStatus.mutate({
      itemId: item.id,
      status,
      resposta: respostaTexto,
    });
  };

  const handleRetriar = () => {
    retriar.mutate(item.id, {
      onSuccess: (r) => {
        if (r.ok) toast.success('Re-triagem concluída.');
        else toast.info('Re-triagem falhou — item permanece na fila.');
      },
    });
  };

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      {/* Header clicável */}
      <button
        type="button"
        className="w-full flex items-start gap-3 p-3 text-left hover:bg-muted/40 transition-colors"
        onClick={() => setAberto((v) => !v)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            {/* Status */}
            <span
              className={cn(
                'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold',
                badgeStatusClass(item),
              )}
            >
              {STATUS_LABEL[item.status]}
            </span>

            {/* Urgência */}
            {item.urgencia && (
              <span
                className={cn(
                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold',
                  URGENCIA_CLASSES[item.urgencia],
                )}
              >
                {item.urgencia}
              </span>
            )}

            {/* Tipo */}
            {item.tipo && (
              <Badge variant="outline" className="text-xs capitalize">
                {item.tipo}
              </Badge>
            )}

            {/* Módulo */}
            {item.modulo && (
              <Badge variant="outline" className="text-xs">
                {item.modulo}
              </Badge>
            )}

            {/* Triagem com problema */}
            {item.triagem_status !== 'ok' && (
              <Badge variant="destructive" className="text-xs">
                triagem: {item.triagem_status}
              </Badge>
            )}
          </div>

          <p className="text-sm font-medium text-foreground truncate">
            {item.titulo ?? 'Sem título (triagem pendente)'}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {autorNome} · {fmtData(item.created_at)}
            {item.rota_origem ? ` · ${item.rota_origem}` : ''}
          </p>
        </div>
        <span className="shrink-0 mt-0.5 text-muted-foreground">
          {aberto ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>

      {/* Detalhes expandidos */}
      {aberto && (
        <div className="px-3 pb-3 border-t pt-3 space-y-4">
          {/* Contexto */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {item.rota_origem && <span>Tela: <strong className="text-foreground">{item.rota_origem}</strong></span>}
            {item.empresa && <span>Empresa: <strong className="text-foreground">{item.empresa}</strong></span>}
          </div>

          {/* Thread */}
          {loadingThread ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Carregando thread…
            </div>
          ) : (
            <MelhoriaThread
              mensagens={thread ?? []}
              papelDe={(m) =>
                m.papel === 'funcionario' ? autorNome : m.papel === 'ia' ? 'IA' : 'Lucas'
              }
            />
          )}

          {/* Avaliação técnica da IA */}
          {item.avaliacao_founder && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p className="text-xs font-semibold text-muted-foreground mb-1">
                Avaliação técnica da IA
              </p>
              <p className="whitespace-pre-wrap text-foreground">{item.avaliacao_founder}</p>
            </div>
          )}

          {/* Ações */}
          <div className="space-y-3">
            {/* Copiar prompt */}
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopiarPrompt}
              disabled={loadingThread}
              className="w-full justify-start gap-2"
            >
              <ClipboardCopy className="w-4 h-4" />
              Copiar prompt pro Claude Code
            </Button>

            {/* Re-triar */}
            {item.triagem_status !== 'ok' && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRetriar}
                disabled={retriar.isPending}
                className="w-full justify-start gap-2"
              >
                {retriar.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                Re-triar com IA
              </Button>
            )}

            {/* Resposta + botões de status */}
            <div className="space-y-2">
              <Textarea
                value={respostaTexto}
                onChange={(e) => setRespostaTexto(e.target.value)}
                placeholder="Resposta ao funcionário (opcional)…"
                rows={2}
                className="text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleStatus('em_andamento')}
                  disabled={alterarStatus.isPending || item.status === 'em_andamento'}
                >
                  Em andamento
                </Button>
                <Button
                  size="sm"
                  onClick={() => handleStatus('resolvido')}
                  disabled={alterarStatus.isPending || item.status === 'resolvido'}
                >
                  Resolver
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => handleStatus('descartado')}
                  disabled={alterarStatus.isPending || item.status === 'descartado'}
                >
                  Descartar
                </Button>
                {alterarStatus.isPending && (
                  <Loader2 className="w-4 h-4 animate-spin self-center text-muted-foreground" />
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Filtros ──────────────────────────────────────────────────────────────────

const STATUS_FILTROS: Array<{ value: string; label: string }> = [
  { value: 'aberto', label: 'Abertos' },
  { value: 'em_andamento', label: 'Em andamento' },
  { value: 'resolvido', label: 'Resolvidos' },
  { value: 'descartado', label: 'Descartados' },
  { value: 'all', label: 'Todos' },
];

const TIPO_FILTROS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'Todos os tipos' },
  { value: 'problema', label: 'Problema' },
  { value: 'sugestao', label: 'Sugestão' },
  { value: 'pergunta', label: 'Pergunta' },
];

// ── Página principal ─────────────────────────────────────────────────────────

export default function GestaoMelhorias() {
  const { isMaster } = useAuth();
  const [filtros, setFiltros] = useUrlState({ status: 'aberto', tipo: 'all' });

  const { data: itens, isLoading } = useGestaoMelhorias(!!isMaster);

  // Resolve nomes dos autores
  const autorIds = useMemo(
    () => [...new Set((itens ?? []).map((i) => i.autor_user_id))],
    [itens],
  );
  const { data: nomes } = useAutoresNomes(autorIds);

  // Filtro + ordenação
  const itensFiltrados = useMemo(() => {
    let lista = itens ?? [];
    if (filtros.status !== 'all') {
      lista = lista.filter((i) => i.status === filtros.status);
    }
    if (filtros.tipo !== 'all') {
      lista = lista.filter((i) => i.tipo === filtros.tipo);
    }
    // Ordenação: urgência alta>media>baixa, depois data desc
    return [...lista].sort((a, b) => {
      const ua = URGENCIA_ORDER[a.urgencia ?? 'baixa'] ?? 2;
      const ub = URGENCIA_ORDER[b.urgencia ?? 'baixa'] ?? 2;
      if (ua !== ub) return ua - ub;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [itens, filtros]);

  // Gate de acesso
  if (!isMaster) {
    return (
      <div className="p-4">
        <EmptyState
          icon={Lock}
          title="Acesso restrito"
          description="Esta área é exclusiva para o administrador master."
        />
      </div>
    );
  }

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold">Fila de melhorias</h1>
        <p className="text-sm text-muted-foreground">
          {itensFiltrados.length} {itensFiltrados.length === 1 ? 'item' : 'itens'} ·{' '}
          {itens?.length ?? 0} no total
        </p>
      </div>

      {/* Filtros de status */}
      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTROS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={filtros.status === f.value ? 'default' : 'outline'}
            onClick={() => setFiltros({ status: f.value })}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {/* Filtros de tipo */}
      <div className="flex flex-wrap gap-1.5">
        {TIPO_FILTROS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={filtros.tipo === f.value ? 'secondary' : 'ghost'}
            onClick={() => setFiltros({ tipo: f.value })}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {/* Lista */}
      {itensFiltrados.length === 0 ? (
        <EmptyState
          icon={Lock}
          title="Nenhum item neste filtro"
          description="Tente outro status ou tipo para ver os itens."
        />
      ) : (
        <div className="space-y-2">
          {itensFiltrados.map((item) => (
            <GestaoCard
              key={item.id}
              item={item}
              autorNome={nomes?.[item.autor_user_id] ?? 'Funcionário'}
            />
          ))}
        </div>
      )}
    </div>
  );
}
