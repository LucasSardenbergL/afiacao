

## Plano: Incluir Vendedor do Omie no Pedido de Afiação

### Problema
Quando um funcionário seleciona um cliente na busca e cria um pedido de afiação, o `codigo_vendedor` associado ao cadastro do cliente no Omie não está sendo carregado nem salvo. Isso porque:
- A busca resumida (`ListarClientesResumido`) não retorna `codigo_vendedor`
- A interface `OmieCustomer` em `NewOrder.tsx` não tem esse campo
- A ação `criar_perfil_local` não salva o `omie_codigo_vendedor` na tabela `omie_clientes`

### Implementação

**1. Edge function `omie-cliente/index.ts`**
- Na ação `pesquisar_clientes`: após obter os resultados resumidos, para cada cliente fazer uma chamada `ConsultarCliente` para buscar o `codigo_vendedor` (ou alternativamente, trocar `ListarClientesResumido` por `ListarClientes` que retorna campos completos)
- Retornar `codigo_vendedor` no mapeamento dos resultados
- Na ação `criar_perfil_local`: receber e salvar `codigo_vendedor` no campo `omie_codigo_vendedor` da tabela `omie_clientes`

**2. Frontend `src/pages/NewOrder.tsx`**
- Adicionar `codigo_vendedor` à interface `OmieCustomer`
- No `searchOmieCustomers`, mapear o novo campo dos resultados
- No `handleSelectCustomer`, chamar `consultar_cliente` para obter dados completos incluindo `codigo_vendedor` (caso a busca resumida não retorne)
- Ao salvar via `criar_perfil_local`, enviar `codigo_vendedor`

**3. Garantia no fluxo de sync (`omie-sync/index.ts`)**
- O código já busca `omie_codigo_vendedor` da tabela `omie_clientes` ao criar a OS -- se salvarmos corretamente na criação do perfil, o vendedor será incluído automaticamente na OS

### Abordagem mais eficiente
Trocar `ListarClientesResumido` por `ListarClientes` na busca, que já retorna `codigo_vendedor`. Isso evita N chamadas extras de `ConsultarCliente`.

