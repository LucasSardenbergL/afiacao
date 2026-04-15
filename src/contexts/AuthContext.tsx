import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

export type AppRole = 'admin' | 'employee' | 'customer' | 'master';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  role: AppRole | null;
  isAdmin: boolean;
  isEmployee: boolean;
  isMaster: boolean;
  isStaff: boolean;
  isApproved: boolean;
  signUp: (email: string, password: string, name: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refetchRole: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

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

  const fetchUserRoleAndApproval = async (userId: string) => {
    try {
      // Fetch role and approval in parallel
      const [roleResult, profileResult, commercialResult] = await Promise.all([
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
      ]);

      if (roleResult.error) {
        console.error('Error fetching user role:', roleResult.error);
        // fail-closed
        setRole(null);
        setIsApproved(false);
        return;
      }

      const fetchedRole = (roleResult.data?.role as AppRole) || 'customer';
      setRole(fetchedRole);

      // Staff (admin/employee/master) are auto-approved
      const isStaffRole = fetchedRole === 'admin' || fetchedRole === 'employee' || fetchedRole === 'master';
      if (isStaffRole) {
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
          console.error('Error fetching approval status:', profileResult.error);
          // fail-closed
          setIsApproved(false);
        } else {
          setIsApproved(profileResult.data?.is_approved ?? false);
        }
      }
    } catch (error) {
      console.error('Error fetching user role/approval:', error);
      // fail-closed
      setRole(null);
      setIsApproved(false);
    }
  };

  useEffect(() => {
    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        setLoading(false);

        // Defer profile creation to avoid deadlock
        if (event === 'SIGNED_IN' && session?.user) {
          setTimeout(() => {
            createProfileIfNotExists(session.user.id, session.user.email);
            fetchUserRoleAndApproval(session.user.id);
          }, 0);
        } else if (event === 'SIGNED_OUT') {
          setRole(null);
          setIsApproved(false);
        }
      }
    );

    // THEN check for existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchUserRoleAndApproval(session.user.id);
      }
      setLoading(false);
    });

    return () => subscription.unsubscribe();
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
      console.error('Error creating profile:', error);
    }
  };

  const signUp = async (email: string, password: string, name: string) => {
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
  };

  const signIn = async (email: string, password: string) => {
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
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setRole(null);
    setIsApproved(false);
  };

  const refetchRole = async () => {
    if (user) {
      await fetchUserRoleAndApproval(user.id);
    }
  };

  const isAdmin = role === 'admin';
  const isEmployee = role === 'employee';
  const isMaster = role === 'master';
  const isStaff = isAdmin || isEmployee || isMaster;

  return (
    <AuthContext.Provider value={{ 
      user, 
      session, 
      loading, 
      role,
      isAdmin,
      isEmployee,
      isMaster,
      isStaff,
      isApproved,
      signUp, 
      signIn, 
      signOut,
      refetchRole,
    }}>
      {children}
    </AuthContext.Provider>
  );
};