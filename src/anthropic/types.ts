// Anthropic Messages API types

// --- Request types ---

export interface AnthropicMessagesRequest {
    model: string;
    max_tokens: number;
    system?: string | AnthropicContentBlock[];
    messages: AnthropicMessage[];
    tools?: AnthropicTool[];
    tool_choice?: AnthropicToolChoice;
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop_sequences?: string[];
    metadata?: { user_id?: string };
}

export interface AnthropicMessage {
    role: string;
    content?: string | AnthropicContentBlock[] | null;
}

export type AnthropicContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | {
          type: 'tool_result';
          tool_use_id: string;
          content?: string | AnthropicContentBlock[];
          is_error?: boolean;
      }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
    | { type: 'auto' }
    | { type: 'any' }
    | { type: 'tool'; name: string };

// --- Response types ---

export interface AnthropicMessageResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: AnthropicResponseBlock[];
    model: string;
    stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
    stop_sequence: string | null;
    usage: { input_tokens: number; output_tokens: number };
}

export type AnthropicResponseBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

// --- Streaming event types ---

export interface TextDelta {
    type: 'text_delta';
    text: string;
}

export interface InputJsonDelta {
    type: 'input_json_delta';
    partial_json: string;
}

export type AnthropicStreamEvent =
    | { type: 'message_start'; message: AnthropicMessageResponse }
    | {
          type: 'content_block_start';
          index: number;
          content_block: AnthropicResponseBlock;
      }
    | { type: 'ping' }
    | {
          type: 'content_block_delta';
          index: number;
          delta: TextDelta | InputJsonDelta;
      }
    | { type: 'content_block_stop'; index: number }
    | {
          type: 'message_delta';
          delta: {
              stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
              stop_sequence: string | null;
          };
          usage: { output_tokens: number };
      }
    | { type: 'message_stop' }
    | { type: 'error'; error: { type: string; message: string } };
