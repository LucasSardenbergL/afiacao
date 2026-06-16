import { useState } from 'react';
import { useKnowledgeBaseList } from '@/hooks/useKnowledgeBaseList';
import { useApprovalQueue } from '@/hooks/useApprovalQueue';
import { useCompletude } from '@/hooks/useCompletude';
import { KbDocumentRow } from '@/components/knowledge-base/KbDocumentRow';
import { BatchUploadDialog } from '@/components/knowledge-base/BatchUploadDialog';
import { ApprovalQueueSection } from '@/components/knowledge-base/ApprovalQueueSection';
import { CompletudeSection } from '@/components/knowledge-base/CompletudeSection';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import { Upload, Loader2, FileText } from 'lucide-react';

export default function AdminKnowledgeBase() {
  const { data, isLoading } = useKnowledgeBaseList();

  // Fila de aprovação — lida aqui apenas para o badge da aba
  const filaAprovacao = useApprovalQueue();
  const qtdPendentes = filaAprovacao.data?.length ?? 0;

  // Completude — lida aqui apenas para o badge da aba "Dados faltantes"
  const completude = useCompletude();
  const qtdFaltantes = completude.data?.length ?? 0;

  // Controla o dialog de upload em lote
  const [uploadAberto, setUploadAberto] = useState(false);

  return (
    <div className="container mx-auto p-4 space-y-3">
      {/* ── Cabeçalho da página ── */}
      <div>
        <h1 className="text-xl font-semibold">Base de conhecimento</h1>
        <p className="text-xs text-muted-foreground">
          Boletins técnicos, cases e comparativos. Usado pelo copilot pra consultar dados precisos durante chamadas.
        </p>
      </div>

      {/* ── Abas: Documentos | A aprovar ── */}
      <Tabs defaultValue="documentos">
        <TabsList>
          <TabsTrigger value="documentos">Documentos</TabsTrigger>
          <TabsTrigger value="aprovacao" className="gap-1.5">
            A aprovar
            {qtdPendentes > 0 && (
              <Badge
                variant="secondary"
                className="text-[10px] px-1.5 py-0 h-4 min-w-4 flex items-center justify-center"
              >
                {qtdPendentes}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="completude" className="gap-1.5">
            Dados faltantes
            {qtdFaltantes > 0 && (
              <Badge
                variant="secondary"
                className="text-[10px] px-1.5 py-0 h-4 min-w-4 flex items-center justify-center"
              >
                {qtdFaltantes}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── Aba: Documentos ── */}
        <TabsContent value="documentos" className="mt-3 space-y-3">
          {/* Botão de upload em lote */}
          <div className="flex justify-end">
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => setUploadAberto(true)}
            >
              <Upload className="w-3.5 h-3.5" />
              Subir boletins
            </Button>
          </div>

          {/* Lista de documentos */}
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : !data || data.length === 0 ? (
            <Card className="p-8 text-center text-xs text-muted-foreground">
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
              Nenhum documento ainda. Suba o primeiro pra começar.
            </Card>
          ) : (
            <div className="space-y-2">
              {data.map((doc) => (
                <KbDocumentRow key={doc.id} doc={doc} />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Aba: A aprovar ── */}
        <TabsContent value="aprovacao" className="mt-3">
          <ApprovalQueueSection />
        </TabsContent>

        {/* ── Aba: Dados faltantes (completude) ── */}
        <TabsContent value="completude" className="mt-3">
          <CompletudeSection />
        </TabsContent>
      </Tabs>

      {/* Dialog de upload em lote (fora das abas pra não ser desmontado) */}
      <BatchUploadDialog
        open={uploadAberto}
        onOpenChange={setUploadAberto}
        onUploaded={() => {
          // A query de documentos é invalidada pelo próprio BatchUploadDialog via toast/onUploaded;
          // não precisa de lógica adicional aqui.
        }}
      />
    </div>
  );
}
