import { useState, useEffect } from 'react';
import { Fingerprint, Scan } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBiometricAuth } from '@/hooks/useBiometricAuth';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

interface BiometricLoginButtonProps {
  onSuccess: () => void;
  className?: string;
}

export const BiometricLoginButton = ({ onSuccess, className }: BiometricLoginButtonProps) => {
  const { isSupported, isLoading, authenticate } = useBiometricAuth();
  const [hasSavedCredential, setHasSavedCredential] = useState(false);

  // Check if there's a saved biometric credential for any user
  useEffect(() => {
    const checkSavedCredential = async () => {
      const savedEmail = localStorage.getItem('biometric_email');
      if (savedEmail && isSupported) {
        setHasSavedCredential(true);
      }
    };
    checkSavedCredential();
  }, [isSupported]);

  const handleBiometricLogin = async () => {
    const result = await authenticate();
    
    if (result && result.actionLink) {
      // Use the magic link token to sign in
      const url = new URL(result.actionLink);
      const token = url.searchParams.get('token');
      const type = url.searchParams.get('type') || 'magiclink';
      
      if (token) {
        const { error } = await supabase.auth.verifyOtp({
          token_hash: token,
          type: type as 'magiclink',
        });
        
        if (!error) {
          onSuccess();
        }
      }
    }
  };

  if (!isSupported || !hasSavedCredential) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="outline"
      className={cn(
        "w-full flex items-center justify-center gap-3 h-14 border-2 border-primary/20 hover:border-primary/50 hover:bg-primary/5 transition-all",
        className
      )}
      onClick={handleBiometricLogin}
      disabled={isLoading}
    >
      {isLoading ? (
        <div className="animate-pulse">Verificando...</div>
      ) : (
        <>
          <div className="relative">
            <Fingerprint className="h-6 w-6 text-primary" />
            <Scan className="h-4 w-4 text-primary/60 absolute -top-1 -right-1" />
          </div>
          <span className="font-medium">Entrar com Face ID / Biometria</span>
        </>
      )}
    </Button>
  );
};
