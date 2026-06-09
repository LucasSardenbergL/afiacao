import { useState, useEffect, useMemo, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { Loader2, Plus, ChevronRight, ChevronLeft, Search } from 'lucide-react';
import { ToolImageIdentifier } from '@/components/ToolImageIdentifier';
import { normalizarOpcaoSpec } from '@/lib/tools/spec-option';

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
  is_required: boolean | null;
  display_order: number | null;
  allow_custom_option: boolean | null;
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

  const [step, setStep] = useState<'category' | 'specs'>('category');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [specifications, setSpecifications] = useState<ToolSpecification[]>([]);
  const [specValues, setSpecValues] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSpecs, setIsLoadingSpecs] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [addingForId, setAddingForId] = useState<string | null>(null);
  const [novoValor, setNovoValor] = useState('');
  const [savingOption, setSavingOption] = useState(false);
  const reqIdRef = useRef(0);
  // ref espelha a categoria atual: o guard de resposta obsoleta NÃO pode comparar
  // contra `selectedCategory` do closure de handleSaveOption (ficaria preso no valor
  // de quando a função foi criada → o guard nunca observaria a troca de categoria).
  const selectedCategoryRef = useRef(selectedCategory);
  selectedCategoryRef.current = selectedCategory;

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setStep('category');
      setSelectedCategory('');
      setSpecifications([]);
      setSpecValues({});
      setQuantity(1);
      setSearchQuery('');
      setAddingForId(null);
      setNovoValor('');
      setSavingOption(false);
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
    setAddingForId(null);
    setNovoValor('');
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
        allow_custom_option: (spec as { allow_custom_option?: boolean | null }).allow_custom_option ?? true,
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
        toast.error('Campo obrigatório', {
          description: `Preencha o campo: ${spec.spec_label}`,
        });
        return false;
      }
    }
    return true;
  };

  const handleSaveOption = async (spec: ToolSpecification) => {
    const norm = normalizarOpcaoSpec(novoValor);
    if (!norm) {
      toast.error('Medida inválida', { description: 'Digite um valor válido (até 60 caracteres).' });
      return;
    }
    const myReq = ++reqIdRef.current;
    const reqCategoria = selectedCategory;
    setSavingOption(true);
    try {
      const { data, error } = await supabase
        .rpc('adicionar_opcao_tool_spec' as never, { p_spec_id: spec.id, p_valor: novoValor } as never);
      if (error) throw error;
      // descarta resposta obsoleta (trocou de categoria/spec no meio)
      if (myReq !== reqIdRef.current || reqCategoria !== selectedCategoryRef.current) return;
      const resp = data as { options: string[]; valor_canonico: string } | null;
      if (!resp) throw new Error('Resposta vazia do servidor');
      setSpecifications(prev => prev.map(s => (s.id === spec.id ? { ...s, options: resp.options } : s)));
      setSpecValues(prev => ({ ...prev, [spec.spec_key]: resp.valor_canonico }));
      setAddingForId(null);
      setNovoValor('');
      toast.success('Medida adicionada', { description: resp.valor_canonico });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Não foi possível adicionar a medida';
      toast.error('Erro ao adicionar medida', { description: msg });
    } finally {
      if (myReq === reqIdRef.current) setSavingOption(false);
    }
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

      toast.success('Ferramenta adicionada!', {
        description: generatedName,
      });

      onOpenChange(false);
      onToolAdded();
    } catch (error) {
      console.error('Error adding tool:', error);
      toast.error('Erro ao adicionar', {
        description: 'Não foi possível adicionar a ferramenta',
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
                      addingForId === spec.id ? (
                        <div className="space-y-2">
                          <Input
                            autoFocus
                            value={novoValor}
                            onChange={(e) => setNovoValor(e.target.value)}
                            placeholder={`Nova medida para ${spec.spec_label}`}
                            maxLength={60}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); handleSaveOption(spec); }
                              if (e.key === 'Escape') { setAddingForId(null); setNovoValor(''); }
                            }}
                          />
                          <p className="text-xs text-muted-foreground">
                            Isto adiciona ao catálogo permanente desta ferramenta.
                          </p>
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => handleSaveOption(spec)} disabled={savingOption}>
                              {savingOption && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                              Salvar
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setAddingForId(null); setNovoValor(''); }}
                              disabled={savingOption}
                            >
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
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
                          {isStaff && spec.allow_custom_option && (
                            <button
                              type="button"
                              onClick={() => { setAddingForId(spec.id); setNovoValor(''); }}
                              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                              + Não está na lista? Adicionar…
                            </button>
                          )}
                        </>
                      )
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
                  disabled={isLoading || savingOption}
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
