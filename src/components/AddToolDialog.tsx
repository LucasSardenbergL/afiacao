import { useState, useEffect, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plus, ChevronRight, ChevronLeft, Search } from 'lucide-react';
import { ToolImageIdentifier } from '@/components/ToolImageIdentifier';

interface ToolCategory {
  id: string;
  name: string;
  description: string | null;
  suggested_interval_days: number | null;
}

interface ToolSpecification {
  id: string;
  spec_key: string;
  spec_label: string;
  spec_type: string;
  options: string[] | null;
  is_required: boolean;
  display_order: number;
}

interface AddToolDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToolAdded: () => void;
  categories: ToolCategory[];
  targetUserId?: string; // For staff adding tools to customers
}

export function AddToolDialog({ open, onOpenChange, onToolAdded, categories, targetUserId }: AddToolDialogProps) {
  const { user, isStaff } = useAuth();
  const { toast } = useToast();
  
  const [step, setStep] = useState<'category' | 'specs'>('category');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [specifications, setSpecifications] = useState<ToolSpecification[]>([]);
  const [specValues, setSpecValues] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSpecs, setIsLoadingSpecs] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setStep('category');
      setSelectedCategory('');
      setSpecifications([]);
      setSpecValues({});
      setQuantity(1);
      setSearchQuery('');
    }
  }, [open]);

  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) return categories;
    const q = searchQuery.toLowerCase();
    return categories.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.description && c.description.toLowerCase().includes(q))
    );
  }, [categories, searchQuery]);

  // Load specifications when category changes
  useEffect(() => {
    if (selectedCategory) {
      loadSpecifications(selectedCategory);
    }
  }, [selectedCategory]);

  const loadSpecifications = async (categoryId: string) => {
    setIsLoadingSpecs(true);
    try {
      const { data, error } = await supabase
        .from('tool_specifications')
        .select('*')
        .eq('tool_category_id', categoryId)
        .order('display_order');

      if (error) throw error;

      // Parse options from JSONB
      const specs = (data || []).map(spec => ({
        ...spec,
        options: spec.options ? (Array.isArray(spec.options) ? spec.options : JSON.parse(spec.options as string)) : null,
      }));

      setSpecifications(specs);
      
      // Initialize spec values with defaults
      const defaults: Record<string, string> = {};
      specs.forEach(spec => {
        if (spec.options && spec.options.length === 1) {
          defaults[spec.spec_key] = spec.options[0];
        }
      });
      setSpecValues(defaults);
    } catch (error) {
      console.error('Error loading specifications:', error);
    } finally {
      setIsLoadingSpecs(false);
    }
  };

  const generateToolName = (): string => {
    const category = categories.find(c => c.id === selectedCategory);
    if (!category) return '';

    const specParts: string[] = [];
    specifications.forEach(spec => {
      const value = specValues[spec.spec_key];
      if (value) {
        specParts.push(value);
      }
    });

    if (specParts.length > 0) {
      return `${category.name} - ${specParts.join(' / ')}`;
    }
    return category.name;
  };

  const handleCategorySelect = (categoryId: string) => {
    setSelectedCategory(categoryId);
    setStep('specs');
  };

  const handleImageIdentified = (categoryId: string, detectedSpecs: Record<string, string>) => {
    setSelectedCategory(categoryId);
    setStep('specs');
    // Pre-fill detected specs after specs load
    setTimeout(() => {
      setSpecValues(prev => ({ ...prev, ...detectedSpecs }));
    }, 500);
  };

  const handleSpecChange = (key: string, value: string) => {
    setSpecValues(prev => ({ ...prev, [key]: value }));
  };

  const validateSpecs = (): boolean => {
    for (const spec of specifications) {
      if (spec.is_required && !specValues[spec.spec_key]) {
        toast({
          title: 'Campo obrigatório',
          description: `Preencha o campo: ${spec.spec_label}`,
          variant: 'destructive',
        });
        return false;
      }
    }
    return true;
  };

  const handleSubmit = async () => {
    if (!validateSpecs()) return;

    const userId = targetUserId || user?.id;
    if (!userId) return;

    setIsLoading(true);
    try {
      const generatedName = generateToolName();

      const { error } = await supabase.from('user_tools').insert({
        user_id: userId,
        tool_category_id: selectedCategory,
        specifications: specValues,
        generated_name: generatedName,
        quantity,
      });

      if (error) throw error;

      toast({
        title: 'Ferramenta adicionada!',
        description: generatedName,
      });

      onOpenChange(false);
      onToolAdded();
    } catch (error) {
      console.error('Error adding tool:', error);
      toast({
        title: 'Erro ao adicionar',
        description: 'Não foi possível adicionar a ferramenta',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const selectedCategoryData = categories.find(c => c.id === selectedCategory);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md mx-4 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">
            {step === 'category' ? 'Selecione a Ferramenta' : selectedCategoryData?.name}
          </DialogTitle>
        </DialogHeader>

        {step === 'category' && (
          <div className="space-y-3 pt-2">
            {/* Image identification */}
            <ToolImageIdentifier
              categories={categories}
              onCategoryIdentified={handleImageIdentified}
              className="mb-2"
            />

            <div className="relative flex items-center gap-3">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground">ou selecione manualmente</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar ferramenta..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {filteredCategories.length > 0 ? (
                filteredCategories.map((category) => (
                  <button
                    key={category.id}
                    onClick={() => handleCategorySelect(category.id)}
                    className="w-full flex items-center justify-between p-4 rounded-xl border border-border hover:border-primary hover:bg-primary/5 transition-colors text-left"
                  >
                    <div>
                      <p className="font-medium text-foreground">{category.name}</p>
                      {category.description && (
                        <p className="text-sm text-muted-foreground">{category.description}</p>
                      )}
                    </div>
                    <ChevronRight className="w-5 h-5 text-muted-foreground" />
                  </button>
                ))
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Nenhuma ferramenta encontrada para "{searchQuery}"
                </p>
              )}
            </div>
          </div>
        )}

        {step === 'specs' && (
          <div className="space-y-4 pt-2">
            <button
              onClick={() => setStep('category')}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              Voltar
            </button>

            {isLoadingSpecs ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : specifications.length > 0 ? (
              <>
                {specifications.map((spec) => (
                  <div key={spec.id} className="space-y-2">
                    <Label>
                      {spec.spec_label}
                      {spec.is_required && <span className="text-destructive ml-1">*</span>}
                    </Label>
                    {spec.spec_type === 'select' && spec.options ? (
                      <Select 
                        value={specValues[spec.spec_key] || ''} 
                        onValueChange={(v) => handleSpecChange(spec.spec_key, v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Selecione..." />
                        </SelectTrigger>
                        <SelectContent className="bg-popover max-h-60">
                          {spec.options.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={specValues[spec.spec_key] || ''}
                        onChange={(e) => handleSpecChange(spec.spec_key, e.target.value)}
                        placeholder={spec.spec_label}
                      />
                    )}
                  </div>
                ))}

                <div className="space-y-2">
                  <Label>Quantidade</Label>
                  <Input
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                  />
                </div>

                {/* Preview generated name */}
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-1">Nome gerado:</p>
                  <p className="text-sm font-medium text-foreground">{generateToolName()}</p>
                </div>

                <Button
                  className="w-full"
                  onClick={handleSubmit}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4 mr-2" />
                  )}
                  Adicionar Ferramenta
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Esta ferramenta não possui especificações adicionais.
                </p>
                
                <div className="space-y-2">
                  <Label>Quantidade</Label>
                  <Input
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                  />
                </div>

                <Button
                  className="w-full"
                  onClick={handleSubmit}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4 mr-2" />
                  )}
                  Adicionar Ferramenta
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
