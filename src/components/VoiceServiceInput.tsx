import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, Send, Loader2, Sparkles, X, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

export interface SuggestedService {
  omie_codigo_servico: number;
  descricao: string;
  quantity: number;
  notes?: string;
}

interface VoiceServiceInputProps {
  onServicesIdentified: (services: SuggestedService[]) => void;
  isLoading?: boolean;
}

export function VoiceServiceInput({ onServicesIdentified, isLoading = false }: VoiceServiceInputProps) {
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [suggestedServices, setSuggestedServices] = useState<SuggestedService[]>([]);
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

  const startRecording = useCallback(async () => {
    try {
      // Request microphone permission
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        } 
      });
      
      streamRef.current = stream;
      audioChunksRef.current = [];

      // Determine best supported format
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
        // Stop all tracks
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

      // Start recording
      mediaRecorder.start(1000); // Collect data every second
      setIsRecording(true);
      setRecordingDuration(0);

      // Start timer
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
      // Determine file extension based on blob type
      let extension = 'webm';
      if (audioBlob.type.includes('mp4')) {
        extension = 'mp4';
      } else if (audioBlob.type.includes('ogg')) {
        extension = 'ogg';
      }

      const formData = new FormData();
      formData.append('audio', audioBlob, `recording.${extension}`);

      console.log('Sending audio to transcription service...');

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/elevenlabs-transcribe`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
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

    // Stop recording if active
    if (isRecording) {
      stopRecording();
    }

    setIsAnalyzing(true);
    setAiMessage(null);
    setSuggestedServices([]);

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-services`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({ text: text.trim() }),
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Erro ao analisar serviços');
      }

      const result = await response.json();
      
      if (result.services && result.services.length > 0) {
        setSuggestedServices(result.services);
        setAiMessage(result.message || `Encontrei ${result.services.length} serviço(s) para você.`);
      } else {
        setAiMessage('Não consegui identificar serviços específicos. Tente descrever as ferramentas que precisa afiar.');
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

  const confirmServices = () => {
    onServicesIdentified(suggestedServices);
    // Clear state
    setText('');
    setAiMessage(null);
    setSuggestedServices([]);
    toast({
      title: 'Serviços adicionados!',
      description: `${suggestedServices.length} serviço(s) adicionado(s) ao pedido.`,
    });
  };

  const clearSuggestions = () => {
    setAiMessage(null);
    setSuggestedServices([]);
  };

  const isProcessing = isRecording || isTranscribing || isAnalyzing || isLoading;

  return (
    <div className="bg-card rounded-xl p-4 shadow-soft border border-border space-y-4">
      <div className="flex items-center gap-2 text-primary">
        <Sparkles className="w-5 h-5" />
        <span className="font-semibold text-sm">Solicitar por voz ou texto</span>
      </div>

      <p className="text-sm text-muted-foreground">
        Descreva quais ferramentas você precisa afiar e a IA vai identificar os serviços automaticamente.
      </p>

      {/* Input area */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ex: Preciso afiar 3 serras circulares de widea e 2 facas HSS..."
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
            Identificar Serviços
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

          {suggestedServices.length > 0 && (
            <>
              <div className="space-y-2">
                {suggestedServices.map((service, idx) => (
                  <div
                    key={idx}
                    className="bg-background rounded-lg p-3 border border-border"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-medium text-sm">{service.descricao}</p>
                        {service.notes && (
                          <p className="text-xs text-muted-foreground mt-1">{service.notes}</p>
                        )}
                      </div>
                      <span className="bg-primary/10 text-primary text-xs font-medium px-2 py-1 rounded">
                        Qtd: {service.quantity}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <Button 
                onClick={confirmServices} 
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
