import { useState } from 'react';
import { useKnowledgeBaseList } from '@/hooks/useKnowledgeBaseList';
import { KbDocumentRow } from '@/components/knowledge-base/KbDocumentRow';
import { KbDocumentForm } from '@/components/knowledge-base/KbDocumentForm';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Plus, Loader2, FileText } from 'lucide-react';

export default function AdminKnowledgeBase() {
  const { data, isLoading } = useKnowledgeBaseList();
  const [open, setOpen] = useState(false);

  return (
    <div className="container mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Base de conhecimento</h1>
          <p className="text-xs text-muted-foreground">
            Boletins técnicos, cases e comparativos. Usado pelo copilot pra consultar dados precisos durante chamadas.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              Novo documento
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Subir documento</DialogTitle>
            </DialogHeader>
            <KbDocumentForm onUploaded={() => setOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>

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
    </div>
  );
}
