import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useStandardProcess } from '@/hooks/useStandardProcess';
import { useApproveStandardProcess } from '@/hooks/useApproveStandardProcess';
import { useAuth } from '@/contexts/AuthContext';
import { StandardProcessForm } from '@/components/standard-process/StandardProcessForm';
import { StandardProcessStatusBadge } from '@/components/standard-process/StandardProcessStatusBadge';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, Edit, Check, X, Archive, Clock, Wrench, Factory } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { StandardProcessEtapa } from '@/lib/standard-process/types';

const ETAPA_TYPE_COLOR: Record<string, string> = {
  preparacao: 'bg-status-info-bg text-status-info-foreground',
  aplicacao: 'bg-status-success-bg text-status-success-foreground',
  secagem: 'bg-status-warning-bg text-status-warning-foreground',
  lixamento: 'bg-status-warning-bg text-status-warning-foreground',
  mistura: 'bg-status-purple-bg text-status-purple-foreground',
  inspecao: 'bg-status-error-bg text-status-error-foreground',
  embalagem: 'bg-muted text-muted-foreground',
  outro: 'bg-muted text-muted-foreground',
};

export default function AdminStandardProcessDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isMaster, user } = useAuth();
  const { data, isLoading, refetch } = useStandardProcess(id ?? null);
  const approve = useApproveStandardProcess();
  const [editing, setEditing] = useState(false);

  if (isLoading) {
    return (
      <div className="container mx-auto p-4">
        <PageSkeleton variant="detail" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="container mx-auto p-4 text-xs text-muted-foreground">
        Processo não encontrado.
      </div>
    );
  }

  const isOwner = data.created_by === user?.id;
  const canEdit = isMaster || (isOwner && (data.status === 'draft' || data.status === 'in_review'));

  if (editing) {
    return (
      <div className="container mx-auto p-4 space-y-3 max-w-3xl">
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)} className="gap-1">
            <ChevronLeft className="w-3.5 h-3.5" />
            Cancelar edição
          </Button>
        </div>
        <h1 className="text-xl font-semibold">Editar processo</h1>
        <StandardProcessForm
          initial={data}
          onSaved={() => {
            setEditing(false);
            refetch();
          }}
        />
      </div>
    );
  }

  const handleApprove = (status: 'published' | 'draft' | 'archived') => {
    approve.mutate({ id: data.id, status }, { onSuccess: () => refetch() });
  };

  return (
    <div className="container mx-auto p-4 space-y-3 max-w-3xl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate('/admin/standard-processes')} className="gap-1">
          <ChevronLeft className="w-3.5 h-3.5" />
          Voltar
        </Button>
        <div className="flex items-center gap-1.5">
          {canEdit && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} className="gap-1.5">
              <Edit className="w-3.5 h-3.5" />
              Editar
            </Button>
          )}
          {isMaster && data.status === 'in_review' && (
            <>
              <Button size="sm" onClick={() => handleApprove('published')} disabled={approve.isPending} className="gap-1.5">
                <Check className="w-3.5 h-3.5" />
                Publicar
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleApprove('draft')} disabled={approve.isPending} className="gap-1.5">
                <X className="w-3.5 h-3.5" />
                Voltar pra rascunho
              </Button>
            </>
          )}
          {isMaster && data.status === 'published' && (
            <Button size="sm" variant="outline" onClick={() => handleApprove('archived')} disabled={approve.isPending} className="gap-1.5 text-status-error">
              <Archive className="w-3.5 h-3.5" />
              Arquivar
            </Button>
          )}
        </div>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold">{data.name}</h1>
            {data.description && (
              <p className="text-xs text-muted-foreground mt-1">{data.description}</p>
            )}
          </div>
          <StandardProcessStatusBadge status={data.status} />
        </div>

        <div className="flex items-center gap-2 flex-wrap text-2xs">
          <Badge variant="outline">{data.segmento}</Badge>
          {data.porte_alvo.map((p) => (
            <Badge key={p} variant="outline">porte {p}</Badge>
          ))}
          {data.tags.map((t) => (
            <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>
          ))}
        </div>

        {data.target_audience && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Público alvo:</span> {data.target_audience}
          </div>
        )}

        {data.expected_outcomes.length > 0 && (
          <div>
            <div className="text-2xs uppercase tracking-wide text-muted-foreground mb-1">Resultados esperados</div>
            <ul className="text-xs space-y-0.5 ml-4 list-disc">
              {data.expected_outcomes.map((o, i) => <li key={i}>{o}</li>)}
            </ul>
          </div>
        )}

        {data.prerequisites.length > 0 && (
          <div>
            <div className="text-2xs uppercase tracking-wide text-muted-foreground mb-1">Pré-requisitos</div>
            <ul className="text-xs space-y-0.5 ml-4 list-disc">
              {data.prerequisites.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          </div>
        )}
      </Card>

      <Card className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Factory className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Etapas ({data.etapas.length})</h2>
        </div>

        {data.etapas.map((e: StandardProcessEtapa) => (
          <Card key={e.ordem} className="p-2.5 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-2xs font-mono text-muted-foreground">#{e.ordem}</span>
              <span className="text-sm font-medium">{e.nome}</span>
              <Badge variant="outline" className={`text-[10px] ${ETAPA_TYPE_COLOR[e.tipo] ?? ''}`}>{e.tipo}</Badge>
            </div>

            {e.produtos.length > 0 && (
              <div className="text-2xs text-muted-foreground">
                <span className="font-medium">Produtos:</span> {e.produtos.join(' · ')}
              </div>
            )}

            {e.produtos_kb.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {e.produtos_kb.map((code) => (
                  <Badge key={code} variant="outline" className="text-[10px] font-mono">{code}</Badge>
                ))}
              </div>
            )}

            {(e.parametros.tempo_minutos || e.parametros.temperatura_c) && (
              <div className="flex flex-wrap gap-2 text-2xs">
                {e.parametros.tempo_minutos != null && (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Clock className="w-2.5 h-2.5" />
                    {e.parametros.tempo_minutos} min
                  </span>
                )}
                {e.parametros.temperatura_c != null && (
                  <span className="text-muted-foreground">{e.parametros.temperatura_c}°C</span>
                )}
              </div>
            )}

            {e.equipamentos.length > 0 && (
              <div className="flex items-center gap-1 text-2xs text-muted-foreground">
                <Wrench className="w-2.5 h-2.5" />
                {e.equipamentos.join(' · ')}
              </div>
            )}

            {e.rationale && (
              <div className="text-2xs text-muted-foreground italic">
                <span className="font-medium not-italic">Por quê:</span> {e.rationale}
              </div>
            )}

            {e.observacoes && (
              <div className="text-2xs text-muted-foreground">{e.observacoes}</div>
            )}
          </Card>
        ))}
      </Card>

      <div className="text-2xs text-muted-foreground text-center">
        Criado {format(new Date(data.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
        {data.reviewed_at && <> · Revisado {format(new Date(data.reviewed_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}</>}
        {data.status_notes && <> · {data.status_notes}</>}
      </div>
    </div>
  );
}
