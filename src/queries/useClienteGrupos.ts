import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { TablesUpdate } from '@/integrations/supabase/types';
import { normalizarDocumento as normalizarChave, ehCnpjAlfanumerico, CNPJ_RE } from '@/lib/omie/cnpj-alfanumerico';

/**
 * Grupo de Cliente 360 — camada de dados (CRUD de grupos + membros).
 * Spec: docs/superpowers/specs/2026-06-15-grupo-cliente-360-design.md
 */

export type RelationType = 'sucessao' | 'multi_ativo' | 'incerto';

interface ClienteGrupoMembro {
  id: string;
  grupo_id: string;
  documento: string; // chave: só-dígitos (CPF 11 / CNPJ 14) ou CNPJ alfanumérico válido em MAIÚSCULAS (14)
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

/**
 * Chave de documento do membro — espelha o CHECK `cliente_grupo_membros_documento_formato` (migration
 * 20261020130000): só-dígitos (CPF 11 / CNPJ 14) OU CNPJ alfanumérico RFB VÁLIDO (formato + DV mod-11) em
 * MAIÚSCULAS. Numérico é byte-idêntico ao `.replace(/\D/g, '')` de sempre; minúscula/máscara do alfanumérico
 * são normalizadas AQUI (o banco rejeita o que não vier canônico — fail-closed).
 */
export function normalizarDocumento(doc: string): string {
  return normalizarChave(doc);
}

/** Máscara RFB nas posições exatas (`12.ABC.345/01DE-35`) — o MESMO regex do helper espelho (que não a exporta). */
const CNPJ_MASCARA_RE = /^[0-9A-Z]{2}[.][0-9A-Z]{3}[.][0-9A-Z]{3}\/[0-9A-Z]{4}-[0-9]{2}$/;

export type MotivoDocumento = 'ok' | 'dv_alfanumerico' | 'tamanho';

export const MENSAGEM_DOCUMENTO: Record<Exclude<MotivoDocumento, 'ok'>, string> = {
  dv_alfanumerico: 'CNPJ alfanumérico com dígito verificador inválido — confira o documento.',
  tamanho: 'Documento inválido: informe um CPF (11 dígitos), um CNPJ (14 dígitos) ou um CNPJ alfanumérico válido.',
};

/**
 * Avalia o que o usuário digitou. O que tem a FORMA de CNPJ alfanumérico (14 posições [0-9A-Z] com letra, cru ou
 * com a máscara exata) mas DV errado é RECUSADO aqui — não cai nos dígitos, porque os dígitos de um alfanumérico
 * errado podem ser o CPF de outra pessoa (AEG12345678908 → 12345678908; achado P1 do Codex, 2026-10-20). Letra
 * fora dessa forma (anotação "CNPJ: …", "aeg-123.456.789-09") continua caindo nos dígitos, como sempre.
 */
export function avaliarDocumento(doc: string): { chave: string; motivo: MotivoDocumento } {
  const chave = normalizarChave(doc);
  const d = (doc || '').trim().toUpperCase();
  const temFormaAlfanumerica = (CNPJ_RE.test(d) || CNPJ_MASCARA_RE.test(d)) && /[A-Z]/.test(d);
  if (temFormaAlfanumerica && !ehCnpjAlfanumerico(d.replace(/[-./]/g, ''))) {
    return { chave, motivo: 'dv_alfanumerico' };
  }
  if (chave.length === 11 || chave.length === 14) return { chave, motivo: 'ok' };
  return { chave, motivo: 'tamanho' };
}

export function documentoValido(doc: string): boolean {
  return avaliarDocumento(doc).motivo === 'ok';
}

/** Lista os grupos ativos com seus membros. */
export function useClienteGrupos() {
  return useQuery({
    queryKey: GRUPOS_KEY,
    queryFn: async (): Promise<ClienteGrupo[]> => {
      const { data, error } = await supabase
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
      const { data, error } = await supabase
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
      const patch: TablesUpdate<'cliente_grupos'> = {};
      if (input.nome !== undefined) patch.nome = input.nome.trim();
      if (input.notas !== undefined) patch.notas = input.notas;
      if (input.ativo !== undefined) patch.ativo = input.ativo;
      const { error } = await supabase.from('cliente_grupos').update(patch).eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: GRUPOS_KEY }),
  });
}

/**
 * Adiciona um documento ao grupo. Normaliza para a chave (dígitos, ou CNPJ alfanumérico em maiúsculas).
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
      const { chave: documento, motivo } = avaliarDocumento(input.documento);
      if (motivo !== 'ok') throw new Error(MENSAGEM_DOCUMENTO[motivo]);
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase.from('cliente_grupo_membros').insert({
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
        // 23514 = check_violation (o CHECK do banco é a última palavra: formato + DV)
        if ((error as { code?: string }).code === '23514') {
          throw new Error('O banco recusou o documento (formato ou dígito verificador inválido).');
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
      const { error } = await supabase.from('cliente_grupo_membros').delete().eq('id', membroId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: GRUPOS_KEY }),
  });
}
