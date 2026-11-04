# Lote 6b (plano v5): o dashboard da home baixa em paralelo ao auth

2026-11-04. Continuação do [lote 6](boot-chunk-paralelo-auth-lote6.md). Só Publish: sem edge e sem
migration.

## O problema

O lote 6 fez o chunk da ROTA de entrada (`Index`) baixar no boot, em paralelo ao auth. Dentro do
`Index`, porém, o dashboard é um `lazy` **por papel**: o `StaffDashboard` puxa o dnd (~95 KB) e o
`CustomerDashboard` puxa o framer-motion (~124 KB). O prefetch de rota não enxerga esse `lazy`
aninhado. Para o staff, a cadeia depois do auth tinha dois passos seriais:

1. o `Index` monta e o `useMyCommercialRole` faz um 2º REST de `commercial_roles` (o `AuthContext`
   já tinha feito o mesmo, em paralelo);
2. só então o `StaffDashboard` monta e o import do chunk começa.

Baseline de laboratório (main `cc4f83977`, persona master, medianas em ms a partir do início do
auth):

| perfil | `Index` pedido | `StaffDashboard` início → fim | LCP |
|---|---|---|---|
| mobile (Slow 4G + CPU 4×) | −193 | +1.290 → +2.386 | +3.413 |
| desktop (10 Mbps, 40 ms) | −37 | +872 → +1.034 | +1.159 |

No mobile, o chunk custa ~1,1 s e o 2º REST ~0,55 s. O chunk é o passo maior, e o escopo do lote
ficou nele. O REST duplicado é o próximo passo (ver "Fora do escopo").

## O desenho

- **Como saber o papel antes do auth: uma dica, não o papel.** `src/pages/home/dashboards-home.ts`
  guarda no localStorage `home-dashboard-dica` = `staff` | `cliente`, ou seja, o dashboard que a
  home renderizou da ÚLTIMA vez neste aparelho. O `Index` grava a dica num `useEffect` a partir da
  MESMA decisão que usa para renderizar (`decidirHome`: `aguardando | cliente | staff | redirect`).
  O redirect da vendedora para `/meu-dia` REMOVE a dica, porque ela não usa nenhum dashboard.
- **O prefetch:** `lazyRota` ganhou `{ prefetchJunto }`. O `App.tsx` registra
  `prefetchJunto: carregadorDaDica` na rota do `Index`. Assim o `prefetchRota('/')` do boot (e o
  hover em "Início" na sidebar) baixa o `Index` E o dashboard da dica pelo MESMO
  `prefetchCarregador`. Ele roda 1× por documento, e exceção nele é engolida.
- **Um carregador só:** o `Index` usa `lazyRota(carregarStaffDashboard)` /
  `lazyRota(carregarCustomerDashboard)`, as mesmas funções que a dica devolve. Então o render espera
  o prefetch em voo, e um prefetch que falhou recarrega 1× só se o dashboard for de fato renderizar.
  Um prefetch que falha nunca recarrega sozinho.
- **Autorização intacta:** a dica escolhe só entre dois imports fixos. Dica errada, adulterada ou
  de outro usuário no mesmo aparelho custa um download, nunca um render. Quem renderiza continua
  sendo o `Index`, atrás do `ProtectedRoute` e do papel. Na lente "Ver como", o `Index` segue o
  papel REAL (`useAuth`), e a dica também.
- **Descartados:** (b) pré-carregar sempre, porque o cliente baixaria o dnd e a decisão "lazy por
  papel" seria revertida; (c) encadear o import no `.then` do papel, porque ganha pouco (o 2º REST
  ainda serializa).
- **Limites aceitos:** a 1ª visita no aparelho (sem dica) não ganha nada. A dica é lida 1× por
  documento, então um hover depois do 1º login na mesma aba não reconsidera a dica recém-gravada.

## A/B de laboratório

Mesmo método do lote 6 (`boot-chunk-paralelo-auth-lote6.md` §LCP): build de produção de
`cc4f83977` (antes) e deste PR (depois), cada um com seu servidor estático e cada carga num
contexto frio. A sessão falsa fica no localStorage, e o Supabase é interceptado com 400 ms fixos
(master aprovado, `[]` no resto). A sessão falsa leva também a dica `staff`, que representa o
staff que volta ao app (o build "antes" a ignora). Foram 15 pares alternados mais 1 aquecimento,
com Mann-Whitney. Em todas as cargas `/` renderizou e o elemento do LCP foi um `<p>`. O medidor
rodou fora do `heavy`.

| perfil | métrica (ms) | antes p50 [IQR] | depois p50 [IQR] | Δ p50 | p |
|---|---|---|---|---|---|
| mobile (Slow 4G + CPU 4×) | LCP − início do auth | 3.775 [3.381–5.199] | 2.283 [2.034–3.008] | **−1.492** | <0,0001 |
| | LCP | 11.036 [10.308–12.766] | 9.312 [9.046–10.834] | −1.724 | 0,0034 |
| | `StaffDashboard` pedido − auth | +1.440 | −306 | −1.746 | — |
| desktop (10 Mbps, 40 ms, CPU 1×) | LCP − início do auth | 1.098 [1.088–1.104] | 895 [893–898] | **−203** | <0,0001 |
| | LCP | 2.304 [2.300–2.320] | 2.112 [2.106–2.118] | −192 | <0,0001 |
| | `StaffDashboard` pedido − auth | +853 | −20 | −873 | — |

- **O mecanismo está provado nos dois perfis:** o chunk do `StaffDashboard` sai junto com o do
  `Index`, antes do auth. O FCP e o pedido do `Index` não mudam (p 0,79 e 0,63), como esperado.
- **O que sobra no caminho:** no "depois", o chunk termina (+962 mobile, +186 desktop) antes do
  2º REST de `commercial_roles` responder (pedido em +748 / +432, mais 400 ms de resposta). Agora
  o passo serial dominante é esse REST.
- **Limites:** só a persona master foi medida. O ganho do cliente (dica `cliente`) usa a mesma
  mecânica, coberta por teste, mas não foi medido. A 1ª visita sem dica não muda de
  comportamento: é só uma leitura de localStorage. Como no lote 6, é medida do **mecanismo**, não
  do usuário real; o medidor ficou fora do repo, porque não é gate nem sensor.

## Lote 6c: o cargo comercial lido no auth semeia o cache

2026-11-04, PR seguinte ao #3603. O `AuthContext` já lê `commercial_roles` em paralelo a
`user_roles`/`profiles`, mas o `useMyCommercialRole` refazia a leitura depois que o `Index`
montava, e o `Index` segurava o skeleton do staff até ela voltar. Agora o auth semeia o cache
`['my-commercial-role', userId]` com a MESMA leitura (`src/lib/cargo-comercial-cache.ts`; a chave
mora fora do hook porque o hook importa o `useAuth`). **Leitura com erro não semeia**: semear
`null` de uma leitura que falhou fabricaria "consultei e não tem cargo". Com erro, o hook consulta
sozinho, como antes. Com dado fresco (staleTime 60 s), o hook nasce `pronta` e não refaz o REST.

A/B de laboratório, mesmo método. O antes é a main com o 6b (`329086ecd`), master, dica `staff`,
15 pares:

| perfil | LCP − início do auth | Δ p50 | p |
|---|---|---|---|
| desktop (10 Mbps, 40 ms) | 893 [890–896] → 481 [477–492] | **−412 ms** | <0,0001 |
| mobile (Slow 4G + CPU 4×) | 2.045 [1.961–2.492] → 2.149 [1.975–2.291] | +104 (ruído) | 0,82 |

- **O desktop ganha o RTT inteiro:** o chunk já estava pronto (+190), e quem segurava a home era o
  REST.
- **O mobile não ganha nada, e o motivo foi medido:** depois do 6b, o download do chunk do
  `StaffDashboard` termina em ~+1.080, quase junto com o REST. Os dois passos já se sobrepunham, e
  o chunk é o gargalo do mobile. Em campo, quanto mais rápida a rede e maior o RTT do Supabase,
  mais o ganho se parece com o do desktop.
- **Resíduo:** ainda sai um pedido a `commercial_roles` depois do auth, vindo do `useCommercialRole`
  (hook legado de `useState`/`useEffect`, chamado pelo `useDisplayAccess`). Fora da lente ele não
  segura a home, por isso ficou de fora.

## Lições

- Um `lazy` aninhado na página de entrada é invisível ao prefetch de rota. A rota pode declarar o
  que pré-carregar junto, desde que pelo MESMO carregador que o render usa.
- Gravar a dica a partir da decisão do render, e não do papel, cobre a persona que redireciona
  (vendedora): ela não paga um chunk que nunca vai usar.
