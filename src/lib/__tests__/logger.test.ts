import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock do supabase client antes de importar o logger
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

import { logger, type LogEntry } from '@/lib/logger';

describe('logger', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logger._clearBuffer();
    logger._setUserIdForTest(null);
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('severidades', () => {
    it('debug imprime em dev', () => {
      logger.debug('debug msg');
      expect(debugSpy).toHaveBeenCalled();
    });

    it('info imprime em dev', () => {
      logger.info('info msg');
      expect(infoSpy).toHaveBeenCalled();
    });

    it('warn imprime', () => {
      logger.warn('warn msg');
      expect(warnSpy).toHaveBeenCalled();
    });

    it('error imprime via console.error', () => {
      logger.error('err msg');
      expect(errorSpy).toHaveBeenCalled();
    });

    it('critical imprime via console.error', () => {
      logger.critical('critical msg');
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('buffer circular', () => {
    it('mantém somente os últimos 50 logs', () => {
      for (let i = 0; i < 60; i++) {
        logger.info(`msg-${i}`);
      }
      const recent = logger.getRecentLogs();
      expect(recent).toHaveLength(50);
      expect(recent[0].message).toBe('msg-10');
      expect(recent[49].message).toBe('msg-59');
    });

    it('getRecentLogs retorna cópia (não referência mutável)', () => {
      logger.info('test');
      const a = logger.getRecentLogs();
      a.pop();
      expect(logger.getRecentLogs()).toHaveLength(1);
    });
  });

  describe('enriquecimento de contexto', () => {
    it('adiciona timestamp ISO', () => {
      logger.info('msg');
      const entry = logger.getRecentLogs()[0];
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('adiciona build version', () => {
      logger.info('msg', { foo: 'bar' });
      const entry = logger.getRecentLogs()[0];
      expect(entry.context.build).toBeDefined();
    });

    it('adiciona user_id quando setado', () => {
      logger._setUserIdForTest('user-123');
      logger.info('msg');
      const entry = logger.getRecentLogs()[0];
      expect(entry.context.user_id).toBe('user-123');
    });

    it('contexto do dev tem precedência sobre auto', () => {
      logger._setUserIdForTest('cached-user');
      logger.info('msg', { user_id: 'override-user', extra: 1 });
      const entry = logger.getRecentLogs()[0];
      expect(entry.context.user_id).toBe('override-user');
      expect(entry.context.extra).toBe(1);
    });
  });

  describe('tratamento de Error', () => {
    it('extrai name, message, stack de Error', () => {
      const err = new Error('boom');
      logger.error(err);
      const entry = logger.getRecentLogs()[0];
      expect(entry.message).toBe('boom');
      expect(entry.error?.name).toBe('Error');
      expect(entry.error?.message).toBe('boom');
      expect(entry.error?.stack).toBeDefined();
    });

    it('extrai cause quando presente (ES2022)', () => {
      const root = new Error('root cause');
      const err = new Error('wrapper', { cause: root });
      logger.error(err);
      const entry = logger.getRecentLogs()[0];
      expect(entry.error?.cause).toBeDefined();
    });

    it('preserva contexto adicional ao receber Error', () => {
      logger.error(new Error('fail'), { orderId: 'abc' });
      const entry = logger.getRecentLogs()[0];
      expect(entry.context.orderId).toBe('abc');
      expect(entry.error?.message).toBe('fail');
    });
  });

  describe('LogEntry shape', () => {
    it('produz entrada com todos os campos esperados', () => {
      logger.warn('test', { foo: 1 });
      const entry: LogEntry = logger.getRecentLogs()[0];
      expect(entry.severity).toBe('warn');
      expect(entry.message).toBe('test');
      expect(entry.context.foo).toBe(1);
      expect(typeof entry.timestamp).toBe('string');
    });
  });
});
