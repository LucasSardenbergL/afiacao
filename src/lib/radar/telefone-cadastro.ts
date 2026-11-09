/**
 * Radar, pacote L (item 4): qual telefone vai para o cadastro no Omie (Oben).
 *
 * Antes o payload levava `telefone1 || telefone2` às cegas — quando o telefone1 é o da CONTABILIDADE (o escritório
 * que abriu o CNPJ, marcado pela migration 20261109140000), o cliente nascia no Omie com o número errado e a
 * confirmação não deixava conferir. Agora a confirmação mostra os números, marca o da contabilidade e deixa trocar;
 * a sugestão é o 1º número que NÃO é da contabilidade (e nenhum, se todos são).
 * `contabil === null` = não sei (sinal não calculado ou leitura que falhou): a tela não afirma nada.
 */
import type { CampoContato, LeituraContatoContabil } from '@/lib/radar/contato-contabil';

export interface OpcaoTelefone {
  campo: Extract<CampoContato, 'telefone1' | 'telefone2'>;
  numero: string;
  contabil: boolean | null;
}

const CAMPOS = ['telefone1', 'telefone2'] as const;
const soDigitos = (v: string) => v.replace(/\D+/g, '');

export function opcoesTelefoneCadastro(
  e: { telefone1?: string | null; telefone2?: string | null },
  leitura: LeituraContatoContabil | null | undefined,
): OpcaoTelefone[] {
  const vistos = new Set<string>();
  const opcoes: OpcaoTelefone[] = [];
  for (const campo of CAMPOS) {
    const numero = (e[campo] ?? '').trim();
    const chave = soDigitos(numero);
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    const c = leitura?.contatos.get(campo);
    opcoes.push({ campo, numero, contabil: leitura ? (c?.efetivo ?? null) : null });
  }
  return opcoes;
}

/** A sugestão: o 1º número que não é da contabilidade; `null` (não enviar telefone) quando só há o da contabilidade. */
export function telefonePadraoCadastro(opcoes: readonly OpcaoTelefone[]): string | null {
  return opcoes.find((o) => o.contabil !== true)?.numero ?? null;
}

/** Valor do Select/RadioGroup para "não enviar telefone" (o rádio não aceita null). */
export const SEM_TELEFONE = '__sem_telefone__';
