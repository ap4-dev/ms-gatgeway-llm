import { z } from 'zod';

/**
 * Validation schema for the inbound body on POST /v1/chat/completions.
 *
 * Modeled after the OpenAI Chat Completions API but intentionally lenient on
 * optional fields — different clients (Kilo, OpenCode, Claude Code, ...) send
 * slightly different shapes, and the gateway's job is to forward, not to
 * reject. Anything not listed here passes through to the upstream OpenAI SDK.
 */

// --- Message content variants -----------------------------------------------

const TextPart = z.object({
    type: z.literal('text'),
    text: z.string(),
});

const ImageUrlPart = z.object({
    type: z.literal('image_url'),
    image_url: z.object({
        url: z.string().url().or(z.string().regex(/^data:image\//)),
        detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
});

const ContentPart = z.union([TextPart, ImageUrlPart]);

// Tool-call argument can be any JSON value, but refuse functions that don't
// deserialize to something the SDK can serialize.
const FunctionArgs = z.record(z.string(), z.unknown());

// --- Messages ---------------------------------------------------------------

const Message = z
    .object({
        role: z.enum(['system', 'user', 'assistant', 'tool', 'developer', 'function']),
        // content is required except for assistant tool-call messages, where
        // the SDK accepts null. We permit null/omitted and let the SDK validate.
        content: z
            .union([z.string(), z.array(ContentPart)])
            .nullable()
            .optional(),
        name: z.string().optional(),
        // assistant→tool_calls
        tool_calls: z
            .array(
                z.object({
                    id: z.string(),
                    type: z.literal('function'),
                    function: z.object({
                        name: z.string(),
                        arguments: z.string().or(FunctionArgs),
                    }),
                }),
            )
            .optional(),
        // tool→tool_call_id
        tool_call_id: z.string().optional(),
    })
    .passthrough(); // forward unknown fields to the SDK

// --- Tools / response_format (lenient passthrough) --------------------------

const ToolFunction = z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
});

const Tool = z.object({
    type: z.literal('function'),
    function: ToolFunction,
});

const ResponseFormat = z.object({
    type: z.enum(['text', 'json_object', 'json_schema']).optional(),
});

// --- Top-level body --------------------------------------------------------

export const ChatCompletionBodySchema = z
    .object({
        model: z.string().min(1, 'model is required'),
        messages: z
            .array(Message)
            .min(1, 'messages must contain at least one entry'),
        stream: z.boolean().optional(),

        temperature: z.number().min(0).max(2).optional(),
        top_p: z.number().min(0).max(1).optional(),
        n: z.number().int().positive().optional(),
        max_tokens: z.number().int().positive().optional(),
        presence_penalty: z.number().min(-2).max(2).optional(),
        frequency_penalty: z.number().min(-2).max(2).optional(),
        seed: z.number().int().optional(),
        user: z.string().optional(),
        stop: z.union([z.string(), z.array(z.string())]).optional(),

        tools: z.array(Tool).optional(),
        tool_choice: z
            .union([z.string(), z.object({}).passthrough()])
            .optional(),
        response_format: ResponseFormat.optional(),
        logit_bias: z.record(z.string(), z.number()).optional(),
    })
    .passthrough();

export type ChatCompletionBody = z.infer<typeof ChatCompletionBodySchema>;

/**
 * Format a ZodError into the OpenAI-shaped error response. Nest exceptions
 * pass this through to the client.
 */
export function formatZodIssues(error: z.ZodError): {
    message: string;
    type: string;
    param: string | null;
    code: string;
}[] {
    return error.issues.map((i) => ({
        message: i.message,
        type: i.code,
        param: i.path.join('.') || null,
        code: 'invalid_request',
    }));
}
