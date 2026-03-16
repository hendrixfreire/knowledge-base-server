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
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth-oauth.js';
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

  const __dirname = dirname(fileURLToPath(import.meta.url));

  // --- CORS for external API/MCP access ---
  const corsMiddleware = cors({
    origin: [
      'https://claude.ai',
      'https://claude.com',
      'https://chat.openai.com',
      'https://chatgpt.com',
      'https://gemini.google.com',
      'https://kb.yourdomain.com',
      'https://brain.yourdomain.com',
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'Mcp-Session-Id'],
    credentials: true,
  });

  // --- Better Auth OAuth handler (MUST be BEFORE express.json) ---
  app.all('/api/auth/*', corsMiddleware, toNodeHandler(auth));

  // --- Well-known OAuth discovery endpoints ---
  // These return Web Response objects, so we convert to Express responses
  const { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } = await import('better-auth/plugins');
  const discoveryHandler = oAuthDiscoveryMetadata(auth);
  const resourceHandler = oAuthProtectedResourceMetadata(auth);

  app.get('/.well-known/oauth-authorization-server', corsMiddleware, async (req, res) => {
    const url = `${process.env.BETTER_AUTH_URL || 'https://brain.yourdomain.com'}${req.originalUrl}`;
    const webRes = await discoveryHandler(new Request(url));
    const data = await webRes.json();
    res.json(data);
  });
  app.get('/.well-known/oauth-protected-resource', corsMiddleware, async (req, res) => {
    const url = `${process.env.BETTER_AUTH_URL || 'https://brain.yourdomain.com'}${req.originalUrl}`;
    const webRes = await resourceHandler(new Request(url));
    const data = await webRes.json();
    res.json(data);
  });

  // --- Sign-in page for OAuth consent flow ---
  app.get('/sign-in', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'sign-in.html'));
  });

  // Now enable JSON body parsing for remaining routes
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // --- Dashboard routes (existing, cookie auth) ---
  app.use(authRoutes);
  app.use(apiRoutes);

  // --- Brain API (external access via brain.yourdomain.com) ---
  const apiKeyAuth = createApiKeyMiddleware();

  // Auth middleware: accepts EITHER API key OR OAuth Bearer token
  const brainAuth = async (req, res, next) => {
    // Try API key first (fast path)
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      return apiKeyAuth(req, res, next);
    }

    // Try OAuth Bearer token
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      // Check if it's an API key in Bearer format
      const token = authHeader.slice(7);
      const keyMap = {
        [process.env.KB_API_KEY_CLAUDE]: 'claude',
        [process.env.KB_API_KEY_OPENAI]: 'openai',
        [process.env.KB_API_KEY_GEMINI]: 'gemini',
      };
      if (keyMap[token]) {
        req.apiService = keyMap[token];
        return next();
      }

      // Otherwise validate as OAuth token via better-auth
      try {
        const session = await auth.api.getMcpSession({
          headers: req.headers,
        });
        if (session) {
          req.apiService = 'oauth';
          req.oauthSession = session;
          return next();
        }
      } catch {
        // Fall through to 401
      }
    }

    return res.status(401).json({ error: 'Missing or invalid authentication. Provide X-API-Key header or OAuth Bearer token.' });
  };

  // Public (no auth): OpenAPI spec + health
  app.get('/openapi.json', corsMiddleware, openapiRoute);
  app.get('/api/v1/health', corsMiddleware, (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  // Authenticated: v1 API (API key or OAuth)
  app.use('/api/v1', corsMiddleware, brainAuth, v1Router);

  // Authenticated: MCP HTTP (API key or OAuth)
  app.post('/mcp', corsMiddleware, brainAuth, mcpHttpHandler);
  app.get('/mcp', corsMiddleware, brainAuth, mcpGetHandler);
  app.delete('/mcp', corsMiddleware, brainAuth, (req, res) => {
    // Session termination endpoint (MCP spec)
    res.status(200).json({ ok: true });
  });

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
