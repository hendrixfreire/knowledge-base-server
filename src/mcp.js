import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchDocuments, listDocuments, getDocument } from './db.js';
import { ingestText } from './ingest.js';

export async function start() {
  const server = new McpServer({
    name: 'knowledge-base',
    version: '1.0.0',
  });

  server.tool(
    'kb_search',
    'Search the knowledge base using full-text search. Returns ranked results with highlighted snippets.',
    {
      query: z.string().describe('Full-text search query'),
      limit: z.number().optional().default(20).describe('Maximum number of results to return'),
    },
    async ({ query, limit }) => {
      try {
        const results = searchDocuments(query, limit);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_list',
    'List documents in the knowledge base, optionally filtered by type or tag.',
    {
      type: z.string().optional().describe('Filter by document type (e.g. text, markdown, code, pdf)'),
      tag: z.string().optional().describe('Filter by tag'),
      limit: z.number().optional().default(50).describe('Maximum number of results to return'),
    },
    async ({ type, tag, limit }) => {
      try {
        const results = listDocuments({ type, tag, limit });
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_read',
    'Read the full content of a specific document by its ID.',
    {
      id: z.number().describe('Document ID'),
    },
    async ({ id }) => {
      try {
        const doc = getDocument(id);
        if (!doc) {
          return { content: [{ type: 'text', text: `Error: Document with ID ${id} not found.` }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_ingest',
    'Ingest a new document into the knowledge base from text content.',
    {
      title: z.string().describe('Document title'),
      content: z.string().describe('Document text content'),
      tags: z.string().optional().describe('Comma-separated tags'),
    },
    async ({ title, content, tags }) => {
      try {
        const doc = ingestText(title, content, tags);
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Allow direct execution
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^\//, ''));
if (isMain || process.argv[1]?.endsWith('mcp.js')) {
  start().catch((err) => {
    console.error('MCP server failed to start:', err);
    process.exit(1);
  });
}
