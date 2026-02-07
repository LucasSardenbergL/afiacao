import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Loader2, Mail, Lock, User, Eye, EyeOff, FileText, Phone, MapPin, ChevronLeft, Wrench, Check, Factory, Home, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { Checkbox } from '@/components/ui/checkbox';

const loginSchema = z.object({
  email: z.string().email('E-mail inválido'),
  password: z.string().min(6, 'A senha deve ter pelo menos 6 caracteres'),
});

const documentSchema = z.object({
  document: z.string().min(11, 'Informe um CPF ou CNPJ válido').max(18, 'Documento inválido'),
});

const signupSchema = z.object({
  name: z.string().min(2, 'O nome deve ter pelo menos 2 caracteres'),
  tradeName: z.string().optional(),
  email: z.string().email('E-mail inválido'),
  phone: z.string().min(10, 'Telefone inválido'),
  password: z.string().min(6, 'A senha deve ter pelo menos 6 caracteres'),
  confirmPassword: z.string(),
  street: z.string().min(3, 'Endereço é obrigatório'),
  number: z.string().min(1, 'Número é obrigatório'),
  complement: z.string().optional(),
  neighborhood: z.string().min(2, 'Bairro é obrigatório'),
  city: z.string().min(2, 'Cidade é obrigatória'),
  state: z.string().length(2, 'UF deve ter 2 letras'),
  zipCode: z.string().min(8, 'CEP inválido'),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'As senhas não coincidem',
  path: ['confirmPassword'],
});

type AuthMode = 'login' | 'signup';
type SignupStep = 'document' | 'form' | 'tools';

interface OmieClienteData {
  codigo_cliente?: number;
  razao_social?: string;
  nome_fantasia?: string;
  cnpj_cpf?: string;
  email?: string;
  telefone?: string;
  endereco?: string;
  endereco_numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  cep?: string;
  pessoa_fisica?: string;
}

interface ToolCategory {
  id: string;
  name: string;
  description: string;
  icon: string;
  usage_type: string;
  suggested_interval_days: number;
}

const BRAZILIAN_STATES = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 
  'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 
  'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
];

const formatDocument = (value: string): string => {
  const numbers = value.replace(/\D/g, '');
  if (numbers.length <= 11) {
    return numbers
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  } else {
    return numbers
      .replace(/(\d{2})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1/$2')
      .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
  }
};

const formatPhone = (value: string): string => {
  const numbers = value.replace(/\D/g, '');
  if (numbers.length <= 10) {
    return numbers
      .replace(/(\d{2})(\d)/, '($1) $2')
      .replace(/(\d{4})(\d)/, '$1-$2');
  } else {
    return numbers
      .replace(/(\d{2})(\d)/, '($1) $2')
      .replace(/(\d{5})(\d)/, '$1-$2');
  }
};

const formatZipCode = (value: string): string => {
  const numbers = value.replace(/\D/g, '');
  return numbers.replace(/(\d{5})(\d)/, '$1-$2');
};

const Auth = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading, signIn } = useAuth();
  const { toast } = useToast();
  
  const [mode, setMode] = useState<AuthMode>('login');
  const [signupStep, setSignupStep] = useState<SignupStep>('document');
  const [isLoading, setIsLoading] = useState(false);
  const [isCheckingDocument, setIsCheckingDocument] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [omieCliente, setOmieCliente] = useState<OmieClienteData | null>(null);
  const [documentChecked, setDocumentChecked] = useState(false);
  const [isIndustrial, setIsIndustrial] = useState(false);
  const [cnae, setCnae] = useState<string | null>(null);
  const [cnaeDescricao, setCnaeDescricao] = useState<string | null>(null);
  const [toolCategories, setToolCategories] = useState<ToolCategory[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [existingUserError, setExistingUserError] = useState(false);
  
  const [formData, setFormData] = useState({
    document: '',
    name: '',
    tradeName: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
    street: '',
    number: '',
    complement: '',
    neighborhood: '',
    city: '',
    state: '',
    zipCode: '',
  });

  // Redirect if already authenticated
  useEffect(() => {
    if (user && !authLoading) {
      navigate('/', { replace: true });
    }
  }, [user, authLoading, navigate]);

  // Load tool categories
  useEffect(() => {
    const loadToolCategories = async () => {
      const { data } = await supabase
        .from('tool_categories')
        .select('*')
        .order('name');
      if (data) {
        setToolCategories(data);
      }
    };
    loadToolCategories();
  }, []);

  const handleInputChange = (field: string, value: string) => {
    let formattedValue = value;
    
    if (field === 'document') {
      formattedValue = formatDocument(value);
    } else if (field === 'phone') {
      formattedValue = formatPhone(value);
    } else if (field === 'zipCode') {
      formattedValue = formatZipCode(value);
    } else if (field === 'state') {
      formattedValue = value.toUpperCase().slice(0, 2);
    }
    
    setFormData((prev) => ({ ...prev, [field]: formattedValue }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  const checkDocumentInOmie = async () => {
    try {
      documentSchema.parse({ document: formData.document });
    } catch (error) {
      if (error instanceof z.ZodError) {
        setErrors({ document: error.errors[0].message });
      }
      return;
    }

    setIsCheckingDocument(true);
    setErrors({});
    setExistingUserError(false);

    try {
      // Primeiro verificar se já existe usuário com este documento no app
      const docLimpo = formData.document.replace(/\D/g, '');
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('document', docLimpo)
        .maybeSingle();

      if (existingProfile) {
        setExistingUserError(true);
        toast({
          title: 'Cadastro existente',
          description: 'Este documento já está cadastrado. Faça login com seu e-mail.',
          variant: 'destructive',
        });
        setIsCheckingDocument(false);
        return;
      }

      const { data, error } = await supabase.functions.invoke('omie-cliente', {
        body: {
          action: 'buscar_por_documento',
          documento: formData.document,
        },
      });

      if (error) throw error;

      // Set industrial flag based on CNAE
      setIsIndustrial(data.isIndustrial || false);
      setCnae(data.cnae || null);
      setCnaeDescricao(data.cnaeDescricao || null);

      if (data.cliente) {
        const cliente = data.cliente as OmieClienteData;
        setOmieCliente(data.found ? cliente : null);
        setFormData(prev => ({
          ...prev,
          name: cliente.razao_social || '',
          tradeName: cliente.nome_fantasia || '',
          email: cliente.email || '',
          phone: cliente.telefone ? formatPhone(cliente.telefone) : '',
          street: cliente.endereco || '',
          number: cliente.endereco_numero || '',
          complement: cliente.complemento || '',
          neighborhood: cliente.bairro || '',
          city: cliente.cidade || '',
          state: cliente.estado || '',
          zipCode: cliente.cep ? formatZipCode(cliente.cep) : '',
        }));
        toast({
          title: data.found ? 'Cliente encontrado!' : 'Dados carregados',
          description: data.found 
            ? 'Seus dados foram carregados do cadastro existente.' 
            : 'Dados da empresa carregados. Complete o cadastro.',
        });
      } else {
        setOmieCliente(null);
        toast({
          title: 'Novo cadastro',
          description: 'Preencha seus dados para criar uma conta.',
        });
      }

      setDocumentChecked(true);
      setSignupStep('form');
    } catch (error) {
      console.error('Erro ao verificar documento:', error);
      toast({
        title: 'Erro ao verificar documento',
        description: 'Não foi possível verificar o documento. Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setIsCheckingDocument(false);
    }
  };

  const validateForm = (): boolean => {
    try {
      if (mode === 'login') {
        loginSchema.parse({ email: formData.email, password: formData.password });
      } else {
        signupSchema.parse(formData);
      }
      setErrors({});
      return true;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const newErrors: Record<string, string> = {};
        error.errors.forEach((err) => {
          if (err.path[0]) {
            newErrors[err.path[0] as string] = err.message;
          }
        });
        setErrors(newErrors);
      }
      return false;
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) return;
    
    // Go to tools selection
    setSignupStep('tools');
  };

  const handleToolToggle = (toolId: string) => {
    setSelectedTools(prev => 
      prev.includes(toolId) 
        ? prev.filter(id => id !== toolId)
        : [...prev, toolId]
    );
  };

  const handleFinalSubmit = async () => {
    setIsLoading(true);

    try {
      if (mode === 'login') {
        const { error } = await signIn(formData.email, formData.password);
        
        if (error) {
          if (error.message.includes('Invalid login credentials')) {
            toast({
              title: 'Erro ao entrar',
              description: 'E-mail ou senha incorretos',
              variant: 'destructive',
            });
          } else if (error.message.includes('Email not confirmed')) {
            toast({
              title: 'E-mail não confirmado',
              description: 'Verifique sua caixa de entrada para confirmar seu e-mail',
              variant: 'destructive',
            });
          } else {
            toast({
              title: 'Erro ao entrar',
              description: error.message,
              variant: 'destructive',
            });
          }
          return;
        }

        toast({
          title: 'Bem-vindo!',
          description: 'Login realizado com sucesso',
        });
        navigate('/', { replace: true });
      } else {
        // Signup flow
        const redirectUrl = `${window.location.origin}/`;
        
        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
          email: formData.email,
          password: formData.password,
          options: {
            emailRedirectTo: redirectUrl,
            data: {
              name: formData.name,
            },
          },
        });

        if (signUpError) {
          if (signUpError.message.includes('User already registered')) {
            toast({
              title: 'E-mail já cadastrado',
              description: 'Este e-mail já está em uso. Tente fazer login.',
              variant: 'destructive',
            });
          } else {
            toast({
              title: 'Erro ao cadastrar',
              description: signUpError.message,
              variant: 'destructive',
            });
          }
          return;
        }

        if (signUpData.user) {
          // Create profile with customer type
          await supabase.from('profiles').insert({
            user_id: signUpData.user.id,
            name: formData.name,
            email: formData.email,
            phone: formData.phone.replace(/\D/g, ''),
            document: formData.document.replace(/\D/g, ''),
            customer_type: isIndustrial ? 'industrial' : 'domestic',
            cnae: cnae,
          });

          // Create default address from Omie
          await supabase.from('addresses').insert({
            user_id: signUpData.user.id,
            label: 'Principal',
            street: formData.street,
            number: formData.number,
            complement: formData.complement || null,
            neighborhood: formData.neighborhood,
            city: formData.city,
            state: formData.state,
            zip_code: formData.zipCode.replace(/\D/g, ''),
            is_default: true,
            is_from_omie: true,
          });

          // Save user's selected tools
          if (selectedTools.length > 0) {
            const toolsToInsert = selectedTools.map(toolCategoryId => {
              const category = toolCategories.find(c => c.id === toolCategoryId);
              return {
                user_id: signUpData.user!.id,
                tool_category_id: toolCategoryId,
                sharpening_interval_days: category?.suggested_interval_days || 90,
              };
            });
            await supabase.from('user_tools').insert(toolsToInsert);
          }

          // If we found an Omie client, save the mapping
          if (omieCliente?.codigo_cliente) {
            await supabase.from('omie_clientes').insert({
              user_id: signUpData.user.id,
              omie_codigo_cliente: omieCliente.codigo_cliente,
              omie_codigo_cliente_integracao: `APP_${signUpData.user.id.substring(0, 8)}`,
            });
          }
        }

        toast({
          title: 'Conta criada!',
          description: 'Verifique seu e-mail para confirmar o cadastro',
        });
        setMode('login');
        setSignupStep('document');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;
    
    setIsLoading(true);
    try {
      const { error } = await signIn(formData.email, formData.password);
      
      if (error) {
        if (error.message.includes('Invalid login credentials')) {
          toast({
            title: 'Erro ao entrar',
            description: 'E-mail ou senha incorretos',
            variant: 'destructive',
          });
        } else if (error.message.includes('Email not confirmed')) {
          toast({
            title: 'E-mail não confirmado',
            description: 'Verifique sua caixa de entrada para confirmar seu e-mail',
            variant: 'destructive',
          });
        } else {
          toast({
            title: 'Erro ao entrar',
            description: error.message,
            variant: 'destructive',
          });
        }
        return;
      }

      toast({
        title: 'Bem-vindo!',
        description: 'Login realizado com sucesso',
      });
      navigate('/', { replace: true });
    } finally {
      setIsLoading(false);
    }
  };

  const resetSignup = () => {
    setSignupStep('document');
    setDocumentChecked(false);
    setOmieCliente(null);
    setSelectedTools([]);
    setIsIndustrial(false);
    setCnae(null);
    setExistingUserError(false);
    setFormData({
      document: formData.document,
      name: '',
      tradeName: '',
      email: '',
      phone: '',
      password: '',
      confirmPassword: '',
      street: '',
      number: '',
      complement: '',
      neighborhood: '',
      city: '',
      state: '',
      zipCode: '',
    });
  };

  // Filter tools based on customer type
  const filteredTools = toolCategories.filter(tool => 
    tool.usage_type === 'both' || 
    (isIndustrial && tool.usage_type === 'industrial') ||
    (!isIndustrial && tool.usage_type === 'domestic')
  );

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Carregando...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header decorativo */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-gradient-radial from-primary/10 via-primary/5 to-transparent rounded-full blur-3xl -translate-y-1/2" />
      </div>
      
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 relative z-10">
        <div className="w-full max-w-md">
          {/* Logo/Brand */}
          <div className="text-center mb-8 animate-fade-in">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-primary shadow-glow mb-4">
              <Wrench className="w-8 h-8 text-primary-foreground" />
            </div>
            <h1 className="font-display font-bold text-4xl text-foreground tracking-tight mb-2">
              Colacor
            </h1>
            <p className="text-muted-foreground text-lg">
              {mode === 'login' 
                ? 'Bem-vindo de volta!' 
                : signupStep === 'document' 
                  ? 'Vamos começar' 
                  : signupStep === 'form'
                    ? 'Complete seu cadastro'
                    : 'Suas ferramentas'}
            </p>
          </div>

          {/* Auth Card */}
          <div className="bg-card rounded-2xl shadow-strong border border-border p-6 animate-fade-in" style={{ animationDelay: '0.1s' }}>
          {/* Mode Toggle - only show on login or document step */}
          {(mode === 'login' || signupStep === 'document') && (
            <div className="flex gap-2 mb-6 p-1 bg-muted rounded-xl">
              <button
                type="button"
                onClick={() => { setMode('login'); setSignupStep('document'); setExistingUserError(false); }}
                className={cn(
                  'flex-1 py-2.5 rounded-lg font-semibold text-sm transition-all',
                  mode === 'login'
                    ? 'bg-card text-foreground shadow-medium'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Entrar
              </button>
              <button
                type="button"
                onClick={() => { setMode('signup'); setSignupStep('document'); setExistingUserError(false); }}
                className={cn(
                  'flex-1 py-2.5 rounded-lg font-semibold text-sm transition-all',
                  mode === 'signup'
                    ? 'bg-card text-foreground shadow-medium'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Cadastrar
              </button>
            </div>
          )}

          {mode === 'signup' && (signupStep === 'form' || signupStep === 'tools') && (
            <button
              type="button"
              onClick={() => signupStep === 'tools' ? setSignupStep('form') : resetSignup()}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors group"
            >
              <ChevronLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
              Voltar
            </button>
          )}

          {/* Login Form */}
          {mode === 'login' && (
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <Label htmlFor="email" className="text-sm font-medium">
                  E-mail
                </Label>
                <div className="relative mt-1.5">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="seu@email.com"
                    value={formData.email}
                    onChange={(e) => handleInputChange('email', e.target.value)}
                    className={cn('pl-10', errors.email && 'border-destructive')}
                    disabled={isLoading}
                  />
                </div>
                {errors.email && (
                  <p className="text-xs text-destructive mt-1">{errors.email}</p>
                )}
              </div>

              <div>
                <Label htmlFor="password" className="text-sm font-medium">
                  Senha
                </Label>
                <div className="relative mt-1.5">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={formData.password}
                    onChange={(e) => handleInputChange('password', e.target.value)}
                    className={cn('pl-10 pr-10', errors.password && 'border-destructive')}
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {errors.password && (
                  <p className="text-xs text-destructive mt-1">{errors.password}</p>
                )}
              </div>

              <Button type="submit" className="w-full h-12 text-base font-semibold shadow-glow" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Entrando...
                  </>
                ) : (
                  'Entrar'
                )}
              </Button>
            </form>
          )}

          {/* Signup - Document Step */}
          {mode === 'signup' && signupStep === 'document' && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="document" className="text-sm font-medium">
                  CPF ou CNPJ
                </Label>
                <div className="relative mt-1.5">
                  <FileText className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="document"
                    type="text"
                    placeholder="000.000.000-00"
                    value={formData.document}
                    onChange={(e) => handleInputChange('document', e.target.value)}
                    className={cn('pl-10', errors.document && 'border-destructive')}
                    disabled={isCheckingDocument}
                    maxLength={18}
                  />
                </div>
                {errors.document && (
                  <p className="text-xs text-destructive mt-1">{errors.document}</p>
                )}
                <p className="text-xs text-muted-foreground mt-2">
                  Verificaremos se você já possui cadastro
                </p>
              </div>

              {existingUserError && (
                <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
                  <div className="text-sm">
                    <p className="font-medium text-destructive">Cadastro já existe</p>
                    <p className="text-muted-foreground">
                      Este documento já está cadastrado.{' '}
                      <button 
                        type="button"
                        onClick={() => setMode('login')}
                        className="text-primary hover:underline font-medium"
                      >
                        Faça login
                      </button>
                    </p>
                  </div>
                </div>
              )}

              <Button 
                type="button" 
                className="w-full h-12 text-base font-semibold shadow-glow" 
                disabled={isCheckingDocument || !formData.document}
                onClick={checkDocumentInOmie}
              >
                {isCheckingDocument ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Verificando...
                  </>
                ) : (
                  'Continuar'
                )}
              </Button>
            </div>
          )}

          {/* Signup - Form Step */}
          {mode === 'signup' && signupStep === 'form' && (
            <form onSubmit={handleFormSubmit} className="space-y-4">
              {/* Document display with customer type */}
              <div className="bg-muted/50 rounded-lg p-3 mb-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Documento</p>
                    <p className="font-medium">{formData.document}</p>
                  </div>
                  <div className={cn(
                    'flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium',
                    isIndustrial 
                      ? 'bg-amber-100 text-amber-800' 
                      : 'bg-blue-100 text-blue-800'
                  )}>
                    {isIndustrial ? <Factory className="w-3 h-3" /> : <Home className="w-3 h-3" />}
                    {isIndustrial ? 'Industrial' : 'Doméstico'}
                  </div>
                </div>
                {omieCliente && (
                  <p className="text-xs text-primary mt-1">✓ Cliente existente no Omie</p>
                )}
                {cnaeDescricao && (
                  <p className="text-xs text-muted-foreground mt-1">
                    CNAE: {cnae} - {cnaeDescricao}
                  </p>
                )}
                {isIndustrial && (
                  <p className="text-xs text-green-600 mt-1">✓ Frete gratuito para cliente industrial</p>
                )}
              </div>

              {/* Personal/Company Info */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
                  <User className="w-4 h-4" />
                  Dados Pessoais
                </h3>

                <div>
                  <Label htmlFor="name" className="text-sm font-medium">
                    {formData.document.replace(/\D/g, '').length > 11 ? 'Razão Social' : 'Nome Completo'} *
                  </Label>
                  <Input
                    id="name"
                    type="text"
                    placeholder="Nome completo ou razão social"
                    value={formData.name}
                    onChange={(e) => handleInputChange('name', e.target.value)}
                    className={cn(errors.name && 'border-destructive')}
                    disabled={isLoading}
                  />
                  {errors.name && (
                    <p className="text-xs text-destructive mt-1">{errors.name}</p>
                  )}
                </div>

                {formData.document.replace(/\D/g, '').length > 11 && (
                  <div>
                    <Label htmlFor="tradeName" className="text-sm font-medium">
                      Nome Fantasia
                    </Label>
                    <Input
                      id="tradeName"
                      type="text"
                      placeholder="Nome fantasia"
                      value={formData.tradeName}
                      onChange={(e) => handleInputChange('tradeName', e.target.value)}
                      disabled={isLoading}
                    />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="email" className="text-sm font-medium">
                      E-mail *
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="seu@email.com"
                      value={formData.email}
                      onChange={(e) => handleInputChange('email', e.target.value)}
                      className={cn(errors.email && 'border-destructive')}
                      disabled={isLoading}
                    />
                    {errors.email && (
                      <p className="text-xs text-destructive mt-1">{errors.email}</p>
                    )}
                  </div>

                  <div>
                    <Label htmlFor="phone" className="text-sm font-medium">
                      Telefone *
                    </Label>
                    <Input
                      id="phone"
                      type="text"
                      placeholder="(00) 00000-0000"
                      value={formData.phone}
                      onChange={(e) => handleInputChange('phone', e.target.value)}
                      className={cn(errors.phone && 'border-destructive')}
                      disabled={isLoading}
                      maxLength={15}
                    />
                    {errors.phone && (
                      <p className="text-xs text-destructive mt-1">{errors.phone}</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Address */}
              <div className="space-y-3 pt-2">
                <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
                  <MapPin className="w-4 h-4" />
                  Endereço
                </h3>

                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <Label htmlFor="zipCode" className="text-sm font-medium">
                      CEP *
                    </Label>
                    <Input
                      id="zipCode"
                      type="text"
                      placeholder="00000-000"
                      value={formData.zipCode}
                      onChange={(e) => handleInputChange('zipCode', e.target.value)}
                      className={cn(errors.zipCode && 'border-destructive')}
                      disabled={isLoading}
                      maxLength={9}
                    />
                    {errors.zipCode && (
                      <p className="text-xs text-destructive mt-1">{errors.zipCode}</p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="state" className="text-sm font-medium">
                      UF *
                    </Label>
                    <select
                      id="state"
                      value={formData.state}
                      onChange={(e) => handleInputChange('state', e.target.value)}
                      className={cn(
                        'w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring',
                        errors.state && 'border-destructive'
                      )}
                      disabled={isLoading}
                    >
                      <option value="">UF</option>
                      {BRAZILIAN_STATES.map(uf => (
                        <option key={uf} value={uf}>{uf}</option>
                      ))}
                    </select>
                    {errors.state && (
                      <p className="text-xs text-destructive mt-1">{errors.state}</p>
                    )}
                  </div>
                </div>

                <div>
                  <Label htmlFor="street" className="text-sm font-medium">
                    Endereço *
                  </Label>
                  <Input
                    id="street"
                    type="text"
                    placeholder="Rua, Avenida..."
                    value={formData.street}
                    onChange={(e) => handleInputChange('street', e.target.value)}
                    className={cn(errors.street && 'border-destructive')}
                    disabled={isLoading}
                  />
                  {errors.street && (
                    <p className="text-xs text-destructive mt-1">{errors.street}</p>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label htmlFor="number" className="text-sm font-medium">
                      Número *
                    </Label>
                    <Input
                      id="number"
                      type="text"
                      placeholder="123"
                      value={formData.number}
                      onChange={(e) => handleInputChange('number', e.target.value)}
                      className={cn(errors.number && 'border-destructive')}
                      disabled={isLoading}
                    />
                    {errors.number && (
                      <p className="text-xs text-destructive mt-1">{errors.number}</p>
                    )}
                  </div>
                  <div className="col-span-2">
                    <Label htmlFor="complement" className="text-sm font-medium">
                      Complemento
                    </Label>
                    <Input
                      id="complement"
                      type="text"
                      placeholder="Apto, Sala..."
                      value={formData.complement}
                      onChange={(e) => handleInputChange('complement', e.target.value)}
                      disabled={isLoading}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="neighborhood" className="text-sm font-medium">
                      Bairro *
                    </Label>
                    <Input
                      id="neighborhood"
                      type="text"
                      placeholder="Bairro"
                      value={formData.neighborhood}
                      onChange={(e) => handleInputChange('neighborhood', e.target.value)}
                      className={cn(errors.neighborhood && 'border-destructive')}
                      disabled={isLoading}
                    />
                    {errors.neighborhood && (
                      <p className="text-xs text-destructive mt-1">{errors.neighborhood}</p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="city" className="text-sm font-medium">
                      Cidade *
                    </Label>
                    <Input
                      id="city"
                      type="text"
                      placeholder="Cidade"
                      value={formData.city}
                      onChange={(e) => handleInputChange('city', e.target.value)}
                      className={cn(errors.city && 'border-destructive')}
                      disabled={isLoading}
                    />
                    {errors.city && (
                      <p className="text-xs text-destructive mt-1">{errors.city}</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Password */}
              <div className="space-y-3 pt-2">
                <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
                  <Lock className="w-4 h-4" />
                  Senha de Acesso
                </h3>

                <div>
                  <Label htmlFor="password" className="text-sm font-medium">
                    Senha *
                  </Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Mínimo 6 caracteres"
                      value={formData.password}
                      onChange={(e) => handleInputChange('password', e.target.value)}
                      className={cn('pr-10', errors.password && 'border-destructive')}
                      disabled={isLoading}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {errors.password && (
                    <p className="text-xs text-destructive mt-1">{errors.password}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="confirmPassword" className="text-sm font-medium">
                    Confirmar Senha *
                  </Label>
                  <Input
                    id="confirmPassword"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Repita a senha"
                    value={formData.confirmPassword}
                    onChange={(e) => handleInputChange('confirmPassword', e.target.value)}
                    className={cn(errors.confirmPassword && 'border-destructive')}
                    disabled={isLoading}
                  />
                  {errors.confirmPassword && (
                    <p className="text-xs text-destructive mt-1">{errors.confirmPassword}</p>
                  )}
                </div>
              </div>

              <Button type="submit" className="w-full h-12 text-base font-semibold" disabled={isLoading}>
                Próximo: Selecionar Ferramentas
              </Button>
            </form>
          )}

          {/* Signup - Tools Selection Step */}
          {mode === 'signup' && signupStep === 'tools' && (
            <div className="space-y-4">
              <div className="text-center mb-4">
                <Wrench className="w-10 h-10 mx-auto text-primary mb-2" />
                <h3 className="font-semibold text-foreground">Suas Ferramentas</h3>
                <p className="text-sm text-muted-foreground">
                  Selecione as ferramentas que você costuma afiar. Iremos lembrar você quando chegar a hora!
                </p>
              </div>

              <div className="space-y-2 max-h-64 overflow-y-auto">
                {filteredTools.map((tool) => (
                  <label
                    key={tool.id}
                    className={cn(
                      'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all',
                      selectedTools.includes(tool.id)
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    )}
                  >
                    <Checkbox
                      checked={selectedTools.includes(tool.id)}
                      onCheckedChange={() => handleToolToggle(tool.id)}
                    />
                    <div className="flex-1">
                      <p className="font-medium text-sm">{tool.name}</p>
                      <p className="text-xs text-muted-foreground">{tool.description}</p>
                    </div>
                    {selectedTools.includes(tool.id) && (
                      <Check className="w-4 h-4 text-primary" />
                    )}
                  </label>
                ))}
              </div>

              <p className="text-xs text-muted-foreground text-center">
                {selectedTools.length} ferramenta(s) selecionada(s)
              </p>

              <Button 
                type="button" 
                className="w-full h-12 text-base font-semibold shadow-glow" 
                disabled={isLoading}
                onClick={handleFinalSubmit}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Cadastrando...
                  </>
                ) : (
                  'Criar Conta'
                )}
              </Button>

              <button
                type="button"
                onClick={handleFinalSubmit}
                className="w-full text-sm text-muted-foreground hover:text-foreground"
                disabled={isLoading}
              >
                Pular por agora
              </button>
            </div>
          )}
          </div>

          {/* Footer */}
          <p className="text-center text-sm text-muted-foreground mt-6 animate-fade-in" style={{ animationDelay: '0.2s' }}>
            {mode === 'login' ? (
              <>
                Não tem uma conta?{' '}
                <button
                  type="button"
                  onClick={() => { setMode('signup'); setSignupStep('document'); }}
                  className="text-primary hover:underline font-semibold"
                >
                  Cadastre-se
                </button>
              </>
            ) : (
              <>
                Já tem uma conta?{' '}
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className="text-primary hover:underline font-semibold"
                >
                  Faça login
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
};

export default Auth;
