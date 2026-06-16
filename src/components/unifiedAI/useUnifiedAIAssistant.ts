// Lógica do Assistente de Pedido IA (estado, gravação/transcrição, imagem, análise, sugestões).
// Extraída verbatim de src/components/UnifiedAIAssistant.tsx (god-component split).
import { useState, useRef, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { decodeHtmlEntities } from '@/lib/utils';
import { invokeFunction } from '@/lib/invoke-function';
import {
  type AIProduct,
  type AIService,
  type AISuggestion,
  type AICustomerMatch,
  type ImageAttachment,
  type UnifiedAIAssistantProps,
} from './types';

export function useUnifiedAIAssistant({
  products,
  userTools,
  onItemsIdentified,
  onCustomerIdentified,
  customerUserId,
  hasCustomerSelected = false,
  isLoading = false,
}: UnifiedAIAssistantProps) {
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
        toast.error('Erro na gravação');
        stopRecording();
      };

      mr.start(1000);
      setIsRecording(true);
      setRecordingDuration(0);
      timerRef.current = window.setInterval(() => setRecordingDuration(p => p + 1), 1000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError') {
        toast.error('Permissão negada', { description: 'Permita o acesso ao microfone.' });
      } else {
        toast.error('Erro ao gravar', { description: msg });
      }
    }
  }, []);

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

      const result = await invokeFunction<{ text?: string }>('elevenlabs-transcribe', fd);
      if (result.text) {
        setText(prev => prev + (prev ? ' ' : '') + result.text);
        toast.success('Transcrição concluída');
      } else {
        toast.error('Nenhum texto detectado');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error('Erro na transcrição', { description: msg });
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
        toast.error(`"${file.name}" não é um áudio`);
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        toast.error(`"${file.name}" muito grande (máx 10MB)`);
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
      if (!file.type.startsWith('image/')) { toast.error('Selecione uma imagem'); continue; }
      if (file.size > 5 * 1024 * 1024) { toast.error(`"${file.name}" muito grande (máx 5MB)`); continue; }
      if (images.length >= 5) { toast.error('Máximo de 5 fotos'); break; }

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
  const [aiFallbackActive, setAiFallbackActive] = useState(false);

  const analyze = async () => {
    if (!text.trim() && images.length === 0) {
      toast.error('Digite, grave, anexe áudio ou tire uma foto');
      return;
    }
    if (isRecording) stopRecording();

    setIsAnalyzing(true);
    setAiMessage(null);
    setIdentifiedProducts([]);
    setIdentifiedServices([]);
    setSuggestions([]);
    setIdentifiedCustomer(null);
    setAiFallbackActive(false);

    try {
      const result = await invokeFunction<{
        products?: AIProduct[];
        services?: AIService[];
        suggestions?: AISuggestion[];
        customer?: AICustomerMatch | null;
        message?: string;
      }>('analyze-unified-order', {
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
      });

      // Guard against null/undefined/non-object responses
      if (!result || typeof result !== 'object') {
        console.error('[UnifiedOrder AI] Resposta inválida da análise:', result);
        setAiFallbackActive(true);
        setAiMessage('A análise inteligente está indisponível no momento. Você pode continuar montando o pedido manualmente.');
        return;
      }

      const prods = Array.isArray(result.products) ? result.products : [];
      const svcs = Array.isArray(result.services) ? result.services : [];
      const sugs = Array.isArray(result.suggestions) ? result.suggestions : [];
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
    } catch (e: unknown) {
      console.error('[UnifiedOrder AI] Falha ao analisar pedido:', e);
      setAiFallbackActive(true);
      setAiMessage('A análise inteligente está indisponível no momento. Você pode continuar montando o pedido manualmente.');
      toast.success('Análise indisponível', {
        description: 'Continue montando o pedido manualmente. Você pode tentar novamente depois.',
      });
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
    toast.success('Itens adicionados!', { description: `${total} item(ns) adicionado(s) ao pedido.` });
  };

  const confirmCustomer = () => {
    if (identifiedCustomer && onCustomerIdentified) {
      onCustomerIdentified(identifiedCustomer);
      setIdentifiedCustomer(null);
      toast.success('Cliente selecionado!', { description: decodeHtmlEntities(identifiedCustomer.nome_fantasia || identifiedCustomer.razao_social) });
      // Note: we intentionally do NOT clear identifiedProducts/suggestions
      // so the user can add them after customer is set
    }
  };

  const acceptSuggestion = (suggestion: AISuggestion) => {
    if (suggestion.type === 'product' && suggestion.product_id && suggestion.product_id !== '') {
      const prod: AIProduct = {
        product_id: suggestion.product_id,
        codigo: suggestion.codigo || '',
        descricao: suggestion.descricao,
        quantity: suggestion.quantity || 1,
        account: (suggestion.account || 'oben') as 'oben' | 'colacor',
        unit_price: suggestion.unit_price,
      };
      onItemsIdentified({ products: [prod], services: [] });
      toast.success('Produto adicionado!', { description: suggestion.descricao });
    } else if (suggestion.type === 'product' && (!suggestion.product_id || suggestion.product_id === '')) {
      // Suggestion without exact product_id - try to find it in products list
      const matchProd = products.find(p =>
        (suggestion.codigo && p.codigo.toLowerCase().includes(suggestion.codigo.toLowerCase())) ||
        p.descricao.toLowerCase().includes(suggestion.descricao.toLowerCase())
      );
      if (matchProd) {
        const prod: AIProduct = {
          product_id: matchProd.id,
          codigo: matchProd.codigo,
          descricao: matchProd.descricao,
          quantity: suggestion.quantity || 1,
          account: (matchProd.account || suggestion.account || 'oben') as 'oben' | 'colacor',
          unit_price: suggestion.unit_price,
        };
        onItemsIdentified({ products: [prod], services: [] });
        toast.success('Produto adicionado!', { description: matchProd.descricao });
      } else {
        toast.error('Produto não encontrado', { description: 'Busque manualmente no catálogo.' });
      }
    } else if (suggestion.type === 'service' && suggestion.userToolId && suggestion.omie_codigo_servico) {
      const svc: AIService = {
        userToolId: suggestion.userToolId,
        omie_codigo_servico: suggestion.omie_codigo_servico,
        servico_descricao: suggestion.servico_descricao || suggestion.descricao,
        quantity: suggestion.quantity || 1,
      };
      onItemsIdentified({ products: [], services: [svc] });
      toast.success('Serviço adicionado!', { description: suggestion.descricao });
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

  const removeIdentifiedProduct = (idx: number) => {
    setIdentifiedProducts(prev => prev.filter((_, i) => i !== idx));
  };

  const isProcessing = isRecording || isTranscribing || isAnalyzing || isLoading;

  return {
    // refs (file inputs)
    fileInputRef,
    audioInputRef,
    // input state
    text,
    setText,
    images,
    removeImage,
    // status
    isRecording,
    isTranscribing,
    isAnalyzing,
    isProcessing,
    recordingDuration,
    // recording / input handlers
    startRecording,
    stopRecording,
    handleAudioFileSelect,
    handleImageSelect,
    analyze,
    // results
    aiMessage,
    aiFallbackActive,
    identifiedProducts,
    identifiedServices,
    suggestions,
    identifiedCustomer,
    // result handlers
    confirmItems,
    confirmCustomer,
    acceptSuggestion,
    clearSuggestions,
    removeIdentifiedProduct,
  };
}
