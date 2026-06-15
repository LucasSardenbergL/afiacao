import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Type, StopCircle, Shield, Loader2 } from 'lucide-react';
import { useFarmerCopilot } from '@/components/farmer/copilot/useFarmerCopilot';
import { SessionStartCard } from '@/components/farmer/copilot/SessionStartCard';
import { DirectionIndicator } from '@/components/farmer/copilot/DirectionIndicator';
import { SuggestionCard } from '@/components/farmer/copilot/SuggestionCard';
import { ActivePlanCard } from '@/components/farmer/copilot/ActivePlanCard';
import { ManualTextInput } from '@/components/farmer/copilot/ManualTextInput';
import { TranscriptCard } from '@/components/farmer/copilot/TranscriptCard';
import { AnalysisHistoryCard } from '@/components/farmer/copilot/AnalysisHistoryCard';

const FarmerCopilot = () => {
  const {
    navigate,
    isStaff,
    isImpersonating,
    copilot,
    selectedCustomer,
    setSelectedCustomer,
    customers,
    isConnecting,
    copied,
    activePlan,
    showPlan,
    setShowPlan,
    inputMode,
    setInputMode,
    manualText,
    setManualText,
    isManualAnalyzing,
    riskFlash,
    transcriptEndRef,
    handleStart,
    handleStop,
    handleAnalyzeManualText,
    handleCopySuggestion,
    analysis,
    dir,
    DirIcon,
    SugIcon,
  } = useFarmerCopilot();

  if (!isStaff) { navigate('/', { replace: true }); return null; }

  return (
    <div className="min-h-screen bg-background pb-24">

      <main className="px-4 py-4 space-y-3 max-w-lg mx-auto">
        {/* Session Controls */}
        {!copilot.isActive ? (
          <SessionStartCard
            inputMode={inputMode}
            setInputMode={setInputMode}
            selectedCustomer={selectedCustomer}
            setSelectedCustomer={setSelectedCustomer}
            customers={customers}
            isConnecting={isConnecting}
            onStart={handleStart}
            disabled={isImpersonating}
          />
        ) : (
          <>
            {/* Active Session Header */}
            <Card className="bg-gradient-to-r from-primary/10 to-primary/5 border-primary/20">
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {inputMode === 'voice' ? (
                      <div className="w-2 h-2 rounded-full bg-status-error animate-pulse" />
                    ) : (
                      <Type className="w-3.5 h-3.5 text-primary" />
                    )}
                    <span className="text-xs font-bold">
                      {inputMode === 'voice' ? 'AO VIVO' : 'MODO TEXTO'}
                    </span>
                    {copilot.session?.customerName && (
                      <Badge variant="outline" className="text-[9px]">{copilot.session.customerName}</Badge>
                    )}
                  </div>
                  <Button size="sm" variant="destructive" onClick={handleStop} className="h-7 text-[10px] gap-1">
                    <StopCircle className="w-3 h-3" /> Encerrar
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Direction Indicator */}
            {analysis && dir && (
              <DirectionIndicator analysis={analysis} dir={dir} DirIcon={DirIcon} />
            )}

            {/* AI Suggestion */}
            {analysis?.suggestion && (
              <SuggestionCard
                analysis={analysis}
                SugIcon={SugIcon}
                riskFlash={riskFlash}
                copied={copied}
                onCopy={handleCopySuggestion}
                suggestionsShown={copilot.suggestionsShown}
                suggestionsUsed={copilot.suggestionsUsed}
              />
            )}

            {/* Active PTPL */}
            {activePlan && (
              <ActivePlanCard
                activePlan={activePlan}
                showPlan={showPlan}
                onToggle={() => setShowPlan(!showPlan)}
              />
            )}

            {copilot.isAnalyzing && (
              <div className="flex items-center gap-2 justify-center py-1">
                <Loader2 className="w-3 h-3 animate-spin text-primary" />
                <span className="text-[10px] text-muted-foreground">Analisando...</span>
              </div>
            )}

            {/* Manual Text Input (text mode) */}
            {inputMode === 'text' && (
              <ManualTextInput
                manualText={manualText}
                setManualText={setManualText}
                isManualAnalyzing={isManualAnalyzing}
                onAnalyze={handleAnalyzeManualText}
              />
            )}

            {/* Transcript */}
            <TranscriptCard
              transcript={copilot.transcript}
              inputMode={inputMode}
              transcriptEndRef={transcriptEndRef}
            />

            {/* Analysis History */}
            {copilot.analysisHistory.length > 1 && (
              <AnalysisHistoryCard analysisHistory={copilot.analysisHistory} />
            )}
          </>
        )}

        {/* Governance Notice */}
        <Card className="border-dashed">
          <CardContent className="p-3">
            <div className="flex items-start gap-2">
              <Shield className="w-4 h-4 text-muted-foreground mt-0.5" />
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground">Governança</p>
                <p className="text-[9px] text-muted-foreground">
                  O copiloto apenas sugere — nenhuma resposta é enviada automaticamente ao cliente.
                  Mudanças estruturais requerem aprovação via CPF autorizado.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>

    </div>
  );
};

export default FarmerCopilot;
