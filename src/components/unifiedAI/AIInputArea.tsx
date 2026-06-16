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
  return (
    <>
      <input ref={fileInputRef} type="file" accept="image/*" capture="environment" multiple onChange={onImageSelect} className="hidden" />
      <input ref={audioInputRef} type="file" accept="audio/*" multiple onChange={onAudioFileSelect} className="hidden" />

      <div className="flex items-center gap-2 text-primary">
        <Sparkles className="w-5 h-5" />
        <span className="font-semibold text-sm">Assistente de Pedido IA</span>
      </div>

      <p className="text-sm text-muted-foreground">
        {hasCustomerSelected
          ? 'Diga, digite, tire fotos ou anexe áudios — a IA identifica produtos e serviços automaticamente.'
          : 'Diga o nome do cliente, produtos e serviços — a IA identifica tudo automaticamente por voz, texto ou foto.'}
      </p>

      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {images.map((img, idx) => (
            <div key={idx} className="relative rounded-lg overflow-hidden bg-muted w-20 h-20">
              <img src={img.preview} alt={`Foto ${idx + 1}`} className="w-full h-full object-cover" />
              <button onClick={() => onRemoveImage(idx)} className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-background/80 backdrop-blur flex items-center justify-center hover:bg-background">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
          {images.length < 5 && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-20 h-20 rounded-lg border-2 border-dashed border-muted-foreground/30 flex items-center justify-center text-muted-foreground hover:border-primary hover:text-primary transition-colors"
            >
              <Plus className="w-5 h-5" />
            </button>
          )}
        </div>
      )}

      {/* Input area */}
      <div className="relative">
        <textarea
          value={text}
          onChange={e => onTextChange(e.target.value)}
          placeholder={hasCustomerSelected
            ? "Ex: 10 discos de corte 7 polegadas, afiar as serras circulares..."
            : "Ex: Pedido do cliente Metalúrgica São Paulo, de Curitiba. 10 discos de corte 7pol..."
          }
          className={cn(
            "w-full min-h-[80px] p-3 pr-28 rounded-lg border bg-background text-sm resize-none",
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
            className="p-2 rounded-full bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary transition-all"
            title="Anexar áudio"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          {/* Camera button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing}
            className="p-2 rounded-full bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary transition-all"
            title="Tirar foto ou anexar imagem"
          >
            <Camera className="w-4 h-4" />
          </button>
          {/* Mic button */}
          <button
            type="button"
            onClick={() => isRecording ? onStopRecording() : onStartRecording()}
            disabled={isAnalyzing || isLoading || isTranscribing}
            className={cn(
              "p-2 rounded-full transition-all",
              isRecording
                ? "bg-destructive text-destructive-foreground animate-pulse"
                : "bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary"
            )}
            title={isRecording ? 'Parar gravação' : 'Gravar áudio'}
          >
            {isRecording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Recording */}
      {isRecording && (
        <div className="flex items-center gap-2 text-destructive text-sm">
          <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
          <span>Gravando... {formatDuration(recordingDuration)}</span>
        </div>
      )}

      {isTranscribing && (
        <div className="flex items-center gap-2 text-primary text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Transcrevendo áudio...</span>
        </div>
      )}

      {/* Analyze button */}
      <Button
        onClick={onAnalyze}
        disabled={(!text.trim() && images.length === 0) || isProcessing}
        className="w-full"
      >
        {isAnalyzing ? (
          <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Analisando...</>
        ) : (
          <><Sparkles className="w-4 h-4 mr-2" />{hasCustomerSelected ? 'Identificar Itens do Pedido' : 'Identificar Cliente e Itens'}</>
        )}
      </Button>
    </>
  );
}
