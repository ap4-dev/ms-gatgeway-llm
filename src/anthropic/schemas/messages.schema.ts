import { z } from 'zod';

const TextBlock = z.object({
    type: z.literal('text'),
    text: z.string(),
});

const ThinkingBlock = z.object({
    type: z.literal('thinking'),
    thinking: z.string(),
    signature: z.string().optional(),
});

const ToolUseBlock = z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
});

const ToolResultBlock = z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z
        .union([z.string(), z.array(TextBlock)])
        .optional(),
    is_error: z.boolean().optional(),
});

const ImageBlock = z.object({
    type: z.literal('image'),
    source: z.object({
        type: z.literal('base64'),
        media_type: z.string(),
        data: z.string(),
    }),
});

const ContentBlock = z.union([TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock, ImageBlock]);

const Message = z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(ContentBlock)]).nullable().optional(),
}).passthrough();

const Tool = z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()),
}).passthrough();

const ToolChoice = z.union([
    z.object({ type: z.literal('auto') }),
    z.object({ type: z.literal('any') }),
    z.object({ type: z.literal('tool'), name: z.string() }),
]);

export const AnthropicMessagesSchema = z.object({
    model: z.string().min(1, 'model is required'),
    max_tokens: z.number().int().positive('max_tokens must be a positive integer'),
    system: z.union([z.string(), z.array(ContentBlock)]).optional(),
    messages: z.array(Message).min(1, 'messages must contain at least one entry'),
    tools: z.array(Tool).optional(),
    tool_choice: ToolChoice.optional(),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().positive().optional(), // accepted for client compat; dropped in request-adapter (no OpenAI equivalent)
    stop_sequences: z.array(z.string()).optional(),
    metadata: z.object({ user_id: z.string().optional() }).optional(),
    thinking: z
        .object({
            type: z.enum(['enabled', 'disabled']),
            budget_tokens: z.number().int().positive().optional(),
        })
        .optional(),
}).passthrough();

export type AnthropicMessagesBody = z.infer<typeof AnthropicMessagesSchema>;
