// Regras puras do diálogo de desligamento de funcionário (edge `desligar-funcionario`).
// A autoridade é o servidor (RPC `desligar_funcionario`); aqui só o que a tela precisa para não
// oferecer escolha inválida e para descrever o que aconteceu.

export type MembroEquipe = { user_id: string; name: string | null };

/** Quem pode receber a carteira: a equipe menos o desligado, mais o próprio master (sem duplicar). */
export function opcoesNovoDono(
  equipe: MembroEquipe[],
  alvoId: string,
  eu: MembroEquipe | null,
): MembroEquipe[] {
  const porId = new Map<string, MembroEquipe>();
  for (const m of equipe) if (m.user_id !== alvoId) porId.set(m.user_id, m);
  if (eu && eu.user_id !== alvoId && !porId.has(eu.user_id)) porId.set(eu.user_id, eu);
  return [...porId.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'pt-BR'));
}

const normalizar = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');

/** Impedimento para confirmar (texto para o usuário) ou `null` quando pode. */
export function impedimentoDoDesligamento(p: {
  nomeAlvo: string | null;
  confirmacao: string;
  motivo: string;
  novoDono: string | null;
}): string | null {
  if (!p.novoDono) return 'Escolha quem recebe a carteira.';
  const motivo = p.motivo.trim();
  if (motivo.length < 3) return 'Escreva o motivo.';
  if (motivo.length > 500) return 'Motivo longo demais (máx. 500 caracteres).';
  const nome = p.nomeAlvo ? normalizar(p.nomeAlvo) : '';
  if (!nome || normalizar(p.confirmacao) !== nome) return 'Digite o nome do funcionário para confirmar.';
  return null;
}

const ROTULOS: Array<[string, string, string]> = [
  ['carteira', 'cliente', 'clientes'],
  ['vendedor_map', 'código Omie', 'códigos Omie'],
  ['cobranca', 'cobrança aberta', 'cobranças abertas'],
  ['tarefas', 'tarefa aberta', 'tarefas abertas'],
  ['cobertura', 'cobertura encerrada', 'coberturas encerradas'],
];

/** "3 clientes, 2 códigos Omie" — só o que foi transferido/encerrado; vazio se nada. */
export function resumoDoDesligamento(resumo: Record<string, unknown> | null | undefined): string {
  if (!resumo) return '';
  const partes: string[] = [];
  for (const [chave, um, varios] of ROTULOS) {
    const n = Number(resumo[chave]);
    if (Number.isFinite(n) && n > 0) partes.push(`${n} ${n === 1 ? um : varios}`);
  }
  if (Number(resumo.hunter) > 0) partes.push('fila de órfãos (hunter)');
  return partes.join(', ');
}
