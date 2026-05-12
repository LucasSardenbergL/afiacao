import { describe, it, expect } from 'vitest';
import type { AppRole } from '@/contexts/AuthContext';

/**
 * Pure logic extracted from AuthContext — mirrors the staff-role derivation.
 */
function deriveRoleFlags(role: AppRole | null) {
  const isMaster = role === 'master';
  const isEmployee = role === 'employee';
  const isCustomer = role === 'customer';
  const isStaff = isMaster || isEmployee;
  return { role, isMaster, isEmployee, isCustomer, isStaff };
}

describe('AuthContext role derivation', () => {
  it('derives master flags correctly', () => {
    const flags = deriveRoleFlags('master');
    expect(flags.role).toBe('master');
    expect(flags.isMaster).toBe(true);
    expect(flags.isStaff).toBe(true);
    expect(flags.isEmployee).toBe(false);
    expect(flags.isCustomer).toBe(false);
  });

  it('derives employee flags correctly', () => {
    const flags = deriveRoleFlags('employee');
    expect(flags.role).toBe('employee');
    expect(flags.isEmployee).toBe(true);
    expect(flags.isStaff).toBe(true);
    expect(flags.isMaster).toBe(false);
  });

  it('returns null role and all false flags when unauthenticated', () => {
    const flags = deriveRoleFlags(null);
    expect(flags.role).toBeNull();
    expect(flags.isEmployee).toBe(false);
    expect(flags.isMaster).toBe(false);
    expect(flags.isStaff).toBe(false);
    expect(flags.isCustomer).toBe(false);
  });

  it.each(['employee', 'master'] as AppRole[])(
    'isStaff is true when role is %s',
    (role) => {
      expect(deriveRoleFlags(role).isStaff).toBe(true);
    }
  );

  it('isStaff is false when role is customer', () => {
    const flags = deriveRoleFlags('customer');
    expect(flags.isStaff).toBe(false);
    expect(flags.isCustomer).toBe(true);
  });
});
