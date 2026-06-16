import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Upload, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useBatchUploadKbDocuments } from '@/hooks/useBatchUploadKbDocuments';
import type { BatchUploadItem } from '@/hooks/useBatchUploadKbDocuments';

// ─── Helpers visuais ─────────────────────────────────────────────────────────

function statusBadge(item: BatchUploadItem) {
  switch (item.status) {
    case 'pendente':
      return (
        <Badge variant="secondary" className="text-muted-foreground gap-1">
          <Clock className="w-3 h-3" />
          Aguardando
        </Badge>
      );
    case 'enviando':
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          Enviando…
        </Badge>
      );
    case 'ok':
      return (
        <Badge variant="secondary" className="text-status-success gap-1">
          <CheckCircle2 className="w-3 h-3" />
          Enviado
        </Badge>
      );
    case 'erro':
      return (
        <Badge variant="secondary" className="text-status-error gap-1">
          <XCircle className="w-3 h-3" />
          Erro
        </Badge>
      );
  }
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface BatchUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded?: () => void;
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function BatchUploadDialog({
  open,
  onOpenChange,
  onUploaded,
}: BatchUploadDialogProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [supplier, setSupplier] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { items, isRunning, run, reset } = useBatchUploadKbDocuments();

  // Determina se o upload terminou (nenhum item em 'pendente' ou 'enviando')
  const isFinished =
    items.length > 0 &&
    items.every((it) => it.status === 'ok' || it.status === 'erro');

  // Ao terminar, exibe toast e, se tudo ok, fecha o dialog
  useEffect(() => {
    if (!isFinished) return;
    const total = items.length;
    const erros = items.filter((it) => it.status === 'erro').length;
    const ok = total - erros;

    if (erros === 0) {
      toast.success(
        `${ok} arquivo${ok > 1 ? 's' : ''} enviado${ok > 1 ? 's' : ''}`,
        { description: 'Processando texto e embeddings…' },
      );
      onUploaded?.();
      onOpenChange(false);
    } else {
      toast.error(`${ok} enviado${ok !== 1 ? 's' : ''}, ${erros} com erro`, {
        description: 'Verifique os arquivos com erro e tente novamente.',
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFinished]);

  // Limpa o estado interno quando o dialog é fechado
  useEffect(() => {
    if (!open) {
      setFiles([]);
      setSupplier('');
      setTagsRaw('');
      reset();
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [open, reset]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    setFiles(selected);
    reset(); // limpa resultado de um run anterior ao trocar os arquivos
  }

  async function handleEnviar() {
    if (files.length === 0 || isRunning) return;
    const tags = tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    await run({
      files,
      supplier: supplier.trim() || undefined,
      tags: tags.length > 0 ? tags : undefined,
    });
  }

  // Usa os items do hook quando o run já começou; senão mostra os files selecionados
  const listaExibida: Array<{ nome: string; tamanho: number; item?: BatchUploadItem }> =
    items.length > 0
      ? items.map((it) => ({ nome: it.file.name, tamanho: it.file.size, item: it }))
      : files.map((f) => ({ nome: f.name, tamanho: f.size }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Enviar boletins em lote</DialogTitle>
          <DialogDescription>
            Selecione vários PDFs de uma vez. Cada arquivo vira um boletim técnico em
            processamento.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-1">
          {/* Seletor de arquivos */}
          <div>
            <Label htmlFor="batch-files">Arquivos PDF</Label>
            <Input
              id="batch-files"
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              multiple
              disabled={isRunning}
              onChange={handleFileChange}
            />
          </div>

          {/* Lista de arquivos selecionados / status de upload */}
          {listaExibida.length > 0 && (
            <div className="rounded-md border divide-y max-h-52 overflow-y-auto">
              {listaExibida.map(({ nome, tamanho, item }, i) => (
                <div
                  key={`${nome}-${i}`}
                  className="flex items-center justify-between px-3 py-2 gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-sm font-medium truncate"
                      title={nome}
                    >
                      {nome}
                    </div>
                    {item?.error && (
                      <div className="text-2xs text-status-error mt-0.5 truncate" title={item.error}>
                        {item.error}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatKb(tamanho)}
                    </span>
                    {item ? statusBadge(item) : (
                      <Badge variant="secondary" className="text-muted-foreground gap-1">
                        <Clock className="w-3 h-3" />
                        Aguardando
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Campos comuns opcionais */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="batch-supplier">Fornecedor</Label>
              <Input
                id="batch-supplier"
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                placeholder="sayerlack, farben…"
                disabled={isRunning}
              />
            </div>
            <div>
              <Label htmlFor="batch-tags">Tags (separe por vírgula)</Label>
              <Input
                id="batch-tags"
                value={tagsRaw}
                onChange={(e) => setTagsRaw(e.target.value)}
                placeholder="madeira, pu, fosco"
                disabled={isRunning}
              />
            </div>
          </div>

          {/* Botão de envio */}
          <Button
            className="w-full"
            disabled={files.length === 0 || isRunning}
            onClick={handleEnviar}
          >
            {isRunning ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
                Enviando…
              </>
            ) : (
              <>
                <Upload className="w-3.5 h-3.5 mr-2" />
                Enviar {files.length > 0 ? `${files.length} arquivo${files.length > 1 ? 's' : ''}` : 'arquivo(s)'}
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
