// Estado do salvar que precisa sobreviver à TELA (revisão /sales leva 1, #30; Codex 2026-11-26).
//
// O editor remonta a cada `:id` (cada pedido tem a sua instância), então a resposta atrasada do pedido A não
// tem como escrever na tela do pedido B. Mas dois fatos são do PEDIDO, não da tela, e valem enquanto o app
// estiver aberto: (1) o envio de A ainda está voando — uma tela nova de A não pode mandar outro por cima;
// (2) A ficou divergente do Omie — reabrir A (mesmo depois de ir e voltar) relê o app, não o Omie, e não
// pode reabilitar o carrinho velho. Desde o PR 2 da leva 1 a verdade é do BANCO (posse por conta+PV, migration
// 20261127100200: outra aba/aparelho, recarga e desfecho pelo token); este registro é só o bloqueio síncrono da
// mesma aba (duplo clique, A→B→A) e o cache do divergente até a tela reler o banco.

const emVoo = new Set<string>();
const divergentes = new Set<string>();
// Tokens de salvamento com desfecho NÃO provado (divergente sem leitura, ou ainda em voo): ao reabrir, a tela os
// ENCERRA no banco antes de destravar — o envio atrasado não chega mais ao Omie (Codex no diff r2).
// Persistidos neste APARELHO (localStorage): um F5 não pode apagar o único rastro de um envio ainda incerto
// (Codex r3). Melhor esforço — storage bloqueado degrada para a memória da aba, nunca quebra o salvar.
const CHAVE_STORAGE = 'afiacao.edicao-pedido.pendentes.v1';
const pendentes = new Map<string, Set<string>>();
let pendentesCarregados = false;
function carregarPendentes(): void {
  if (pendentesCarregados) return;
  pendentesCarregados = true;
  try {
    const cru = globalThis.localStorage?.getItem(CHAVE_STORAGE);
    const lido = cru ? JSON.parse(cru) as unknown : null;
    if (lido && typeof lido === 'object') {
      for (const [k, v] of Object.entries(lido as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          const tokens = v.filter((t): t is string => typeof t === 'string');
          if (tokens.length > 0) pendentes.set(k, new Set(tokens));
        }
      }
    }
  } catch { /* storage indisponível ou corrompido: só a memória da aba */ }
}
function gravarPendentes(): void {
  try {
    globalThis.localStorage?.setItem(
      CHAVE_STORAGE,
      JSON.stringify(Object.fromEntries([...pendentes].map(([k, v]) => [k, [...v]]))),
    );
  } catch { /* idem */ }
}
const ouvintes = new Set<() => void>();

const avisar = () => { for (const f of ouvintes) f(); };
/** Chave canônica: só os dígitos hexadecimais, em minúsculas. A rota aceita o UUID em maiúsculas, sem hífens
 *  ou entre chaves, e o banco devolve sempre o formato com hífens (Codex 2026-11-26). */
const chave = (pedidoId: string) => pedidoId.toLowerCase().replace(/[^0-9a-f]/g, '');

/** Adquire o envio do pedido: `false` se outro já voa (outra tela, mesma aba) — síncrono, sem janela entre
 *  conferir e marcar (Codex 2026-11-26: A→B→A com dois cliques mandava dois envios do mesmo PV). */
export function iniciarEnvio(pedidoId: string): boolean {
  // Divergente também recusa: a trava não depende de a tela ter lido o registro pela mesma grafia.
  if (emVoo.has(chave(pedidoId)) || divergentes.has(chave(pedidoId))) return false;
  emVoo.add(chave(pedidoId));
  avisar();
  return true;
}

export function encerrarEnvio(pedidoId: string): void {
  emVoo.delete(chave(pedidoId));
  avisar();
}

export function marcarDivergente(pedidoId: string): void {
  divergentes.add(chave(pedidoId));
  avisar();
}

export function marcarPendente(pedidoId: string, token: string): void {
  carregarPendentes();
  const k = chave(pedidoId);
  pendentes.set(k, new Set([...(pendentes.get(k) ?? []), token]));
  gravarPendentes();
}

export function tokensPendentes(pedidoId: string): string[] {
  carregarPendentes();
  return [...(pendentes.get(chave(pedidoId)) ?? [])];
}

export function resolverPendente(pedidoId: string, token: string): void {
  carregarPendentes();
  const k = chave(pedidoId);
  const s = pendentes.get(k);
  if (!s) return;
  s.delete(token);
  if (s.size === 0) pendentes.delete(k);
  gravarPendentes();
}

/** Só depois de um master liberar a divergência DURÁVEL no banco (`pedido_edicao_omie_resolver`). */
export function liberarDivergente(pedidoId: string): void {
  divergentes.delete(chave(pedidoId));
  avisar();
}

export function estadoDoPedido(pedidoId: string): { emVoo: boolean; divergente: boolean } {
  return { emVoo: emVoo.has(chave(pedidoId)), divergente: divergentes.has(chave(pedidoId)) };
}

export function ouvirRegistro(f: () => void): () => void {
  ouvintes.add(f);
  return () => { ouvintes.delete(f); };
}

/** Só para testes: simula um F5 — a memória da aba some, o que está no localStorage fica. */
export function esquecerMemoriaParaTeste(): void {
  emVoo.clear();
  divergentes.clear();
  pendentes.clear();
  pendentesCarregados = false;
  avisar();
}

/** Só para testes: o registro é do módulo e vazaria de um teste para o outro. */
export function limparRegistroParaTeste(): void {
  emVoo.clear();
  divergentes.clear();
  pendentes.clear();
  pendentesCarregados = false;
  try { globalThis.localStorage?.removeItem(CHAVE_STORAGE); } catch { /* idem */ }
  avisar();
}
