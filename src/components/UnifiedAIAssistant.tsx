import { type UnifiedAIAssistantProps } from './unifiedAI/types';
import { useUnifiedAIAssistant } from './unifiedAI/useUnifiedAIAssistant';
import { AIInputArea } from './unifiedAI/AIInputArea';
import { AIResultPanel } from './unifiedAI/AIResultPanel';

// Re-exporta os tipos públicos para preservar os imports existentes
// (ex: useUnifiedOrder.ts importa AIOrderResult / AICustomerMatch deste módulo).
export type {
  AIProduct,
  AIService,
  AISuggestion,
  AICustomerMatch,
  AIOrderResult,
} from './unifiedAI/types';

export function UnifiedAIAssistant(props: UnifiedAIAssistantProps) {
  const { products, userTools, hasCustomerSelected = false, isLoading = false } = props;
  const ai = useUnifiedAIAssistant(props);

  return (
    <div className="bg-card rounded-xl p-4 shadow-soft border border-border space-y-4">
      <AIInputArea
        fileInputRef={ai.fileInputRef}
        audioInputRef={ai.audioInputRef}
        onImageSelect={ai.handleImageSelect}
        onAudioFileSelect={ai.handleAudioFileSelect}
        images={ai.images}
        onRemoveImage={ai.removeImage}
        text={ai.text}
        onTextChange={ai.setText}
        isRecording={ai.isRecording}
        isTranscribing={ai.isTranscribing}
        isAnalyzing={ai.isAnalyzing}
        isLoading={isLoading}
        isProcessing={ai.isProcessing}
        recordingDuration={ai.recordingDuration}
        onStartRecording={ai.startRecording}
        onStopRecording={ai.stopRecording}
        onAnalyze={ai.analyze}
        hasCustomerSelected={hasCustomerSelected}
      />

      {/* AI Response */}
      {ai.aiMessage && (
        <AIResultPanel
          aiMessage={ai.aiMessage}
          aiFallbackActive={ai.aiFallbackActive}
          onClear={ai.clearSuggestions}
          onAnalyze={ai.analyze}
          isAnalyzing={ai.isAnalyzing}
          identifiedCustomer={ai.identifiedCustomer}
          hasCustomerSelected={hasCustomerSelected}
          onConfirmCustomer={ai.confirmCustomer}
          identifiedProducts={ai.identifiedProducts}
          catalog={products}
          onRemoveProduct={ai.removeIdentifiedProduct}
          identifiedServices={ai.identifiedServices}
          userTools={userTools}
          isLoading={isLoading}
          onConfirmItems={ai.confirmItems}
          suggestions={ai.suggestions}
          onAcceptSuggestion={ai.acceptSuggestion}
        />
      )}

      <p className="text-xs text-muted-foreground text-center">
        🎙️ Voz &nbsp;·&nbsp; ⌨️ Texto &nbsp;·&nbsp; 📷 Fotos &nbsp;·&nbsp; 📎 Áudio — identifica cliente, produtos e serviços
      </p>
    </div>
  );
}
