// src/lib/call-log/recording-policy.ts
import type { CallPartyKind } from '@/types/call-log';

/** Auto-grava (e toca a Sara) quando é cliente OU fornecedor cadastrado. */
export function shouldAutoRecord(kind: CallPartyKind): boolean {
  return kind === 'cliente' || kind === 'fornecedor';
}
