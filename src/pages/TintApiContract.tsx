import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Shield, Key, RefreshCw, AlertTriangle, CheckCircle, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

const BASE_URL = `https://${import.meta.env.VITE_SUPABASE_PROJECT_ID}.supabase.co/functions/v1/tint-sync-agent`;

function CodeBlock({ code, lang = 'json' }: { code: string; lang?: string }) {
  return (
    <div className="relative group">
      <Button
        variant="ghost" size="icon"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 h-7 w-7"
        onClick={() => { navigator.clipboard.writeText(code); toast.success('Copiado!'); }}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
      <pre className="bg-muted rounded-lg p-4 text-xs overflow-x-auto font-mono whitespace-pre">
        {code}
      </pre>
    </div>
  );
}

function EndpointDoc({ method, path, title, description, headers, requestBody, responseSuccess, responseDuplicate, responseError, idempotency }: {
  method: string; path: string; title: string; description: string;
  headers: string; requestBody: string; responseSuccess: string;
  responseDuplicate?: string; responseError: string; idempotency: string;
}) {
  return (
    <AccordionItem value={path}>
      <AccordionTrigger className="hover:no-underline">
        <div className="flex items-center gap-3 text-left">
          <Badge variant="outline" className="font-mono text-xs bg-primary/10 text-primary">
            {method}
          </Badge>
          <span className="font-mono text-sm">{path}</span>
          <span className="text-muted-foreground text-sm hidden sm:inline">— {title}</span>
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-4 pt-2">
        <p className="text-sm text-muted-foreground">{description}</p>

        <div>
          <h4 className="text-sm font-semibold mb-2">Headers obrigatórios</h4>
          <CodeBlock code={headers} />
        </div>

        <div>
          <h4 className="text-sm font-semibold mb-2">Request Body</h4>
          <CodeBlock code={requestBody} />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <h4 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
              <CheckCircle className="h-3.5 w-3.5 text-green-500" /> Sucesso (200)
            </h4>
            <CodeBlock code={responseSuccess} />
          </div>
          <div>
            <h4 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" /> Erro (401 / 500)
            </h4>
            <CodeBlock code={responseError} />
          </div>
        </div>

        {responseDuplicate && (
          <div>
            <h4 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
              <RefreshCw className="h-3.5 w-3.5 text-yellow-500" /> Duplicidade / Idempotência
            </h4>
            <CodeBlock code={responseDuplicate} />
          </div>
        )}

        <div className="bg-muted/50 rounded-lg p-3 border">
          <h4 className="text-sm font-semibold mb-1 flex items-center gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" /> Regra de Idempotência
          </h4>
          <p className="text-xs text-muted-foreground">{idempotency}</p>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

const COMMON_HEADERS = `{
  "Content-Type": "application/json",
  "x-sync-token": "<TOKEN_DA_LOJA>",
  "x-store-code": "<CODIGO_DA_LOJA>"
}`;

const endpoints = [
  {
    method: 'POST', path: '/heartbeat', title: 'Heartbeat',
    description: 'Enviado periodicamente pelo agent para indicar que está online. Atualiza last_heartbeat_at, agent_version e hostname.',
    headers: COMMON_HEADERS,
    requestBody: `{
  "agent_version": "1.2.0",
  "hostname": "LOJA01-PC",
  "uptime_seconds": 86400,
  "db_connected": true
}`,
    responseSuccess: `{
  "ok": true,
  "server_time": "2026-03-29T18:00:00.000Z"
}`,
    responseError: `// 401
{ "error": "Invalid token or store" }`,
    idempotency: 'Idempotente por natureza. Pode ser chamado repetidamente sem efeitos colaterais. Recomendado: a cada 60 segundos.',
  },
  {
    method: 'POST', path: '/test', title: 'Test Connection',
    description: 'Valida se o token e store_code são válidos. Usado na configuração inicial do agent.',
    headers: COMMON_HEADERS,
    requestBody: `{}  // Body vazio ou omitido`,
    responseSuccess: `{
  "ok": true,
  "account": "oben",
  "store_code": "LOJA01"
}`,
    responseError: `// 401
{ "error": "Invalid token or store" }`,
    idempotency: 'Idempotente. Apenas leitura, sem efeitos no banco.',
  },
  {
    method: 'POST', path: '/catalogs', title: 'Catalog Sync (Produtos, Bases, Embalagens, Corantes)',
    description: 'Envia catálogo completo ou incremental. Os dados são gravados nas tabelas de staging para reconciliação posterior. NÃO altera dados oficiais.',
    headers: COMMON_HEADERS,
    requestBody: `{
  "produtos": [
    {
      "cod_produto": "WFO0098",
      "descricao": "WANDEPOXY BR 0098 BRANCO"
    }
  ],
  "bases": [
    {
      "id_base_sayersystem": "BASE-T",
      "descricao": "Base T - Transparente"
    }
  ],
  "embalagens": [
    {
      "id_embalagem_sayersystem": "EMB-3600",
      "descricao": "Galão 3.6L",
      "volume_ml": 3600
    }
  ],
  "corantes": [
    {
      "id_corante_sayersystem": "AX",
      "descricao": "Corante AX - Amarelo Óxido",
      "preco_litro": 45.90
    }
  ],
  "skus": [
    {
      "cod_produto": "WFO0098",
      "id_base": "BASE-T",
      "id_embalagem": "EMB-3600"
    }
  ]
}`,
    responseSuccess: `{
  "ok": true,
  "run_id": "uuid-do-sync-run",
  "inserts": 15,
  "updates": 0,
  "errors": 0
}`,
    responseDuplicate: `// Re-envio do mesmo lote cria novo sync_run.
// O agent deve enviar APENAS registros novos/alterados.
// Registros duplicados no staging são tratados
// na reconciliação sem afetar dados oficiais.
{
  "ok": true,
  "run_id": "uuid-novo",
  "inserts": 15,
  "updates": 0,
  "errors": 0
}`,
    responseError: `// 401
{ "error": "Invalid token or store" }

// 500
{ "error": "Failed to create sync run" }`,
    idempotency: 'Cada chamada cria um novo sync_run. Para evitar duplicidade lógica, o agent deve controlar o checkpoint local (último ID sincronizado ou timestamp). A reconciliação detecta registros duplicados entre runs.',
  },
  {
    method: 'POST', path: '/formulas', title: 'Formula Sync',
    description: 'Envia fórmulas com seus itens (corantes + quantidades). Grava em staging. A chave lógica de pareamento é: cor_id | cod_produto | id_base | id_embalagem.',
    headers: COMMON_HEADERS,
    requestBody: `{
  "formulas": [
    {
      "cor_id": "2345",
      "nome_cor": "AZUL INFINITO",
      "cod_produto": "WFO0098",
      "id_base": "BASE-T",
      "id_embalagem": "EMB-3600",
      "subcolecao": "COL-PREMIUM",
      "volume_final_ml": 3600,
      "preco_final": 189.50,
      "personalizada": false,
      "itens": [
        {
          "id_corante": "AX",
          "ordem": 1,
          "qtd_ml": 12.5
        },
        {
          "id_corante": "BV",
          "ordem": 2,
          "qtd_ml": 8.3
        },
        {
          "id_corante": "RO",
          "ordem": 3,
          "qtd_ml": 3.1
        }
      ]
    }
  ]
}`,
    responseSuccess: `{
  "ok": true,
  "run_id": "uuid-do-sync-run",
  "inserts": 1,
  "errors": 0
}`,
    responseDuplicate: `// Fórmulas com mesma chave lógica em runs
// diferentes são detectadas na reconciliação.
// O staging aceita a inserção sem erro.`,
    responseError: `// 401
{ "error": "Invalid token or store" }

// 500 (item inválido)
{
  "ok": true,
  "run_id": "uuid",
  "inserts": 0,
  "errors": 1
}
// Detalhes gravados em tint_sync_errors`,
    idempotency: 'Cada envio gera um novo sync_run. A reconciliação compara staging vs dados oficiais CSV por chave lógica. O agent deve enviar fórmulas alteradas desde o último checkpoint.',
  },
  {
    method: 'POST', path: '/preparations', title: 'Preparation Sync (Preparações/Vendas)',
    description: 'Envia preparações realizadas na máquina tintométrica (vendas de cor). Cada preparação registra o que foi efetivamente dispensado.',
    headers: COMMON_HEADERS,
    requestBody: `{
  "preparacoes": [
    {
      "preparacao_id": "PREP-20260329-001",
      "cor_id": "2345",
      "nome_cor": "AZUL INFINITO",
      "cod_produto": "WFO0098",
      "id_base": "BASE-T",
      "id_embalagem": "EMB-3600",
      "volume_ml": 3600,
      "preco_cobrado": 189.50,
      "cliente_nome": "José da Silva",
      "cliente_doc": "12345678901",
      "operador": "Maria",
      "preparado_em": "2026-03-29T14:30:00-03:00",
      "itens": [
        {
          "id_corante": "AX",
          "qtd_ml_prevista": 12.5,
          "qtd_ml_real": 12.48
        },
        {
          "id_corante": "BV",
          "qtd_ml_prevista": 8.3,
          "qtd_ml_real": 8.31
        }
      ]
    }
  ]
}`,
    responseSuccess: `{
  "ok": true,
  "run_id": "uuid-do-sync-run",
  "inserts": 1,
  "errors": 0
}`,
    responseDuplicate: `// Se o mesmo preparacao_id for enviado novamente,
// será gravado como novo registro no staging.
// A reconciliação/análise posterior detecta duplicidade
// pelo campo preparacao_id.`,
    responseError: `// 401
{ "error": "Invalid token or store" }

// 500
{ "error": "Failed to create sync run" }`,
    idempotency: 'O campo preparacao_id deve ser único por preparação. O agent deve manter controle local do último ID enviado. O servidor aceita re-envios sem rejeitar, mas a análise posterior filtra duplicatas.',
  },
];

export default function TintApiContract() {
  const [copiedUrl, setCopiedUrl] = useState(false);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Contrato da API — Agent Local Windows</h1>
        <p className="text-muted-foreground mt-1">
          Documentação técnica completa para integração do SAYERSYSTEM via conector local.
        </p>
      </div>

      <Tabs defaultValue="endpoints" className="space-y-4">
        <TabsList>
          <TabsTrigger value="endpoints">Endpoints</TabsTrigger>
          <TabsTrigger value="auth">Autenticação</TabsTrigger>
          <TabsTrigger value="rules">Regras Gerais</TabsTrigger>
          <TabsTrigger value="flow">Fluxo Recomendado</TabsTrigger>
        </TabsList>

        {/* ─── ENDPOINTS ─── */}
        <TabsContent value="endpoints" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Base URL</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <code className="bg-muted px-3 py-1.5 rounded text-sm font-mono flex-1 truncate">
                  {BASE_URL}
                </code>
                <Button variant="outline" size="sm" onClick={() => {
                  navigator.clipboard.writeText(BASE_URL);
                  setCopiedUrl(true);
                  toast.success('URL copiada!');
                  setTimeout(() => setCopiedUrl(false), 2000);
                }}>
                  {copiedUrl ? <CheckCircle className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Todos os endpoints usam este prefixo. Ex: <code className="text-xs">{BASE_URL}/heartbeat</code>
              </p>
            </CardContent>
          </Card>

          <Accordion type="multiple" className="space-y-2">
            {endpoints.map((ep) => (
              <EndpointDoc key={ep.path} {...ep} />
            ))}
          </Accordion>
        </TabsContent>

        {/* ─── AUTH ─── */}
        <TabsContent value="auth" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" /> Autenticação por Token por Loja
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Cada loja possui um <strong>sync_token</strong> único gerado na tela de Integrações do módulo tintométrico. 
                O agent local deve enviar esse token em todas as requisições.
              </p>

              <div>
                <h4 className="font-semibold text-sm mb-2">Headers obrigatórios</h4>
                <CodeBlock code={`x-sync-token: <TOKEN_UUID_GERADO_NA_TELA_DE_INTEGRACOES>
x-store-code: <CODIGO_DA_LOJA>  // Ex: "LOJA01", "FILIAL02"`} lang="text" />
              </div>

              <div>
                <h4 className="font-semibold text-sm mb-2">Modelo de dados</h4>
                <CodeBlock code={`-- Tabela: tint_integration_settings
-- Campos relevantes para autenticação:
{
  "id": "uuid",
  "account": "oben",           // Conta fixa
  "store_code": "LOJA01",      // Identificador da loja
  "sync_token": "uuid-v4",     // Token secreto
  "sync_enabled": true,        // Deve estar ativo
  "integration_mode": "shadow_mode" // csv_only | shadow_mode | automatic_primary
}`} />
              </div>

              <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3">
                <h4 className="font-semibold text-sm flex items-center gap-1.5 text-destructive">
                  <Shield className="h-4 w-4" /> Segurança
                </h4>
                <ul className="text-xs text-muted-foreground mt-2 space-y-1 list-disc list-inside">
                  <li>O token deve ser armazenado de forma segura no agent local (ex: Windows Credential Manager)</li>
                  <li>Token inválido ou loja desativada retorna <code>401</code></li>
                  <li>O token pode ser regenerado na tela de Integrações a qualquer momento</li>
                  <li>Cada loja tem seu próprio token — não compartilhar entre lojas</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── RULES ─── */}
        <TabsContent value="rules" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-500" /> Respostas Padrão
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Badge variant="outline" className="bg-green-500/10 text-green-700 mb-1">200 OK</Badge>
                  <p className="text-xs text-muted-foreground">Operação concluída. Campo <code>"ok": true</code> sempre presente.</p>
                </div>
                <div>
                  <Badge variant="outline" className="bg-yellow-500/10 text-yellow-700 mb-1">200 com errors &gt; 0</Badge>
                  <p className="text-xs text-muted-foreground">Processamento parcial. Alguns itens falharam. Detalhes em <code>tint_sync_errors</code>.</p>
                </div>
                <div>
                  <Badge variant="outline" className="bg-red-500/10 text-red-700 mb-1">401 Unauthorized</Badge>
                  <p className="text-xs text-muted-foreground">Token inválido, loja desativada ou headers ausentes.</p>
                </div>
                <div>
                  <Badge variant="outline" className="bg-red-500/10 text-red-700 mb-1">500 Internal Error</Badge>
                  <p className="text-xs text-muted-foreground">Erro no servidor. O agent deve fazer retry com backoff exponencial.</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <RefreshCw className="h-4 w-4" /> Idempotência e Duplicidade
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p><strong>Heartbeat / Test:</strong> Totalmente idempotentes. Podem ser chamados ilimitadamente.</p>
                <p><strong>Catalog / Formula / Preparation sync:</strong> Cada chamada cria um novo <code>sync_run</code>. O servidor <em>não rejeita</em> dados duplicados no staging — a reconciliação posterior é responsável por detectar duplicatas.</p>
                <p><strong>Responsabilidade do agent:</strong> Manter checkpoint local (último timestamp ou ID sincronizado) para enviar apenas dados novos/alterados.</p>
                <p><strong>Chave lógica de fórmulas:</strong> <code>cor_id | cod_produto | id_base | id_embalagem</code></p>
                <p><strong>Chave lógica de preparações:</strong> <code>preparacao_id</code> (único por evento)</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Retry e Backoff</CardTitle>
            </CardHeader>
            <CardContent>
              <CodeBlock code={`// Estratégia recomendada para o agent:
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  try {
    const response = await fetch(url, options);
    if (response.status === 401) break; // Não fazer retry em 401
    if (response.ok) return await response.json();
    // 500: retry
  } catch (networkError) {
    // Retry em erro de rede
  }
  await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
}`} lang="typescript" />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── FLOW ─── */}
        <TabsContent value="flow" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Fluxo Recomendado do Agent Local</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-4 text-sm">
                <li className="flex gap-3">
                  <Badge className="shrink-0 h-6 w-6 rounded-full flex items-center justify-center text-xs">1</Badge>
                  <div>
                    <strong>Inicialização</strong>
                    <p className="text-muted-foreground">Agent inicia → lê config local (token, store_code, endpoint) → chama <code>/test</code> para validar conexão.</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <Badge className="shrink-0 h-6 w-6 rounded-full flex items-center justify-center text-xs">2</Badge>
                  <div>
                    <strong>Heartbeat Loop</strong>
                    <p className="text-muted-foreground">A cada 60s, envia <code>/heartbeat</code> com versão e status do PostgreSQL local.</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <Badge className="shrink-0 h-6 w-6 rounded-full flex items-center justify-center text-xs">3</Badge>
                  <div>
                    <strong>Sync de Catálogo (diário ou sob demanda)</strong>
                    <p className="text-muted-foreground">Lê produtos, bases, embalagens e corantes do PostgreSQL local → envia via <code>/catalogs</code>.</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <Badge className="shrink-0 h-6 w-6 rounded-full flex items-center justify-center text-xs">4</Badge>
                  <div>
                    <strong>Sync de Fórmulas (incremental)</strong>
                    <p className="text-muted-foreground">Consulta fórmulas alteradas desde o último checkpoint → envia em lotes de até 500 via <code>/formulas</code>.</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <Badge className="shrink-0 h-6 w-6 rounded-full flex items-center justify-center text-xs">5</Badge>
                  <div>
                    <strong>Sync de Preparações (em tempo real ou batch)</strong>
                    <p className="text-muted-foreground">Monitora novas preparações no banco local → envia via <code>/preparations</code>. Pode ser em tempo real (polling a cada 30s) ou batch (a cada hora).</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <Badge className="shrink-0 h-6 w-6 rounded-full flex items-center justify-center text-xs">6</Badge>
                  <div>
                    <strong>Reconciliação (no app web)</strong>
                    <p className="text-muted-foreground">Operador acessa a tela de Reconciliação para comparar dados do agent vs CSV oficial. Aprovação manual antes de promover para produção.</p>
                  </div>
                </li>
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Modos de Operação</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="border rounded-lg p-3">
                  <Badge variant="outline" className="mb-2">csv_only</Badge>
                  <p className="text-xs text-muted-foreground">Modo padrão. Agent desativado. Apenas importação CSV manual funciona.</p>
                </div>
                <div className="border rounded-lg p-3 border-primary/30 bg-primary/5">
                  <Badge className="mb-2">shadow_mode</Badge>
                  <p className="text-xs text-muted-foreground">Agent envia dados para staging. CSV continua sendo a fonte oficial. Reconciliação valida paridade.</p>
                </div>
                <div className="border rounded-lg p-3">
                  <Badge variant="secondary" className="mb-2">automatic_primary</Badge>
                  <p className="text-xs text-muted-foreground">Agent é a fonte primária. CSV pode ser usado como backup. Requer validação prévia em shadow_mode.</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
