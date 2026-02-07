import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface BiometricAuthResult {
  email: string;
  tempToken: string;
  actionLink: string;
}

interface BiometricAuthHook {
  isSupported: boolean;
  isRegistered: boolean;
  isLoading: boolean;
  register: () => Promise<boolean>;
  authenticate: () => Promise<BiometricAuthResult | null>;
  removeCredential: () => Promise<boolean>;
  checkRegistration: (userId: string) => Promise<boolean>;
}

// Helper to convert ArrayBuffer to Base64
const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

// Helper to convert Base64 to ArrayBuffer
const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

// Generate a random challenge
const generateChallenge = (): ArrayBuffer => {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return array.buffer;
};

export const useBiometricAuth = (): BiometricAuthHook => {
  const [isSupported, setIsSupported] = useState(false);
  const [isRegistered, setIsRegistered] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // Check if WebAuthn is supported
  useEffect(() => {
    const checkSupport = async () => {
      if (window.PublicKeyCredential) {
        try {
          const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
          setIsSupported(available);
        } catch {
          setIsSupported(false);
        }
      }
    };
    checkSupport();
  }, []);

  // Check if user has registered biometric
  const checkRegistration = useCallback(async (userId: string): Promise<boolean> => {
    try {
      const { data, error } = await supabase
        .from('webauthn_credentials')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) throw error;
      const registered = !!data;
      setIsRegistered(registered);
      return registered;
    } catch (error) {
      console.error('Error checking biometric registration:', error);
      return false;
    }
  }, []);

  // Register biometric credential
  const register = useCallback(async (): Promise<boolean> => {
    if (!isSupported) {
      toast({
        title: 'Não suportado',
        description: 'Seu dispositivo não suporta autenticação biométrica',
        variant: 'destructive',
      });
      return false;
    }

    setIsLoading(true);

    try {
      // Get current user
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: 'Erro',
          description: 'Você precisa estar logado para registrar biometria',
          variant: 'destructive',
        });
        return false;
      }

      const challenge = generateChallenge();

      // Create credential options
      const publicKeyCredentialCreationOptions: PublicKeyCredentialCreationOptions = {
        challenge,
        rp: {
          name: 'Afiações App',
          id: window.location.hostname,
        },
        user: {
          id: new TextEncoder().encode(user.id),
          name: user.email || 'user',
          displayName: user.email || 'Usuário',
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' }, // ES256
          { alg: -257, type: 'public-key' }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'required',
          requireResidentKey: true,
        },
        timeout: 60000,
        attestation: 'none',
      };

      // Create credential
      const credential = await navigator.credentials.create({
        publicKey: publicKeyCredentialCreationOptions,
      }) as PublicKeyCredential;

      if (!credential) {
        throw new Error('Failed to create credential');
      }

      const response = credential.response as AuthenticatorAttestationResponse;
      
      // Extract public key and credential ID
      const credentialId = arrayBufferToBase64(credential.rawId);
      const publicKey = arrayBufferToBase64(response.getPublicKey() || new ArrayBuffer(0));
      
      // Get device name
      const deviceName = getDeviceName();

      // Store credential in database
      const { error } = await supabase.from('webauthn_credentials').insert({
        user_id: user.id,
        credential_id: credentialId,
        public_key: publicKey,
        device_name: deviceName,
        counter: 0,
      });

      if (error) throw error;

      // Store email for biometric login (encrypted in localStorage)
      localStorage.setItem('biometric_email', btoa(user.email || ''));

      setIsRegistered(true);
      toast({
        title: 'Biometria registrada!',
        description: 'Agora você pode fazer login com Face ID ou impressão digital',
      });

      return true;
    } catch (error: any) {
      console.error('Biometric registration error:', error);
      if (error.name === 'NotAllowedError') {
        toast({
          title: 'Acesso negado',
          description: 'Você precisa permitir o uso de biometria',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Erro ao registrar biometria',
          description: error.message || 'Tente novamente mais tarde',
          variant: 'destructive',
        });
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [isSupported, toast]);

  // Authenticate with biometric
  const authenticate = useCallback(async (): Promise<BiometricAuthResult | null> => {
    if (!isSupported) {
      toast({
        title: 'Não suportado',
        description: 'Seu dispositivo não suporta autenticação biométrica',
        variant: 'destructive',
      });
      return null;
    }

    setIsLoading(true);

    try {
      const challenge = generateChallenge();

      // Get credential for authentication
      const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
        challenge,
        rpId: window.location.hostname,
        userVerification: 'required',
        timeout: 60000,
      };

      const assertion = await navigator.credentials.get({
        publicKey: publicKeyCredentialRequestOptions,
      }) as PublicKeyCredential;

      if (!assertion) {
        throw new Error('Authentication failed');
      }

      const credentialId = arrayBufferToBase64(assertion.rawId);

      // Verify credential exists and get user info
      const { data, error } = await supabase.functions.invoke('biometric-auth', {
        body: {
          action: 'verify',
          credentialId,
        },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || 'Authentication failed');
      }

      return {
        email: data.email,
        tempToken: data.tempToken,
        actionLink: data.actionLink,
      };
    } catch (error: any) {
      console.error('Biometric authentication error:', error);
      if (error.name === 'NotAllowedError') {
        toast({
          title: 'Acesso negado',
          description: 'Autenticação biométrica cancelada',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Erro na autenticação',
          description: 'Não foi possível autenticar com biometria',
          variant: 'destructive',
        });
      }
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [isSupported, toast]);

  // Remove biometric credential
  const removeCredential = useCallback(async (): Promise<boolean> => {
    setIsLoading(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return false;

      const { error } = await supabase
        .from('webauthn_credentials')
        .delete()
        .eq('user_id', user.id);

      if (error) throw error;

      localStorage.removeItem('biometric_email');
      setIsRegistered(false);

      toast({
        title: 'Biometria removida',
        description: 'Autenticação biométrica desativada',
      });

      return true;
    } catch (error) {
      console.error('Error removing biometric:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível remover a biometria',
        variant: 'destructive',
      });
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  return {
    isSupported,
    isRegistered,
    isLoading,
    register,
    authenticate,
    removeCredential,
    checkRegistration,
  };
};

// Helper to detect device name
const getDeviceName = (): string => {
  const userAgent = navigator.userAgent;
  
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Mac/.test(userAgent)) return 'Mac';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Windows/.test(userAgent)) return 'Windows';
  
  return 'Dispositivo';
};
