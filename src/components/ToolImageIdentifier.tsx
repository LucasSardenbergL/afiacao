import { useState, useRef } from 'react';
import { Camera, Loader2, X, CheckCircle, AlertCircle, Image } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface ToolCategory {
  id: string;
  name: string;
  description: string | null;
}

interface IdentificationResult {
  identified: boolean;
  category_name: string | null;
  confidence: 'alta' | 'media' | 'baixa';
  description: string;
  specs_detected: Record<string, string>;
  suggested_services: string[];
}

interface ToolImageIdentifierProps {
  categories: ToolCategory[];
  onCategoryIdentified: (categoryId: string, specs: Record<string, string>) => void;
  onClose?: () => void;
  className?: string;
}

export function ToolImageIdentifier({ categories, onCategoryIdentified, onClose, className }: ToolImageIdentifierProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<IdentificationResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Selecione uma imagem', variant: 'destructive' });
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: 'Imagem muito grande', description: 'Máximo 5MB', variant: 'destructive' });
      return;
    }

    // Read and resize image
    const base64 = await fileToBase64(file);
    setPreview(URL.createObjectURL(file));
    setResult(null);
    await analyzeImage(base64);
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix
        resolve(result.split(',')[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const analyzeImage = async (imageBase64: string) => {
    setIsAnalyzing(true);
    try {
      const { data, error } = await supabase.functions.invoke('identify-tool', {
        body: {
          imageBase64,
          categories: categories.map(c => ({ name: c.name, description: c.description })),
        },
      });

      if (error) throw error;
      setResult(data as IdentificationResult);
    } catch (error) {
      console.error('Erro ao analisar imagem:', error);
      toast({
        title: 'Erro na análise',
        description: 'Não foi possível analisar a imagem. Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleConfirm = () => {
    if (!result?.category_name) return;

    const matchedCategory = categories.find(
      c => c.name.toLowerCase() === result.category_name!.toLowerCase()
    );

    if (matchedCategory) {
      onCategoryIdentified(matchedCategory.id, result.specs_detected || {});
      toast({
        title: 'Ferramenta identificada!',
        description: `${matchedCategory.name} selecionada`,
      });
    } else {
      toast({
        title: 'Categoria não encontrada',
        description: `"${result.category_name}" não corresponde a nenhuma categoria cadastrada. Selecione manualmente.`,
        variant: 'destructive',
      });
    }
  };

  const reset = () => {
    setPreview(null);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const confidenceColor = {
    alta: 'text-emerald-600',
    media: 'text-amber-600',
    baixa: 'text-destructive',
  };

  const confidenceLabel = {
    alta: 'Alta confiança',
    media: 'Confiança média',
    baixa: 'Baixa confiança',
  };

  return (
    <div className={cn('space-y-4', className)}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileSelect}
        className="hidden"
      />

      {!preview ? (
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full border-2 border-dashed border-border rounded-xl p-6 flex flex-col items-center gap-3 hover:border-primary hover:bg-primary/5 transition-colors"
        >
          <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
            <Camera className="w-7 h-7 text-primary" />
          </div>
          <div className="text-center">
            <p className="font-medium text-foreground">Identificar por foto</p>
            <p className="text-xs text-muted-foreground mt-1">
              Tire uma foto ou selecione da galeria
            </p>
          </div>
        </button>
      ) : (
        <div className="space-y-3">
          {/* Image preview */}
          <div className="relative rounded-xl overflow-hidden bg-muted">
            <img src={preview} alt="Ferramenta" className="w-full h-48 object-cover" />
            <button
              onClick={reset}
              className="absolute top-2 right-2 w-8 h-8 rounded-full bg-background/80 backdrop-blur flex items-center justify-center hover:bg-background"
            >
              <X className="w-4 h-4" />
            </button>

            {isAnalyzing && (
              <div className="absolute inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center">
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="w-8 h-8 animate-spin text-primary" />
                  <p className="text-sm font-medium">Analisando imagem...</p>
                </div>
              </div>
            )}
          </div>

          {/* Result */}
          {result && (
            <div className="bg-card rounded-xl border border-border p-4 space-y-3">
              {result.identified ? (
                <>
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <p className="font-semibold text-foreground">{result.category_name}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">{result.description}</p>
                      <p className={cn('text-xs mt-1 font-medium', confidenceColor[result.confidence])}>
                        {confidenceLabel[result.confidence]}
                      </p>
                    </div>
                  </div>

                  {/* Detected specs */}
                  {Object.keys(result.specs_detected || {}).length > 0 && (
                    <div className="bg-muted/50 rounded-lg p-3">
                      <p className="text-xs font-medium text-muted-foreground mb-2">Especificações detectadas:</p>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(result.specs_detected).map(([key, value]) => (
                          <span key={key} className="text-xs bg-background rounded-full px-2 py-1 border border-border">
                            {key}: {value}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Suggested services */}
                  {result.suggested_services?.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Serviços sugeridos:</p>
                      <div className="flex flex-wrap gap-1">
                        {result.suggested_services.map((svc, i) => (
                          <span key={i} className="text-xs bg-primary/10 text-primary rounded-full px-2 py-1">
                            {svc}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2 pt-1">
                    <Button size="sm" onClick={handleConfirm} className="flex-1">
                      Usar esta ferramenta
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                      <Image className="w-4 h-4" />
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-muted-foreground mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-medium text-foreground">Não foi possível identificar</p>
                      <p className="text-sm text-muted-foreground mt-0.5">{result.description}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} className="flex-1">
                      Tentar outra foto
                    </Button>
                    {onClose && (
                      <Button size="sm" variant="ghost" onClick={onClose}>
                        Selecionar manualmente
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
