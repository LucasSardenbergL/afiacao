import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Wrench } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { LoginForm } from '@/components/auth/LoginForm';
import { SignupForm } from '@/components/auth/SignupForm';
import { handleInputFormat, INITIAL_FORM_DATA } from '@/components/auth/authSchemas';
import type { AuthMode, AuthFormData, OmieClienteData, ToolCategory } from '@/components/auth/authSchemas';

const Auth = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading, signIn } = useAuth();
  const { toast } = useToast();

  const [mode, setMode] = useState<AuthMode>('login');
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState<AuthFormData>({ ...INITIAL_FORM_DATA });
  const [toolCategories, setToolCategories] = useState<ToolCategory[]>([]);

  useEffect(() => {
    if (user && !authLoading) navigate('/', { replace: true });
  }, [user, authLoading, navigate]);

  useEffect(() => {
    const loadToolCategories = async () => {
      const { data } = await supabase.from('tool_categories').select('*').order('name');
      if (data) setToolCategories(data);
    };
    loadToolCategories();
  }, []);

  const handleInputChange = (field: string, value: string) => {
    const formattedValue = handleInputFormat(field, value);
    setFormData(prev => ({ ...prev, [field]: formattedValue }));
  };

  const handleLogin = async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const { error } = await signIn(email, password);
      if (error) {
        if (error.message.includes('Invalid login credentials')) {
          toast({ title: 'Erro ao entrar', description: 'E-mail ou senha incorretos', variant: 'destructive' });
        } else if (error.message.includes('Email not confirmed')) {
          toast({ title: 'E-mail não confirmado', description: 'Verifique sua caixa de entrada para confirmar seu e-mail', variant: 'destructive' });
        } else {
          toast({ title: 'Erro ao entrar', description: error.message, variant: 'destructive' });
        }
        return;
      }
      toast({ title: 'Bem-vindo!', description: 'Login realizado com sucesso' });
      navigate('/', { replace: true });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignupSubmit = async (opts: {
    omieCliente: OmieClienteData | null;
    isIndustrial: boolean;
    isEmployee: boolean;
    cnae: string | null;
    selectedTools: string[];
  }) => {
    setIsLoading(true);
    try {
      const redirectUrl = `${window.location.origin}/`;
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: formData.email,
        password: formData.password,
        options: { emailRedirectTo: redirectUrl, data: { name: formData.name } },
      });

      if (signUpError) {
        if (signUpError.message.includes('User already registered')) {
          toast({ title: 'E-mail já cadastrado', description: 'Este e-mail já está em uso. Tente fazer login.', variant: 'destructive' });
        } else {
          toast({ title: 'Erro ao cadastrar', description: signUpError.message, variant: 'destructive' });
        }
        return;
      }

      if (signUpData.user) {
        const shouldAutoApprove = opts.isEmployee || !!opts.omieCliente;

        await supabase.from('profiles').upsert({
          user_id: signUpData.user.id, name: formData.name, email: formData.email,
          phone: formData.phone.replace(/\D/g, ''), document: formData.document.replace(/\D/g, ''),
          customer_type: opts.isIndustrial ? 'industrial' : 'domestic',
          cnae: opts.cnae, is_employee: opts.isEmployee, is_approved: shouldAutoApprove,
        }, { onConflict: 'user_id' });

        await supabase.from('addresses').insert({
          user_id: signUpData.user.id, label: 'Principal', street: formData.street,
          number: formData.number, complement: formData.complement || null,
          neighborhood: formData.neighborhood, city: formData.city, state: formData.state,
          zip_code: formData.zipCode.replace(/\D/g, ''), is_default: true, is_from_omie: true,
        });

        if (opts.selectedTools.length > 0) {
          const toolsToInsert = opts.selectedTools.map(toolCategoryId => {
            const category = toolCategories.find(c => c.id === toolCategoryId);
            return {
              user_id: signUpData.user!.id, tool_category_id: toolCategoryId,
              sharpening_interval_days: category?.suggested_interval_days || 90,
            };
          });
          await supabase.from('user_tools').insert(toolsToInsert);
        }

        if (opts.omieCliente?.codigo_cliente) {
          await supabase.from('omie_clientes').insert({
            user_id: signUpData.user.id, omie_codigo_cliente: opts.omieCliente.codigo_cliente,
            omie_codigo_cliente_integracao: `APP_${signUpData.user.id.substring(0, 8)}`,
          });
        }
      }

      toast({ title: 'Conta criada!', description: 'Verifique seu e-mail para confirmar o cadastro' });
      setMode('login');
    } finally {
      setIsLoading(false);
    }
  };

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

  const subtitle = mode === 'login' ? 'Bem-vindo de volta!' : 'Vamos começar';

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-gradient-radial from-primary/10 via-primary/5 to-transparent rounded-full blur-3xl -translate-y-1/2" />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 relative z-10">
        <div className="w-full max-w-md">
          <div className="text-center mb-8 animate-fade-in">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-primary shadow-glow mb-4">
              <Wrench className="w-8 h-8 text-primary-foreground" />
            </div>
            <h1 className="font-display font-bold text-4xl text-foreground tracking-tight mb-2">Colacor</h1>
            <p className="text-muted-foreground text-lg">{subtitle}</p>
          </div>

          <div className="bg-card rounded-2xl shadow-strong border border-border p-6 animate-fade-in" style={{ animationDelay: '0.1s' }}>
            {/* Mode Toggle */}
            {mode === 'login' && (
              <div className="flex gap-2 mb-6 p-1 bg-muted rounded-xl">
                <button type="button" onClick={() => setMode('login')}
                  className={cn('flex-1 py-2.5 rounded-lg font-semibold text-sm transition-all', 'bg-card text-foreground shadow-medium')}>
                  Entrar
                </button>
                <button type="button" onClick={() => setMode('signup')}
                  className="flex-1 py-2.5 rounded-lg font-semibold text-sm transition-all text-muted-foreground hover:text-foreground">
                  Cadastrar
                </button>
              </div>
            )}

            {mode === 'login' ? (
              <LoginForm formData={formData} onInputChange={handleInputChange} onSubmit={handleLogin} isLoading={isLoading} />
            ) : (
              <SignupForm formData={formData} onInputChange={handleInputChange} isLoading={isLoading}
                onFinalSubmit={handleSignupSubmit} onSwitchToLogin={() => setMode('login')} toolCategories={toolCategories as any} />
            )}
          </div>

          <p className="text-center text-sm text-muted-foreground mt-6 animate-fade-in" style={{ animationDelay: '0.2s' }}>
            {mode === 'login' ? (
              <>Não tem uma conta?{' '}<button type="button" onClick={() => setMode('signup')} className="text-primary hover:underline font-semibold">Cadastre-se</button></>
            ) : (
              <>Já tem uma conta?{' '}<button type="button" onClick={() => setMode('login')} className="text-primary hover:underline font-semibold">Faça login</button></>
            )}
          </p>
        </div>
      </div>
    </div>
  );
};

export default Auth;
