import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BotoesDesfechoRecomendacao } from '../BotoesDesfechoRecomendacao';
import { useFarmerDesfecho, mensagemDoErro, MOTIVOS_RECUSA } from '@/hooks/useFarmerDesfecho';

const impMock = vi.fn(() => ({ isImpersonating: false }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
// `vi.mock` é HOISTED para o topo do arquivo, e esta factory lê a variável na hora
// de montar o objeto (`{ toast: toastMock }`) — não dentro de uma função, como as
// outras. Sem `vi.hoisted` isso é `ReferenceError: Cannot access 'toastMock' before
// initialization`, e a suíte inteira falha na COLETA (nenhum teste chega a rodar).
const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: toastMock }));
/**
 * O retorno é tipado à mão porque `vi.fn(async () => ({data:null,error:null}))` INFERE
 * `error: null` como o tipo, e todo `mockResolvedValue` com erro vira TS2322. Os
 * argumentos idem: sem `..._a`, `mock.calls[0]` é `[]` e o cast para ler o payload
 * vira TS2352. (Pego pelo `Type check (strict)` do CI, que checa os testes também.)
 */
type RpcRet = { data: unknown; error: { code?: string; message: string } | null };
type RpcArgs = [string, Record<string, unknown>];
const rpcMock = vi.fn(async (..._a: unknown[]): Promise<RpcRet> => ({ data: null, error: null }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

import { track } from '@/lib/analytics';
const eventos = () => (track as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, unknown>][];

const ALVO = { customerId: 'cli-1', productId: 'prod-1', type: 'cross_sell' as const };

beforeEach(() => {
  impMock.mockReturnValue({ isImpersonating: false });
  rpcMock.mockResolvedValue({ data: null, error: null });
  vi.clearAllMocks();
});

/** Monta o componente com o hook REAL — o writer é o que está sob teste. */
const Host = ({ alvo = ALVO }: { alvo?: typeof ALVO }) => {
  const registro = useFarmerDesfecho();
  return <BotoesDesfechoRecomendacao alvo={alvo} registro={registro} />;
};

describe('CONTROLE POSITIVO — a superfície existe antes de afirmar que ela mede algo', () => {
  // Sem este teste, todos os outros poderiam passar num componente que não renderiza
  // nada. Ele é o denominador: prova que a fixture PRODUZ os dois alvos de registro.
  it('[SENSOR] os dois botões de desfecho estão na face do card', () => {
    render(<Host />);
    expect(screen.getByRole('button', { name: 'Cliente comprou' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cliente recusou' })).toBeInTheDocument();
  });
});

describe('o aceite grava UM fato', () => {
  it('[SENSOR] "Comprou" chama a RPC com desfecho aceito e motivo null', async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    const [nome, args] = rpcMock.mock.calls[0] as unknown as RpcArgs;
    expect(nome).toBe('farmer_recomendacao_registrar_desfecho');
    expect(args.p_desfecho).toBe('aceito');
    expect(args.p_customer_user_id).toBe('cli-1');
    expect(args.p_product_id).toBe('prod-1');
    expect(args.p_recommendation_type).toBe('cross_sell');
    // [money-path: ausente ≠ zero] `null` EXPLÍCITO, nunca undefined nem string vazia:
    // undefined sumiria do JSON e deixaria o default do Postgres decidir por nós.
    expect(args.p_motivo).toBeNull();
  });

  it('[SENSOR] o card passa a exibir o fato e some com os botões', async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    await waitFor(() => expect(screen.getByText('Venda registrada')).toBeInTheDocument());
    // Reabrir a decisão ofereceria uma ação que a trigger trg_frec_desfecho_imutavel
    // recusa — o toast de erro puniria quem só se enganou no toque.
    expect(screen.queryByRole('button', { name: 'Cliente comprou' })).toBeNull();
  });
});

describe('a recusa exige o PORQUÊ — é o motivo que calibra, não o placar', () => {
  it('[SENSOR] "Recusou" NÃO grava direto: abre o motivo', async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente recusou' }));
    await waitFor(() => expect(screen.getByText('Por que o cliente recusou?')).toBeInTheDocument());
    // O ponto: nenhuma escrita aconteceu ainda.
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('[SENSOR] escolher o motivo grava rejeitado COM o motivo', async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente recusou' }));
    await waitFor(() => screen.getByText('Por que o cliente recusou?'));
    fireEvent.click(screen.getByRole('button', { name: 'Preço' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    const args = (rpcMock.mock.calls[0] as unknown as RpcArgs)[1];
    expect(args.p_desfecho).toBe('rejeitado');
    expect(args.p_motivo).toBe('preco');
    // A CHAVE DE NEGÓCIO é a única identidade que o browser tem — o id da linha nunca
    // volta do motor. Mandá-la errada só na recusa dava FD004, ou pior: carimbava outra
    // linha. O teste do aceite conferia isto; o da recusa, não (achado do /codex).
    expect(args.p_customer_user_id).toBe('cli-1');
    expect(args.p_product_id).toBe('prod-1');
    expect(args.p_recommendation_type).toBe('cross_sell');
  });

  it('[SENSOR] a recusa confirmada vira "Recusa registrada" — nunca "Venda registrada"', async () => {
    // Nada exigia isto: renderizar "Venda registrada" para um desfecho `rejeitado`
    // deixava os 16 testes verdes (achado do /codex). Seria a UI afirmando uma venda
    // onde o banco gravou uma recusa — o dado errado que é pior que dado nenhum.
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente recusou' }));
    await waitFor(() => screen.getByText('Por que o cliente recusou?'));
    fireEvent.click(screen.getByRole('button', { name: 'Preço' }));

    await waitFor(() => expect(screen.getByText('Recusa registrada')).toBeInTheDocument());
    expect(screen.queryByText('Venda registrada')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cliente recusou' })).toBeNull();
  });

  it('[SENSOR] o dialog RENDERIZA os seis motivos, não só o primeiro', async () => {
    // O teste de vocabulário abaixo prova a CONSTANTE. Renderizar só "Preço" mantendo a
    // constante intacta ficava verde (achado do /codex) — e um motivo que não aparece na
    // tela nunca entra na calibração, enviesando o porquê das recusas.
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente recusou' }));
    await waitFor(() => screen.getByText('Por que o cliente recusou?'));
    // O laço percorre a MESMA constante que o componente mapeia — sozinho ele só prova
    // "renderiza o que a constante diz". O elo com o banco é o teste acima (constante ↔
    // CHECK da migration); o elo aqui é constante ↔ tela. A contagem explícita fecha o
    // caso de renderizar um subconjunto.
    for (const m of MOTIVOS_RECUSA) {
      expect(screen.getByRole('button', { name: m.rotulo }), `motivo "${m.rotulo}" não foi renderizado`).toBeInTheDocument();
    }
    expect(MOTIVOS_RECUSA).toHaveLength(6);
  });

  it('[SENSOR] o vocabulário do dialog é EXATAMENTE o do CHECK da tabela', () => {
    // Um rótulo a mais aqui é um clique que o banco recusa com 23514.
    //
    // Este assert comparava a constante TS com um literal TS — o nome prometia acordo
    // com o CHECK e provava acordo consigo mesmo. Agora ele LÊ a migration. Não prova a
    // prod (apply manual pode divergir do repo — CLAUDE.md §migration), mas fecha a
    // corrente com o outro elo: db/test-farmer-desfecho.sh executa este mesmo CHECK num
    // PG17 de verdade. TS↔arquivo aqui, arquivo↔Postgres lá.
    const sql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/20260821194411_farmer_recomendacao_desfecho.sql'),
      'utf-8',
    );
    const lista = /rejection_reason IN \(([^)]*)\)/.exec(sql)?.[1];
    // CONTROLE: sem isto, uma regex que não casa devolveria [] e o `toEqual` falharia por
    // um motivo que eu leria como "o vocabulário divergiu". Fail-closed com o nome certo.
    expect(lista, 'não achei a lista do CHECK na migration — o assert abaixo seria cego').toBeTruthy();
    const doBanco = [...lista!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(doBanco).toHaveLength(6);
    expect(MOTIVOS_RECUSA.map((m) => m.valor)).toEqual(doBanco);
  });

  it('[SENSOR] o dialog NÃO fecha quando o banco recusa', async () => {
    // Fechar esconderia o toast de erro atrás do card e ela acharia que registrou —
    // um desfecho fantasma na cabeça da vendedora e zero linha no banco.
    rpcMock.mockResolvedValue({ data: null, error: { code: 'FD004', message: 'x' } });
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente recusou' }));
    await waitFor(() => screen.getByText('Por que o cliente recusou?'));
    fireEvent.click(screen.getByRole('button', { name: 'Preço' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(screen.getByText('Por que o cliente recusou?')).toBeInTheDocument();
  });
});

describe('a lente "Ver como" não registra na carteira alheia', () => {
  it('[LENTE] os botões ficam desabilitados e nada é gravado', () => {
    impMock.mockReturnValue({ isImpersonating: true });
    render(<Host />);
    const comprou = screen.getByRole('button', { name: 'Cliente comprou' });
    expect(comprou).toBeDisabled();
    fireEvent.click(comprou);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('[LENTE] o HOOK recusa mesmo sem passar pelo botão', async () => {
    // Este teste existe porque a falsificação denunciou o de cima: remover o guard
    // do hook deixava a suíte VERDE. `fireEvent.click` num botão `disabled` nem
    // dispara o handler, então aquele assert prova o `disabled` do COMPONENTE e
    // nada sobre o hook — e o hook é a camada que um POST direto alcançaria.
    impMock.mockReturnValue({ isImpersonating: true });
    let registrar: ReturnType<typeof useFarmerDesfecho>['registrar'] | null = null;
    const Sonda = () => { registrar = useFarmerDesfecho().registrar; return null; };
    render(<Sonda />);
    const ok = await registrar!(ALVO, 'aceito');
    expect(ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
    // A terceira camada é o banco: a RPC busca por auth.uid() (o master REAL) e
    // recusa com FD004 — provado em db/test-farmer-desfecho.sh, asserts 10 e 10b.
  });
});

describe('erro do banco vira instrução, não "erro ao salvar"', () => {
  it('[ERRO] cada SQLSTATE tem a ação certa, e FD004 NUNCA sugere tentar de novo', () => {
    expect(mensagemDoErro('FD001', 'fb')).toMatch(/sessão/i);
    expect(mensagemDoErro('FD003', 'fb')).toMatch(/motivo/i);
    expect(mensagemDoErro('FD006', 'fb')).toMatch(/duplicad/i);
    // ⚠️ Achado do /codex: retry depois de um recompute acertaria uma recomendação
    // NOVA e colaria o desfecho a um cálculo que ela nunca viu.
    const fd004 = mensagemDoErro('FD004', 'fb');
    expect(fd004).toMatch(/Recarregue/);
    expect(fd004).not.toMatch(/tente de novo|tentar novamente/i);
    // FD002/FD007 existem no contrato e nenhum assert os chamava (achado do /codex):
    // quebrá-los devolvia o fallback genérico, que não diz o que fazer.
    expect(mensagemDoErro('FD002', 'fb')).toMatch(/inválido/i);
    expect(mensagemDoErro('FD007', 'fb')).toMatch(/já tem desfecho|histórico/i);
    // Código desconhecido cai no fallback — nunca numa mensagem inventada.
    expect(mensagemDoErro(undefined, 'fb')).toBe('fb');
  });

  it('[ERRO] falha de TRANSPORTE não marca o card como registrado', async () => {
    // O `catch` (rede/CORS) não tinha teste NENHUM (achado do /codex): sabotá-lo para
    // chamar setRegistrados e devolver `true` deixava a suíte inteira verde. É o irmão
    // do erro de banco — a UI afirmando uma gravação sem nenhuma evidência de que ela
    // aconteceu, no caso em que o servidor sequer respondeu.
    rpcMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(toastMock.error.mock.calls[0][0]).toMatch(/NÃO foi registrado/);
    expect(screen.queryByText('Venda registrada')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cliente comprou' })).toBeInTheDocument();
  });

  it('[ERRO] erro de banco NÃO marca o card como registrado', async () => {
    // O supabase-js resolve com `error` preenchido em vez de lançar: um `await`
    // solto devolveria "sucesso" e o card mostraria desfecho que não existe.
    rpcMock.mockResolvedValue({ data: null, error: { code: 'FD004', message: 'x' } });
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(screen.queryByText('Venda registrada')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cliente comprou' })).toBeInTheDocument();
  });
});

describe('o sensor mede a TENTATIVA, não só o sucesso', () => {
  it('[TRACK] o evento sai ANTES do await e carrega desfecho e tipo', async () => {
    // A RPC fica PENDENTE de propósito. Com um mock que resolve na hora, este assert
    // passava com o `track()` movido para DEPOIS do await (achado do /codex adversarial):
    // ele provava que o evento existe em algum momento, não que ele precede a ida ao
    // banco. E é justamente o caso "clicou e a gravação nunca voltou" que o sensor
    // existe para medir — no sucesso o dado já está no banco e não precisa do evento.
    let resolver: (v: RpcRet) => void = () => {};
    rpcMock.mockImplementation(() => new Promise<RpcRet>((r) => { resolver = r; }));
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));

    // Sem `waitFor`: o evento tem de estar aqui AGORA, com a RPC ainda em voo.
    const ev = eventos().find(([n]) => n === 'recomendacao.desfecho_clicado');
    expect(ev, 'o evento só saiu depois do await — tentativa que morre não seria medida').toBeTruthy();
    expect(ev![1]).toMatchObject({ desfecho: 'aceito', tipo: 'cross_sell', motivo: null });

    resolver({ data: null, error: null });
    await waitFor(() => expect(screen.getByText('Venda registrada')).toBeInTheDocument());
  });

  it('[TRACK] a RECUSA também conta como tentativa, e carrega o motivo', async () => {
    // Emitir só no aceite enviesaria o sensor na direção mais cara: as recusas são
    // metade do sinal, e o motivo é o que separa erro do motor de falha operacional.
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente recusou' }));
    await waitFor(() => screen.getByText('Por que o cliente recusou?'));
    fireEvent.click(screen.getByRole('button', { name: 'Preço' }));

    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    const ev = eventos().find(([n]) => n === 'recomendacao.desfecho_clicado');
    expect(ev![1]).toMatchObject({ desfecho: 'rejeitado', motivo: 'preco', tipo: 'cross_sell' });
  });

  it('[TRACK] toque barrado pela lente NÃO conta como tentativa', () => {
    // Contá-lo inflaria o numerador com cliques que nunca chegaram à RPC — e a
    // pergunta "eles não registram ou o sistema recusa?" ficaria sem resposta.
    impMock.mockReturnValue({ isImpersonating: true });
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    expect(eventos().filter(([n]) => n === 'recomendacao.desfecho_clicado')).toHaveLength(0);
  });
});

describe('a trava de concorrência é síncrona', () => {
  it('[TRAVA] o botão fica desabilitado durante a gravação', async () => {
    // Camada 1 (UI): cliques do USUÁRIO são eventos separados, e o `fireEvent` do
    // RTL passa por `act()` — o `setState` já fez flush quando o segundo chega.
    // Este teste prova essa camada, e SÓ ela: ele passa com ou sem a ref (foi a
    // falsificação que mostrou isso). O caminho que só a ref cobre está abaixo.
    let resolver: (v: RpcRet) => void = () => {};
    rpcMock.mockImplementation(() => new Promise<RpcRet>((r) => { resolver = r; }));
    render(<Host />);
    const b = screen.getByRole('button', { name: 'Cliente comprou' });
    fireEvent.click(b);
    expect(b).toBeDisabled();
    fireEvent.click(b);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    resolver({ data: null, error: null });
    await waitFor(() => expect(screen.getByText('Venda registrada')).toBeInTheDocument());
  });

  it('[TRAVA] duas chamadas no MESMO tick geram UMA chamada à RPC', async () => {
    // Camada 2 (hook): aqui não há `act()` entre as duas invocações, então
    // `registrando` ainda é `null` na segunda — exatamente o caso que o `useState`
    // deixa passar e a ref barra. Trocar a ref por estado deixa este teste VERMELHO.
    let resolver: (v: RpcRet) => void = () => {};
    rpcMock.mockImplementation(() => new Promise<RpcRet>((r) => { resolver = r; }));
    let registrar: ReturnType<typeof useFarmerDesfecho>['registrar'] | null = null;
    const Sonda = () => { registrar = useFarmerDesfecho().registrar; return null; };
    render(<Sonda />);
    const a = registrar!(ALVO, 'aceito');
    const b = registrar!(ALVO, 'aceito');
    expect(rpcMock).toHaveBeenCalledTimes(1);
    resolver({ data: null, error: null });
    expect(await a).toBe(true);
    expect(await b).toBe(false);
  });

  it('[TRAVA] a trava é SOLTA após um erro — o card não congela', async () => {
    // Sem soltar a ref no finally, uma falha travaria o hook inteiro em silêncio:
    // os botões voltariam a parecer clicáveis e nenhum clique faria nada.
    rpcMock.mockResolvedValue({ data: null, error: { code: 'FD004', message: 'x' } });
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    rpcMock.mockResolvedValue({ data: null, error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    await waitFor(() => expect(screen.getByText('Venda registrada')).toBeInTheDocument());
  });
});
