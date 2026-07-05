import { Injectable, Logger } from '@nestjs/common';

/**
 * One structured log line per chat request. Lives alongside the existing
 * `request_logs` table — the table is for queries; the structured log is
 * for the centralized log pipeline (and for grep). They share the same
 * source so the two views stay aligned.
 *
 * The logger implementation in production is `AppJsonLogger` (see
 * `src/app.logger.ts`) which serializes records to a single JSON line in
 * non-dev environments.
 */
@Injectable()
export class LlmLoggingService {
    private readonly logger = new Logger(LlmLoggingService.name);

    logRequest(args: RequestLogEvent): void {
        const payload = JSON.stringify(args);
        try {
            switch (args.status) {
                case 'error':
                    this.logger.error(payload);
                    break;
                case 'circuit_open':
                    this.logger.warn(payload);
                    break;
                default:
                    this.logger.log(payload);
                    break;
            }
        } catch (err) {
            // Logging must never break a request. Swallow.
            // The DB row (RequestLogService) still captured the event.
            void err;
        }
    }
}

export interface RequestLogEvent {
    event: 'chat.request';
    /** Unix-seconds timestamp captured at the start of ChatService.completions. */
    ts: number;
    model: string;
    resolvedProvider: string | null;
    resolvedModel: string | null;
    promptHash: string;
    latencyMs: number;
    attempts: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    status: 'ok' | 'error' | 'circuit_open';
    error?: string;
    clientKey?: string;
}
