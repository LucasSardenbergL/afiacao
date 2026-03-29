import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Shield, Key, RefreshCw, AlertTriangle, CheckCircle, Copy, ArrowRight, Trash2, Clock, Database, Fingerprint, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';

const BASE_URL_DISPLAY = 'https://<PROJECT_REF>.supabase.co/functions/v1/tint-sync-agent';

function CodeBlock({ code, title }: { code: string; title?: string }) {
  return (
    <div className="relative group">
      {title && <p className="text-xs font-semibold text-muted-foreground mb-1">{title}</p>}
      <Button
        variant="ghost" size="icon"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 h-7 w-7"
        onClick={() => { navigator.clipboard.writeText(code); toast.success('Copiado!'); }}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
      <pre className="bg-muted rounded-lg p-4 text-xs overflow-x-auto font-mono whitespace-pre leading-relaxed">
        {code}
      </pre>
    </div>
  );
}

function FieldTable({ fields }: { fields: { name: string; type: string; required: boolean; desc: string }[] }) {
  return (
    <div className="border rounded-lg overflow-hidden text-xs">
      <table className="w-full">
        <thead className="bg-muted">
          <tr>
            <th className="text-left p-2 font-semibold">Campo</th>
            <th className="text-left p-2 font-semibold">Tipo</th>
            <th className="text-left p-2 font-semibold">Obrig.</th>
            <th className="text-left p-2 font-semibold">Descrição</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.name} className="border-t">
              <td className="p-2 font-mono">{f.name}</td>
              <td className="p-2 text-muted-foreground">{f.type}</td>
              <td className="p-2">{f.required ? <Badge variant="destructive" className="text-[10px] px-1">sim</Badge> : <span className="text-muted-foreground">não</span>}</td>
              <td className="p-2 text-muted-foreground">{f.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── ENDPOINT DATA ───

const COMMON_HEADERS = `Content-Type: application/json
x-sync-token: <TOKEN_DA_LOJA>        (obrigatório)
x-store-code: <CODIGO_DA_LOJA>       (obrigatório)
x-idempotency-key: <UUID_DO_LOTE>    (opcional, recomendado em sync)`;

const RESPONSE_SCHEMA = `{
  "ok": true,                    // boolean — operação processada
  "sync_run_id": "uuid",         // string — ID do sync_run criado
  "batch_id": "uuid|null",       // string — eco do x-idempotency-key
  "idempotent_replay": false,    // boolean — true se foi replay
  "received_count": 10,          // int — total de itens recebidos
  "inserted_count": 8,           // int — inseridos com sucesso
  "updated_count": 0,            // int — atualizados (upsert)
  "ignored_count": 0,            // int — ignorados (duplicata lógica)
  "error_count": 2,              // int — falharam validação/inserção
  "errors": [                    // array — detalhes (max 50)
    {
      "entity_type": "formula",
      "entity_id": "COR-001",
      "message": "Missing required field: id_base"
    }
  ]
}`;

export default function TintApiContract() {
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setChecklist((p) => ({ ...p, [k]: !p[k] }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Contrato da API — Agent Local Windows</h1>
        <p className="text-muted-foreground mt-1">
          Especificação técnica completa para implementação do conector SAYERSYSTEM.
        </p>
        <div className="flex gap-2 mt-2">
          <Badge>v2.0</Badge>
          <Badge variant="outline">shadow_mode</Badge>
          <Badge variant="secondary">staging-only</Badge>
        </div>
      </div>

      <Tabs defaultValue="endpoints" className="space-y-4">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="endpoints">Endpoints</TabsTrigger>
          <TabsTrigger value="auth">Autenticação</TabsTrigger>
          <TabsTrigger value="idempotency">Idempotência</TabsTrigger>
          <TabsTrigger value="incremental">Incremental</TabsTrigger>
          <TabsTrigger value="responses">Respostas</TabsTrigger>
          <TabsTrigger value="deletion">Deleção</TabsTrigger>
          <TabsTrigger value="checklist">Checklist</TabsTrigger>
        </TabsList>

        {/* ═══════ ENDPOINTS ═══════ */}
        <TabsContent value="endpoints" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Base URL & Limites</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <CodeBlock code={BASE_URL_DISPLAY} />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mt-3">
                <div className="border rounded p-2 text-center"><p className="font-bold text-lg">1 000</p><p className="text-muted-foreground">Max itens/lote</p></div>
                <div className="border rounded p-2 text-center"><p className="font-bold text-lg">5 MB</p><p className="text-muted-foreground">Max payload</p></div>
                <div className="border rounded p-2 text-center"><p className="font-bold text-lg">60s</p><p className="text-muted-foreground">Timeout</p></div>
                <div className="border rounded p-2 text-center"><p className="font-bold text-lg">3</p><p className="text-muted-foreground">Max retries</p></div>
              </div>
            </CardContent>
          </Card>

          <Accordion type="multiple" className="space-y-2">
            {/* ── HEARTBEAT ── */}
            <AccordionItem value="heartbeat">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-3 text-left">
                  <Badge variant="outline" className="font-mono text-xs bg-primary/10 text-primary">POST</Badge>
                  <span className="font-mono text-sm">/heartbeat</span>
                  <span className="text-muted-foreground text-sm hidden sm:inline">— Sinal de vida do agent</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-4 pt-2">
                <p className="text-sm text-muted-foreground">Enviado periodicamente (recomendado: 60s). Idempotente por natureza. <strong>Semântica: snapshot do estado atual.</strong></p>
                <FieldTable fields={[
                  { name: 'agent_version', type: 'string', required: false, desc: 'Versão do executável Windows' },
                  { name: 'hostname', type: 'string', required: false, desc: 'Nome do computador' },
                  { name: 'uptime_seconds', type: 'integer', required: false, desc: 'Segundos desde o boot do agent' },
                  { name: 'db_connected', type: 'boolean', required: false, desc: 'PostgreSQL local está acessível' },
                ]} />
                <CodeBlock title="Request" code={`POST /heartbeat
Headers: x-sync-token, x-store-code

{
  "agent_version": "1.2.0",
  "hostname": "LOJA01-PC",
  "uptime_seconds": 86400,
  "db_connected": true
}`} />
                <CodeBlock title="Response 200" code={`{
  "ok": true,
  "server_time": "2026-03-29T18:00:00.000Z"
}`} />
                <CodeBlock title="Response 401" code={`{ "ok": false, "error": "Invalid token or store" }`} />
              </AccordionContent>
            </AccordionItem>

            {/* ── TEST ── */}
            <AccordionItem value="test">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-3 text-left">
                  <Badge variant="outline" className="font-mono text-xs bg-primary/10 text-primary">POST</Badge>
                  <span className="font-mono text-sm">/test</span>
                  <span className="text-muted-foreground text-sm hidden sm:inline">— Teste de conexão</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-4 pt-2">
                <p className="text-sm text-muted-foreground">Valida token + loja. Somente leitura, sem efeitos colaterais. Usar na configuração inicial.</p>
                <CodeBlock title="Request" code={`POST /test
Headers: x-sync-token, x-store-code

{} // body vazio`} />
                <CodeBlock title="Response 200" code={`{
  "ok": true,
  "account": "oben",
  "store_code": "LOJA01"
}`} />
              </AccordionContent>
            </AccordionItem>

            {/* ── CATALOGS ── */}
            <AccordionItem value="catalogs">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-3 text-left">
                  <Badge variant="outline" className="font-mono text-xs bg-primary/10 text-primary">POST</Badge>
                  <span className="font-mono text-sm">/catalogs</span>
                  <span className="text-muted-foreground text-sm hidden sm:inline">— Sync de catálogo</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-4 pt-2">
                <div className="flex gap-2 flex-wrap">
                  <Badge variant="secondary">Semântica: delta/upsert</Badge>
                  <Badge variant="outline">Idempotência: x-idempotency-key</Badge>
                  <Badge variant="outline">Max: 1000 itens/entidade</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  Envia produtos, bases, embalagens, SKUs e corantes alterados desde o último checkpoint.
                  Dados vão para staging — NÃO altera tabelas oficiais.
                </p>

                <h4 className="font-semibold text-sm">Campos por entidade</h4>
                <Accordion type="multiple">
                  <AccordionItem value="cat-produtos">
                    <AccordionTrigger className="text-xs py-2">produtos[]</AccordionTrigger>
                    <AccordionContent>
                      <FieldTable fields={[
                        { name: 'cod_produto', type: 'string', required: true, desc: 'Código do produto no SAYER (ex: WFO0098)' },
                        { name: 'descricao', type: 'string', required: true, desc: 'Nome/descrição do produto' },
                        { name: 'ativo', type: 'boolean', required: false, desc: 'Se o produto está ativo (default true)' },
                        { name: 'updated_at', type: 'ISO 8601', required: false, desc: 'Timestamp da última alteração no banco local' },
                      ]} />
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="cat-bases">
                    <AccordionTrigger className="text-xs py-2">bases[]</AccordionTrigger>
                    <AccordionContent>
                      <FieldTable fields={[
                        { name: 'id_base_sayersystem', type: 'string', required: true, desc: 'ID da base no SAYER' },
                        { name: 'descricao', type: 'string', required: true, desc: 'Nome da base' },
                        { name: 'ativo', type: 'boolean', required: false, desc: 'Default true' },
                      ]} />
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="cat-embalagens">
                    <AccordionTrigger className="text-xs py-2">embalagens[]</AccordionTrigger>
                    <AccordionContent>
                      <FieldTable fields={[
                        { name: 'id_embalagem_sayersystem', type: 'string', required: true, desc: 'ID da embalagem no SAYER' },
                        { name: 'descricao', type: 'string', required: true, desc: 'Nome (ex: Galão 3.6L)' },
                        { name: 'volume_ml', type: 'number', required: true, desc: 'Volume em mililitros' },
                      ]} />
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="cat-corantes">
                    <AccordionTrigger className="text-xs py-2">corantes[]</AccordionTrigger>
                    <AccordionContent>
                      <FieldTable fields={[
                        { name: 'id_corante_sayersystem', type: 'string', required: true, desc: 'ID do corante (ex: AX, BV, RO)' },
                        { name: 'descricao', type: 'string', required: true, desc: 'Nome do corante' },
                        { name: 'preco_litro', type: 'number', required: false, desc: 'Preço por litro (R$)' },
                      ]} />
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="cat-skus">
                    <AccordionTrigger className="text-xs py-2">skus[]</AccordionTrigger>
                    <AccordionContent>
                      <FieldTable fields={[
                        { name: 'cod_produto', type: 'string', required: true, desc: 'Referência ao produto' },
                        { name: 'id_base', type: 'string', required: true, desc: 'Referência à base' },
                        { name: 'id_embalagem', type: 'string', required: true, desc: 'Referência à embalagem' },
                      ]} />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>

                <CodeBlock title="Request completo" code={`POST /catalogs
Headers:
  x-sync-token: abc-123
  x-store-code: LOJA01
  x-idempotency-key: batch-cat-20260329-001

{
  "produtos": [
    { "cod_produto": "WFO0098", "descricao": "WANDEPOXY BR 0098 BRANCO", "ativo": true }
  ],
  "bases": [
    { "id_base_sayersystem": "BASE-T", "descricao": "Base T - Transparente" }
  ],
  "embalagens": [
    { "id_embalagem_sayersystem": "EMB-3600", "descricao": "Galão 3.6L", "volume_ml": 3600 }
  ],
  "corantes": [
    { "id_corante_sayersystem": "AX", "descricao": "Amarelo Óxido", "preco_litro": 45.90 }
  ],
  "skus": [
    { "cod_produto": "WFO0098", "id_base": "BASE-T", "id_embalagem": "EMB-3600" }
  ]
}`} />
                <div className="grid gap-3 md:grid-cols-2">
                  <CodeBlock title="✅ Sucesso total (200)" code={`{
  "ok": true,
  "sync_run_id": "uuid-run",
  "batch_id": "batch-cat-20260329-001",
  "idempotent_replay": false,
  "received_count": 5,
  "inserted_count": 5,
  "updated_count": 0,
  "ignored_count": 0,
  "error_count": 0,
  "errors": []
}`} />
                  <CodeBlock title="⚠️ Sucesso parcial (200)" code={`{
  "ok": true,
  "sync_run_id": "uuid-run",
  "batch_id": "batch-cat-20260329-001",
  "idempotent_replay": false,
  "received_count": 5,
  "inserted_count": 3,
  "updated_count": 0,
  "ignored_count": 0,
  "error_count": 2,
  "errors": [
    { "entity_type": "corantes",
      "entity_id": "AX",
      "message": "duplicate key" }
  ]
}`} />
                </div>
                <CodeBlock title="🔄 Replay idempotente (200)" code={`{
  "ok": true,
  "sync_run_id": "uuid-run-original",
  "batch_id": "batch-cat-20260329-001",
  "idempotent_replay": true,
  "received_count": 5,
  "inserted_count": 5,
  "updated_count": 0,
  "ignored_count": 0,
  "error_count": 0,
  "errors": []
}`} />
              </AccordionContent>
            </AccordionItem>

            {/* ── FORMULAS ── */}
            <AccordionItem value="formulas">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-3 text-left">
                  <Badge variant="outline" className="font-mono text-xs bg-primary/10 text-primary">POST</Badge>
                  <span className="font-mono text-sm">/formulas</span>
                  <span className="text-muted-foreground text-sm hidden sm:inline">— Sync de fórmulas</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-4 pt-2">
                <div className="flex gap-2 flex-wrap">
                  <Badge variant="secondary">Semântica: delta</Badge>
                  <Badge variant="outline">Idempotência: x-idempotency-key</Badge>
                  <Badge variant="outline">Max: 1000 fórmulas/lote</Badge>
                </div>

                <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
                  <h4 className="font-semibold text-sm flex items-center gap-1.5"><Fingerprint className="h-4 w-4" /> Chave Lógica de Unicidade</h4>
                  <code className="text-sm font-mono bg-muted px-2 py-1 rounded mt-1 inline-block">cor_id | cod_produto | id_base | id_embalagem</code>
                  <p className="text-xs text-muted-foreground mt-2">
                    <strong>subcolecao NÃO faz parte da chave de unicidade.</strong> Uma mesma cor pode ter subcoleção diferente sem ser considerada fórmula distinta.
                    A subcoleção é informação descritiva armazenada junto à fórmula mas não participa do pareamento na reconciliação.
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Esta chave é idêntica à usada na função <code>tint_run_reconciliation</code> e no staging.
                  </p>
                </div>

                <FieldTable fields={[
                  { name: 'cor_id', type: 'string', required: true, desc: 'ID da cor no SAYER' },
                  { name: 'nome_cor', type: 'string', required: true, desc: 'Nome da cor' },
                  { name: 'cod_produto', type: 'string', required: true, desc: 'Código do produto (ref)' },
                  { name: 'id_base', type: 'string', required: true, desc: 'ID da base SAYER (ref)' },
                  { name: 'id_embalagem', type: 'string', required: true, desc: 'ID da embalagem SAYER (ref)' },
                  { name: 'subcolecao', type: 'string', required: false, desc: 'Subcoleção (descritivo, não é chave)' },
                  { name: 'volume_final_ml', type: 'number', required: false, desc: 'Volume final em ml' },
                  { name: 'preco_final', type: 'number', required: false, desc: 'Preço final calculado pelo SAYER' },
                  { name: 'personalizada', type: 'boolean', required: false, desc: 'Default false' },
                  { name: 'itens', type: 'array', required: false, desc: 'Lista de corantes da fórmula' },
                ]} />
                <FieldTable fields={[
                  { name: 'itens[].id_corante', type: 'string', required: true, desc: 'ID do corante usado' },
                  { name: 'itens[].ordem', type: 'integer', required: true, desc: 'Ordem de dispensação (1-6)' },
                  { name: 'itens[].qtd_ml', type: 'number', required: true, desc: 'Quantidade em ml' },
                ]} />

                <CodeBlock title="Request completo" code={`POST /formulas
Headers:
  x-sync-token: abc-123
  x-store-code: LOJA01
  x-idempotency-key: batch-form-20260329-001

{
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
        { "id_corante": "AX", "ordem": 1, "qtd_ml": 12.5 },
        { "id_corante": "BV", "ordem": 2, "qtd_ml": 8.3 },
        { "id_corante": "RO", "ordem": 3, "qtd_ml": 3.1 }
      ]
    }
  ]
}`} />
                <CodeBlock title="❌ Erro de validação (200 com errors)" code={`{
  "ok": true,
  "sync_run_id": "uuid",
  "batch_id": "batch-form-20260329-001",
  "idempotent_replay": false,
  "received_count": 2,
  "inserted_count": 1,
  "updated_count": 0,
  "ignored_count": 0,
  "error_count": 1,
  "errors": [
    { "entity_type": "formula",
      "entity_id": null,
      "message": "Missing required field: cor_id, cod_produto, id_base, id_embalagem" }
  ]
}`} />
              </AccordionContent>
            </AccordionItem>

            {/* ── PREPARATIONS ── */}
            <AccordionItem value="preparations">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-3 text-left">
                  <Badge variant="outline" className="font-mono text-xs bg-primary/10 text-primary">POST</Badge>
                  <span className="font-mono text-sm">/preparations</span>
                  <span className="text-muted-foreground text-sm hidden sm:inline">— Sync de preparações</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-4 pt-2">
                <div className="flex gap-2 flex-wrap">
                  <Badge variant="secondary">Semântica: append-only</Badge>
                  <Badge variant="outline">Idempotência: x-idempotency-key</Badge>
                  <Badge variant="outline">Max: 1000 preparações/lote</Badge>
                </div>

                <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
                  <h4 className="font-semibold text-sm flex items-center gap-1.5"><Fingerprint className="h-4 w-4" /> Chave Lógica</h4>
                  <code className="text-sm font-mono bg-muted px-2 py-1 rounded mt-1 inline-block">preparacao_id</code>
                  <p className="text-xs text-muted-foreground mt-1">Único por evento de preparação. Gerado pelo banco local do SAYER.</p>
                </div>

                <FieldTable fields={[
                  { name: 'preparacao_id', type: 'string', required: true, desc: 'ID único da preparação no SAYER' },
                  { name: 'cor_id', type: 'string', required: true, desc: 'ID da cor preparada' },
                  { name: 'nome_cor', type: 'string', required: false, desc: 'Nome da cor' },
                  { name: 'cod_produto', type: 'string', required: true, desc: 'Código do produto' },
                  { name: 'id_base', type: 'string', required: true, desc: 'ID da base' },
                  { name: 'id_embalagem', type: 'string', required: true, desc: 'ID da embalagem' },
                  { name: 'volume_ml', type: 'number', required: false, desc: 'Volume preparado em ml' },
                  { name: 'preco', type: 'number', required: false, desc: 'Preço cobrado' },
                  { name: 'cliente', type: 'string', required: false, desc: 'Nome do cliente' },
                  { name: 'data_preparacao', type: 'ISO 8601', required: false, desc: 'Quando foi preparado' },
                  { name: 'personalizada', type: 'boolean', required: false, desc: 'Default false' },
                  { name: 'itens', type: 'array', required: false, desc: 'Corantes dispensados' },
                ]} />
                <FieldTable fields={[
                  { name: 'itens[].id_corante', type: 'string', required: true, desc: 'ID do corante' },
                  { name: 'itens[].ordem', type: 'integer', required: false, desc: 'Ordem de dispensação' },
                  { name: 'itens[].qtd_ml', type: 'number', required: true, desc: 'ml dispensados' },
                ]} />

                <CodeBlock title="Request completo" code={`POST /preparations
Headers:
  x-sync-token: abc-123
  x-store-code: LOJA01
  x-idempotency-key: batch-prep-20260329-001

{
  "preparacoes": [
    {
      "preparacao_id": "PREP-20260329-001",
      "cor_id": "2345",
      "nome_cor": "AZUL INFINITO",
      "cod_produto": "WFO0098",
      "id_base": "BASE-T",
      "id_embalagem": "EMB-3600",
      "volume_ml": 3600,
      "preco": 189.50,
      "cliente": "José da Silva",
      "data_preparacao": "2026-03-29T14:30:00-03:00",
      "personalizada": false,
      "itens": [
        { "id_corante": "AX", "ordem": 1, "qtd_ml": 12.48 },
        { "id_corante": "BV", "ordem": 2, "qtd_ml": 8.31 }
      ]
    }
  ]
}`} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </TabsContent>

        {/* ═══════ AUTH ═══════ */}
        <TabsContent value="auth" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Key className="h-5 w-5" /> Autenticação por Token por Loja</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Cada loja possui um <strong>sync_token</strong> (UUID v4) gerado na tela de Integrações.
              </p>
              <CodeBlock title="Headers obrigatórios" code={`x-sync-token: 550e8400-e29b-41d4-a716-446655440000
x-store-code: LOJA01`} />
              <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 space-y-2">
                <h4 className="font-semibold text-sm flex items-center gap-1.5 text-destructive"><Shield className="h-4 w-4" /> Segurança</h4>
                <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                  <li>Armazenar token no Windows Credential Manager, nunca em texto plano</li>
                  <li>Token inválido ou loja desativada → <code>401</code></li>
                  <li>Token pode ser regenerado na tela de Integrações (invalida o anterior imediatamente)</li>
                  <li>Cada loja tem seu próprio token — nunca compartilhar</li>
                  <li>O campo <code>sync_enabled</code> deve estar <code>true</code></li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══════ IDEMPOTENCY ═══════ */}
        <TabsContent value="idempotency" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><RefreshCw className="h-5 w-5" /> Idempotência Real</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                O header <code>x-idempotency-key</code> garante que o reenvio do mesmo lote retorne a mesma resposta
                sem duplicar dados no staging nem criar sync_run redundante.
              </p>

              <div className="space-y-3">
                <h4 className="font-semibold text-sm">Como funciona</h4>
                <ol className="text-sm space-y-2 list-decimal list-inside text-muted-foreground">
                  <li>Agent gera um UUID v4 como <code>x-idempotency-key</code> para cada lote</li>
                  <li>Servidor verifica se já existe um <code>sync_run</code> com essa key + setting_id + sync_type</li>
                  <li>Se <strong>existe</strong>: retorna a resposta armazenada com <code>"idempotent_replay": true</code></li>
                  <li>Se <strong>não existe</strong>: processa normalmente, salva a resposta no campo <code>idempotency_response</code></li>
                </ol>
              </div>

              <CodeBlock title="Índice único no banco" code={`CREATE UNIQUE INDEX idx_tint_sync_runs_idempotency
  ON tint_sync_runs (setting_id, sync_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;`} />

              <div className="bg-muted rounded-lg p-3 border space-y-2">
                <h4 className="font-semibold text-sm">Retry seguro — algoritmo recomendado</h4>
                <CodeBlock code={`const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-token': token,
        'x-store-code': storeCode,
        'x-idempotency-key': batchId, // MESMO UUID em todas as tentativas
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 401) {
      // Token inválido — não fazer retry
      throw new Error('AUTH_FAILED');
    }
    if (res.status === 400) {
      // Payload inválido — não fazer retry
      throw new Error('INVALID_PAYLOAD');
    }
    if (res.ok) {
      const data = await res.json();
      saveCheckpoint(data.sync_run_id);
      return data;
    }
    // 500 ou outro: retry
  } catch (e) {
    if (e.message === 'AUTH_FAILED' || e.message === 'INVALID_PAYLOAD') throw e;
    // Erro de rede: retry
  }
  await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
}
throw new Error('MAX_RETRIES_EXCEEDED');`} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══════ INCREMENTAL ═══════ */}
        <TabsContent value="incremental" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Clock className="h-5 w-5" /> Semântica Incremental por Endpoint</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="border rounded-lg overflow-hidden text-sm">
                <table className="w-full">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left p-3 font-semibold">Endpoint</th>
                      <th className="text-left p-3 font-semibold">Semântica</th>
                      <th className="text-left p-3 font-semibold">Checkpoint</th>
                      <th className="text-left p-3 font-semibold">Descrição</th>
                    </tr>
                  </thead>
                  <tbody className="text-muted-foreground">
                    <tr className="border-t">
                      <td className="p-3 font-mono">/heartbeat</td>
                      <td className="p-3"><Badge variant="outline">snapshot</Badge></td>
                      <td className="p-3">N/A</td>
                      <td className="p-3">Sempre envia o estado completo atual do agent</td>
                    </tr>
                    <tr className="border-t">
                      <td className="p-3 font-mono">/catalogs</td>
                      <td className="p-3"><Badge variant="secondary">delta</Badge></td>
                      <td className="p-3"><code>updated_at</code></td>
                      <td className="p-3">Enviar apenas registros alterados desde o último sync bem-sucedido</td>
                    </tr>
                    <tr className="border-t">
                      <td className="p-3 font-mono">/formulas</td>
                      <td className="p-3"><Badge variant="secondary">delta</Badge></td>
                      <td className="p-3"><code>updated_at</code></td>
                      <td className="p-3">Enviar fórmulas alteradas desde o checkpoint. Lotes de até 500 recomendados.</td>
                    </tr>
                    <tr className="border-t">
                      <td className="p-3 font-mono">/preparations</td>
                      <td className="p-3"><Badge>append-only</Badge></td>
                      <td className="p-3"><code>id sequencial</code></td>
                      <td className="p-3">Enviar apenas preparações novas (nunca retroativa). Não há update.</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="space-y-3">
                <h4 className="font-semibold text-sm flex items-center gap-1.5"><Database className="h-4 w-4" /> Checkpoint local do agent</h4>
                <CodeBlock code={`// checkpoint.json (mantido pelo agent)
{
  "catalogs": {
    "last_sync_run_id": "uuid",
    "last_updated_at": "2026-03-29T18:00:00Z",
    "last_success": true
  },
  "formulas": {
    "last_sync_run_id": "uuid",
    "last_updated_at": "2026-03-29T18:00:00Z",
    "last_id_seq": 477231
  },
  "preparations": {
    "last_sync_run_id": "uuid",
    "last_id": 9842,
    "last_success": true
  }
}`} />
              </div>

              <div className="bg-muted/50 border rounded-lg p-3 space-y-2">
                <h4 className="font-semibold text-sm">Clock Skew e Empates de Timestamp</h4>
                <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                  <li><strong>Margem de segurança:</strong> ao consultar delta por <code>updated_at</code>, subtrair 5 minutos do último checkpoint para cobrir clock skew entre máquinas</li>
                  <li><strong>Empate:</strong> se múltiplos registros têm o mesmo <code>updated_at</code>, incluir todos — o staging aceita duplicatas e a reconciliação filtra</li>
                  <li><strong>Fórmulas:</strong> preferir <code>id_seq</code> como checkpoint secundário (sequencial no PostgreSQL local) quando disponível</li>
                  <li><strong>Preparações:</strong> usar exclusivamente o ID sequencial (auto-increment) — nunca <code>updated_at</code></li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══════ RESPONSES ═══════ */}
        <TabsContent value="responses" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Esquema de Resposta Padronizado</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <CodeBlock title="Estrutura completa" code={RESPONSE_SCHEMA} />

              <div className="border rounded-lg overflow-hidden text-xs">
                <table className="w-full">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left p-2 font-semibold">Campo</th>
                      <th className="text-left p-2 font-semibold">Tipo</th>
                      <th className="text-left p-2 font-semibold">Significado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ['ok', 'boolean', 'true = request processado (pode ter erros parciais). false = falha geral (401/400/500).'],
                      ['sync_run_id', 'string', 'UUID do sync_run criado. Usar para rastreio e reconciliação.'],
                      ['batch_id', 'string|null', 'Eco do x-idempotency-key. null se não enviado.'],
                      ['idempotent_replay', 'boolean', 'true = este é um replay de lote já processado. Nenhum dado foi duplicado.'],
                      ['received_count', 'integer', 'Total de itens recebidos no payload.'],
                      ['inserted_count', 'integer', 'Registros inseridos com sucesso no staging.'],
                      ['updated_count', 'integer', 'Registros atualizados (reservado para futuro upsert).'],
                      ['ignored_count', 'integer', 'Registros ignorados (duplicata lógica no mesmo lote).'],
                      ['error_count', 'integer', 'Registros que falharam (validação ou inserção).'],
                      ['errors[]', 'array', 'Detalhes dos primeiros 50 erros. Cada um com entity_type, entity_id, message.'],
                    ].map(([field, type, desc]) => (
                      <tr key={field} className="border-t">
                        <td className="p-2 font-mono">{field}</td>
                        <td className="p-2 text-muted-foreground">{type}</td>
                        <td className="p-2 text-muted-foreground">{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <h4 className="font-semibold text-sm flex items-center gap-1.5"><CheckCircle className="h-4 w-4 text-green-500" /> HTTP Status Codes</h4>
                  <ul className="text-xs text-muted-foreground space-y-1">
                    <li><code>200</code> — Processado (verificar error_count para parcial)</li>
                    <li><code>400</code> — Payload inválido (batch excede limite, campo faltante)</li>
                    <li><code>401</code> — Token inválido ou loja desativada</li>
                    <li><code>404</code> — Endpoint não existe</li>
                    <li><code>500</code> — Erro interno do servidor</li>
                  </ul>
                </div>
                <div className="space-y-2">
                  <h4 className="font-semibold text-sm flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 text-destructive" /> Quando NÃO fazer retry</h4>
                  <ul className="text-xs text-muted-foreground space-y-1">
                    <li><code>401</code> — Verificar token na configuração</li>
                    <li><code>400</code> — Corrigir payload antes de reenviar</li>
                    <li><code>404</code> — Verificar URL do endpoint</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══════ DELETION ═══════ */}
        <TabsContent value="deletion" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5" /> Deleção e Inativação</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-muted/50 border rounded-lg p-4 space-y-3">
                <h4 className="font-semibold">Política: Ausência sem efeito + soft delete via flag</h4>
                <p className="text-sm text-muted-foreground">
                  O contrato <strong>não possui endpoint de deleção</strong>. A remoção de registros é tratada assim:
                </p>

                <div className="space-y-3">
                  <div className="border rounded-lg p-3 bg-background">
                    <h5 className="font-semibold text-sm">Produtos, Bases, Embalagens, Corantes</h5>
                    <ul className="text-xs text-muted-foreground mt-1 space-y-1 list-disc list-inside">
                      <li>Se um item foi removido ou desativado no SAYER, o agent envia <code>"ativo": false</code> no próximo sync de catálogo</li>
                      <li>Se o item simplesmente não aparece no delta, nada acontece — a ausência não é interpretada como deleção</li>
                      <li>A reconciliação pode detectar itens que existem no CSV mas não no sync (status "Só CSV") — isso é informativo, não deleta</li>
                    </ul>
                  </div>

                  <div className="border rounded-lg p-3 bg-background">
                    <h5 className="font-semibold text-sm">Fórmulas</h5>
                    <ul className="text-xs text-muted-foreground mt-1 space-y-1 list-disc list-inside">
                      <li>Fórmulas removidas do SAYER não são deletadas automaticamente</li>
                      <li>O operador pode identificá-las via reconciliação ("Só CSV") e decidir manualmente</li>
                      <li>Em modo <code>automatic_primary</code> futuro, a ausência prolongada poderá gerar alerta</li>
                    </ul>
                  </div>

                  <div className="border rounded-lg p-3 bg-background">
                    <h5 className="font-semibold text-sm">Preparações</h5>
                    <ul className="text-xs text-muted-foreground mt-1 space-y-1 list-disc list-inside">
                      <li>Preparações são <strong>append-only</strong> — nunca são deletadas ou alteradas</li>
                      <li>Representam eventos de venda imutáveis</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 text-xs">
                  <strong>Resumo:</strong> Nenhum registro é deletado via API. A inativação usa <code>ativo: false</code>.
                  A ausência de um registro no delta não é tratada como tombstone. Deleção física é responsabilidade do operador via painel admin.
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══════ CHECKLIST ═══════ */}
        <TabsContent value="checklist" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ListChecks className="h-5 w-5" /> Checklist: Pronto para Implementar Agent</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                { id: 'auth', label: 'Autenticação por token configurada na tela de Integrações' },
                { id: 'test', label: 'Endpoint /test retorna ok:true com token válido' },
                { id: 'heartbeat', label: 'Loop de heartbeat (60s) implementado com retry' },
                { id: 'checkpoint', label: 'Arquivo de checkpoint local implementado (JSON ou SQLite)' },
                { id: 'idempotency', label: 'x-idempotency-key gerado para cada lote de sync' },
                { id: 'catalog-delta', label: 'Sync de catálogo envia apenas registros com updated_at > checkpoint' },
                { id: 'formula-delta', label: 'Sync de fórmulas envia delta por updated_at com margem de 5 min' },
                { id: 'prep-append', label: 'Sync de preparações usa ID sequencial como checkpoint (append-only)' },
                { id: 'batch-limit', label: 'Lotes limitados a 1000 itens por entidade' },
                { id: 'retry', label: 'Retry com backoff exponencial (3 tentativas, não retry em 401/400)' },
                { id: 'token-secure', label: 'Token armazenado no Windows Credential Manager' },
                { id: 'clock-skew', label: 'Margem de 5 minutos no checkpoint para clock skew' },
                { id: 'error-handling', label: 'Erros parciais (error_count > 0) são logados localmente' },
                { id: 'ativo-flag', label: 'Registros inativos enviados com ativo:false (não omitidos)' },
                { id: 'shadow-mode', label: 'Integração configurada em shadow_mode para validação inicial' },
                { id: 'reconciliation', label: 'Operador validou reconciliação com dados reais antes de ativar automatic_primary' },
              ].map((item) => (
                <div key={item.id} className="flex items-start gap-3 py-1">
                  <Checkbox
                    id={item.id}
                    checked={!!checklist[item.id]}
                    onCheckedChange={() => toggle(item.id)}
                    className="mt-0.5"
                  />
                  <label htmlFor={item.id} className="text-sm cursor-pointer leading-snug">
                    {item.label}
                  </label>
                </div>
              ))}

              <div className="border-t pt-4 mt-4">
                <p className="text-sm text-muted-foreground">
                  {Object.values(checklist).filter(Boolean).length} de 16 itens concluídos
                </p>
                <div className="w-full bg-muted rounded-full h-2 mt-2">
                  <div
                    className="bg-primary h-2 rounded-full transition-all"
                    style={{ width: `${(Object.values(checklist).filter(Boolean).length / 16) * 100}%` }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
