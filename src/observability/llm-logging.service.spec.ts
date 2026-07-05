import { Logger } from '@nestjs/common';
import {
    LlmLoggingService,
    type RequestLogEvent,
} from './llm-logging.service';

describe('LlmLoggingService', () => {
    let logSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let svc: LlmLoggingService;

    beforeEach(() => {
        logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        svc = new LlmLoggingService();
    });

    afterEach(() => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('emits a structured chat.request event for successful calls', () => {
        const args: RequestLogEvent = {
            event: 'chat.request',
            ts: 1_700_000_000,
            model: 'fast',
            resolvedProvider: 'openai',
            resolvedModel: 'gpt-4o-mini',
            promptHash: 'abc123',
            latencyMs: 250,
            attempts: 1,
            promptTokens: 42,
            completionTokens: 17,
            totalTokens: 59,
            status: 'ok',
            clientKey: 'demo',
        };
        svc.logRequest(args);
        expect(logSpy).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(logSpy.mock.calls[0][0]);
        expect(payload).toEqual(args);
    });

    it('emits via logger.error for status=error and includes the error message', () => {
        svc.logRequest({
            event: 'chat.request',
            ts: 1_700_000_000,
            model: 'mystery',
            resolvedProvider: null,
            resolvedModel: null,
            promptHash: 'deadbeef',
            latencyMs: 4_000,
            attempts: 2,
            status: 'error',
            error: 'all providers failed',
        });
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(errorSpy.mock.calls[0][0]).status).toBe('error');
        // info / warn should not fire for an error event.
        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('emits via logger.warn for status=circuit_open', () => {
        svc.logRequest({
            event: 'chat.request',
            ts: 1_700_000_000,
            model: 'fast',
            resolvedProvider: null,
            resolvedModel: null,
            promptHash: 'cafebabe',
            latencyMs: 0,
            attempts: 0,
            status: 'circuit_open',
        });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(warnSpy.mock.calls[0][0]).status).toBe('circuit_open');
    });

    it('never throws even when the logger would', () => {
        logSpy.mockImplementation(() => {
            throw new Error('log boom');
        });
        expect(() =>
            svc.logRequest({
                event: 'chat.request',
                ts: 0,
                model: 'fast',
                resolvedProvider: 'openai',
                resolvedModel: 'gpt-4o-mini',
                promptHash: 'x',
                latencyMs: 1,
                attempts: 1,
                status: 'ok',
            }),
        ).not.toThrow();
    });
});
