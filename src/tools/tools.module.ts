import { Module } from '@nestjs/common';
import { ToolsController } from './tools.controller';

/**
 * Tools module — registry of gateway capabilities surfaced to clients.
 *
 * `GET /v1/tools` advertises every registered tool in OpenAI shape (for
 * Kilo/OpenCode); the MCP layer (`mcp/`) reuses the same tool
 * definitions via `tools/list`. Tool definitions are plain consts
 * (`web-search.tool.ts`) — no DI, so adding a tool is one file + one
 * entry in the controller.
 */
@Module({
    controllers: [ToolsController],
})
export class ToolsModule {}
