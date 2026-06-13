// src/pages/Melhorias.tsx
// Lista dos itens de melhoria do próprio usuário + thread expansível + réplica.
import { useState } from 'react';
import { Lightbulb, Plus, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { MelhoriaThread } from '@/components/melhorias/MelhoriaThread';
import { MelhoriaDialog } from '@/components/melhorias/MelhoriaDialog';
import {
  useMeusMelhoriaItens,
  useMelhoriaThread,
  useEnviarReplica,
} from '@/hooks/useMelhorias';
import { podeReplicar } from '@/lib/melhorias/triagem-helpers';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import type { MelhoriaItem, MelhoriaStatus } from '@/lib/melhorias/types';
import { cn } from '@/lib/utils';

// ── Badge de status ──────────────────────────────────────────────────────────

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

// ── Card expansível ──────────────────────────────────────────────────────────

function MelhoriaCard({ item, userId }: { item: MelhoriaItem; userId: string }) {
  const [aberto, setAberto] = useState(false);
  const [replicaTexto, setReplicaTexto] = useState('');

  const { data: thread, isLoading: loadingThread } = useMelhoriaThread(aberto ? item.id : null);
  const enviarReplica = useEnviarReplica(item.id);

  const gate = podeReplicar(item, thread ?? []);

  const handleReplica = async () => {
    if (!replicaTexto.trim()) return;
    try {
      await enviarReplica.mutateAsync({ conteudo: replicaTexto, autorUserId: userId });
      setReplicaTexto('');
    } catch {
      // RLS nega se o item foi finalizado enquanto digitava; rede também cai aqui.
      toast.error('Não consegui enviar a réplica — o item pode ter sido finalizado.');
    }
  };

  const fmtData = (iso: string) =>
    new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

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
            <span
              className={cn(
                'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold',
                STATUS_CLASSES[item.status],
              )}
            >
              {STATUS_LABEL[item.status]}
            </span>
            {item.tipo && (
              <Badge variant="outline" className="text-xs capitalize">
                {item.tipo}
              </Badge>
            )}
            {item.modulo && (
              <Badge variant="outline" className="text-xs">
                {item.modulo}
              </Badge>
            )}
          </div>
          <p className="text-sm font-medium text-foreground truncate">
            {item.titulo ?? 'Aguardando avaliação…'}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">{fmtData(item.created_at)}</p>
        </div>
        <span className="shrink-0 mt-0.5 text-muted-foreground">
          {aberto ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>

      {/* Thread expandida */}
      {aberto && (
        <div className="px-3 pb-3 border-t pt-3 space-y-3">
          {loadingThread ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Carregando…
            </div>
          ) : (
            <MelhoriaThread mensagens={thread ?? []} />
          )}

          {/* Resposta do Lucas */}
          {item.resposta_founder && (
            <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm">
              <p className="text-xs font-semibold text-primary mb-1">Resposta do Lucas</p>
              <p className="whitespace-pre-wrap">{item.resposta_founder}</p>
            </div>
          )}

          {/* Réplica */}
          {gate.ok ? (
            <div className="space-y-2">
              <Textarea
                value={replicaTexto}
                onChange={(e) => setReplicaTexto(e.target.value)}
                placeholder="Adicionar informação ou resposta…"
                rows={2}
                className="text-sm"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={handleReplica}
                  disabled={enviarReplica.isPending || replicaTexto.trim().length < 3}
                >
                  {enviarReplica.isPending ? (
                    <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Enviando…</>
                  ) : (
                    'Enviar réplica'
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{gate.motivo}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Página principal ─────────────────────────────────────────────────────────

export default function Melhorias() {
  const { user } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: itens, isLoading } = useMeusMelhoriaItens();

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Minhas melhorias</h1>
          <p className="text-sm text-muted-foreground">
            Sugestões e problemas que você reportou.
          </p>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="w-4 h-4 mr-1" />
          Nova
        </Button>
      </div>

      {/* Lista */}
      {!itens?.length ? (
        <EmptyState
          icon={Lightbulb}
          title="Nenhuma melhoria ainda"
          description="Reporte um problema ou sugestão — a IA avalia e o Lucas recebe na hora."
          actionLabel="Reportar agora"
          onAction={() => setDialogOpen(true)}
        />
      ) : (
        <div className="space-y-2">
          {itens.map((item) => (
            <MelhoriaCard key={item.id} item={item} userId={user?.id ?? ''} />
          ))}
        </div>
      )}

      {/* Dialog de criação */}
      <MelhoriaDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
