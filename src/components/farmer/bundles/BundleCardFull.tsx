// Card completo de um bundle (produtos, métricas, CTA, perguntas SPIN, argumentação IA).
// Extraído verbatim de src/pages/FarmerBundles.tsx (god-component split).
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Loader2, Phone, Send, FileText, Sparkles, Copy, Check,
  HelpCircle, Save, ShoppingCart,
} from 'lucide-react';
import { toast } from 'sonner';
import type { BundleRecommendation } from '@/hooks/useBundleEngine';
import type { BundleArgument, CustomerProfile } from '@/hooks/useBundleArguments';
import type { QuestionWithResponse, QuestionResponse } from '@/hooks/useDiagnosticQuestions';
import { fmt } from './format';
import type { CustomerCtx } from './types';
import { ArgLine } from './ArgLine';
import { QuestionCard } from './QuestionCard';

interface BundleCardFullProps {
  bundle: BundleRecommendation;
  rank: number;
  bundleKey: string;
  customerId: string;
  customerCtx: CustomerCtx;
  profile: CustomerProfile;
  argument?: BundleArgument;
  isArgGenerating: boolean;
  onGenerateArg: () => void;
  questions: QuestionWithResponse[];
  isQuestionsGenerating: boolean;
  onGenerateQuestions: () => void;
  onSetResponse: (idx: number, resp: QuestionResponse, notes?: string) => void;
  onToggleAlt: (idx: number) => void;
  onSaveQuestions: (offered: boolean, result?: string, margin?: number, time?: number) => void;
}

export const BundleCardFull = ({
  bundle, rank, customerId, argument, isArgGenerating, onGenerateArg,
  questions, isQuestionsGenerating, onGenerateQuestions, onSetResponse, onToggleAlt, onSaveQuestions,
}: BundleCardFullProps) => {
  const navigate = useNavigate();
  // Lente "Ver como": a geração (perguntas/argumentação via edge) e o save de respostas
  // são WRITES — bloqueados na fonte pelo write-guard. Desabilitar os botões é UX honesta
  // (evita o toast de erro do guard). A leitura/inspeção dos bundles do alvo segue normal.
  const { isImpersonating } = useImpersonation();
  const lensTitle = isImpersonating ? 'Indisponível em modo Ver como' : undefined;
  const [argTab, setArgTab] = useState<'phone' | 'whatsapp' | 'tecnica'>('phone');
  const [activeSection, setActiveSection] = useState<'none' | 'args' | 'questions'>('none');
  const [copied, setCopied] = useState(false);

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success('Copiado!');
    setTimeout(() => setCopied(false), 2000);
  };

  const getActiveText = () => {
    if (!argument) return '';
    if (argTab === 'phone') return argument.versao_phone;
    if (argTab === 'whatsapp') return argument.versao_whatsapp;
    return argument.versao_tecnica;
  };

  return (
    <div className="bg-muted/30 rounded-lg p-2.5 border">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-[8px]">Bundle #{rank}</Badge>
          <Badge className="text-[8px] bg-primary/10 text-primary">{bundle.products.length} produtos</Badge>
        </div>
        <span className="text-xs font-bold text-status-success">{fmt(bundle.lieBundle)}</span>
      </div>

      {/* Products */}
      <div className="space-y-1 mb-2">
        {bundle.products.map((p, i) => (
          <div key={i} className="flex items-center justify-between bg-background rounded px-2 py-1">
            <span className="text-[10px] truncate flex-1">{p.name}</span>
            <span className="text-[10px] font-semibold text-status-success ml-2">{fmt(p.margin)}</span>
          </div>
        ))}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-1 text-center mb-2">
        <div><p className="text-[8px] text-muted-foreground">Support</p><p className="text-[10px] font-semibold">{(bundle.support * 100).toFixed(1)}%</p></div>
        <div><p className="text-[8px] text-muted-foreground">Confidence</p><p className="text-[10px] font-semibold">{(bundle.confidence * 100).toFixed(1)}%</p></div>
        <div><p className="text-[8px] text-muted-foreground">Lift</p><p className="text-[10px] font-semibold">{bundle.lift.toFixed(2)}</p></div>
        <div><p className="text-[8px] text-muted-foreground">P(Bundle)</p><p className="text-[10px] font-semibold">{bundle.pBundle.toFixed(1)}%</p></div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-1.5 mb-2">
        <Button
          size="sm"
          variant={activeSection === 'questions' ? 'default' : 'outline'}
          className="flex-1 h-7 text-[9px] gap-1"
          disabled={isImpersonating}
          title={lensTitle}
          onClick={() => {
            if (activeSection === 'questions') { setActiveSection('none'); return; }
            setActiveSection('questions');
            if (!questions.length && !isQuestionsGenerating) onGenerateQuestions();
          }}
        >
          <HelpCircle className="w-3 h-3" /> Perguntas SPIN
        </Button>
        <Button
          size="sm"
          variant={activeSection === 'args' ? 'default' : 'outline'}
          className="flex-1 h-7 text-[9px] gap-1"
          disabled={isImpersonating}
          title={lensTitle}
          onClick={() => {
            if (activeSection === 'args') { setActiveSection('none'); return; }
            setActiveSection('args');
            if (!argument && !isArgGenerating) onGenerateArg();
          }}
        >
          <Sparkles className="w-3 h-3" /> Argumentação
        </Button>
      </div>

      {/* CTA: Create order from bundle */}
      <Button
        size="sm"
        className="w-full h-7 text-[9px] gap-1 mb-2"
        disabled={!customerId}
        onClick={() => {
          const params = new URLSearchParams();
          if (customerId) params.set('customer', customerId);
          navigate(`/sales/new?${params.toString()}`);
        }}
      >
        <ShoppingCart className="w-3 h-3" /> Montar pedido com este bundle
      </Button>

      {/* ─── DIAGNOSTIC QUESTIONS ──────────────────────────────── */}
      {activeSection === 'questions' && (
        <div className="space-y-2">
          {isQuestionsGenerating && (
            <div className="flex items-center justify-center gap-2 py-3">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <span className="text-[10px] text-muted-foreground">Gerando perguntas diagnósticas...</span>
            </div>
          )}

          {questions.length > 0 && (
            <div className="bg-background rounded-lg p-2 space-y-2">
              <p className="text-[9px] font-semibold flex items-center gap-1">
                <HelpCircle className="w-3 h-3 text-primary" /> Perguntas Diagnósticas SPIN
              </p>
              {questions.map((q, idx) => (
                <QuestionCard
                  key={idx}
                  question={q}
                  onSetResponse={(resp, notes) => onSetResponse(idx, resp, notes)}
                  onToggleAlt={() => onToggleAlt(idx)}
                />
              ))}

              {/* Save responses */}
              <div className="flex gap-1.5 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-7 text-[9px] gap-1"
                  disabled={isImpersonating}
                  title={lensTitle}
                  onClick={() => onSaveQuestions(false)}
                >
                  <Save className="w-3 h-3" /> Salvar (sem oferta)
                </Button>
                <Button
                  size="sm"
                  className="flex-1 h-7 text-[9px] gap-1"
                  disabled={isImpersonating}
                  title={lensTitle}
                  onClick={() => onSaveQuestions(true)}
                >
                  <Save className="w-3 h-3" /> Salvar (ofertou)
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── ARGUMENT SECTION ──────────────────────────────────── */}
      {activeSection === 'args' && (
        <div className="space-y-2">
          {isArgGenerating && (
            <div className="flex items-center justify-center gap-2 py-3">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <span className="text-[10px] text-muted-foreground">Gerando argumentação...</span>
            </div>
          )}

          {argument && (
            <>
              <div className="bg-background rounded-lg p-2 space-y-1.5">
                <p className="text-[9px] font-semibold flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-primary" /> Argumentação IA
                </p>
                <ArgLine icon="🔍" label="Diagnóstico" text={argument.diagnostico} />
                <ArgLine icon="🔬" label="Insight Técnico" text={argument.insight_tecnico} />
                <ArgLine icon="⚙️" label="Benefício Operacional" text={argument.beneficio_operacional} />
                <ArgLine icon="💰" label="Benefício Econômico" text={argument.beneficio_economico} />
                <ArgLine icon="🛡️" label="Objeção Antecipada" text={argument.objecao_antecipada} />
              </div>

              <div className="bg-background rounded-lg p-2">
                <div className="flex items-center gap-1 mb-2">
                  <Button size="sm" variant={argTab === 'phone' ? 'default' : 'ghost'} className="h-6 text-[9px] gap-1 px-2" onClick={() => setArgTab('phone')}>
                    <Phone className="w-3 h-3" /> Ligação
                  </Button>
                  <Button size="sm" variant={argTab === 'whatsapp' ? 'default' : 'ghost'} className="h-6 text-[9px] gap-1 px-2" onClick={() => setArgTab('whatsapp')}>
                    <Send className="w-3 h-3" /> WhatsApp
                  </Button>
                  <Button size="sm" variant={argTab === 'tecnica' ? 'default' : 'ghost'} className="h-6 text-[9px] gap-1 px-2" onClick={() => setArgTab('tecnica')}>
                    <FileText className="w-3 h-3" /> Técnica
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 text-[9px] gap-1 px-2 ml-auto" onClick={() => copyText(getActiveText())}>
                    {copied ? <Check className="w-3 h-3 text-status-success" /> : <Copy className="w-3 h-3" />}
                  </Button>
                </div>
                <div className="bg-muted/50 rounded p-2">
                  <p className="text-[10px] whitespace-pre-line leading-relaxed">{getActiveText()}</p>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
