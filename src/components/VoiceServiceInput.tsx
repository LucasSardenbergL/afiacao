import { useState, useRef, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Mic, Send, Loader2, Sparkles, X, Square, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

interface UserTool {
  id: string;
  tool_category_id: string;
  generated_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  tool_categories?: {
    name: string;
  } | null;
}

export interface IdentifiedItem {
  userToolId: string;
  omie_codigo_servico: number;
  servico_descricao: string;
  quantity: number;
  notes?: string;
}

interface VoiceServiceInputProps {
  userTools: UserTool[];
  onItemsIdentified: (items: IdentifiedItem[]) => void;
  isLoading?: boolean;
}

export function VoiceServiceInput({ userTools, onItemsIdentified, isLoading = false }: VoiceServiceInputProps) {
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [identifiedItems, setIdentifiedItems] = useState<IdentifiedItem[]>([]);
  const [recordingDuration, setRecordingDuration] = useState(0);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const getToolDisplayName = (tool: UserTool) => {
    return tool.generated_name || tool.custom_name || tool.tool_categories?.name || 'Ferramenta';
  };

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        } 
      });
      
      streamRef.current = stream;
      audioChunksRef.current = [];

      let mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
        mimeType = 'audio/ogg';
      }

      console.log('Using MIME type:', mimeType);
      
      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        
        if (audioChunksRef.current.length > 0) {
          const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
          console.log('Audio blob created:', audioBlob.size, 'bytes');
          await transcribeAudio(audioBlob);
        }
      };

      mediaRecorder.onerror = (event) => {
        console.error('MediaRecorder error:', event);
        toast({
          title: 'Erro na gravação',
          description: 'Ocorreu um erro ao gravar o áudio.',
          variant: 'destructive',
        });
        stopRecording();
      };

      mediaRecorder.start(1000);
      setIsRecording(true);
      setRecordingDuration(0);

      timerRef.current = window.setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);

      console.log('Recording started');
    } catch (error) {
      console.error('Error starting recording:', error);
      
      const err = error as { name?: string; message?: string };
      
      if (err.name === 'NotAllowedError') {
        toast({
          title: 'Permissão negada',
          description: 'Permita o acesso ao microfone nas configurações do navegador.',
          variant: 'destructive',
        });
      } else if (err.name === 'NotFoundError') {
        toast({
          title: 'Microfone não encontrado',
          description: 'Verifique se um microfone está conectado ao dispositivo.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Erro ao iniciar gravação',
          description: err.message || 'Não foi possível acessar o microfone.',
          variant: 'destructive',
        });
      }
    }
  }, [toast]);

  const stopRecording = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    setIsRecording(false);
    console.log('Recording stopped');
  }, []);

  const transcribeAudio = async (audioBlob: Blob) => {
    setIsTranscribing(true);

    try {
      let extension = 'webm';
      if (audioBlob.type.includes('mp4')) {
        extension = 'mp4';
      } else if (audioBlob.type.includes('ogg')) {
        extension = 'ogg';
      }

      const formData = new FormData();
      formData.append('audio', audioBlob, `recording.${extension}`);

      console.log('Sending audio to transcription service...');

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast({ title: 'Sessão expirada', description: 'Faça login novamente para usar esta funcionalidade.', variant: 'destructive' });
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/elevenlabs-transcribe`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
          body: formData,
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Erro na transcrição');
      }

      const result = await response.json();
      console.log('Transcription result:', result);

      if (result.text) {
        setText(prev => prev + (prev ? ' ' : '') + result.text);
        toast({
          title: 'Transcrição concluída',
          description: 'O áudio foi convertido em texto.',
        });
      } else {
        toast({
          title: 'Nenhum texto detectado',
          description: 'Não foi possível identificar fala no áudio.',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Transcription error:', error);
      toast({
        title: 'Erro na transcrição',
        description: error instanceof Error ? error.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setIsTranscribing(false);
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const analyzeText = async () => {
    if (!text.trim()) {
      toast({
        title: 'Texto vazio',
        description: 'Digite ou grave o que você precisa.',
        variant: 'destructive',
      });
      return;
    }

    if (userTools.length === 0) {
      toast({
        title: 'Nenhuma ferramenta cadastrada',
        description: 'Cadastre suas ferramentas antes de usar o assistente por voz.',
        variant: 'destructive',
      });
      return;
    }

    if (isRecording) {
      stopRecording();
    }

    setIsAnalyzing(true);
    setAiMessage(null);
    setIdentifiedItems([]);

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-services`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({ 
            text: text.trim(),
            userTools: userTools.map(t => ({
              id: t.id,
              generated_name: t.generated_name,
              custom_name: t.custom_name,
              quantity: t.quantity,
              tool_categories: t.tool_categories,
            })),
          }),
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Erro ao analisar');
      }

      const result = await response.json();
      
      if (result.items && result.items.length > 0) {
        setIdentifiedItems(result.items);
        setAiMessage(result.message || `Encontrei ${result.items.length} item(ns) para o pedido.`);
      } else {
        setAiMessage('Não consegui identificar ferramentas no seu texto. Tente mencionar o nome das suas ferramentas cadastradas.');
      }
    } catch (error) {
      console.error('Erro ao analisar:', error);
      toast({
        title: 'Erro na análise',
        description: error instanceof Error ? error.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const confirmItems = () => {
    onItemsIdentified(identifiedItems);
    setText('');
    setAiMessage(null);
    setIdentifiedItems([]);
    toast({
      title: 'Itens adicionados!',
      description: `${identifiedItems.length} item(ns) adicionado(s) ao pedido. Adicione fotos se desejar.`,
    });
  };

  const clearSuggestions = () => {
    setAiMessage(null);
    setIdentifiedItems([]);
  };

  const getToolById = (toolId: string) => {
    return userTools.find(t => t.id === toolId);
  };

  const isProcessing = isRecording || isTranscribing || isAnalyzing || isLoading;

  if (userTools.length === 0) {
    return null;
  }

  return (
    <div className="bg-card rounded-xl p-4 shadow-soft border border-border space-y-4">
      <div className="flex items-center gap-2 text-primary">
        <Sparkles className="w-5 h-5" />
        <span className="font-semibold text-sm">Solicitar por voz ou texto</span>
      </div>

      <p className="text-sm text-muted-foreground">
        Diga quais ferramentas deseja afiar e a IA identificará automaticamente.
      </p>

      {/* Input area */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ex: Quero afiar minhas serras circulares, a de 250mm está lascada..."
          className={cn(
            "w-full min-h-[100px] p-3 pr-12 rounded-lg border bg-background text-sm resize-none",
            "focus:outline-none focus:ring-2 focus:ring-ring",
            isRecording && "border-primary ring-2 ring-primary/20"
          )}
          disabled={isAnalyzing || isLoading || isTranscribing}
        />
        
        {/* Microphone button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            toggleRecording();
          }}
          disabled={isAnalyzing || isLoading || isTranscribing}
          className={cn(
            "absolute right-3 top-3 p-2 rounded-full transition-all z-10",
            isRecording 
              ? "bg-destructive text-destructive-foreground animate-pulse" 
              : "bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary"
          )}
        >
          {isRecording ? <Square className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
        </button>
      </div>

      {/* Recording indicator */}
      {isRecording && (
        <div className="flex items-center gap-2 text-destructive text-sm">
          <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
          <span>Gravando... {formatDuration(recordingDuration)}</span>
          <span className="text-muted-foreground text-xs">(Clique para parar)</span>
        </div>
      )}

      {/* Transcribing indicator */}
      {isTranscribing && (
        <div className="flex items-center gap-2 text-primary text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Transcrevendo áudio...</span>
        </div>
      )}

      {/* Analyze button */}
      <Button
        onClick={(e) => {
          e.stopPropagation();
          if (isRecording) {
            stopRecording();
          }
          analyzeText();
        }}
        disabled={!text.trim() || isProcessing}
        className="w-full"
      >
        {isAnalyzing ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Analisando...
          </>
        ) : (
          <>
            <Sparkles className="w-4 h-4 mr-2" />
            Identificar Ferramentas e Serviços
          </>
        )}
      </Button>

      {/* AI Response */}
      {aiMessage && (
        <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 text-primary">
              <Sparkles className="w-4 h-4" />
              <span className="text-sm font-medium">Resultado da IA</span>
            </div>
            <button
              onClick={clearSuggestions}
              className="p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          
          <p className="text-sm text-foreground">{aiMessage}</p>

          {identifiedItems.length > 0 && (
            <>
              <div className="space-y-2">
                {identifiedItems.map((item, idx) => {
                  const tool = getToolById(item.userToolId);
                  return (
                    <div
                      key={idx}
                      className="bg-background rounded-lg p-3 border border-border"
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <Wrench className="w-4 h-4 text-primary" />
                            <p className="font-medium text-sm">
                              {tool ? getToolDisplayName(tool) : 'Ferramenta'}
                            </p>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Serviço: {item.servico_descricao}
                          </p>
                          {item.notes && (
                            <p className="text-xs text-muted-foreground mt-1 italic">
                              Obs: {item.notes}
                            </p>
                          )}
                        </div>
                        <span className="bg-primary/10 text-primary text-xs font-medium px-2 py-1 rounded">
                          Qtd: {item.quantity}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <Button 
                onClick={confirmItems} 
                className="w-full"
                disabled={isLoading}
              >
                <Send className="w-4 h-4 mr-2" />
                Adicionar ao Pedido
              </Button>
            </>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center">
        🎙️ Funciona em todos os navegadores e dispositivos
      </p>
    </div>
  );
}
