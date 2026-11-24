import { describe, expect, it } from 'vitest';
import { tipoDeParadaDaOs } from '@/hooks/useRoutePlanner';

// PR 2.3: a OS do app passou a gravar a modalidade real e entra na rota — o tipo de parada não pode
// mais vir só do status (somente entrega em `pedido_recebido` virava COLETA no balcão do cliente).
describe('tipoDeParadaDaOs', () => {
  const IDA = ['pedido_recebido', 'aguardando_coleta'];
  const VOLTA = ['pronto_entrega', 'em_rota'];

  it('coleta e entrega: coleta na ida, entrega na volta', () => {
    for (const s of IDA) expect(tipoDeParadaDaOs('coleta_entrega', s)).toBe('pickup_tools');
    for (const s of VOLTA) expect(tipoDeParadaDaOs('coleta_entrega', s)).toBe('deliver_tools');
  });

  it('somente entrega: NENHUMA parada na ida (o cliente traz ao balcão); entrega na volta', () => {
    for (const s of IDA) expect(tipoDeParadaDaOs('somente_entrega', s)).toBeNull();
    for (const s of VOLTA) expect(tipoDeParadaDaOs('somente_entrega', s)).toBe('deliver_tools');
  });

  it('somente coleta: coleta na ida; NENHUMA parada na volta (o cliente retira)', () => {
    for (const s of IDA) expect(tipoDeParadaDaOs('somente_coleta', s)).toBe('pickup_tools');
    for (const s of VOLTA) expect(tipoDeParadaDaOs('somente_coleta', s)).toBeNull();
  });
});
