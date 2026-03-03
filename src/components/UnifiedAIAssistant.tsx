import { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Send, Loader2, Sparkles, X, Square, Camera, Package, Wrench, Image, Check, Lightbulb, Plus, Paperclip, FileAudio, User, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

export interface AIProduct {
  product_id: string;
  codigo: string;
  descricao: string;
  quantity: number;
  account: 'oben' | 'colacor';
  notes?: string;
}

export interface AIService {
  userToolId: string;
  omie_codigo_servico: number;
  servico_descricao: string;
  quantity: number;
  notes?: string;
}

export interface AISuggestion {
  type: 'product' | 'service';
  product_id?: string;
  codigo?: string;
  descricao: string;
  quantity?: number;
  account?: string;
  reason: string;
  userToolId?: string;
  omie_codigo_servico?: number;
  servico_descricao?: string;
}

export interface AICustomerMatch {
  nome_fantasia: string;
  razao_social: string;
  cnpj_cpf: string;
  cidade?: string;
  codigo_cliente: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface AIOrderResult {
  products: AIProduct[];
  services: AIService[];
  suggestions?: AISuggestion[];
  customer?: AICustomerMatch | null;
}

interface Product {
  id: string;
  codigo: string;
  descricao: string;
  valor_unitario: number;
  estoque: number;
  account?: string;
}

interface UserTool {
  id: string;
  tool_category_id: string;
  generated_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  tool_categories?: { name: string } | null;
}

interface ImageAttachment {
  preview: string;
  base64: string;
}

interface UnifiedAIAssistantProps {
  products: Product[];
  userTools: UserTool[];
  onItemsIdentified: (result: AIOrderResult) => void;
  onCustomerIdentified?: (customer: AICustomerMatch) => void;
  customerUserId?: string | null;
  hasCustomerSelected?: boolean;
  isLoading?: boolean;
}

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function UnifiedAIAssistant({ products, userTools, onItemsIdentified, onCustomerIdentified, customerUserId, hasCustomerSelected = false, isLoading = false }: UnifiedAIAssistantProps) {
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [identifiedProducts, setIdentifiedProducts] = useState<AIProduct[]>([]);
  const [identifiedServices, setIdentifiedServices] = useState<AIService[]>([]);
  const [suggestions, setSuggestions] = useState<AISuggestion[]>([]);
  const [identifiedCustomer, setIdentifiedCustomer] = useState<AICustomerMatch | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [images, setImages] = useState<ImageAttachment[]>([]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  const getToolName = (tool: UserTool) =>
    tool.generated_name || tool.custom_name || tool.tool_categories?.name || 'Ferramenta';

  // ─── Recording ───
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      audioChunksRef.current = [];

      let mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
      else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
      else if (MediaRecorder.isTypeSupported('audio/ogg')) mimeType = 'audio/ogg';

      const mr = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (audioChunksRef.current.length > 0) {
          await transcribeAudio(new Blob(audioChunksRef.current, { type: mimeType }));
        }
      };
      mr.onerror = () => {
        toast({ title: 'Erro na gravação', variant: 'destructive' });
        stopRecording();
      };

      mr.start(1000);
      setIsRecording(true);
      setRecordingDuration(0);
      timerRef.current = window.setInterval(() => setRecordingDuration(p => p + 1), 1000);
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        toast({ title: 'Permissão negada', description: 'Permita o acesso ao microfone.', variant: 'destructive' });
      } else {
        toast({ title: 'Erro ao gravar', description: err.message, variant: 'destructive' });
      }
    }
  }, [toast]);

  const stopRecording = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }, []);

  const transcribeAudio = async (blob: Blob) => {
    setIsTranscribing(true);
    try {
      let ext = 'webm';
      if (blob.type.includes('mp4')) ext = 'mp4';
      else if (blob.type.includes('ogg')) ext = 'ogg';
      else if (blob.type.includes('mpeg') || blob.type.includes('mp3')) ext = 'mp3';
      else if (blob.type.includes('wav')) ext = 'wav';
      else if (blob.type.includes('m4a') || blob.type.includes('x-m4a')) ext = 'm4a';

      const fd = new FormData();
      fd.append('audio', blob, `recording.${ext}`);

      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/elevenlabs-transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: fd,
      });

      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Erro'); }
      const result = await res.json();
      if (result.text) {
        setText(prev => prev + (prev ? ' ' : '') + result.text);
        toast({ title: 'Transcrição concluída' });
      } else {
        toast({ title: 'Nenhum texto detectado', variant: 'destructive' });
      }
    } catch (e: any) {
      toast({ title: 'Erro na transcrição', description: e.message, variant: 'destructive' });
    } finally {
      setIsTranscribing(false);
    }
  };

  // ─── Audio file attachment ───
  const handleAudioFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith('audio/')) {
        toast({ title: `"${file.name}" não é um áudio`, variant: 'destructive' });
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        toast({ title: `"${file.name}" muito grande (máx 10MB)`, variant: 'destructive' });
        continue;
      }
      await transcribeAudio(file);
    }

    if (audioInputRef.current) audioInputRef.current.value = '';
  };

  // ─── Image ───
  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith('image/')) { toast({ title: 'Selecione uma imagem', variant: 'destructive' }); continue; }
      if (file.size > 5 * 1024 * 1024) { toast({ title: `"${file.name}" muito grande (máx 5MB)`, variant: 'destructive' }); continue; }
      if (images.length >= 5) { toast({ title: 'Máximo de 5 fotos', variant: 'destructive' }); break; }

      const preview = URL.createObjectURL(file);
      const b64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });
      setImages(prev => [...prev, { preview, base64: b64 }]);
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (idx: number) => {
    setImages(prev => prev.filter((_, i) => i !== idx));
  };

  const clearImages = () => {
    setImages([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ─── Analyze ───
  const analyze = async () => {
    if (!text.trim() && images.length === 0) {
      toast({ title: 'Digite, grave, anexe áudio ou tire uma foto', variant: 'destructive' });
      return;
    }
    if (isRecording) stopRecording();

    setIsAnalyzing(true);
    setAiMessage(null);
    setIdentifiedProducts([]);
    setIdentifiedServices([]);
    setSuggestions([]);
    setIdentifiedCustomer(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-unified-order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          text: text.trim() || undefined,
          imageBase64: images.length === 1 ? images[0].base64 : undefined,
          imagesBase64: images.length > 1 ? images.map(img => img.base64) : undefined,
          customerUserId: customerUserId || undefined,
          searchCustomer: !hasCustomerSelected,
          products: products.map(p => ({
            id: p.id, codigo: p.codigo, descricao: p.descricao,
            valor_unitario: p.valor_unitario, estoque: p.estoque, account: p.account || 'oben',
          })),
          userTools: userTools.map(t => ({
            id: t.id, generated_name: t.generated_name, custom_name: t.custom_name,
            quantity: t.quantity, tool_categories: t.tool_categories,
          })),
        }),
      });

      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Erro'); }
      const result = await res.json();

      const prods = result.products || [];
      const svcs = result.services || [];
      const sugs = result.suggestions || [];
      const cust = result.customer || null;

      if (prods.length > 0 || svcs.length > 0 || sugs.length > 0 || cust) {
        setIdentifiedProducts(prods);
        setIdentifiedServices(svcs);
        setSuggestions(sugs);
        setIdentifiedCustomer(cust);
        setAiMessage(result.message || `Encontrei ${prods.length} produto(s) e ${svcs.length} serviço(s).`);
      } else {
        setAiMessage(result.message || 'Não consegui identificar itens. Tente ser mais específico.');
      }
    } catch (e: any) {
      toast({ title: 'Erro na análise', description: e.message, variant: 'destructive' });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const confirmItems = () => {
    onItemsIdentified({ products: identifiedProducts, services: identifiedServices });
    setText('');
    setAiMessage(null);
    setIdentifiedProducts([]);
    setIdentifiedServices([]);
    setSuggestions([]);
    setIdentifiedCustomer(null);
    clearImages();
    const total = identifiedProducts.length + identifiedServices.length;
    toast({ title: 'Itens adicionados!', description: `${total} item(ns) adicionado(s) ao pedido.` });
  };

  const confirmCustomer = () => {
    if (identifiedCustomer && onCustomerIdentified) {
      onCustomerIdentified(identifiedCustomer);
      setIdentifiedCustomer(null);
      toast({ title: 'Cliente selecionado!', description: identifiedCustomer.nome_fantasia || identifiedCustomer.razao_social });
    }
  };

  const acceptSuggestion = (suggestion: AISuggestion) => {
    if (suggestion.type === 'product' && suggestion.product_id) {
      const prod: AIProduct = {
        product_id: suggestion.product_id,
        codigo: suggestion.codigo || '',
        descricao: suggestion.descricao,
        quantity: suggestion.quantity || 1,
        account: (suggestion.account || 'oben') as 'oben' | 'colacor',
      };
      onItemsIdentified({ products: [prod], services: [] });
      toast({ title: 'Produto adicionado!', description: suggestion.descricao });
    } else if (suggestion.type === 'service' && suggestion.userToolId && suggestion.omie_codigo_servico) {
      const svc: AIService = {
        userToolId: suggestion.userToolId,
        omie_codigo_servico: suggestion.omie_codigo_servico,
        servico_descricao: suggestion.servico_descricao || suggestion.descricao,
        quantity: suggestion.quantity || 1,
      };
      onItemsIdentified({ products: [], services: [svc] });
      toast({ title: 'Serviço adicionado!', description: suggestion.descricao });
    }
    setSuggestions(prev => prev.filter(s => s !== suggestion));
  };

  const clearSuggestions = () => {
    setAiMessage(null);
    setIdentifiedProducts([]);
    setIdentifiedServices([]);
    setSuggestions([]);
    setIdentifiedCustomer(null);
  };

  const isProcessing = isRecording || isTranscribing || isAnalyzing || isLoading;
  const formatDuration = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  return (
    <div className="bg-card rounded-xl p-4 shadow-soft border border-border space-y-4">
      <input ref={fileInputRef} type="file" accept="image/*" capture="environment" multiple onChange={handleImageSelect} className="hidden" />
      <input ref={audioInputRef} type="file" accept="audio/*" multiple onChange={handleAudioFileSelect} className="hidden" />

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
              <button onClick={() => removeImage(idx)} className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-background/80 backdrop-blur flex items-center justify-center hover:bg-background">
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
          onChange={e => setText(e.target.value)}
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
            onClick={() => isRecording ? stopRecording() : startRecording()}
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
        onClick={analyze}
        disabled={(!text.trim() && images.length === 0) || isProcessing}
        className="w-full"
      >
        {isAnalyzing ? (
          <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Analisando...</>
        ) : (
          <><Sparkles className="w-4 h-4 mr-2" />{hasCustomerSelected ? 'Identificar Itens do Pedido' : 'Identificar Cliente e Itens'}</>
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
            <button onClick={clearSuggestions} className="p-1 text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>

          <p className="text-sm text-foreground">{aiMessage}</p>

          {/* Customer identified */}
          {identifiedCustomer && !hasCustomerSelected && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <User className="w-3.5 h-3.5" /> Cliente Identificado
              </p>
              <div className="bg-background rounded-lg p-3 border border-border">
                <div className="flex justify-between items-start">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm">{identifiedCustomer.nome_fantasia || identifiedCustomer.razao_social}</p>
                    {identifiedCustomer.nome_fantasia && identifiedCustomer.razao_social && identifiedCustomer.nome_fantasia !== identifiedCustomer.razao_social && (
                      <p className="text-xs text-muted-foreground">{identifiedCustomer.razao_social}</p>
                    )}
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground">{identifiedCustomer.cnpj_cpf}</span>
                      {identifiedCustomer.cidade && (
                        <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                          <MapPin className="w-3 h-3" />{identifiedCustomer.cidade}
                        </span>
                      )}
                    </div>
                    <Badge
                      variant={identifiedCustomer.confidence === 'high' ? 'default' : 'outline'}
                      className="text-[10px] mt-1"
                    >
                      {identifiedCustomer.confidence === 'high' ? 'Alta confiança' : identifiedCustomer.confidence === 'medium' ? 'Confiança média' : 'Baixa confiança'}
                    </Badge>
                  </div>
                  <Button size="sm" onClick={confirmCustomer} className="flex-shrink-0">
                    <Check className="w-3 h-3 mr-1" />
                    Selecionar
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Products */}
          {identifiedProducts.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Package className="w-3.5 h-3.5" /> Produtos ({identifiedProducts.length})
              </p>
              {identifiedProducts.map((item, idx) => {
                const prod = products.find(p => p.id === item.product_id);
                return (
                  <div key={idx} className="bg-background rounded-lg p-3 border border-border">
                    <div className="flex justify-between items-start">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{prod?.descricao || item.descricao || item.codigo}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <Badge variant="outline" className="text-[10px]">{item.account === 'colacor' ? 'Colacor' : 'Oben'}</Badge>
                          {prod && <span className="text-[10px] text-muted-foreground">{fmt(prod.valor_unitario)}/un</span>}
                        </div>
                        {item.notes && <p className="text-xs text-muted-foreground mt-1 italic">Obs: {item.notes}</p>}
                      </div>
                      <span className="bg-primary/10 text-primary text-xs font-medium px-2 py-1 rounded">
                        Qtd: {item.quantity}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Services */}
          {identifiedServices.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Wrench className="w-3.5 h-3.5" /> Serviços de Afiação ({identifiedServices.length})
              </p>
              {identifiedServices.map((item, idx) => {
                const tool = userTools.find(t => t.id === item.userToolId);
                return (
                  <div key={idx} className="bg-background rounded-lg p-3 border border-border">
                    <div className="flex justify-between items-start">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{tool ? getToolName(tool) : 'Ferramenta'}</p>
                        <p className="text-xs text-muted-foreground">Serviço: {item.servico_descricao}</p>
                        {item.notes && <p className="text-xs text-muted-foreground mt-1 italic">Obs: {item.notes}</p>}
                      </div>
                      <span className="bg-primary/10 text-primary text-xs font-medium px-2 py-1 rounded">
                        Qtd: {item.quantity}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {(identifiedProducts.length > 0 || identifiedServices.length > 0) && hasCustomerSelected && (
            <Button onClick={confirmItems} className="w-full" disabled={isLoading}>
              <Check className="w-4 h-4 mr-2" />
              Adicionar {identifiedProducts.length + identifiedServices.length} item(ns) ao Pedido
            </Button>
          )}

          {(identifiedProducts.length > 0 || identifiedServices.length > 0) && !hasCustomerSelected && (
            <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/20 p-2 rounded">
              ⚠️ Selecione o cliente acima primeiro para adicionar os itens ao pedido.
            </p>
          )}

          {/* Suggestions */}
          {suggestions.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-border">
              <p className="text-xs font-medium text-amber-600 flex items-center gap-1.5">
                <Lightbulb className="w-3.5 h-3.5" /> Sugestões ({suggestions.length})
              </p>
              <p className="text-xs text-muted-foreground">
                Não encontrei correspondência exata, mas esses itens podem ser o que você procura:
              </p>
              {suggestions.map((sug, idx) => {
                const prod = sug.type === 'product' && sug.product_id ? products.find(p => p.id === sug.product_id) : null;
                const tool = sug.type === 'service' && sug.userToolId ? userTools.find(t => t.id === sug.userToolId) : null;
                return (
                  <div key={idx} className="bg-amber-50 dark:bg-amber-950/20 rounded-lg p-3 border border-amber-200 dark:border-amber-800">
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {sug.type === 'product' ? (
                            <Package className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
                          ) : (
                            <Wrench className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
                          )}
                          <p className="font-medium text-sm truncate">
                            {prod?.descricao || (tool ? getToolName(tool) : sug.descricao)}
                          </p>
                        </div>
                        <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 italic">
                          💡 {sug.reason}
                        </p>
                        {sug.type === 'product' && prod && (
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="outline" className="text-[10px]">{sug.account === 'colacor' ? 'Colacor' : 'Oben'}</Badge>
                            <span className="text-[10px] text-muted-foreground">{fmt(prod.valor_unitario)}/un</span>
                          </div>
                        )}
                        {sug.type === 'service' && sug.servico_descricao && (
                          <p className="text-xs text-muted-foreground mt-0.5">Serviço: {sug.servico_descricao}</p>
                        )}
                      </div>
                      {hasCustomerSelected && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-shrink-0 text-xs border-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30"
                          onClick={() => acceptSuggestion(sug)}
                        >
                          <Plus className="w-3 h-3 mr-1" />
                          Adicionar
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center">
        🎙️ Voz &nbsp;·&nbsp; ⌨️ Texto &nbsp;·&nbsp; 📷 Fotos &nbsp;·&nbsp; 📎 Áudio — identifica cliente, produtos e serviços
      </p>
    </div>
  );
}
