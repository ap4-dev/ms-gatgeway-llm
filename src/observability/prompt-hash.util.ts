import { createHash } from 'node:crypto';

export interface PromptMessage {
    role: string;
    content: unknown;
    name?: string;
    [key: string]: unknown;
}

/**
 * Stable, short identifier of the (model, conversation-shape) pair. Built
 * for prompt grouping and observability — not for secrets or security. Two
 * requests with the same logical prompt collide; trivial whitespace / case
 * differences do not.
 *
 * Algorithm:
 *   1. Extract text per message (`extractText` from chat.service, duplicated
 *      here to keep this module dependency-free).
 *   2. Lowercase and trim each line.
 *   3. Join with role tag → `role:text`.
 *   4. Mix in the model identifier so distinct models on the same prompt
 *      hash to different buckets.
 *   5. SHA-256, take the first 16 hex chars (64 bits of entropy).
 */
export function hashPrompt(messages: ReadonlyArray<PromptMessage>, model: string): string {
    const parts: string[] = [];
    for (const m of messages ?? []) {
        const text = extractText(m?.content).trim().toLowerCase();
        const role = (m?.role ?? 'unknown').toString();
        parts.push(`${role}:${text}`);
    }
    parts.push(`model:${model}`);
    const payload = parts.join('\n');
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function extractText(content: unknown): string {
    let raw: string;
    if (typeof content === 'string') {
        raw = content;
    } else if (Array.isArray(content)) {
        raw = content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object' && 'text' in part) {
                    return String((part as any).text ?? '');
                }
                return '';
            })
            .join('');
    } else {
        raw = '';
    }
    // Collapse any run of whitespace into a single space. Trim leading/trailing.
    return raw.replace(/\s+/g, ' ').trim();
}
