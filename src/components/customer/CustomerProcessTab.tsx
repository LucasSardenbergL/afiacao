import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { useCustomerProcess, useSaveCustomerProcess, useStructureProcess } from '@/hooks/useCustomerProcess';
import { ProcessComparisonPanel } from './ProcessComparisonPanel';
import { Sparkles, Save, Loader2, AlertTriangle, Factory, Clock, Wrench } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { StructuredProcessResponse, ProcessEtapa } from '@/lib/customer-process/types';

interface Props {
  customerId: string;
}

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

export function CustomerProcessTab({ customerId }: Props) {
  const { data: current, isLoading } = useCustomerProcess(customerId);
  const structure = useStructureProcess();
  const save = useSaveCustomerProcess();

  const [descricao, setDescricao] = useState('');
  const [structured, setStructured] = useState<StructuredProcessResponse | null>(null);
  const [editing, setEditing] = useState(false);

  // Carrega dados atuais quando customer muda
  useEffect(() => {
    if (current && !editing) {
      setDescricao(current.descricao_livre);
      if (current.etapas) {
        setStructured({
          etapas: current.etapas as ProcessEtapa[],
          segmento: current.segmento ?? '',
          porte: (current.porte as 'pequeno' | 'medio' | 'grande') ?? 'medio',
          tags: current.tags,
          ia_confidence: current.ia_confidence ?? 0,
          ia_gaps: current.ia_gaps,
        });
      }
    }
  }, [current, editing]);

  const handleStructure = () => {
    if (descricao.length < 30) {
      return;
    }
    structure.mutate(descricao, {
      onSuccess: (data) => setStructured(data),
    });
  };

  const handleSave = () => {
    save.mutate(
      {
        customerId,
        descricao_livre: descricao,
        structured: structured ?? undefined,
        previousId: current?.id,
      },
      {
        onSuccess: () => setEditing(false),
      }
    );
  };

  if (isLoading) {
    return <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  }

  const hasContent = current?.descricao_livre || descricao;

  return (
    <div className="space-y-3">
      <Card className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Processo produtivo do cliente</h3>
            <p className="text-2xs text-muted-foreground">
              Descreva como o cliente produz hoje. Quanto mais detalhe, melhor a IA estrutura e compara depois.
            </p>
          </div>
          {hasContent && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Editar</Button>
          )}
        </div>

        {editing || !current?.descricao_livre ? (
          <>
            <Textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder="Ex: Marcenaria média. Recebem MDF cortado. Aplicam primer PU da Renner em cabine simples com pistola gravity, secagem 4h ao ar, depois lixam 320, aplicam verniz PU 2K e secam 24h. Volume ~150 peças/mês. Problema atual: retrabalho frequente por casca de laranja..."
              rows={6}
              className="text-xs"
            />

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleStructure}
                disabled={descricao.length < 30 || structure.isPending}
                className="gap-1.5"
              >
                {structure.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Estruturar com IA
              </Button>

              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={descricao.length < 10 || save.isPending}
                className="gap-1.5"
              >
                {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Salvar
              </Button>
            </div>

            {structure.isPending && (
              <div className="text-2xs text-muted-foreground italic">Analisando processo…</div>
            )}
          </>
        ) : (
          <div className="text-xs whitespace-pre-wrap text-foreground/80">{current.descricao_livre}</div>
        )}
      </Card>

      {/* Etapas estruturadas */}
      {structured && structured.etapas.length > 0 && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Factory className="w-4 h-4 text-muted-foreground" />
              <h4 className="text-sm font-semibold">Etapas estruturadas</h4>
              <Badge variant="outline" className="text-2xs">{structured.etapas.length} etapas</Badge>
            </div>
            <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Badge variant="outline" className="text-2xs">{structured.segmento}</Badge>
              <Badge variant="outline" className="text-2xs">porte {structured.porte}</Badge>
              <span>{Math.round(structured.ia_confidence * 100)}% conf.</span>
            </div>
          </div>

          {structured.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {structured.tags.map((t) => (
                <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {structured.etapas.map((e) => (
              <div key={e.ordem} className="rounded-md border border-border p-2.5 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-2xs font-mono text-muted-foreground">#{e.ordem}</span>
                  <span className="text-xs font-medium">{e.nome}</span>
                  <Badge variant="outline" className={`text-[10px] ${ETAPA_TYPE_COLOR[e.tipo] ?? ''}`}>{e.tipo}</Badge>
                </div>

                {e.produtos.length > 0 && (
                  <div className="text-2xs text-muted-foreground">
                    <span className="font-medium">Produtos:</span> {e.produtos.join(' · ')}
                  </div>
                )}

                {(e.parametros.tempo_minutos || e.parametros.temperatura_c || e.parametros.umidade_pct) && (
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
                    {e.parametros.umidade_pct != null && (
                      <span className="text-muted-foreground">{e.parametros.umidade_pct}% UR</span>
                    )}
                  </div>
                )}

                {e.equipamentos.length > 0 && (
                  <div className="flex items-center gap-1 text-2xs text-muted-foreground">
                    <Wrench className="w-2.5 h-2.5" />
                    {e.equipamentos.join(' · ')}
                  </div>
                )}

                {e.observacoes && (
                  <div className="text-2xs text-muted-foreground italic">{e.observacoes}</div>
                )}
              </div>
            ))}
          </div>

          {structured.ia_gaps.length > 0 && (
            <Card className="p-2.5 bg-status-warning-bg border-status-warning">
              <div className="text-2xs text-status-warning font-medium flex items-center gap-1 mb-1">
                <AlertTriangle className="w-3 h-3" />
                Informações faltantes pra análise mais precisa
              </div>
              <ul className="text-2xs text-muted-foreground space-y-0.5 ml-4 list-disc">
                {structured.ia_gaps.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            </Card>
          )}
        </Card>
      )}

      {current?.ia_structured_at && (
        <div className="text-2xs text-muted-foreground text-center">
          Estruturado pela IA {formatDistanceToNow(new Date(current.ia_structured_at), { locale: ptBR, addSuffix: true })}
        </div>
      )}

      {/* PR-P3 — Comparação inteligente. Só renderiza quando já existe processo estruturado. */}
      {current?.etapas && (
        <ProcessComparisonPanel customerId={customerId} />
      )}
    </div>
  );
}
