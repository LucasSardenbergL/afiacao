import { useState, useRef, useEffect } from 'react';
import { Mic, MicOff, Send, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

// Tipos para Web Speech API
interface SpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event & { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

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
  const [isListening, setIsListening] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [suggestedServices, setSuggestedServices] = useState<SuggestedService[]>([]);
  
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Verificar suporte ao Web Speech API
  const isSpeechSupported = typeof window !== 'undefined' && 
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  useEffect(() => {
    if (!isSpeechSupported) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'pt-BR';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }

      if (final) {
        setText(prev => prev + (prev ? ' ' : '') + final);
        setInterimText('');
      } else {
        setInterimText(interim);
      }
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
      
      if (event.error === 'not-allowed') {
        toast({
          title: 'Permissão negada',
          description: 'Permita o acesso ao microfone para usar o reconhecimento de voz.',
          variant: 'destructive',
        });
      }
    };

    recognition.onend = () => {
      setIsListening(false);
      setInterimText('');
    };

    recognitionRef.current = recognition;

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, [isSpeechSupported, toast]);

  const toggleListening = () => {
    if (!recognitionRef.current) return;

    if (isListening) {
      recognitionRef.current.stop();
    } else {
      try {
        recognitionRef.current.start();
        setIsListening(true);
      } catch (error) {
        console.error('Error starting recognition:', error);
      }
    }
  };

  const analyzeText = async () => {
    if (!text.trim()) {
      toast({
        title: 'Texto vazio',
        description: 'Digite ou fale o que você precisa.',
        variant: 'destructive',
      });
      return;
    }

    // Parar gravação se estiver ativa
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
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
    // Limpar estado
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
          value={text + (interimText ? ' ' + interimText : '')}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ex: Preciso afiar 3 serras circulares de widea e 2 facas HSS..."
          className={cn(
            "w-full min-h-[100px] p-3 pr-12 rounded-lg border bg-background text-sm resize-none",
            "focus:outline-none focus:ring-2 focus:ring-ring",
            isListening && "border-primary ring-2 ring-primary/20"
          )}
          disabled={isAnalyzing || isLoading}
        />
        
        {/* Microfone button */}
        {isSpeechSupported && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              toggleListening();
            }}
            disabled={isAnalyzing || isLoading}
            className={cn(
              "absolute right-3 top-3 p-2 rounded-full transition-all z-10",
              isListening 
                ? "bg-primary text-primary-foreground animate-pulse" 
                : "bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary"
            )}
          >
            {isListening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>
        )}
      </div>

      {/* Listening indicator */}
      {isListening && (
        <div className="flex items-center gap-2 text-primary text-sm">
          <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          <span>Ouvindo... Fale agora</span>
        </div>
      )}

      {/* Analyze button */}
      <Button
        onClick={analyzeText}
        disabled={!text.trim() || isAnalyzing || isLoading}
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

      {!isSpeechSupported && (
        <p className="text-xs text-muted-foreground text-center">
          Reconhecimento de voz não suportado neste navegador. Use Chrome, Edge ou Safari.
        </p>
      )}
    </div>
  );
}
