/**
 * Single source of truth for the `web_search` tool surfaced through both
 * `POST /v1/mcp` (tools/list) and `GET /v1/tools` (discovery). Keeping one
 * definition guarantees the JSON Schema advertised to MCP clients matches
 * what the REST discovery endpoint advertises to Kilo/OpenCode.
 */

export const WEB_SEARCH_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        query: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
            description: 'Search query (1–500 chars).',
        },
        count: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description: 'Number of results to return (1–20, default 5).',
        },
        freshness: {
            type: 'string',
            description:
                'Freshness window: pd (past day), pw (past week), pm (past month), py (past year), or an explicit YYYY-MM-DDtoYYYY-MM-DD range.',
        },
        fetch_content: {
            type: 'boolean',
            description:
                'Fetch full page content alongside snippets. Slower, but gives the model raw text for RAG-style answers.',
        },
    },
    required: ['query'],
} as const;

export interface WebSearchToolDef {
    name: string;
    description: string;
    inputSchema: typeof WEB_SEARCH_INPUT_SCHEMA;
}

export const WEB_SEARCH_TOOL: WebSearchToolDef = {
    name: 'web_search',
    description:
        'Search the web and return ranked results with titles, URLs, snippets and optional full page content. ' +
        'Use when you need up-to-date information not present in your training data: news, docs, prices, events, ' +
        'or anything where the answer may have changed recently.',
    inputSchema: WEB_SEARCH_INPUT_SCHEMA,
};
