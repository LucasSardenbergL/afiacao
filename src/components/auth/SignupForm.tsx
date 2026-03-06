import { useState } from 'react';
import { Loader2, FileText, User, Lock, Eye, EyeOff, MapPin, Phone, Mail, AlertCircle, Factory, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import {
  documentSchema, signupSchema, BRAZILIAN_STATES,
  formatPhone, formatZipCode,
} from './authSchemas';
import type { AuthFormData, OmieClienteData, SignupStep } from './authSchemas';

interface SignupFormProps {
  formData: AuthFormData;
  onInputChange: (field: string, value: string) => void;
  isLoading: boolean;
  onFinalSubmit: (opts: {
    omieCliente: OmieClienteData | null;
    isIndustrial: boolean;
    isEmployee: boolean;
    cnae: string | null;
    selectedTools: string[];
  }) => Promise<void>;
  onSwitchToLogin: () => void;
  toolCategories: { id: string; name: string; description: string; usage_type: string; suggested_interval_days: number }[];
}

export function SignupForm({ formData, onInputChange, isLoading, onFinalSubmit, onSwitchToLogin, toolCategories }: SignupFormProps) {
  const { toast } = useToast();
  const [signupStep, setSignupStep] = useState<SignupStep>('document');
  const [isCheckingDocument, setIsCheckingDocument] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [omieCliente, setOmieCliente] = useState<OmieClienteData | null>(null);
  const [isIndustrial, setIsIndustrial] = useState(false);
  const [isEmployee, setIsEmployee] = useState(false);
  const [cnae, setCnae] = useState<string | null>(null);
  const [cnaeDescricao, setCnaeDescricao] = useState<string | null>(null);
  const [existingUserError, setExistingUserError] = useState(false);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  const filteredTools = toolCategories.filter(tool =>
    tool.usage_type === 'both' ||
    (isIndustrial && tool.usage_type === 'industrial') ||
    (!isIndustrial && tool.usage_type === 'domestic')
  );

  const resetSignup = () => {
    setSignupStep('document');
    setOmieCliente(null);
    setSelectedTools([]);
    setIsIndustrial(false);
    setIsEmployee(false);
    setCnae(null);
    setExistingUserError(false);
    // Reset form fields except document
    ['name', 'tradeName', 'email', 'phone', 'password', 'confirmPassword',
      'street', 'number', 'complement', 'neighborhood', 'city', 'state', 'zipCode',
    ].forEach(f => onInputChange(f, ''));
  };

  const checkDocumentInOmie = async () => {
    try {
      documentSchema.parse({ document: formData.document });
    } catch (error) {
      if (error instanceof z.ZodError) setErrors({ document: error.errors[0].message });
      return;
    }
    setIsCheckingDocument(true);
    setErrors({});
    setExistingUserError(false);
    try {
      const docLimpo = formData.document.replace(/\D/g, '');
      const { data: existingProfile } = await supabase.from('profiles').select('id').eq('document', docLimpo).maybeSingle();
      if (existingProfile) {
        setExistingUserError(true);
        toast({ title: 'Cadastro existente', description: 'Este documento já está cadastrado. Faça login com seu e-mail.', variant: 'destructive' });
        setIsCheckingDocument(false);
        return;
      }
      const { data, error } = await supabase.functions.invoke('omie-cliente', {
        body: { action: 'buscar_por_documento', documento: formData.document },
      });
      if (error) throw error;
      setIsIndustrial(data.isIndustrial || false);
      setIsEmployee(data.isEmployee || false);
      setCnae(data.cnae || null);
      setCnaeDescricao(data.cnaeDescricao || null);
      if (data.isEmployee) {
        toast({ title: 'Funcionário identificado!', description: 'Você terá acesso ao painel administrativo após o cadastro.' });
      }
      if (data.cliente) {
        const cliente = data.cliente as OmieClienteData;
        setOmieCliente(data.found ? cliente : null);
        onInputChange('name', cliente.razao_social || '');
        onInputChange('tradeName', cliente.nome_fantasia || '');
        onInputChange('email', cliente.email || '');
        onInputChange('phone', cliente.telefone ? formatPhone(cliente.telefone) : '');
        onInputChange('street', cliente.endereco || '');
        onInputChange('number', cliente.endereco_numero || '');
        onInputChange('complement', cliente.complemento || '');
        onInputChange('neighborhood', cliente.bairro || '');
        onInputChange('city', cliente.cidade || '');
        onInputChange('state', cliente.estado || '');
        onInputChange('zipCode', cliente.cep ? formatZipCode(cliente.cep) : '');
        toast({ title: data.found ? 'Cliente encontrado!' : 'Dados carregados', description: data.found ? 'Seus dados foram carregados do cadastro existente.' : 'Dados da empresa carregados. Complete o cadastro.' });
      } else {
        setOmieCliente(null);
        toast({ title: 'Novo cadastro', description: 'Preencha seus dados para criar uma conta.' });
      }
      setSignupStep('form');
    } catch (error) {
      console.error('Erro ao verificar documento:', error);
      toast({ title: 'Erro ao verificar documento', description: 'Não foi possível verificar o documento. Tente novamente.', variant: 'destructive' });
    } finally {
      setIsCheckingDocument(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      signupSchema.parse(formData);
      setErrors({});
    } catch (error) {
      if (error instanceof z.ZodError) {
        const newErrors: Record<string, string> = {};
        error.errors.forEach((err) => { if (err.path[0]) newErrors[err.path[0] as string] = err.message; });
        setErrors(newErrors);
        return;
      }
    }
    if (isEmployee) {
      onFinalSubmit({ omieCliente, isIndustrial, isEmployee, cnae, selectedTools });
      return;
    }
    setSignupStep('tools');
  };

  const handleToolToggle = (toolId: string) => {
    setSelectedTools(prev => prev.includes(toolId) ? prev.filter(id => id !== toolId) : [...prev, toolId]);
  };

  const handleFinalSubmit = () => {
    onFinalSubmit({ omieCliente, isIndustrial, isEmployee, cnae, selectedTools });
  };

  return (
    <>
      {(signupStep === 'form' || signupStep === 'tools') && (
        <button type="button" onClick={() => signupStep === 'tools' ? setSignupStep('form') : resetSignup()}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors group">
          <ChevronLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" /> Voltar
        </button>
      )}

      {/* Document Step */}
      {signupStep === 'document' && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="document" className="text-sm font-medium">CPF ou CNPJ</Label>
            <div className="relative mt-1.5">
              <FileText className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input id="document" type="text" placeholder="000.000.000-00" value={formData.document}
                onChange={(e) => onInputChange('document', e.target.value)}
                className={cn('pl-10', errors.document && 'border-destructive')}
                disabled={isCheckingDocument} maxLength={18} />
            </div>
            {errors.document && <p className="text-xs text-destructive mt-1">{errors.document}</p>}
            <p className="text-xs text-muted-foreground mt-2">Verificaremos se você já possui cadastro</p>
          </div>
          {existingUserError && (
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-destructive">Cadastro já existe</p>
                <p className="text-muted-foreground">
                  Este documento já está cadastrado.{' '}
                  <button type="button" onClick={onSwitchToLogin} className="text-primary hover:underline font-medium">Faça login</button>
                </p>
              </div>
            </div>
          )}
          <Button type="button" className="w-full h-12 text-base font-semibold shadow-glow"
            disabled={isCheckingDocument || !formData.document} onClick={checkDocumentInOmie}>
            {isCheckingDocument ? (<><Loader2 className="w-5 h-5 mr-2 animate-spin" />Verificando...</>) : 'Continuar'}
          </Button>
        </div>
      )}

      {/* Form Step */}
      {signupStep === 'form' && (
        <form onSubmit={handleFormSubmit} className="space-y-4">
          <div className="bg-muted/50 rounded-lg p-3 mb-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Documento</p>
                <p className="font-medium">{formData.document}</p>
              </div>
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                <Factory className="w-3 h-3" />Industrial
              </div>
            </div>
            {omieCliente && <p className="text-xs text-primary mt-1">✓ Cliente existente no Omie</p>}
            {cnaeDescricao && <p className="text-xs text-muted-foreground mt-1">CNAE: {cnae} - {cnaeDescricao}</p>}
            <p className="text-xs text-emerald-600 mt-1">✓ Frete gratuito em todos os pedidos</p>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-2"><User className="w-4 h-4" />Dados Pessoais</h3>
            <div>
              <Label htmlFor="name" className="text-sm font-medium">
                {formData.document.replace(/\D/g, '').length > 11 ? 'Razão Social' : 'Nome Completo'} *
              </Label>
              <Input id="name" type="text" placeholder="Nome completo ou razão social" value={formData.name}
                onChange={(e) => onInputChange('name', e.target.value)} className={cn(errors.name && 'border-destructive')} disabled={isLoading} />
              {errors.name && <p className="text-xs text-destructive mt-1">{errors.name}</p>}
            </div>
            {formData.document.replace(/\D/g, '').length > 11 && (
              <div>
                <Label htmlFor="tradeName" className="text-sm font-medium">Nome Fantasia</Label>
                <Input id="tradeName" type="text" placeholder="Nome fantasia" value={formData.tradeName}
                  onChange={(e) => onInputChange('tradeName', e.target.value)} disabled={isLoading} />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="signup-email" className="text-sm font-medium">E-mail *</Label>
                <Input id="signup-email" type="email" placeholder="seu@email.com" value={formData.email}
                  onChange={(e) => onInputChange('email', e.target.value)} className={cn(errors.email && 'border-destructive')} disabled={isLoading} />
                {errors.email && <p className="text-xs text-destructive mt-1">{errors.email}</p>}
              </div>
              <div>
                <Label htmlFor="phone" className="text-sm font-medium">Telefone *</Label>
                <Input id="phone" type="text" placeholder="(00) 00000-0000" value={formData.phone}
                  onChange={(e) => onInputChange('phone', e.target.value)} className={cn(errors.phone && 'border-destructive')} disabled={isLoading} maxLength={15} />
                {errors.phone && <p className="text-xs text-destructive mt-1">{errors.phone}</p>}
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-2"><MapPin className="w-4 h-4" />Endereço</h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Label htmlFor="zipCode" className="text-sm font-medium">CEP *</Label>
                <Input id="zipCode" type="text" placeholder="00000-000" value={formData.zipCode}
                  onChange={(e) => onInputChange('zipCode', e.target.value)} className={cn(errors.zipCode && 'border-destructive')} disabled={isLoading} maxLength={9} />
                {errors.zipCode && <p className="text-xs text-destructive mt-1">{errors.zipCode}</p>}
              </div>
              <div>
                <Label htmlFor="state" className="text-sm font-medium">UF *</Label>
                <select id="state" value={formData.state} onChange={(e) => onInputChange('state', e.target.value)}
                  className={cn('w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring', errors.state && 'border-destructive')} disabled={isLoading}>
                  <option value="">UF</option>
                  {BRAZILIAN_STATES.map(uf => <option key={uf} value={uf}>{uf}</option>)}
                </select>
                {errors.state && <p className="text-xs text-destructive mt-1">{errors.state}</p>}
              </div>
            </div>
            <div>
              <Label htmlFor="street" className="text-sm font-medium">Endereço *</Label>
              <Input id="street" type="text" placeholder="Rua, Avenida..." value={formData.street}
                onChange={(e) => onInputChange('street', e.target.value)} className={cn(errors.street && 'border-destructive')} disabled={isLoading} />
              {errors.street && <p className="text-xs text-destructive mt-1">{errors.street}</p>}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="number" className="text-sm font-medium">Número *</Label>
                <Input id="number" type="text" placeholder="123" value={formData.number}
                  onChange={(e) => onInputChange('number', e.target.value)} className={cn(errors.number && 'border-destructive')} disabled={isLoading} />
                {errors.number && <p className="text-xs text-destructive mt-1">{errors.number}</p>}
              </div>
              <div className="col-span-2">
                <Label htmlFor="complement" className="text-sm font-medium">Complemento</Label>
                <Input id="complement" type="text" placeholder="Apto, Sala..." value={formData.complement}
                  onChange={(e) => onInputChange('complement', e.target.value)} disabled={isLoading} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="neighborhood" className="text-sm font-medium">Bairro *</Label>
                <Input id="neighborhood" type="text" placeholder="Bairro" value={formData.neighborhood}
                  onChange={(e) => onInputChange('neighborhood', e.target.value)} className={cn(errors.neighborhood && 'border-destructive')} disabled={isLoading} />
                {errors.neighborhood && <p className="text-xs text-destructive mt-1">{errors.neighborhood}</p>}
              </div>
              <div>
                <Label htmlFor="city" className="text-sm font-medium">Cidade *</Label>
                <Input id="city" type="text" placeholder="Cidade" value={formData.city}
                  onChange={(e) => onInputChange('city', e.target.value)} className={cn(errors.city && 'border-destructive')} disabled={isLoading} />
                {errors.city && <p className="text-xs text-destructive mt-1">{errors.city}</p>}
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-2"><Lock className="w-4 h-4" />Senha de Acesso</h3>
            <div>
              <Label htmlFor="signup-password" className="text-sm font-medium">Senha *</Label>
              <div className="relative">
                <Input id="signup-password" type={showPassword ? 'text' : 'password'} placeholder="Mínimo 6 caracteres"
                  value={formData.password} onChange={(e) => onInputChange('password', e.target.value)}
                  className={cn('pr-10', errors.password && 'border-destructive')} disabled={isLoading} />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}>
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {errors.password && <p className="text-xs text-destructive mt-1">{errors.password}</p>}
            </div>
            <div>
              <Label htmlFor="confirmPassword" className="text-sm font-medium">Confirmar Senha *</Label>
              <Input id="confirmPassword" type={showPassword ? 'text' : 'password'} placeholder="Repita a senha"
                value={formData.confirmPassword} onChange={(e) => onInputChange('confirmPassword', e.target.value)}
                className={cn(errors.confirmPassword && 'border-destructive')} disabled={isLoading} />
              {errors.confirmPassword && <p className="text-xs text-destructive mt-1">{errors.confirmPassword}</p>}
            </div>
          </div>

          <Button type="submit" className="w-full h-12 text-base font-semibold" disabled={isLoading}>
            Próximo: Selecionar Ferramentas
          </Button>
        </form>
      )}

      {/* Tools Step */}
      {signupStep === 'tools' && (
        <div className="space-y-4">
          <div className="text-center mb-4">
            <div className="w-10 h-10 mx-auto text-primary mb-2 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
            </div>
            <h3 className="font-semibold text-foreground">Suas Ferramentas</h3>
            <p className="text-sm text-muted-foreground">Selecione as ferramentas que você costuma afiar.</p>
          </div>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {filteredTools.map((tool) => (
              <label key={tool.id} className={cn(
                'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all',
                selectedTools.includes(tool.id) ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
              )}>
                <input type="checkbox" className="sr-only" checked={selectedTools.includes(tool.id)} onChange={() => handleToolToggle(tool.id)} />
                <div className={cn('w-4 h-4 rounded border-2 flex items-center justify-center',
                  selectedTools.includes(tool.id) ? 'bg-primary border-primary' : 'border-muted-foreground')}>
                  {selectedTools.includes(tool.id) && <svg className="w-3 h-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                </div>
                <div className="flex-1">
                  <p className="font-medium text-sm">{tool.name}</p>
                  <p className="text-xs text-muted-foreground">{tool.description}</p>
                </div>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground text-center">{selectedTools.length} ferramenta(s) selecionada(s)</p>
          <Button type="button" className="w-full h-12 text-base font-semibold shadow-glow" disabled={isLoading} onClick={handleFinalSubmit}>
            {isLoading ? (<><Loader2 className="w-5 h-5 mr-2 animate-spin" />Cadastrando...</>) : 'Criar Conta'}
          </Button>
          <button type="button" onClick={handleFinalSubmit} className="w-full text-sm text-muted-foreground hover:text-foreground" disabled={isLoading}>
            Pular por agora
          </button>
        </div>
      )}
    </>
  );
}
