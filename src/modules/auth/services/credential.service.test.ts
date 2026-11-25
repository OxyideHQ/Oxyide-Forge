import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@prisma/client';

const mockRemoveByUserId = vi.fn();

vi.mock('../repositories/credential.repository.js', () => ({
  credentialRepository: {
    removeByUserId: mockRemoveByUserId,
  },
}));

const { credentialService } = await import('./credential.service.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('credentialService', () => {
  const mockTx = {} as unknown as Prisma.TransactionClient;

  describe('removeByUserId', () => {
    it('delegates to the auth-owned credential repository and returns its result', async () => {
      mockRemoveByUserId.mockResolvedValueOnce(true);

      const result = await credentialService.removeByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(true);
      expect(mockRemoveByUserId).toHaveBeenCalledWith('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', undefined);
    });

    it('threads the caller-owned transaction client through to the repository', async () => {
      mockRemoveByUserId.mockResolvedValueOnce(false);

      const result = await credentialService.removeByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', mockTx);

      expect(result).toBe(false);
      expect(mockRemoveByUserId).toHaveBeenCalledWith('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', mockTx);
    });

    it('exposes removeByUserId as a function on the service object', () => {
      expect(typeof credentialService.removeByUserId).toBe('function');
    });
  });
});
