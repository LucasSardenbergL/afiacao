// Lógica do Assistente de Pedido IA (estado, gravação/transcrição, imagem, análise, sugestões).
// Extraída verbatim de src/components/UnifiedAIAssistant.tsx (god-component split).
import { useState, useRef, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { decodeHtmlEntities } from '@/lib/utils';
import { invokeFunction } from '@/lib/invoke-function';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import {
  type AIDescartado,
  type AIProduct,
  type AIService,
  type AISuggestion,
  type AICustomerMatch,
  type ImageAttachment,
  type RelatorioAdicaoIA,
  type UnifiedAIAssistantProps,
} from './types';
import { resumoRelatorio } from './helpers';
import { contarRelatorio } from '@/hooks/unifiedOrder/adicao-ia';

export function useUnifiedAIAssistant({
  products,
  userTools,
  onItemsIdentified,
  onCustomerIdentified,
  customerUserId,
  hasCustomerSelected = false,
  isLoading = false,
  aoSensor,
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
  // PR 3.1: o que a edge descartou (com motivo) e o desfecho da última adição, por item.
  const [descartadosIA, setDescartadosIA] = useState<AIDescartado[]>([]);
  const [relatorio, setRelatorio] = useState<RelatorioAdicaoIA | null>(null);
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
      const msg = mensagemDeErro(err) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.';
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
      const msg = mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.';
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
    aoSensor?.('novo_pedido.ia_analise_pedida', {
      com_texto: !!text.trim(), imagens: images.length, cliente_na_tela: hasCustomerSelected,
    });

    setIsAnalyzing(true);
    setAiMessage(null);
    setIdentifiedProducts([]);
    setIdentifiedServices([]);
    setSuggestions([]);
    setIdentifiedCustomer(null);
    setDescartadosIA([]);
    setRelatorio(null);
    setAiFallbackActive(false);

    try {
      const result = await invokeFunction<{
        products?: AIProduct[];
        services?: AIService[];
        suggestions?: AISuggestion[];
        customer?: AICustomerMatch | null;
        descartados?: AIDescartado[];
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
      setDescartadosIA(Array.isArray(result.descartados) ? result.descartados : []);

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
      // A edge devolve motivo ACIONÁVEL no corpo (foto HEIC que precisa virar
      // JPEG, resposta truncada, créditos esgotados) e o invokeFunction o
      // propaga na mensagem do erro. Trocar isso pelo texto genérico escondia
      // do vendedor por que a foto dele não entrou na análise.
      const motivoDoServidor =
        e instanceof Error && e.name === 'EdgeFunctionError' &&
        !/non-2xx status code/i.test(e.message)
          ? e.message
          : null;
      setAiMessage(
        motivoDoServidor ??
        'A análise inteligente está indisponível no momento. Você pode continuar montando o pedido manualmente.',
      );
      toast.success(motivoDoServidor ? 'Análise não concluída' : 'Análise indisponível', {
        description:
          motivoDoServidor ?? 'Continue montando o pedido manualmente. Você pode tentar novamente depois.',
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  // PR 3.1: o anúncio e o sensor contam o que ENTROU (o relatório por item que o carrinho devolve),
  // não o que foi pedido. Antes, "N item(ns) adicionado(s)" incluía o produto fora do catálogo e a
  // ferramenta já no pedido, que o carrinho pulava em silêncio.
  const anunciar = (rel: RelatorioAdicaoIA, via: 'confirmar' | 'sugestao') => {
    const c = contarRelatorio(rel);
    aoSensor?.('novo_pedido.ia_itens_adicionados', {
      n: c.entrou, via, aguardando_cor: c.cor, nao_entraram: c.descartado, qtd_inferida: c.inferidas,
    });
    const resumo = resumoRelatorio(c);
    if (c.entrou === 0 && c.cor === 0) toast.error('Nenhum item entrou no pedido', { description: resumo });
    else if (c.descartado > 0 || c.inferidas > 0) toast.warning('Itens adicionados com ressalvas', { description: resumo });
    else toast.success('Itens adicionados!', { description: resumo });
    return c;
  };

  const confirmItems = () => {
    const rel = onItemsIdentified({ products: identifiedProducts, services: identifiedServices });
    const c = anunciar(rel, 'confirmar');
    setRelatorio(rel);
    // Nada entrou (ex.: carrinho travado no envio): os itens FICAM no painel para tentar de novo.
    if (c.entrou === 0 && c.cor === 0) return;
    // Saída que RECOMEÇA (lição dos PRs 8.1/8.2): o painel troca a análise pelo resultado da adição,
    // sem guardar a lista velha que já virou carrinho.
    setText('');
    setAiMessage(`Resultado: ${resumoRelatorio(c)}.`);
    setIdentifiedProducts([]);
    setIdentifiedServices([]);
    setSuggestions([]);
    setDescartadosIA([]);
    setIdentifiedCustomer(null);
    clearImages();
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
    let rel: RelatorioAdicaoIA | null = null;
    if (suggestion.type === 'product' && suggestion.product_id && suggestion.product_id !== '') {
      const prod: AIProduct = {
        product_id: suggestion.product_id,
        codigo: suggestion.codigo || '',
        descricao: suggestion.descricao,
        quantity: suggestion.quantity || 1,
        quantidade_inferida: suggestion.quantity ? suggestion.quantidade_inferida : true,
        account: (suggestion.account || 'oben') as 'oben' | 'colacor',
      };
      rel = onItemsIdentified({ products: [prod], services: [] });
    } else if (suggestion.type === 'product' && (!suggestion.product_id || suggestion.product_id === '')) {
      // Sugestão sem product_id: procura no catálogo da tela. Só adiciona com UM candidato — o
      // primeiro que casava pelo texto entrava mesmo havendo outras embalagens (PR 3.1).
      const candidatos = products.filter(p =>
        (suggestion.codigo && p.codigo.toLowerCase().includes(suggestion.codigo.toLowerCase())) ||
        p.descricao.toLowerCase().includes(suggestion.descricao.toLowerCase())
      );
      if (candidatos.length > 1) {
        toast.error('Mais de um produto casa com a sugestão', {
          description: `${candidatos.length} produtos parecidos — busque pelo código para escolher o certo.`,
        });
        return;
      }
      const matchProd = candidatos[0];
      if (!matchProd) {
        toast.error('Produto não encontrado', { description: 'Busque manualmente no catálogo.' });
        return;
      }
      const prod: AIProduct = {
        product_id: matchProd.id,
        codigo: matchProd.codigo,
        descricao: matchProd.descricao,
        quantity: suggestion.quantity || 1,
        quantidade_inferida: suggestion.quantity ? suggestion.quantidade_inferida : true,
        account: (matchProd.account || suggestion.account || 'oben') as 'oben' | 'colacor',
      };
      rel = onItemsIdentified({ products: [prod], services: [] });
    } else if (suggestion.type === 'service' && suggestion.userToolId && suggestion.omie_codigo_servico) {
      const svc: AIService = {
        userToolId: suggestion.userToolId,
        omie_codigo_servico: suggestion.omie_codigo_servico,
        servico_descricao: suggestion.servico_descricao || suggestion.descricao,
        quantity: suggestion.quantity || 1,
        quantidade_inferida: suggestion.quantity ? suggestion.quantidade_inferida : true,
      };
      rel = onItemsIdentified({ products: [], services: [svc] });
    }
    if (!rel) return;
    const c = anunciar(rel, 'sugestao');
    setRelatorio(rel);
    // A sugestão só sai da lista quando entrou (ou foi para a cor) — a que não entrou continua lá.
    if (c.entrou > 0 || c.cor > 0) setSuggestions(prev => prev.filter(s => s !== suggestion));
  };

  const clearSuggestions = () => {
    const pendentes = identifiedProducts.length + identifiedServices.length + suggestions.length;
    if (pendentes > 0) aoSensor?.('novo_pedido.ia_itens_descartados', { n: pendentes, via: 'limpar' });
    setAiMessage(null);
    setIdentifiedProducts([]);
    setIdentifiedServices([]);
    setSuggestions([]);
    setIdentifiedCustomer(null);
    setDescartadosIA([]);
    setRelatorio(null);
  };

  const removeIdentifiedProduct = (idx: number) => {
    aoSensor?.('novo_pedido.ia_itens_descartados', { n: 1, via: 'remover' });
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
    descartadosIA,
    relatorio,
    // result handlers
    confirmItems,
    confirmCustomer,
    acceptSuggestion,
    clearSuggestions,
    removeIdentifiedProduct,
  };
}
