import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  auditGovernance,
  probeRepository,
  ProfileFlywheel,
  RepoMemoryLedger,
  scoutOpportunities,
} from '@opencontrib/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLIENT_HTML_PATH = join(__dirname, '..', 'client', 'index.html');

const PORT = parseInt(process.env.PORT || '4173', 10);
const memory = new RepoMemoryLedger();
const flywheel = new ProfileFlywheel();

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 1. Static HTML Frontend
    if (url.pathname === '/' || url.pathname === '/index.html') {
      try {
        const html = readFileSync(CLIENT_HTML_PATH, 'utf-8');
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      } catch (err: any) {
        return new Response(`Error loading studio interface: ${err.message}`, { status: 500 });
      }
    }

    // 2. API: Opportunities Radar
    if (url.pathname === '/api/opportunities' && req.method === 'GET') {
      const tech = (url.searchParams.get('tech') || 'typescript, react')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const repo = url.searchParams.get('repo') || undefined;

      try {
        const opps = await scoutOpportunities(
          {
            techStack: tech,
            proficiency: 'intermediate',
            focusAreas: ['tooling', 'dx'],
            minMatchScore: 60,
          },
          { repo, limit: 5 },
        );
        return new Response(JSON.stringify({ status: 'success', opportunities: opps }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ status: 'error', message: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // 3. API: Proactive Probe
    if (url.pathname === '/api/probe' && req.method === 'POST') {
      try {
        const body = (await req.json()) as { repoFullName: string };
        const probeResult = await probeRepository(body.repoFullName);
        return new Response(JSON.stringify({ status: 'success', probeResult }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ status: 'error', message: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // 4. API: Governance & Diff Auditor
    if (url.pathname === '/api/audit' && req.method === 'POST') {
      try {
        const body = (await req.json()) as any;
        const audit = auditGovernance({
          diffText: body.diffText || '',
          prBodyText: body.prBodyText || '',
          confidenceBreakdown: body.confidence,
          lineCount: body.diffLineCount || 10,
        });
        return new Response(JSON.stringify({ status: 'success', audit }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ status: 'error', message: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // 5. API: Profile Flywheel
    if (url.pathname === '/api/flywheel' && req.method === 'GET') {
      const records = flywheel.loadRecords();
      const markdown = flywheel.renderProfileMarkdown(records);
      const svg = flywheel.renderBadgeSvg(records);
      return new Response(JSON.stringify({ status: 'success', records, markdown, svg }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 6. API: Sandbox & Workspace Purge / Cleanup
    if (url.pathname === '/api/cleanup' && req.method === 'POST') {
      try {
        const { WorktreeManager } = await import('@opencontrib/core');
        const manager = new WorktreeManager();
        const report = manager.purgeAllWorkspaces({
          cleanRepos: false,
          cleanScratchDir: join(__dirname, '..', '..', '..', 'scratch'),
        });
        return new Response(JSON.stringify({ status: 'success', report }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ status: 'error', message: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`[OpenContrib Studio] Running at http://localhost:${PORT}`);
