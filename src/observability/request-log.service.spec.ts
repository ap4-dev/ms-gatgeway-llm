import { Logger } from '@nestjs/common';
import {
    RequestLogService,
    type RecordSuccessArgs,
    type RecordFailureArgs,
} from './request-log.service';
import type { RequestLogRow } from '../database/repositories/request-log.repository';

function makeRepo(throws = false) {
    let lastRow: RequestLogRow | undefined;
    let count = 0;
    const append = jest.fn((row: RequestLogRow) => {
        if (throws) throw new Error('DB down');
        lastRow = row;
        count += 1;
        return count;
    });
    return {
        append,
        recent: jest.fn(() => []),
        getLastRow: () => lastRow,
        getCount: () => count,
    } as any;
}

describe('RequestLogService', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    describe('recordSuccess', () => {
        const args: RecordSuccessArgs = {
            requestedAt: 1_700_000_000,
            requestedModel: 'fast',
            resolvedProvider: 'openai',
            resolvedModel: 'gpt-4o-mini',
            attempts: 1,
            latencyMs: 250,
        };

        it('writes a row with status=ok', () => {
            const repo = makeRepo();
            new RequestLogService(repo).recordSuccess(args);
            expect(repo.append).toHaveBeenCalledTimes(1);
            expect(repo.getLastRow()).toMatchObject({
                status: 'ok',
                requestedAt: 1_700_000_000,
                modelRequested: 'fast',
                resolvedProvider: 'openai',
                resolvedModel: 'gpt-4o-mini',
                attempts: 1,
                latencyMs: 250,
            });
            // success rows carry no error message.
            expect(repo.getLastRow()?.error).toBeFalsy();
        });

        it('passes through clientKey when provided', () => {
            const repo = makeRepo();
            new RequestLogService(repo).recordSuccess({ ...args, clientKey: 'k1' });
            expect(repo.getLastRow()?.clientKey).toBe('k1');
        });

        it('swallows DB errors with a logger.warn so logging never breaks the request', () => {
            const repo = makeRepo(true);
            // Must not throw.
            expect(() => new RequestLogService(repo).recordSuccess(args)).not.toThrow();
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0][0]).toMatch(/request log append failed/);
        });
    });

    describe('recordFailure', () => {
        const baseArgs: RecordFailureArgs = {
            requestedAt: 1_700_000_000,
            requestedModel: 'fast',
            attempts: [{ ok: false, circuitOpen: true, providerId: 'openai' } as any],
            latencyMs: 5_000,
            error: new Error('all providers failed'),
        };

        it('writes a row with status=error when a real Error was thrown', () => {
            const repo = makeRepo();
            new RequestLogService(repo).recordFailure(baseArgs);
            const row = repo.getLastRow();
            expect(row?.status).toBe('error');
            expect(row?.error).toBe('Error: all providers failed');
            expect(row?.attempts).toBe(1);
        });

        it('records status=circuit_open and skips error when there are no upstream errors', () => {
            const repo = makeRepo();
            new RequestLogService(repo).recordFailure({
                ...baseArgs,
                error: undefined,
                attempts: [],
            });
            const row = repo.getLastRow();
            // Empty attempts and no error → downgraded to circuit_open.
            expect(row?.status).toBe('circuit_open');
            expect(row?.error).toBeNull();
        });

        it('swallows DB errors', () => {
            const repo = makeRepo(true);
            expect(() => new RequestLogService(repo).recordFailure(baseArgs)).not.toThrow();
            expect(warnSpy).toHaveBeenCalledTimes(1);
        });
    });
});
