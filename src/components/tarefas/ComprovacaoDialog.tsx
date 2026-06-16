/**
 * ComprovacaoDialog — fluxo de prova do operador (Fase 2, Task 7).
 *
 * Acionado ao concluir uma tarefa com `requer_comprovacao=true`.
 * Conforme `tipo_comprovacao`:
 *   - 'foto':           upload de imagem → path no bucket tarefa-comprovacoes
 *   - 'leitura':        input numérico validado client-side (faixa min/max)
 *   - 'foto_e_leitura': ambos obrigatórios
 *
 * Os limites de leitura (leituraMin / leituraMax / leituraUnidade) chegam via
 * prop — quem abre o dialog já tem a instância da tarefa, que carrega esses
 * valores herdados do template no momento da materialização (campos opcionais
 * em TarefaInstancia não existem ainda, mas o dialog aceita null graciosamente).
 *
 * Upload: supabase.storage.from('tarefa-comprovacoes').upload(path, file)
 * Path:   montarPathComprovacao(uid, tarefaId, ext, ts) → {uid}/{tarefaId}/{ts}.ext
 *         (RPC verifica que a URL contém '{uid}/{tarefaId}')
 */

import { useRef, useState } from 'react';
import { Camera, CheckCircle2, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { montarPathComprovacao, validarLeitura } from '@/lib/tarefas/comprovacao';
import { useConcluirComComprovacao } from '@/hooks/useTarefasFase2';
import type { TarefaInstancia } from '@/lib/tarefas/templates-types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ComprovacaoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tarefa: TarefaInstancia;
  /**
   * Limites de leitura provenientes do template.
   * Passados explicitamente para desacoplar o dialog do carregamento do template.
   */
  leituraMin?: number | null;
  leituraMax?: number | null;
  leituraUnidade?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers de UI
// ---------------------------------------------------------------------------

/** Extrai a extensão do nome de arquivo sem o ponto. Ex.: 'foto.JPG' → 'jpg' */
function extDoArquivo(file: File): string {
  const partes = file.name.split('.');
  if (partes.length < 2) return 'jpg';
  return partes[partes.length - 1].toLowerCase();
}

/** Descrição legível da faixa de leitura. Ex.: '7,0 – 7,5 pH' */
function descricaoFaixa(
  min: number | null | undefined,
  max: number | null | undefined,
  unidade: string | null | undefined,
): string | null {
  const u = unidade ?? '';
  if (min != null && max != null)
    return `${min.toLocaleString('pt-BR')} – ${max.toLocaleString('pt-BR')}${u ? ' ' + u : ''}`;
  if (min != null) return `≥ ${min.toLocaleString('pt-BR')}${u ? ' ' + u : ''}`;
  if (max != null) return `≤ ${max.toLocaleString('pt-BR')}${u ? ' ' + u : ''}`;
  return null;
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

export function ComprovacaoDialog({
  open,
  onOpenChange,
  tarefa,
  leituraMin,
  leituraMax,
  leituraUnidade,
}: ComprovacaoDialogProps) {
  const { user } = useAuth();
  const { concluirComComprovacao } = useConcluirComComprovacao();

  const tipo = tarefa.tipo_comprovacao ?? 'nenhuma';
  const precisaFoto = tipo === 'foto' || tipo === 'foto_e_leitura';
  const precisaLeitura = tipo === 'leitura' || tipo === 'foto_e_leitura';

  // ---- estado de foto ----
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [arquivoSelecionado, setArquivoSelecionado] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // ---- estado de leitura ----
  const [leituraRaw, setLeituraRaw] = useState('');

  // ---- estado de envio ----
  const [salvando, setSalvando] = useState(false);

  // ---------------------------------------------------------------------------
  // Seleção de arquivo
  // ---------------------------------------------------------------------------

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Arquivo inválido', { description: 'Apenas imagens são permitidas.' });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Arquivo muito grande', { description: 'Tamanho máximo: 10 MB.' });
      return;
    }

    setArquivoSelecionado(file);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
  };

  const removerFoto = () => {
    setArquivoSelecionado(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ---------------------------------------------------------------------------
  // Validação client-side do botão Salvar
  // ---------------------------------------------------------------------------

  const leituraNumero = leituraRaw.trim() === '' ? null : Number(leituraRaw.replace(',', '.'));
  const leituraInvalida = isNaN(leituraNumero as number) && leituraRaw.trim() !== '';

  const validacaoLeitura = precisaLeitura
    ? validarLeitura(
        leituraRaw.trim() === '' ? null : (leituraInvalida ? null : leituraNumero),
        leituraMin ?? null,
        leituraMax ?? null,
      )
    : { ok: true, erro: null };

  const podeConfirmar =
    !salvando &&
    !uploading &&
    (!precisaFoto || arquivoSelecionado !== null) &&
    (!precisaLeitura || (validacaoLeitura.ok && leituraRaw.trim() !== ''));

  // ---------------------------------------------------------------------------
  // Submissão
  // ---------------------------------------------------------------------------

  const handleConfirmar = async () => {
    if (!user) return;
    setSalvando(true);

    try {
      let pathComprovacao: string | null = null;

      // 1. Upload da foto (se necessário)
      if (precisaFoto && arquivoSelecionado) {
        setUploading(true);
        const ext = extDoArquivo(arquivoSelecionado);
        const path = montarPathComprovacao(user.id, tarefa.id, ext, Date.now());

        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('tarefa-comprovacoes')
          .upload(path, arquivoSelecionado, { upsert: false });

        setUploading(false);

        if (uploadError) {
          toast.error('Erro ao enviar foto', { description: uploadError.message });
          setSalvando(false);
          return;
        }

        pathComprovacao = uploadData.path;
      }

      // 2. Chamar a RPC de conclusão
      const leituraFinal =
        precisaLeitura && leituraRaw.trim() !== ''
          ? Number(leituraRaw.replace(',', '.'))
          : null;

      await concluirComComprovacao(tarefa.id, pathComprovacao, leituraFinal);

      // Sucesso — o hook já exibe o toast e invalida as queries
      fechar();
    } catch {
      // Erros da RPC (faixa inválida, foto obrigatória, etc.) já são
      // exibidos via toast dentro do hook useConcluirComComprovacao.
      // Mantemos o dialog aberto para o operador corrigir.
    } finally {
      setSalvando(false);
      setUploading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Fechar + limpar
  // ---------------------------------------------------------------------------

  const fechar = () => {
    removerFoto();
    setLeituraRaw('');
    setSalvando(false);
    setUploading(false);
    onOpenChange(false);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const faixaDescricao = descricaoFaixa(leituraMin, leituraMax, leituraUnidade);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) fechar(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Comprovação de tarefa</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <p className="text-sm text-muted-foreground line-clamp-2">{tarefa.descricao}</p>

          {/* ---- Seção de foto ---- */}
          {precisaFoto && (
            <div className="space-y-2">
              <Label>
                Foto
                <span className="text-status-error ml-1">*</span>
              </Label>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={handleFileChange}
                disabled={salvando}
              />

              {previewUrl ? (
                <div className="relative rounded-md overflow-hidden border border-border">
                  <img
                    src={previewUrl}
                    alt="Prévia da comprovação"
                    className="w-full max-h-52 object-contain bg-muted"
                  />
                  {!salvando && (
                    <button
                      type="button"
                      onClick={removerFoto}
                      className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center"
                      aria-label="Remover foto"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={salvando}
                  className="w-full rounded-md border-2 border-dashed border-border p-6 text-center hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Camera className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">
                    Toque para tirar ou escolher foto
                  </p>
                </button>
              )}
            </div>
          )}

          {/* ---- Seção de leitura ---- */}
          {precisaLeitura && (
            <div className="space-y-2">
              <Label htmlFor="leitura-input">
                {leituraUnidade ? `Leitura (${leituraUnidade})` : 'Leitura'}
                <span className="text-status-error ml-1">*</span>
                {faixaDescricao && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    — faixa: {faixaDescricao}
                  </span>
                )}
              </Label>

              <Input
                id="leitura-input"
                type="text"
                inputMode="decimal"
                placeholder={faixaDescricao ?? 'Ex.: 7.2'}
                value={leituraRaw}
                onChange={(e) => setLeituraRaw(e.target.value)}
                disabled={salvando}
                className={
                  leituraRaw.trim() !== '' && !validacaoLeitura.ok
                    ? 'border-status-error focus-visible:ring-status-error/30'
                    : ''
                }
              />

              {leituraRaw.trim() !== '' && !validacaoLeitura.ok && validacaoLeitura.erro && (
                <p className="text-xs text-status-error">{validacaoLeitura.erro}</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={fechar} disabled={salvando}>
            Cancelar
          </Button>
          <Button onClick={handleConfirmar} disabled={!podeConfirmar}>
            {(salvando || uploading) ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {uploading ? 'Enviando foto…' : 'Salvando…'}
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Concluir
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
