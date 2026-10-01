// Preço exibido no painel do assistente de IA para um item de produto.
//
// MONEY-PATH: o painel mostra o preço com que o item VAI nascer no carrinho — o mesmo
// `getProductPrice` (= precoPartida, para o cliente SELECIONADO) que o handleUnifiedAIResult usa,
// recebido por `precoNascimentoPorId`. Até 2026-09-30 o painel exibia o `unit_price` da edge com o
// selo "Preço cliente", e com o cliente já selecionado esse número era o eco da TABELA: a tela dizia
// "preço do cliente" sobre um número que não era, e o carrinho o gravava. A edge não manda mais
// preço (a IA não precifica).
//
// Ausente ≠ número: enquanto o preço de partida não firmou (tier/config carregando) ou se o produto
// está fora do catálogo carregado, NÃO exibe número nenhum — nem a tabela, que seria fabricar o
// "preço provável" que o carrinho talvez não use. Um número FINITO é exibido como é, inclusive 0: o
// painel mostra o que o carrinho vai gravar (o guard de submit é quem barra ≤0, não o painel).
import { fmt } from './helpers';

interface PrecoNascimentoIAProps {
  productId: string | null | undefined;
  precoNascimentoPorId: (productId: string) => number | null;
  precoLoading?: boolean;
}

export function PrecoNascimentoIA({ productId, precoNascimentoPorId, precoLoading = false }: PrecoNascimentoIAProps) {
  if (precoLoading) {
    return <span className="text-[10px] text-muted-foreground">calculando preço…</span>;
  }
  const preco = productId ? precoNascimentoPorId(productId) : null;
  if (preco === null || !Number.isFinite(preco)) return null;
  return <span className="text-[10px] text-muted-foreground">{fmt(preco)}/un</span>;
}
