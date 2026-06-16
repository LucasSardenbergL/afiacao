import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { visitasAgendadasTable, type VisitaAgendadaRow } from '@/integrations/supabase/visitasAgendadas';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
const KEY = (uid: string | undefined) => ['visitas-agendadas', uid];

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505'
  );
}

export function useVisitasAgendadas() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const uid = user?.id;
  const key = KEY(uid);

  const proximas = useQuery({
    queryKey: key,
    enabled: !!uid,
    queryFn: async (): Promise<VisitaAgendadaRow[]> => {
      const { data, error } = await visitasAgendadasTable()
        .select('*')
        .eq('scheduled_by', uid!)
        .in('status', ['pendente'])
        .order('scheduled_date', { ascending: true });
      if (error) throw new Error(error.message);
      return (data as unknown as VisitaAgendadaRow[]) ?? [];
    },
  });

  const agendar = useMutation({
    mutationFn: async (input: {
      customerUserId: string;
      scheduledDate: string;
      notes?: string;
    }) => {
      if (!uid) throw new Error('Sessão não autenticada');
      const { error } = await visitasAgendadasTable().insert({
        customer_user_id: input.customerUserId,
        scheduled_by: uid!,
        scheduled_date: input.scheduledDate,
        notes: input.notes ?? null,
        visit_type: 'comercial',
        status: 'pendente',
      });
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
    },
    onError: (err) => {
      if (isUniqueViolation(err)) {
        toast.error('Já existe visita pendente pra esse cliente nessa data');
      } else {
        toast.error('Não foi possível agendar a visita');
      }
    },
    onSuccess: () => {
      toast.success('Visita agendada');
      void qc.invalidateQueries({ queryKey: key });
    },
  });

  const remarcar = useMutation({
    mutationFn: async (input: { id: string; scheduledDate: string }) => {
      const { error } = await visitasAgendadasTable()
        .update({ scheduled_date: input.scheduledDate })
        .eq('id', input.id);
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
    },
    onError: (err) =>
      toast.error(
        isUniqueViolation(err)
          ? 'Já existe visita pendente nessa nova data'
          : 'Não foi possível remarcar'
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });

  const cancelar = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await visitasAgendadasTable()
        .update({ status: 'cancelada' })
        .eq('id', id);
      if (error) throw new Error(error.message);
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<VisitaAgendadaRow[]>(key);
      qc.setQueryData<VisitaAgendadaRow[]>(key, (old) =>
        (old ?? []).filter((v) => v.id !== id)
      );
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error('Não foi possível cancelar');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });

  const checkIn = useMutation({
    mutationFn: async (input: { customerUserId: string }) => {
      if (!uid) throw new Error('Sessão não autenticada');
      const coords = await new Promise<{ lat: number; lng: number } | null>((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
          () => resolve(null),
          { timeout: 5000 },
        );
      });
      const { error } = await supabase.from('route_visits').insert({
        customer_user_id: input.customerUserId,
        visited_by: uid!,
        visit_type: 'comercial',
        check_in_at: new Date().toISOString(),
        ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      });
      if (error) throw error;
    },
    onError: () => toast.error('Não foi possível fazer check-in'),
    onSuccess: () => {
      toast.success('Check-in feito');
      void qc.invalidateQueries({ queryKey: key });
    },
  });

  return { proximas, agendar, remarcar, cancelar, checkIn };
}
