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
}

export interface RecordFailureArgs {
    requestedAt: number;
    requestedModel: string;
    attempts: Array<{ ok: boolean; circuitOpen?: boolean }>;
    latencyMs: number;
    error?: unknown;
    clientKey?: string | null;
}

/**
 * Fire-and-forget persistence for the request log. Both methods swallow
 * any DB error with `logger.warn` — observability must never break an
 * actual user request.
 *
 * Wired into `ChatService.completions`; the wider observability story
 * (structured logs, metrics aggregation, OpenTelemetry) lands in Phase 4.
 *
 * Caveat for streamed responses: the log row is written the moment the
 * upstream SDK resolves (i.e. when HTTP returned 200). A partial-stream
 * failure during iteration leaves an `ok` row even though the client
 * got truncated bytes. Phase 4 will revisit streaming visibility.
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
        };
        this.tryAppend(row);
    }

    recordFailure(args: RecordFailureArgs): void {
        const status = chooseFailureStatus(args.error, args.attempts);
        const errorMessage =
            args.error instanceof Error
                ? `${args.error.name}: ${args.error.message}`
                : typeof args.error === 'string'
                ? args.error
                : null;
        const row: RequestLogRow = {
            requestedAt: args.requestedAt,
            modelRequested: args.requestedModel,
            resolvedProvider: null,
            resolvedModel: null,
            attempts: args.attempts.length,
            latencyMs: args.latencyMs,
            status,
            error: errorMessage,
            clientKey: args.clientKey ?? null,
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

function chooseFailureStatus(
    error: unknown,
    attempts: ReadonlyArray<{ ok: boolean; circuitOpen?: boolean }>,
): RequestLogStatus {
    if (error != null) return 'error';
    if (attempts.length === 0) return 'circuit_open';
    if (attempts.every((a) => a.circuitOpen === true)) return 'circuit_open';
    return 'error';
}
