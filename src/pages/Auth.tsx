import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Loader2, Mail, Lock, User, Eye, EyeOff, FileText, Phone, MapPin, Building, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';

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
  // Address fields
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
type SignupStep = 'document' | 'form';

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

const BRAZILIAN_STATES = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 
  'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 
  'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
];

// Formatação de CPF/CNPJ
const formatDocument = (value: string): string => {
  const numbers = value.replace(/\D/g, '');
  if (numbers.length <= 11) {
    // CPF: 000.000.000-00
    return numbers
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  } else {
    // CNPJ: 00.000.000/0000-00
    return numbers
      .replace(/(\d{2})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1/$2')
      .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
  }
};

// Formatação de telefone
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

// Formatação de CEP
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

  const handleInputChange = (field: string, value: string) => {
    let formattedValue = value;
    
    // Apply formatting
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
    // Clear error when user types
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

    try {
      const { data, error } = await supabase.functions.invoke('omie-cliente', {
        body: {
          action: 'buscar_por_documento',
          documento: formData.document,
        },
      });

      if (error) throw error;

      if (data.found && data.cliente) {
        // Cliente encontrado no Omie - preencher dados
        const cliente = data.cliente as OmieClienteData;
        setOmieCliente(cliente);
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
          title: 'Cliente encontrado!',
          description: 'Seus dados foram carregados do cadastro existente.',
        });
      } else {
        // Cliente não encontrado - formulário vazio
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) return;
    
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

        // Create profile with all data
        if (signUpData.user) {
          await supabase.from('profiles').insert({
            user_id: signUpData.user.id,
            name: formData.name,
            email: formData.email,
            phone: formData.phone.replace(/\D/g, ''),
            document: formData.document.replace(/\D/g, ''),
          });

          // Create default address
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
          });

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

  const resetSignup = () => {
    setSignupStep('document');
    setDocumentChecked(false);
    setOmieCliente(null);
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

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-md">
        {/* Logo/Brand */}
        <div className="text-center mb-6">
          <h1 className="font-display font-bold text-3xl text-primary mb-2">
            Afiação Express
          </h1>
          <p className="text-muted-foreground">
            {mode === 'login' 
              ? 'Entre na sua conta' 
              : signupStep === 'document' 
                ? 'Informe seu CPF ou CNPJ' 
                : 'Complete seu cadastro'}
          </p>
        </div>

        {/* Auth Card */}
        <div className="bg-card rounded-2xl shadow-soft border border-border p-6">
          {/* Mode Toggle - only show on login or document step */}
          {(mode === 'login' || signupStep === 'document') && (
            <div className="flex gap-2 mb-6">
              <button
                type="button"
                onClick={() => { setMode('login'); setSignupStep('document'); }}
                className={cn(
                  'flex-1 py-2 rounded-lg font-medium text-sm transition-all',
                  mode === 'login'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                )}
              >
                Entrar
              </button>
              <button
                type="button"
                onClick={() => { setMode('signup'); setSignupStep('document'); }}
                className={cn(
                  'flex-1 py-2 rounded-lg font-medium text-sm transition-all',
                  mode === 'signup'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                )}
              >
                Cadastrar
              </button>
            </div>
          )}

          {/* Back button for signup form step */}
          {mode === 'signup' && signupStep === 'form' && (
            <button
              type="button"
              onClick={resetSignup}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
            >
              <ChevronLeft className="w-4 h-4" />
              Voltar
            </button>
          )}

          {/* Login Form */}
          {mode === 'login' && (
            <form onSubmit={handleSubmit} className="space-y-4">
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

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
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

              <Button 
                type="button" 
                className="w-full" 
                disabled={isCheckingDocument || !formData.document}
                onClick={checkDocumentInOmie}
              >
                {isCheckingDocument ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
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
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Document display */}
              <div className="bg-muted/50 rounded-lg p-3 mb-2">
                <p className="text-xs text-muted-foreground">Documento</p>
                <p className="font-medium">{formData.document}</p>
                {omieCliente && (
                  <p className="text-xs text-primary mt-1">✓ Cliente existente no sistema</p>
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

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Cadastrando...
                  </>
                ) : (
                  'Criar Conta'
                )}
              </Button>
            </form>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-sm text-muted-foreground mt-6">
          {mode === 'login' ? (
            <>
              Não tem uma conta?{' '}
              <button
                type="button"
                onClick={() => { setMode('signup'); setSignupStep('document'); }}
                className="text-primary hover:underline font-medium"
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
                className="text-primary hover:underline font-medium"
              >
                Faça login
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
};

export default Auth;
