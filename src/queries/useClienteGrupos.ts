import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Grupo de Cliente 360 — camada de dados (CRUD de grupos + membros).
 * Spec: docs/superpowers/specs/2026-06-15-grupo-cliente-360-design.md
 *
 * NOTA: as tabelas `cliente_grupos` / `cliente_grupo_membros` ainda não estão nos tipos
 * gerados do Supabase (regen é a Task 4). Até lá, usamos `db` (cast) — mesmo idioma que o
 * repo usa pra `.rpc` não-tipada. Quando os tipos forem regenerados, troque `db` por `supabase`
 * e remova o cast + os tipos manuais abaixo.
 */
// Cast TEMPORÁRIO até a regen de tipos (Task 4): as tabelas cliente_grupos/_membros ainda não
// estão nos tipos gerados do Supabase. Trocar `db` por `supabase` direto quando os tipos existirem.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (table: string) => any };

export type RelationType = 'sucessao' | 'multi_ativo' | 'incerto';

interface ClienteGrupoMembro {
  id: string;
  grupo_id: string;
  documento: string; // só dígitos
  relation_type: RelationType;
  valid_from: string | null;
  valid_to: string | null;
  note: string | null;
  created_at: string;
}

export interface ClienteGrupo {
  id: string;
  nome: string;
  notas: string | null;
  ativo: boolean;
  created_at: string;
  updated_at: string;
  membros: ClienteGrupoMembro[];
}

const GRUPOS_KEY = ['cliente-grupos'] as const;

/** Só dígitos (CPF 11 / CNPJ 14). Espelha o CHECK da migration. */
export function normalizarDocumento(doc: string): string {
  return (doc || '').replace(/\D/g, '');
}

export function documentoValido(doc: string): boolean {
  const d = normalizarDocumento(doc);
  return d.length === 11 || d.length === 14;
}

/** Lista os grupos ativos com seus membros. */
export function useClienteGrupos() {
  return useQuery({
    queryKey: GRUPOS_KEY,
    queryFn: async (): Promise<ClienteGrupo[]> => {
      const { data, error } = await db
        .from('cliente_grupos')
        .select('id, nome, notas, ativo, created_at, updated_at, membros:cliente_grupo_membros(*)')
        .eq('ativo', true)
        .order('nome', { ascending: true });
      if (error) throw error;
      return (data ?? []) as ClienteGrupo[];
    },
  });
}

/** Cria um grupo. Retorna o id criado. */
export function useCreateGrupo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { nome: string; notas?: string | null }): Promise<string> => {
      const { data: userData } = await supabase.auth.getUser();
      const { data, error } = await db
        .from('cliente_grupos')
        .insert({ nome: input.nome.trim(), notas: input.notas ?? null, created_by: userData.user?.id ?? null })
        .select('id')
        .single();
      if (error) throw error;
      return (data as { id: string }).id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: GRUPOS_KEY }),
  });
}

/** Edita nome/notas/ativo de um grupo. */
export function useUpdateGrupo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; nome?: string; notas?: string | null; ativo?: boolean }) => {
      const patch: Record<string, unknown> = {};
      if (input.nome !== undefined) patch.nome = input.nome.trim();
      if (input.notas !== undefined) patch.notas = input.notas;
      if (input.ativo !== undefined) patch.ativo = input.ativo;
      const { error } = await db.from('cliente_grupos').update(patch).eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: GRUPOS_KEY }),
  });
}

/**
 * Adiciona um documento ao grupo. Normaliza pra dígitos.
 * Erro de UNIQUE(documento) vira mensagem clara (documento já está em outro grupo).
 */
export function useAddMembro() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      grupoId: string;
      documento: string;
      relationType?: RelationType;
      note?: string | null;
    }) => {
      const documento = normalizarDocumento(input.documento);
      if (!documentoValido(documento)) {
        throw new Error('Documento inválido: informe um CPF (11 dígitos) ou CNPJ (14 dígitos).');
      }
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await db.from('cliente_grupo_membros').insert({
        grupo_id: input.grupoId,
        documento,
        relation_type: input.relationType ?? 'incerto',
        note: input.note ?? null,
        confirmed_by: userData.user?.id ?? null,
      });
      if (error) {
        // 23505 = unique_violation
        if ((error as { code?: string }).code === '23505') {
          throw new Error('Este documento já pertence a outro grupo. Remova-o de lá antes de mover.');
        }
        throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: GRUPOS_KEY }),
  });
}

/** Remove um documento do grupo. */
export function useRemoveMembro() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (membroId: string) => {
      const { error } = await db.from('cliente_grupo_membros').delete().eq('id', membroId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: GRUPOS_KEY }),
  });
}
