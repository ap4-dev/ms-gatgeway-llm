import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { SearchModule } from '../search/search.module';

/**
 * MCP protocol module — JSON-RPC 2.0 server (`POST /v1/mcp`).
 *
 * Protocol layer, not feature code: implements the MCP wire format and
 * dispatches tool calls to feature modules. Today the only tool is
 * `web_search` (from `tools/`); future tools (read_artifact, …) plug in
 * here without touching the transport.
 */
@Module({
    imports: [SearchModule],
    controllers: [McpController],
})
export class McpModule {}
