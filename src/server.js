import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, writeFileSync, unlinkSync, globSync } from 'fs';
import { homedir } from 'os';

import { PID_PATH } from './paths.js';
import { hasPassword, setPassword, promptPassword, authMiddleware } from './auth.js';
import { getDocumentCount } from './db.js';
import { ingestDirectory } from './ingest.js';
import cors from 'cors';
import authRoutes from './routes/auth-routes.js';
import apiRoutes from './routes/api.js';
import { createApiKeyMiddleware } from './middleware/api-key.js';
import v1Router from './routes/v1.js';
import openapiRoute from './routes/openapi.js';
import { mcpHttpHandler, mcpGetHandler } from './mcp-http.js';

export async function start() {
  const port = parseInt(process.env.KB_PORT || '3838', 10);

  // 1. Password setup
  if (process.env.KB_PASSWORD && !hasPassword()) {
    setPassword(process.env.KB_PASSWORD);
    console.log('Password set from KB_PASSWORD env var');
  } else if (!hasPassword()) {
    await promptPassword();
  }

  // 2. Auto-ingest on first run
  if (getDocumentCount() === 0) {
    console.log('First run — auto-ingesting existing knowledge base...');
    const home = homedir();
    const dirs = [join(home, 'knowledgebase')];
    // Add Claude memory dirs
    try {
      const memoryDirs = globSync(join(home, '.claude/projects/*/memory'));
      dirs.push(...memoryDirs);
    } catch {}
    for (const dir of dirs) {
      if (existsSync(dir)) {
        console.log(`  Ingesting ${dir}...`);
        const result = await ingestDirectory(dir);
        console.log(`    ${result.ingested} ingested, ${result.skipped} skipped`);
      }
    }
  }

  // 3. Express setup
  const app = express();
  app.use(express.json());

  const __dirname = dirname(fileURLToPath(import.meta.url));
  app.use(express.static(join(__dirname, 'public')));

  app.use(authRoutes);
  app.use(apiRoutes);

  // --- Brain API (external access via brain.yourdomain.com) ---
  const corsMiddleware = cors({
    origin: [
      'https://claude.ai',
      'https://chat.openai.com',
      'https://chatgpt.com',
      'https://gemini.google.com',
      'https://kb.yourdomain.com',
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'Mcp-Session-Id'],
  });

  const apiKeyAuth = createApiKeyMiddleware();

  // Public (no auth): OpenAPI spec + health
  app.get('/openapi.json', corsMiddleware, openapiRoute);
  app.get('/api/v1/health', corsMiddleware, (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  // Authenticated: v1 API + MCP HTTP
  app.use('/api/v1', corsMiddleware, apiKeyAuth, v1Router);
  app.post('/mcp', corsMiddleware, apiKeyAuth, mcpHttpHandler);
  app.get('/mcp', corsMiddleware, apiKeyAuth, mcpGetHandler);

  // Fallback to index.html for SPA (MUST remain LAST)
  app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
  });

  // 4. Start
  app.listen(port, () => {
    console.log(`Knowledge Base server running at http://localhost:${port}`);
    writeFileSync(PID_PATH, process.pid.toString());
  });

  // Cleanup on exit
  process.on('SIGTERM', () => {
    try { unlinkSync(PID_PATH); } catch {}
    process.exit(0);
  });
  process.on('SIGINT', () => {
    try { unlinkSync(PID_PATH); } catch {}
    process.exit(0);
  });
}
