import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';
import { limparPushDoDevice } from '@/lib/push/device';

export type AppRole = 'employee' | 'customer' | 'master';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  role: AppRole | null;
  isAdmin: boolean;
  isEmployee: boolean;
  isCustomer: boolean;
  isMaster: boolean;
  isStaff: boolean;
  isApproved: boolean;
  /** commercial_role do usuário (null se não cadastrado). */
  commercialRole: string | null;
  /** Gestor comercial: commercial_role em ('gerencial','estrategico','super_admin'). */
  isGestorComercial: boolean;
  signUp: (email: string, password: string, name: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refetchRole: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const ROLE_FETCH_TIMEOUT_MS = 4_000;
const ROLE_FETCH_RETRY_DELAYS_MS = [0, 500, 1_200] as const;

function isTransientBackendError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? '').toLowerCase();
  const status = (error as { status?: unknown; code?: unknown } | null)?.status;
  const code = String((error as { code?: unknown } | null)?.code ?? '').toLowerCase();

  return (
    status === 503 ||
    status === 504 ||
    code === '503' ||
    code === '504' ||
    message.includes('timeout') ||
    message.includes('upstream connect error') ||
    message.includes('disconnect/reset before headers') ||
    message.includes('failed to fetch')
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timeout ${timeoutMs}ms: ${label}`));
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<AppRole | null>(null);
  const [isApproved, setIsApproved] = useState(false);
  const [commercialRole, setCommercialRole] = useState<string | null>(null);
  const bootstrapResolvedRef = useRef(false);

  const finishLoading = () => {
    bootstrapResolvedRef.current = true;
    setLoading(false);
  };

  const fetchUserRoleAndApprovalOnce = useCallback(async (userId: string) => {
    // Fetch role and approval in parallel
    return withTimeout(
      Promise.all([
          supabase
            .from('user_roles')
            .select('role')
            .eq('user_id', userId)
            .maybeSingle(),
          supabase
            .from('profiles')
            .select('is_approved')
            .eq('user_id', userId)
            .maybeSingle(),
          supabase
            .from('commercial_roles')
            .select('commercial_role')
            .eq('user_id', userId)
            .maybeSingle(),
        ]),
      ROLE_FETCH_TIMEOUT_MS,
      'fetchUserRoleAndApproval',
    );
  }, []);

  const fetchUserRoleAndApproval = useCallback(async (userId: string) => {
    for (let attempt = 0; attempt < ROLE_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = ROLE_FETCH_RETRY_DELAYS_MS[attempt];
      if (delayMs > 0) await wait(delayMs);

      try {
        const [roleResult, profileResult, commercialResult] = await fetchUserRoleAndApprovalOnce(userId);

        if (roleResult.error) {
          if (attempt < ROLE_FETCH_RETRY_DELAYS_MS.length - 1 && isTransientBackendError(roleResult.error)) {
            logger.warn('Transient role fetch failure — retrying', {
              stage: 'role_fetch_retry',
              userId,
              attempt: attempt + 1,
              error: roleResult.error,
            });
            continue;
          }

          logger.critical('Failed to fetch user role (fail-closed)', {
            stage: 'role_fetch',
            userId,
            error: roleResult.error,
          });
          // fail-closed
          setRole(null);
          setIsApproved(false);
          setCommercialRole(null);
          return;
        }

        const fetchedRole = (roleResult.data?.role as AppRole) || 'customer';
        setRole(fetchedRole);

        // Store commercial role for downstream use (isGestorComercial)
        setCommercialRole(commercialResult.data?.commercial_role ?? null);

        // Staff (admin/employee/master) or users with commercial roles are auto-approved
        const hasCommercialRole = !!commercialResult.data?.commercial_role;
        const isStaffRole = fetchedRole === 'employee' || fetchedRole === 'master';
        if (isStaffRole || hasCommercialRole) {
          setIsApproved(true);
          // Auto-approve staff profile if not yet approved
          if (profileResult.data && !profileResult.data.is_approved) {
            supabase
              .from('profiles')
              .update({ is_approved: true })
              .eq('user_id', userId)
              .eq('is_approved', false)
              .then(() => {}); // fire and forget
          }
        } else {
          if (profileResult.error) {
            if (attempt < ROLE_FETCH_RETRY_DELAYS_MS.length - 1 && isTransientBackendError(profileResult.error)) {
              logger.warn('Transient approval fetch failure — retrying', {
                stage: 'approval_fetch_retry',
                userId,
                attempt: attempt + 1,
                error: profileResult.error,
              });
              continue;
            }

            logger.critical('Failed to fetch approval status (fail-closed)', {
              stage: 'approval_fetch',
              userId,
              error: profileResult.error,
            });
            // fail-closed
            setIsApproved(false);
          } else {
            setIsApproved(profileResult.data?.is_approved ?? false);
          }
        }

        return;
      } catch (error) {
        if (attempt < ROLE_FETCH_RETRY_DELAYS_MS.length - 1 && isTransientBackendError(error)) {
          logger.warn('Transient role/approval fetch exception — retrying', {
            stage: 'role_fetch_retry',
            userId,
            attempt: attempt + 1,
            error,
          });
          continue;
        }

        logger.critical('Unexpected error fetching user role/approval (fail-closed)', {
          stage: 'role_fetch',
          userId,
          error,
        });
        // fail-closed
        setRole(null);
        setIsApproved(false);
        setCommercialRole(null);
        return;
      }
    }
  }, [fetchUserRoleAndApprovalOnce]);

  useEffect(() => {
    let isMounted = true;

    // Failsafe: nunca deixar o app preso num spinner pra sempre. Se o bootstrap
    // de auth do Supabase travar (lock do navigator.locks preso por outra aba,
    // token corrompido, ou query de role sem timeout), força loading=false pra
    // que o ProtectedRoute redirecione pro /auth (login) em vez de spinner
    // infinito. 10s é folgado: o caminho normal resolve em <1s.
    const loadingFailsafe = setTimeout(() => {
      if (isMounted && !bootstrapResolvedRef.current) {
        logger.error('Auth bootstrap timed out — forcing loading=false (failsafe)', {
          stage: 'auth_failsafe',
        });
        finishLoading();
      }
    }, 10_000);

    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!isMounted) return;
        setSession(session);
        setUser(session?.user ?? null);

        if (event === 'SIGNED_OUT') {
          setRole(null);
          setIsApproved(false);
          finishLoading();
          return;
        }

        // Load role/approval for any session-bearing event (SIGNED_IN, INITIAL_SESSION, TOKEN_REFRESHED, USER_UPDATED)
        if (session?.user) {
          // Defer to avoid deadlock with Supabase auth client
          setTimeout(async () => {
            if (!isMounted) return;
            if (event === 'SIGNED_IN') {
              createProfileIfNotExists(session.user.id, session.user.email);
            }
            await fetchUserRoleAndApproval(session.user.id);
            if (isMounted) finishLoading();
          }, 0);
        } else {
          // No session — safe to stop loading immediately
          finishLoading();
        }
      }
    );

    // THEN check for existing session (covers cold start before any event fires)
    supabase.auth.getSession().then(async ({ data: { session }, error }) => {
      if (!isMounted) return;
      if (error) {
        logger.error('Error fetching session', { stage: 'get_session', error });
        finishLoading();
        return;
      }
      // If there's no session, stop loading. If there IS a session, the
      // INITIAL_SESSION event from onAuthStateChange will handle role loading.
      if (!session) {
        finishLoading();
      }
    });

    return () => {
      isMounted = false;
      clearTimeout(loadingFailsafe);
      subscription.unsubscribe();
    };
  }, []);

  const createProfileIfNotExists = async (userId: string, email?: string) => {
    try {
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('id, document')
        .eq('user_id', userId)
        .maybeSingle();

      // If profile already has document, it was created by the signup flow — skip
      if (existingProfile?.document) return;

      if (!existingProfile) {
        // Create minimal profile — the signup flow will upsert full data
        await supabase.from('profiles').insert({
          user_id: userId,
          name: email?.split('@')[0] || 'Usuário',
          email: email,
        });
      }
    } catch (error) {
      logger.error('Failed to create profile', {
        stage: 'profile_create',
        userId,
        error,
      });
    }
  };

  const signUp = useCallback(async (email: string, password: string, name: string) => {
    try {
      const redirectUrl = `${window.location.origin}/`;
      
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectUrl,
          data: {
            name,
          },
        },
      });

      if (error) throw error;

      // Create profile after signup
      if (data.user) {
        await supabase.from('profiles').insert({
          user_id: data.user.id,
          name,
          email,
        });
      }

      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  }, []);

  const signOut = useCallback(async () => {
    // ANTES do signOut (a RPC precisa da sessão): desinscreve o Web Push do
    // device — senão quem logar depois neste navegador recebe os pushes de
    // quem saiu. Best-effort (nunca lança, não trava o logout).
    await limparPushDoDevice();
    await supabase.auth.signOut();
    setRole(null);
    setIsApproved(false);
    setCommercialRole(null);
  }, []);

  const refetchRole = useCallback(async () => {
    if (user) {
      await fetchUserRoleAndApproval(user.id);
    }
  }, [user, fetchUserRoleAndApproval]);

  // value memoizado: o AuthProvider envolve a árvore inteira — sem isto, cada
  // render dele recriava o objeto e re-renderizava todos os consumidores de
  // useAuth(). Nenhuma lógica muda: o fail-closed (erro → role null/approval
  // false) vive nos setters acima e segue intacto.
  const value = useMemo<AuthContextType>(() => {
    const isAdmin = role === 'master';
    const isEmployee = role === 'employee';
    const isMaster = role === 'master';
    const isCustomer = role === 'customer';
    const isStaff = isAdmin || isEmployee || isMaster;
    const isGestorComercial = ['gerencial', 'estrategico', 'super_admin'].includes(commercialRole ?? '');
    return {
      user,
      session,
      loading,
      role,
      isAdmin,
      isEmployee,
      isCustomer,
      isMaster,
      isStaff,
      isApproved,
      commercialRole,
      isGestorComercial,
      signUp,
      signIn,
      signOut,
      refetchRole,
    };
  }, [user, session, loading, role, isApproved, commercialRole, signUp, signIn, signOut, refetchRole]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};