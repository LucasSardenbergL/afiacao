import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { KbStatusBadge } from '@/components/knowledge-base/KbStatusBadge';
import { KbSpecsExtractButton } from '@/components/knowledge-base/KbSpecsExtractButton';
import { KbSpecsEditButton } from '@/components/knowledge-base/KbSpecsEditButton';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Loader2, Database, Sparkles } from 'lucide-react';
import type { KbDocument } from '@/lib/knowledge-base/types';
import { useKbProductSpecs } from '@/hooks/useKbProductSpecs';
import { VersionHistory } from '@/components/knowledge-base/VersionHistory';
import { CompletudeBadge } from '@/components/knowledge-base/CompletudeBadge';
import { SpecLinkPanel } from '@/components/knowledge-base/SpecLinkPanel';
import { CatalisadorLinkPanel } from '@/components/knowledge-base/CatalisadorLinkPanel';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';

export default function AdminKnowledgeBaseDetail() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading } = useQuery({
    queryKey: ['kb-document', id],
    enabled: !!id,
    queryFn: async (): Promise<KbDocument | null> => {
      const { data, error } = await supabase.from('kb_documents')
        .select('*')
        .eq('id', id!)
        .single();
      if (error) throw error;
      return data as KbDocument;
    },
    // polling enquanto processa
    refetchInterval: (q) => (q.state.data?.status === 'processing' ? 3000 : false),
  });

  const { data: chunkCount } = useQuery({
    queryKey: ['kb-chunks-count', id],
    enabled: !!id,
    queryFn: async () => {
      const { count } = await supabase.from('kb_chunks')
        .select('*', { count: 'exact', head: true })
        .eq('document_id', id!);
      return count ?? 0;
    },
  });

  if (isLoading) {
    return (
      <div className="container mx-auto p-4 flex justify-center">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="container mx-auto p-4 text-xs text-muted-foreground">
        Documento não encontrado
      </div>
    );
  }

  return <DetailContent data={data} chunkCount={chunkCount} />;
}

function DetailContent({ data, chunkCount }: { data: KbDocument; chunkCount: number | undefined }) {
  const { data: existingSpecs, refetch: refetchSpecs } = useKbProductSpecs(data.product_code);
  const { isMaster } = useAuth();
  const { isImpersonating } = useImpersonation();

  return (
    <div className="container mx-auto p-4 space-y-3 max-w-4xl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-semibold">{data.title}</h1>
        <KbStatusBadge status={data.status} />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="text-2xs">{data.type}</Badge>
        {data.supplier && <Badge variant="outline" className="text-2xs">{data.supplier}</Badge>}
        {data.product_code && <Badge variant="outline" className="text-2xs">{data.product_code}</Badge>}
        {data.tags.map((t) => (
          <Badge key={t} variant="outline" className="text-2xs">
            {t}
          </Badge>
        ))}
      </div>
      <div className="text-2xs text-muted-foreground">
        Enviado {format(new Date(data.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
        {data.file_size_bytes && <> · {(data.file_size_bytes / 1024).toFixed(0)} KB</>}
        {chunkCount !== undefined && <> · {chunkCount} chunks indexados</>}
      </div>

      {data.status === 'error' && data.status_error && (
        <Card className="p-3 border-status-error bg-status-error-bg/50">
          <div className="text-xs font-medium text-status-error">Erro no processamento</div>
          <div className="text-2xs text-muted-foreground font-mono mt-1">{data.status_error}</div>
        </Card>
      )}

      {/* Specs estruturados — só quando documento está ready e tem product_code */}
      {data.status === 'ready' && data.product_code && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Specs estruturados</span>
              {existingSpecs?.approved_at && (
                <Badge variant="outline" className="text-2xs gap-1">
                  <Sparkles className="w-2.5 h-2.5" />
                  Aprovado
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {existingSpecs && (
                <KbSpecsEditButton spec={existingSpecs} onSaved={() => refetchSpecs()} />
              )}
              <KbSpecsExtractButton
                documentId={data.id}
                documentTitle={data.title}
                productCode={data.product_code}
                onSaved={() => refetchSpecs()}
              />
            </div>
          </div>

          {existingSpecs ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-2xs pt-2 border-t border-border">
              {existingSpecs.rendimento_m2_por_litro != null && (
                <KpiCell label="Rendimento" value={`${existingSpecs.rendimento_m2_por_litro} m²/L`} />
              )}
              {existingSpecs.densidade_g_cm3 != null && (
                <KpiCell label="Densidade" value={`${existingSpecs.densidade_g_cm3} g/cm³`} />
              )}
              {existingSpecs.solidos_pct != null && (
                <KpiCell label="Sólidos" value={`${existingSpecs.solidos_pct}%`} />
              )}
              {existingSpecs.pot_life_horas != null && (
                <KpiCell label="Pot life" value={`${existingSpecs.pot_life_horas}h`} />
              )}
              {existingSpecs.validade_dias != null && (
                <KpiCell label="Validade" value={`${existingSpecs.validade_dias} dias`} />
              )}
              {existingSpecs.dureza && <KpiCell label="Dureza" value={existingSpecs.dureza} />}
              {existingSpecs.catalisador_codigo && (
                <KpiCell label="Catalisador" value={`${existingSpecs.catalisador_codigo}${existingSpecs.catalisador_proporcao_pct ? ` (${existingSpecs.catalisador_proporcao_pct}%)` : ''}`} />
              )}
              {existingSpecs.diluente_codigo && (
                <KpiCell label="Diluente" value={existingSpecs.diluente_codigo} />
              )}
              {existingSpecs.demaos_recomendadas != null && (
                <KpiCell label="Demãos" value={String(existingSpecs.demaos_recomendadas)} />
              )}
            </div>
          ) : (
            <div className="text-2xs text-muted-foreground">
              Clique acima pra extrair specs automaticamente do texto via Claude.
            </div>
          )}

          {existingSpecs && <CompletudeBadge spec={existingSpecs} />}
        </Card>
      )}

      {/* Itens de venda vinculados — só master, só ficha aprovada (a venda lê a view confirmed+approved). */}
      {existingSpecs?.approved_at && existingSpecs.id && isMaster && (
        <SpecLinkPanel
          spec={{ id: existingSpecs.id, product_code: existingSpecs.product_code, product_name: existingSpecs.product_name }}
          disabled={isImpersonating}
        />
      )}

      {/* Casamento do catalisador — só master, ficha aprovada, e só se o boletim tem catalisador. */}
      {existingSpecs?.approved_at && isMaster && existingSpecs.catalisador_codigo && (
        // key por código → painel remonta ao trocar de boletim (reseta termo/seleção; evita
        // casar SKU no código errado por estado stale — Codex P1).
        <CatalisadorLinkPanel
          key={existingSpecs.catalisador_codigo}
          catalisadorCodigo={existingSpecs.catalisador_codigo}
          disabled={isImpersonating}
        />
      )}

      {/* Histórico de versões do produto (Fase B1) — null quando não há versões */}
      <VersionHistory supplier={existingSpecs?.supplier} productCode={existingSpecs?.product_code} />

      {data.content_extracted && (
        <Card className="p-3">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground mb-2">
            Texto extraído
          </div>
          <pre className="text-xs whitespace-pre-wrap font-sans text-foreground/80 max-h-96 overflow-y-auto">
            {data.content_extracted}
          </pre>
        </Card>
      )}
    </div>
  );
}

function KpiCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}
