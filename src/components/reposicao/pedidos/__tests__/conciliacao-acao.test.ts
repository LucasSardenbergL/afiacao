import { describe, it, expect } from 'vitest';
import { decidirAcaoPortal, podeCancelarPorRecusaDefinitiva } from '../shared';

describe('decidirAcaoPortal (Fase 3 · 3b)', () => {
  it('aceito_portal_sem_protocolo → conciliar SEM aviso (PO quase-certamente já existe)', () => {
    const a = decidirAcaoPortal('aceito_portal_sem_protocolo');
    expect(a.kind).toBe('conciliar');
    expect(a).toEqual({ kind: 'conciliar', warn: false });
  });

  it('indeterminado_requer_conciliacao → conciliar COM aviso (risco de duplicar)', () => {
    const a = decidirAcaoPortal('indeterminado_requer_conciliacao');
    expect(a.kind).toBe('conciliar');
    expect(a).toEqual({ kind: 'conciliar', warn: true });
  });

  it('erros genuínos (sem PO) → reenviar é seguro', () => {
    expect(decidirAcaoPortal('erro_retentavel').kind).toBe('reenviar');
    expect(decidirAcaoPortal('falha_envio_portal').kind).toBe('reenviar');
    expect(decidirAcaoPortal('erro_nao_retentavel').kind).toBe('reenviar');
  });

  it('sucesso / em-trânsito / nao_aplicavel → nenhuma ação destrutiva (não oferecer reset = anti-duplicação)', () => {
    expect(decidirAcaoPortal('sucesso_portal').kind).toBe('nenhuma');
    expect(decidirAcaoPortal('enviado_portal').kind).toBe('nenhuma');
    expect(decidirAcaoPortal('enviando_portal').kind).toBe('nenhuma');
    expect(decidirAcaoPortal('pendente_envio_portal').kind).toBe('nenhuma');
    expect(decidirAcaoPortal('nao_aplicavel').kind).toBe('nenhuma');
  });

  it('null/undefined → trata como nao_aplicavel (nenhuma ação)', () => {
    expect(decidirAcaoPortal(null).kind).toBe('nenhuma');
    expect(decidirAcaoPortal(undefined).kind).toBe('nenhuma');
  });

  it('um estado conciliável NUNCA cai em reenviar (não pode resetar conciliação = risco PO duplo)', () => {
    expect(decidirAcaoPortal('aceito_portal_sem_protocolo').kind).not.toBe('reenviar');
    expect(decidirAcaoPortal('indeterminado_requer_conciliacao').kind).not.toBe('reenviar');
  });
});

/* ─── Saída do pedido recusado em definitivo (beco "aprovado + erro_nao_retentavel") ─── */
//
// Achado P1 do challenge Codex retroativo do #2198: a edge recusa pré-Browserless gravando SÓ
// `status_envio_portal='erro_nao_retentavel'` — o `status` segue `aprovado_aguardando_disparo`, e a
// única ação que a tela oferecia era "Forçar reenvio", que repete a MESMA recusa indefinidamente.
// Decisão do founder (2026-09-06): política (c) — cancelar + o ciclo regrava (alinhada à Decisão 3
// do #2187, "sem reabertura"); nada de reabrir para `pendente_aprovacao` nem editar item aprovado.
//
// Precisão > recall: só oferece cancelar onde o cancelamento é a saída CERTA. Onde um PO pode
// existir no fornecedor (conciliáveis) ou já existe no Omie (`disparado`), oferecer "cancelar"
// seria uma saída FALSA — pior que nenhuma.
describe('podeCancelarPorRecusaDefinitiva (beco da recusa definitiva)', () => {
  it('erro_nao_retentavel + aprovado_aguardando_disparo → cancelar (o caso VIVO em prod: pedido #2388)', () => {
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'aprovado_aguardando_disparo',
      status_envio_portal: 'erro_nao_retentavel',
    })).toBe(true);
  });

  it('erro_nao_retentavel + pendente_aprovacao/bloqueado_guardrail → cancelar', () => {
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'pendente_aprovacao', status_envio_portal: 'erro_nao_retentavel',
    })).toBe(true);
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'bloqueado_guardrail', status_envio_portal: 'erro_nao_retentavel',
    })).toBe(true);
  });

  it('erro_nao_retentavel + disparado → NÃO (PO real no Omie; cancelar seria saída falsa)', () => {
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'disparado', status_envio_portal: 'erro_nao_retentavel',
    })).toBe(false);
  });

  it('erro_nao_retentavel + já cancelado/expirado → NÃO (nada a cancelar)', () => {
    for (const status of ['cancelado', 'cancelado_humano', 'expirado_sem_aprovacao', 'split_em_filhos']) {
      expect(podeCancelarPorRecusaDefinitiva({ status, status_envio_portal: 'erro_nao_retentavel' })).toBe(false);
    }
  });

  it('erro_retentavel → NÃO (o motor sayerlack-retry-orfaos drena sozinho; cancelar mataria pedido bom)', () => {
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'aprovado_aguardando_disparo', status_envio_portal: 'erro_retentavel',
    })).toBe(false);
  });

  it('falha_envio_portal → NÃO (reenvio ali é legítimo; fora do escopo da decisão (c))', () => {
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'aprovado_aguardando_disparo', status_envio_portal: 'falha_envio_portal',
    })).toBe(false);
  });

  it('conciliáveis → NÃO (PO pode/deve existir no fornecedor — conciliar antes de cancelar)', () => {
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'aprovado_aguardando_disparo', status_envio_portal: 'aceito_portal_sem_protocolo',
    })).toBe(false);
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'aprovado_aguardando_disparo', status_envio_portal: 'indeterminado_requer_conciliacao',
    })).toBe(false);
  });

  it('sucesso/em-voo/nao_aplicavel/ausente → NÃO', () => {
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'aprovado_aguardando_disparo', status_envio_portal: 'sucesso_portal',
    })).toBe(false);
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'aprovado_aguardando_disparo', status_envio_portal: 'enviando_portal',
    })).toBe(false);
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'aprovado_aguardando_disparo', status_envio_portal: 'nao_aplicavel',
    })).toBe(false);
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'aprovado_aguardando_disparo', status_envio_portal: null,
    })).toBe(false);
    expect(podeCancelarPorRecusaDefinitiva({
      status: 'aprovado_aguardando_disparo', status_envio_portal: undefined,
    })).toBe(false);
  });
});
