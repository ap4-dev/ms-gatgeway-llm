import { Injectable, Logger } from '@nestjs/common';
import {
    RequestLogRepository,
    type RequestLogRow,
    type RequestLogStatus,
} from '../database/repositories/request-log.repository';

export interface RecordSuccessArgs {
    requestedAt: number;
    requestedModel: string;
    resolvedProvider: string;
    resolvedModel: string;
    attempts: number;
    latencyMs: number;
    clientKey?: string | null;
    promptHash?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

export interface RecordFailureArgs {
    requestedAt: number;
    requestedModel: string;
    attempts: number;
    latencyMs: number;
    error?: unknown;
    resolvedProvider?: string | null;
    resolvedModel?: string | null;
    clientKey?: string | null;
    promptHash?: string;
    attemptDetails?: string | null;
}

/**
 * Fire-and-forget persistence for the request log. Both methods swallow
 * any DB error with `logger.warn` — observability must never break an
 * actual user request.
 *
 * Wired into `ChatService.completions`. Phase 4 added prompt-hash + token
 * columns to the schema; the wider observability story (metrics
 * aggregation, structured logging service) is also Phase 4.
 *
 * Caveat for streamed responses: the log row is written the moment the
 * upstream SDK resolves (i.e. when HTTP returned 200). A partial-stream
 * failure during iteration leaves an `ok` row even though the client
 * got truncated bytes. Token counts are unavailable for streams unless
 * the upstream surfaces `usage` on the final chunk, which most
 * providers do.
 */
@Injectable()
export class RequestLogService {
    private readonly logger = new Logger(RequestLogService.name);

    constructor(private readonly repo: RequestLogRepository) {}

    recordSuccess(args: RecordSuccessArgs): void {
        const row: RequestLogRow = {
            requestedAt: args.requestedAt,
            modelRequested: args.requestedModel,
            resolvedProvider: args.resolvedProvider,
            resolvedModel: args.resolvedModel,
            attempts: args.attempts,
            latencyMs: args.latencyMs,
            status: 'ok',
            clientKey: args.clientKey ?? null,
            promptHash: args.promptHash ?? null,
            promptTokens: args.promptTokens ?? null,
            completionTokens: args.completionTokens ?? null,
            totalTokens: args.totalTokens ?? null,
        };
        this.tryAppend(row);
    }

    recordFailure(args: RecordFailureArgs): void {
        const errorMessage =
            args.error instanceof Error
                ? `${args.error.name}: ${args.error.message}`
                : typeof args.error === 'string'
                ? args.error
                : null;
        const status = errorMessage != null ? 'error' : 'circuit_open';
        const row: RequestLogRow = {
            requestedAt: args.requestedAt,
            modelRequested: args.requestedModel,
            resolvedProvider: args.resolvedProvider ?? null,
            resolvedModel: args.resolvedModel ?? null,
            attempts: args.attempts,
            latencyMs: args.latencyMs,
            status,
            error: errorMessage,
            clientKey: args.clientKey ?? null,
            promptHash: args.promptHash ?? null,
            attemptDetails: args.attemptDetails ?? null,
        };
        this.tryAppend(row);
    }

    /**
     * Log each individual failed attempt from a fallback chain that
     * eventually succeeded. Each call writes one row with status='error'.
     */
    recordAttemptFailure(args: {
        requestedAt: number;
        requestedModel: string;
        resolvedProvider: string;
        resolvedModel: string;
        latencyMs: number;
        durationMs: number;
        error: unknown;
        circuitOpen: boolean;
        clientKey?: string | null;
        promptHash?: string | null;
        attemptIndex: number;
        totalAttempts: number;
    }): void {
        const errorMessage =
            args.error instanceof Error
                ? `${args.error.name}: ${args.error.message}`
                : typeof args.error === 'string'
                ? args.error
                : args.circuitOpen
                ? 'Circuit breaker open'
                : null;
        const row: RequestLogRow = {
            requestedAt: args.requestedAt,
            modelRequested: args.requestedModel,
            resolvedProvider: args.resolvedProvider,
            resolvedModel: args.resolvedModel,
            attempts: args.totalAttempts,
            latencyMs: args.durationMs,
            status: 'error',
            error: errorMessage,
            clientKey: args.clientKey ?? null,
            promptHash: args.promptHash ?? null,
        };
        this.tryAppend(row);
    }

    private tryAppend(row: RequestLogRow): void {
        try {
            this.repo.append(row);
        } catch (err: any) {
            this.logger.warn(
                `request log append failed (${row.modelRequested}): ${err?.message ?? err}`,
            );
        }
    }
}


