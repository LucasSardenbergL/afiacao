// Helpers puros do snapshot de clientes não-vinculados.
// ⚠️ ESPELHADOS VERBATIM no edge function `omie-analytics-sync` (Deno não importa de src/).
// Única dependência: o espelho `@/lib/omie/cnpj-alfanumerico` (mesmo contrato do `_shared/` do edge).

import { normalizarDocumento } from '@/lib/omie/cnpj-alfanumerico';

export type OmieAccount = 'vendas' | 'servicos' | 'colacor_vendas';
export type Empresa = 'oben' | 'colacor' | 'colacor_sc';

export interface OmieClienteCadastroLite {
  codigo_cliente_omie?: number;
  codigo_vendedor?: number | null;
  cnpj_cpf?: string;
  razao_social?: string;
  nome_fantasia?: string;
  cidade?: string;
  estado?: string;
}

export interface NaoVinculadoRow {
  empresa: Empresa;
  omie_codigo_cliente: number;
  cnpj_cpf: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  cidade: string | null;
  uf: string | null;
  codigo_vendedor: number | null;
  synced_at: string;
}

export function accountToEmpresa(account: OmieAccount): Empresa {
  switch (account) {
    case 'vendas':
      return 'oben';
    case 'colacor_vendas':
      return 'colacor';
    case 'servicos':
      return 'colacor_sc';
  }
}

// Mesmo contrato do edge (`_shared/cnpj-alfanumerico.ts`): só-dígitos para CPF/CNPJ numérico, letras
// preservadas para CNPJ alfanumérico VÁLIDO (RFB jul/2026). Antes este espelho apagava letra e os testes
// daqui deixavam de verificar o comportamento implantado (Codex BAIXO, 2026-10-19).
export function normalizeDoc(raw: string | undefined | null): string {
  return normalizarDocumento(raw);
}

// Classificação de um cliente Omie contra os conjuntos em massa:
//  - codigosVinculados: todos os omie_codigo_cliente já em omie_clientes (vínculo)
//  - docsComProfile: todos os documentos (normalizados) que têm profile no app
// "não-vinculado" = tem código + doc, mas o código NÃO está vinculado E o doc NÃO tem profile.
export type SnapshotClassification = 'skip' | 'linked' | 'has_profile' | 'unlinked';

export function classifyClienteForSnapshot(
  c: OmieClienteCadastroLite,
  codigosVinculados: Set<number>,
  docsComProfile: Set<string>,
): SnapshotClassification {
  const doc = normalizeDoc(c.cnpj_cpf);
  if (!doc || c.codigo_cliente_omie == null) return 'skip';
  if (codigosVinculados.has(Number(c.codigo_cliente_omie))) return 'linked';
  if (docsComProfile.has(doc)) return 'has_profile';
  return 'unlinked';
}

export function buildNaoVinculadoRow(
  c: OmieClienteCadastroLite,
  empresa: Empresa,
  syncedAtIso: string,
): NaoVinculadoRow {
  return {
    empresa,
    omie_codigo_cliente: c.codigo_cliente_omie ?? 0,
    cnpj_cpf: normalizeDoc(c.cnpj_cpf),
    razao_social: c.razao_social?.trim() || null,
    nome_fantasia: c.nome_fantasia?.trim() || null,
    cidade: c.cidade?.trim() || null,
    uf: c.estado?.trim() || null,
    codigo_vendedor: c.codigo_vendedor ?? null,
    synced_at: syncedAtIso,
  };
}
