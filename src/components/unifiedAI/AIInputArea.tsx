// Área de entrada do Assistente de Pedido IA (texto/voz/foto/áudio).
// Extraída verbatim de src/components/UnifiedAIAssistant.tsx (god-component split).
import { Mic, Loader2, Sparkles, X, Square, Camera, Plus, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type ImageAttachment } from './types';
import { formatDuration } from './helpers';

interface AIInputAreaProps {
  fileInputRef: React.RefObject<HTMLInputElement>;
  audioInputRef: React.RefObject<HTMLInputElement>;
  onImageSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAudioFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  images: ImageAttachment[];
  onRemoveImage: (idx: number) => void;
  text: string;
  onTextChange: (value: string) => void;
  isRecording: boolean;
  isTranscribing: boolean;
  isAnalyzing: boolean;
  isLoading: boolean;
  isProcessing: boolean;
  recordingDuration: number;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onAnalyze: () => void;
  hasCustomerSelected: boolean;
}

export function AIInputArea({
  fileInputRef,
  audioInputRef,
  onImageSelect,
  onAudioFileSelect,
  images,
  onRemoveImage,
  text,
  onTextChange,
  isRecording,
  isTranscribing,
  isAnalyzing,
  isLoading,
  isProcessing,
  recordingDuration,
  onStartRecording,
  onStopRecording,
  onAnalyze,
  hasCustomerSelected,
}: AIInputAreaProps) {
  const temConteudo = text.trim().length > 0 || images.length > 0;
  const podeAnalisar = temConteudo && !isProcessing;

  return (
    <>
      <input ref={fileInputRef} type="file" accept="image/*" capture="environment" multiple onChange={onImageSelect} className="hidden" />
      <input ref={audioInputRef} type="file" accept="audio/*" multiple onChange={onAudioFileSelect} className="hidden" />

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Sparkles className="w-4 h-4 text-primary" aria-hidden />
        <span className="font-semibold text-sm">Assistente de pedido</span>
        <span className="text-xs text-muted-foreground">
          {hasCustomerSelected ? 'itens por voz, texto, foto ou áudio' : 'cliente e itens de uma vez — voz, texto, foto ou áudio'}
        </span>
      </div>

      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {images.map((img, idx) => (
            <div key={idx} className="relative rounded-lg overflow-hidden bg-muted w-20 h-20">
              <img src={img.preview} alt={`Foto ${idx + 1}`} className="w-full h-full object-cover" />
              <button type="button" aria-label={`Remover foto ${idx + 1}`} onClick={() => onRemoveImage(idx)} className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-background/80 backdrop-blur flex items-center justify-center hover:bg-background">
                <X className="w-3 h-3" aria-hidden />
              </button>
            </div>
          ))}
          {images.length < 5 && (
            <button
              type="button"
              aria-label="Adicionar outra foto"
              onClick={() => fileInputRef.current?.click()}
              className="w-20 h-20 rounded-lg border-2 border-dashed border-muted-foreground/30 flex items-center justify-center text-muted-foreground hover:border-primary hover:text-primary transition-colors"
            >
              <Plus className="w-5 h-5" aria-hidden />
            </button>
          )}
        </div>
      )}

      {/* Input area */}
      <div className="relative">
        <textarea
          value={text}
          onChange={e => onTextChange(e.target.value)}
          onKeyDown={e => {
            // ⌘/Ctrl+Enter analisa sem tirar a mão do teclado (Enter puro segue quebrando linha).
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && podeAnalisar) { e.preventDefault(); onAnalyze(); }
          }}
          aria-label={hasCustomerSelected ? 'Descreva os itens do pedido' : 'Descreva o cliente e os itens do pedido'}
          placeholder={hasCustomerSelected
            ? "Ex: 10 discos de corte 7 pol., afiar as serras circulares"
            : "Ex: Metalúrgica São Paulo, Curitiba — 10 discos de corte 7 pol."
          }
          className={cn(
            "w-full min-h-[64px] p-3 pr-32 sm:pr-28 rounded-lg border bg-background text-sm resize-none",
            "focus:outline-none focus:ring-2 focus:ring-ring",
            isRecording && "border-primary ring-2 ring-primary/20"
          )}
          disabled={isAnalyzing || isLoading || isTranscribing}
        />
        <div className="absolute right-3 top-3 flex gap-1.5">
          {/* Audio file button */}
          <button
            type="button"
            onClick={() => audioInputRef.current?.click()}
            disabled={isProcessing}
            className="p-2 rounded-full bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary transition-all disabled:opacity-50 disabled:pointer-events-none [@media(pointer:coarse)]:p-3"
            title="Anexar áudio"
            aria-label="Anexar arquivo de áudio"
          >
            <Paperclip className="w-4 h-4" aria-hidden />
          </button>
          {/* Camera button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing}
            className="p-2 rounded-full bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary transition-all disabled:opacity-50 disabled:pointer-events-none [@media(pointer:coarse)]:p-3"
            title="Tirar foto ou anexar imagem"
            aria-label="Tirar foto ou anexar imagem"
          >
            <Camera className="w-4 h-4" aria-hidden />
          </button>
          {/* Mic button */}
          <button
            type="button"
            onClick={() => isRecording ? onStopRecording() : onStartRecording()}
            disabled={isAnalyzing || isLoading || isTranscribing}
            className={cn(
              "p-2 rounded-full transition-all disabled:opacity-50 disabled:pointer-events-none [@media(pointer:coarse)]:p-3",
              isRecording
                ? "bg-destructive text-destructive-foreground animate-pulse"
                : "bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary"
            )}
            title={isRecording ? 'Parar gravação' : 'Gravar áudio'}
            aria-label={isRecording ? 'Parar gravação' : 'Gravar áudio'}
            aria-pressed={isRecording}
          >
            {isRecording ? <Square className="w-4 h-4" aria-hidden /> : <Mic className="w-4 h-4" aria-hidden />}
          </button>
        </div>
      </div>

      {/* Recording */}
      {isRecording && (
        <div role="status" className="flex items-center gap-2 text-destructive text-sm">
          <div aria-hidden className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
          <span>Gravando... {formatDuration(recordingDuration)}</span>
        </div>
      )}

      {isTranscribing && (
        <div role="status" className="flex items-center gap-2 text-primary text-sm">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          <span>Transcrevendo áudio...</span>
        </div>
      )}

      {/* Analyze button */}
      {/* Vazio: botão secundário (contorno) — o primário cinza-desabilitado parecia a ação da página. */}
      <Button
        onClick={onAnalyze}
        disabled={!podeAnalisar}
        variant={temConteudo || isAnalyzing ? 'default' : 'outline'}
        className="w-full"
      >
        {isAnalyzing ? (
          <><Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden />Analisando…</>
        ) : (
          <>
            <Sparkles className="w-4 h-4 mr-2" aria-hidden />
            {hasCustomerSelected ? 'Identificar itens' : 'Identificar cliente e itens'}
            {temConteudo && <kbd className="ml-2 hidden sm:inline text-[10px] opacity-70 font-sans" aria-hidden>⌘↵</kbd>}
          </>
        )}
      </Button>
    </>
  );
}
