import { useState } from 'react';
import { Loader2, Mail, Lock, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ForgotPasswordDialog } from '@/components/ForgotPasswordDialog';
import { cn } from '@/lib/utils';
import { loginSchema } from './authSchemas';
import type { AuthFormData } from './authSchemas';
import { z } from 'zod';

interface LoginFormProps {
  formData: AuthFormData;
  onInputChange: (field: string, value: string) => void;
  onSubmit: (email: string, password: string) => Promise<void>;
  isLoading: boolean;
}

export function LoginForm({ formData, onInputChange, onSubmit, isLoading }: LoginFormProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      loginSchema.parse({ email: formData.email, password: formData.password });
      setErrors({});
    } catch (error) {
      if (error instanceof z.ZodError) {
        const newErrors: Record<string, string> = {};
        error.errors.forEach((err) => {
          if (err.path[0]) newErrors[err.path[0] as string] = err.message;
        });
        setErrors(newErrors);
        return;
      }
    }
    await onSubmit(formData.email, formData.password);
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="email" className="text-sm font-medium">E-mail</Label>
          <div className="relative mt-1.5">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input id="email" type="email" placeholder="seu@email.com" value={formData.email}
              onChange={(e) => onInputChange('email', e.target.value)}
              className={cn('pl-10', errors.email && 'border-destructive')} disabled={isLoading} />
          </div>
          {errors.email && <p className="text-xs text-destructive mt-1">{errors.email}</p>}
        </div>

        <div>
          <Label htmlFor="password" className="text-sm font-medium">Senha</Label>
          <div className="relative mt-1.5">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input id="password" type={showPassword ? 'text' : 'password'} placeholder="••••••••"
              value={formData.password} onChange={(e) => onInputChange('password', e.target.value)}
              className={cn('pl-10 pr-10', errors.password && 'border-destructive')} disabled={isLoading} />
            <button type="button" onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
              aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}>
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {errors.password && <p className="text-xs text-destructive mt-1">{errors.password}</p>}
        </div>

        <div className="flex justify-end">
          <button type="button" onClick={() => setShowForgotPassword(true)} className="text-sm text-primary hover:underline">
            Esqueci minha senha
          </button>
        </div>

        <Button type="submit" className="w-full h-12 text-base font-semibold shadow-glow" disabled={isLoading}>
          {isLoading ? (<><Loader2 className="w-5 h-5 mr-2 animate-spin" />Entrando...</>) : 'Entrar'}
        </Button>
      </form>

      <ForgotPasswordDialog open={showForgotPassword} onOpenChange={setShowForgotPassword} />
    </>
  );
}
