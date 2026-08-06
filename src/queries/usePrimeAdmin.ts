import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { ilikeOr, isSearchablePostgrestTerm } from '@/lib/postgrest';
import { traduzirErroPrime } from '@/lib/prime/erros';
import type {
  PrimeAssinatura,
  PrimeBeneficioTipo,
  PrimeBeneficioUso,
  PrimeBeneficioUsoInsert,
  PrimeExtratoMensal,
  PrimePlano,
} from '@/types/prime';

/**
 * Prime Colacor — camada de dados do admin (/admin/prime).
 * Spec: docs/superpowers/specs/2026-07-09-prime-colacor-design.md §7 (PR-2).
 *
 * Os guards de honestidade vivem NO BANCO (migration prime_fundacao): campos
 * contratuais imutáveis, uso só em assinatura ativa, append-only com estorno,
 * bônus 1/mês ≤50. Aqui: queries + mutations que traduzem os erros (P0001/
 * 23505/23514) via traduzirErroPrime — a UI nunca contorna o guard.
 */
// Cast TEMPORÁRIO até a regen de tipos: as tabelas prime_* ainda não estão nos
// tipos gerados do Supabase (mesmo idioma de useClienteGrupos). Quando os tipos
// forem regenerados, trocar `db` por `supabase` e usar Tables<'prime_planos'>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (table: string) => any };

const KEY_PLANOS = ['prime', 'planos'] as const;
const KEY_ASSINATURAS = ['prime', 'assinaturas'] as const;
const KEY_USOS = ['prime', 'usos'] as const;
const KEY_EXTRATO = ['prime', 'extrato'] as const;

export interface ClienteResumo {
  user_id: string;
  name: string;
  razao_social: string | null;
  document: string | null;
}

export type PrimeAssinaturaComCliente = PrimeAssinatura & {
  cliente: ClienteResumo | null;
};

const COLS_ASSINATURA =
  'id, customer_user_id, plano_id, preco_contratado, franquia_dentes_contratada, status, data_inicio, data_fim, suspensa_em, observacao, created_by, created_at, updated_at';

const COLS_USO =
  'id, assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, descricao, created_by, created_at, estornado_em, estornado_por';

// ── Queries ──────────────────────────────────────────────────────────────────

export function usePrimePlanos() {
  return useQuery({
    queryKey: KEY_PLANOS,
    queryFn: async (): Promise<PrimePlano[]> => {
      const { data, error } = await db
        .from('prime_planos')
        .select('id, nome, preco_mensal, franquia_dentes, beneficios, ativo, created_at, updated_at')
        .order('ativo', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as PrimePlano[];
    },
  });
}

export function usePrimeAssinaturas() {
  return useQuery({
    queryKey: KEY_ASSINATURAS,
    queryFn: async (): Promise<PrimeAssinaturaComCliente[]> => {
      const { data, error } = await db
        .from('prime_assinaturas')
        .select(COLS_ASSINATURA)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      const assinaturas = (data ?? []) as PrimeAssinatura[];

      const ids = [...new Set(assinaturas.map((a) => a.customer_user_id))];
      const clientes: Record<string, ClienteResumo> = {};
      if (ids.length > 0) {
        const { data: perfis, error: erroPerfis } = await supabase
          .from('profiles')
          .select('user_id, name, razao_social, document')
          .in('user_id', ids);
        if (erroPerfis) throw erroPerfis;
        for (const p of perfis ?? []) clientes[p.user_id] = p as ClienteResumo;
      }

      return assinaturas.map((a) => ({
        ...a,
        cliente: clientes[a.customer_user_id] ?? null,
      }));
    },
  });
}

export function usePrimeUsos(incluirEstornados: boolean) {
  return useQuery({
    queryKey: [...KEY_USOS, { incluirEstornados }],
    queryFn: async (): Promise<PrimeBeneficioUso[]> => {
      let query = db
        .from('prime_beneficio_uso')
        .select(COLS_USO)
        .order('created_at', { ascending: false })
        .limit(500);
      if (!incluirEstornados) query = query.is('estornado_em', null);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as PrimeBeneficioUso[];
    },
  });
}

/**
 * Linha do extrato de UMA competência (franquia restante ao registrar uso).
 * `null` quando a view ainda não tem o mês (ex.: assinatura criada agora).
 */
export function usePrimeExtratoCompetencia(
  assinaturaId: string | undefined,
  competencia: string | undefined,
) {
  return useQuery({
    queryKey: [...KEY_EXTRATO, assinaturaId ?? '', competencia ?? ''],
    enabled: Boolean(assinaturaId && competencia),
    queryFn: async (): Promise<PrimeExtratoMensal | null> => {
      const { data, error } = await db
        .from('v_prime_extrato_mensal')
        .select(
          'assinatura_id, customer_user_id, status, competencia, mensalidade_contratada, monetizado_total, dentes_usados, dentes_bonus, franquia_total, dentes_restantes, dentes_excedentes, usos_operacionais, n_registros',
        )
        .eq('assinatura_id', assinaturaId)
        .eq('competencia', competencia)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as PrimeExtratoMensal | null;
    },
  });
}

/** Busca de clientes aprovados p/ nova assinatura (nome/razão social/documento). */
export function useBuscarClientes(termo: string) {
  const termoLimpo = termo.trim();
  return useQuery({
    queryKey: ['prime', 'clientes-busca', termoLimpo],
    enabled: termoLimpo.length >= 2 && isSearchablePostgrestTerm(termoLimpo),
    queryFn: async (): Promise<ClienteResumo[]> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, razao_social, document')
        .eq('is_approved', true)
        .or(ilikeOr(['name', 'razao_social', 'document'], termoLimpo))
        .order('name')
        .limit(20);
      if (error) throw error;
      return (data ?? []) as ClienteResumo[];
    },
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────

interface NovoPlano {
  nome: string;
  preco_mensal: number;
  franquia_dentes: number;
  beneficios: string[];
}

export function useCriarPlano() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (plano: NovoPlano) => {
      const { error } = await db.from('prime_planos').insert(plano);
      if (error) throw error;
    },
    onSuccess: (_d, plano) => {
      qc.invalidateQueries({ queryKey: KEY_PLANOS });
      track('prime.plano_criado', { nome: plano.nome, preco_mensal: plano.preco_mensal });
      toast.success('Plano criado no catálogo');
    },
    onError: (e) => toast.error(traduzirErroPrime(e)),
  });
}

export function useTogglePlanoAtivo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ativo }: { id: string; ativo: boolean }) => {
      const { error } = await db.from('prime_planos').update({ ativo }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: (_d, { ativo }) => {
      qc.invalidateQueries({ queryKey: KEY_PLANOS });
      track('prime.plano_toggle_ativo', { ativo });
      toast.success(ativo ? 'Plano reativado no catálogo' : 'Plano desativado do catálogo');
    },
    onError: (e) => toast.error(traduzirErroPrime(e)),
  });
}

interface NovaAssinatura {
  customer_user_id: string;
  plano_id: string;
  preco_contratado: number;
  franquia_dentes_contratada: number;
  data_inicio: string;
  observacao: string | null;
  created_by: string;
}

export function useCriarAssinatura() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (assinatura: NovaAssinatura) => {
      const { error } = await db.from('prime_assinaturas').insert(assinatura);
      if (error) throw error;
    },
    onSuccess: (_d, assinatura) => {
      qc.invalidateQueries({ queryKey: KEY_ASSINATURAS });
      track('prime.assinatura_criada', { plano_id: assinatura.plano_id });
      toast.success('Assinatura criada');
    },
    onError: (e) => toast.error(traduzirErroPrime(e)),
  });
}

export function useSuspenderAssinatura() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, suspensaEm }: { id: string; suspensaEm: string }) => {
      const { error } = await db
        .from('prime_assinaturas')
        .update({ status: 'suspensa', suspensa_em: suspensaEm })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY_ASSINATURAS });
      qc.invalidateQueries({ queryKey: KEY_EXTRATO });
      track('prime.assinatura_suspensa', {});
      toast.success('Assinatura suspensa — franquia e extrato congelados');
    },
    onError: (e) => toast.error(traduzirErroPrime(e)),
  });
}

export function useReativarAssinatura() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, observacao }: { id: string; observacao: string | null }) => {
      // Decisão PR-2 (minor 8 do review do PR-1): v1 não guarda histórico
      // estruturado de suspensão — o rastro fica na observacao (apensada pelo
      // caller). Meses do período suspenso voltam ao extrato como "sem uso
      // registrado" (fato: o banco barrava uso; nunca fabrica R$).
      const { error } = await db
        .from('prime_assinaturas')
        .update({ status: 'ativa', suspensa_em: null, observacao })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY_ASSINATURAS });
      qc.invalidateQueries({ queryKey: KEY_EXTRATO });
      track('prime.assinatura_reativada', {});
      toast.success('Assinatura reativada');
    },
    onError: (e) => toast.error(traduzirErroPrime(e)),
  });
}

export function useCancelarAssinatura() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, dataFim }: { id: string; dataFim: string }) => {
      // Cancelar suspensa NÃO limpa suspensa_em: a janela do extrato para no
      // que congelou na suspensão (a view usa LEAST — manter é o honesto).
      const { error } = await db
        .from('prime_assinaturas')
        .update({ status: 'cancelada', data_fim: dataFim })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY_ASSINATURAS });
      qc.invalidateQueries({ queryKey: KEY_EXTRATO });
      track('prime.assinatura_cancelada', {});
      toast.success('Assinatura cancelada');
    },
    onError: (e) => toast.error(traduzirErroPrime(e)),
  });
}

export function useRegistrarUso() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (uso: PrimeBeneficioUsoInsert) => {
      const { error } = await db.from('prime_beneficio_uso').insert(uso);
      if (error) throw error;
    },
    onSuccess: (_d, uso) => {
      qc.invalidateQueries({ queryKey: KEY_USOS });
      qc.invalidateQueries({ queryKey: KEY_EXTRATO });
      track('prime.uso_registrado', { tipo: uso.tipo });
      toast.success('Uso de benefício registrado');
    },
    onError: (e) => toast.error(traduzirErroPrime(e)),
  });
}

export function useEstornarUso() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      userId,
      tipo,
    }: {
      id: string;
      userId: string;
      tipo: PrimeBeneficioTipo;
    }) => {
      // Único UPDATE permitido pelo banco (trigger prime_uso_so_estorno):
      // estornado_por PRECISA ser o auth.uid() do caller.
      const { error } = await db
        .from('prime_beneficio_uso')
        .update({ estornado_em: new Date().toISOString(), estornado_por: userId })
        .eq('id', id);
      if (error) throw error;
      return tipo;
    },
    onSuccess: (tipo) => {
      qc.invalidateQueries({ queryKey: KEY_USOS });
      qc.invalidateQueries({ queryKey: KEY_EXTRATO });
      track('prime.uso_estornado', { tipo });
      toast.success('Registro estornado (fica fora do extrato)');
    },
    onError: (e) => toast.error(traduzirErroPrime(e)),
  });
}
