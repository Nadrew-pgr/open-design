import type { Express } from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import type {
  HyperFramesCompositionSummary,
  HyperFramesCompositionsResponse,
  HyperFramesStudioResponse,
  HyperFramesStudioStopResponse,
} from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';

export interface RegisterHyperFramesRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'projectFiles'> {}

const HYPERFRAMES_STUDIO_START_PORT = 3122;
const HYPERFRAMES_STUDIO_PORT_SCAN_LIMIT = 20;
const STUDIO_START_TIMEOUT_MS = 20_000;
const STUDIO_STOP_GRACE_MS = 1_000;

interface StudioSession extends HyperFramesStudioResponse {
  key: string;
  projectDir: string;
  child: ChildProcess | null;
  startPromise?: Promise<HyperFramesStudioResponse>;
  exited?: boolean;
}

export interface HyperFramesStudioLaunchInput {
  projectDir: string;
  composition: HyperFramesCompositionSummary;
  port: number;
  onChild: (child: ChildProcess) => void;
}

export type HyperFramesStudioLauncher = (input: HyperFramesStudioLaunchInput) => Promise<HyperFramesStudioResponse>;

const studioSessions = new Map<string, StudioSession>();
let nextStudioPortHint = HYPERFRAMES_STUDIO_START_PORT;
let hyperFramesStudioLauncher: HyperFramesStudioLauncher = defaultHyperFramesStudioLauncher;

export function configureHyperFramesStudioLauncherForTests(launcher: HyperFramesStudioLauncher | null): void {
  hyperFramesStudioLauncher = launcher ?? defaultHyperFramesStudioLauncher;
}

export async function resetHyperFramesStudioRoutesForTests(): Promise<void> {
  await shutdownHyperFramesStudios();
  nextStudioPortHint = HYPERFRAMES_STUDIO_START_PORT;
  hyperFramesStudioLauncher = defaultHyperFramesStudioLauncher;
}

export async function shutdownHyperFramesStudios(): Promise<void> {
  const sessions = [...studioSessions.values()];
  studioSessions.clear();
  await Promise.allSettled(sessions.map((session) => stopStudioSession(session)));
}

export function registerHyperFramesRoutes(
  app: Express,
  ctx: RegisterHyperFramesRoutesDeps,
) {
  const { db } = ctx;
  const { sendApiError, isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const { PROJECTS_DIR } = ctx.paths;
  const { getProject } = ctx.projectStore;
  const { resolveProjectDir } = ctx.projectFiles;
  const getResolvedPort = () => resolvedPortRef.current;

  app.get('/api/projects/:id/hyperframes/compositions', async (req, res) => {
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const projectRoot = resolveProjectDir(PROJECTS_DIR, req.params.id, project.metadata);
      const body: HyperFramesCompositionsResponse = {
        compositions: await listHyperFramesCompositions(projectRoot, req.params.id),
      };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message ?? err));
    }
  });

  app.post('/api/projects/:id/hyperframes/compositions/:compositionId/studio', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }

    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const projectRoot = resolveProjectDir(PROJECTS_DIR, req.params.id, project.metadata);
      const compositions = await listHyperFramesCompositions(projectRoot, req.params.id);
      const composition = compositions.find((item) => item.id === req.params.compositionId);
      if (!composition) {
        return sendApiError(res, 404, 'COMPOSITION_NOT_FOUND', 'composition not found');
      }
      const compositionRoot = path.join(projectRoot, composition.compositionDir);
      const body = await ensureHyperFramesStudio(compositionRoot, composition);
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message ?? err));
    }
  });

  app.delete('/api/projects/:id/hyperframes/compositions/:compositionId/studio', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }

    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const projectRoot = resolveProjectDir(PROJECTS_DIR, req.params.id, project.metadata);
      const compositions = await listHyperFramesCompositions(projectRoot, req.params.id);
      const composition = compositions.find((item) => item.id === req.params.compositionId);
      if (!composition) {
        return sendApiError(res, 404, 'COMPOSITION_NOT_FOUND', 'composition not found');
      }
      const compositionRoot = path.join(projectRoot, composition.compositionDir);
      const body: HyperFramesStudioStopResponse = {
        stopped: await stopHyperFramesStudio(compositionRoot),
      };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message ?? err));
    }
  });

  app.get('/api/projects/:id/hyperframes/compositions/:compositionId/preview', async (req, res) => {
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const projectRoot = resolveProjectDir(PROJECTS_DIR, req.params.id, project.metadata);
      const compositions = await listHyperFramesCompositions(projectRoot, req.params.id);
      const composition = compositions.find((item) => item.id === req.params.compositionId);
      if (!composition) {
        return sendApiError(res, 404, 'COMPOSITION_NOT_FOUND', 'composition not found');
      }
      const html = await readFile(path.join(projectRoot, composition.compositionDir, composition.entryFile), 'utf8');
      res.type('html').send(
        injectPreviewRuntime(
          html,
          projectRawDirectoryUrl(req.params.id, composition.compositionDir),
        ),
      );
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message ?? err));
    }
  });
}

async function ensureHyperFramesStudio(
  projectDir: string,
  composition: HyperFramesCompositionSummary,
): Promise<HyperFramesStudioResponse> {
  const key = path.resolve(projectDir);
  const existing = studioSessions.get(key);
  if (existing?.startPromise) return existing.startPromise;
  if (existing && await isStudioHealthy(existing)) return studioResponse(existing);

  if (existing) {
    studioSessions.delete(key);
    await stopStudioSession(existing);
  }

  await stopOtherStudioSessions(key);
  const port = await allocateStudioPort();
  const pending: StudioSession = {
    key,
    studioUrl: cleanStudioUrl(port, composition.id),
    projectName: composition.id,
    compositionDir: composition.compositionDir,
    port,
    projectDir: key,
    child: null,
  };
  pending.startPromise = hyperFramesStudioLauncher({
    projectDir: key,
    composition,
    port,
    onChild: (child) => bindStudioChild(pending, child),
  }).then((started) => {
    Object.assign(pending, started);
    delete pending.startPromise;
    return started;
  }).catch((err) => {
    studioSessions.delete(key);
    throw err;
  });
  studioSessions.set(key, pending);
  return pending.startPromise;
}

async function stopHyperFramesStudio(projectDir: string): Promise<boolean> {
  const key = path.resolve(projectDir);
  const existing = studioSessions.get(key);
  if (!existing) return false;
  studioSessions.delete(key);
  await stopStudioSession(existing);
  return true;
}

async function stopOtherStudioSessions(activeKey: string): Promise<void> {
  const sessions = [...studioSessions.entries()].filter(([key]) => key !== activeKey);
  for (const [key, session] of sessions) {
    studioSessions.delete(key);
    await stopStudioSession(session);
  }
}

async function stopStudioSession(session: StudioSession): Promise<void> {
  const child = session.child;
  session.exited = true;
  if (!child || child.killed) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        killStudioChild(child, 'SIGKILL');
      } catch {
        // best effort
      }
      finish();
    }, STUDIO_STOP_GRACE_MS);
    child.once('close', finish);
    try {
      killStudioChild(child, 'SIGTERM');
    } catch {
      finish();
    }
  });
}

function killStudioChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' && child.pid) {
    const args = ['/pid', String(child.pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    const taskkill = spawn('taskkill', args, { stdio: 'ignore' });
    taskkill.on('error', () => {
      try {
        child.kill(signal);
      } catch {
        // best effort
      }
    });
    return;
  }

  if (process.platform !== 'win32' && child.pid) {
    process.kill(-child.pid, signal);
    return;
  }
  child.kill(signal);
}

function bindStudioChild(session: StudioSession, child: ChildProcess): void {
  session.child = child;
  session.exited = false;
  child.once('close', () => {
    session.exited = true;
    if (studioSessions.get(session.key) === session) {
      studioSessions.delete(session.key);
    }
  });
}

function defaultHyperFramesStudioLauncher({
  projectDir,
  composition,
  port,
  onChild,
}: HyperFramesStudioLaunchInput): Promise<HyperFramesStudioResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      [
        '-y',
        'hyperframes',
        'preview',
        projectDir,
        '--port',
        String(port),
        '--no-open',
      ],
      {
        env: { ...process.env, NO_COLOR: '1' },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    onChild(child);

    let settled = false;
    let output = '';
    let timer: ReturnType<typeof setTimeout>;

    const finish = (result: HyperFramesStudioResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        killStudioChild(child, 'SIGTERM');
      } catch {
        // best effort
      }
      reject(err);
    };

    const inspectOutput = (chunk: Buffer) => {
      output = `${output}${stripAnsi(chunk.toString('utf8'))}`.slice(-8000);
      const match = output.match(/Studio\s+(http:\/\/localhost:(\d+))/);
      if (!match) return;
      const parsedPort = Number(match[2]);
      if (!Number.isFinite(parsedPort) || parsedPort <= 0) return;
      finish({
        studioUrl: cleanStudioUrl(parsedPort, composition.id),
        projectName: composition.id,
        compositionDir: composition.compositionDir,
        port: parsedPort,
      });
    };

    timer = setTimeout(() => {
      fail(new Error(`HyperFrames Studio did not start in ${STUDIO_START_TIMEOUT_MS / 1000}s`));
    }, STUDIO_START_TIMEOUT_MS);

    child.stdout.on('data', inspectOutput);
    child.stderr.on('data', inspectOutput);
    child.on('error', fail);
    child.on('close', (code) => {
      if (!settled) {
        fail(new Error(`HyperFrames Studio exited with code ${code ?? 'unknown'}: ${output.trim() || 'no output'}`));
      }
    });
  });
}

function cleanStudioUrl(port: number, compositionId: string): string {
  return `http://127.0.0.1:${port}/#project/${encodeURIComponent(compositionId)}`;
}

async function allocateStudioPort(): Promise<number> {
  for (let i = 0; i < HYPERFRAMES_STUDIO_PORT_SCAN_LIMIT; i += 1) {
    const candidate = nextStudioPortHint;
    nextStudioPortHint += 1;
    if (nextStudioPortHint > HYPERFRAMES_STUDIO_START_PORT + 1000) {
      nextStudioPortHint = HYPERFRAMES_STUDIO_START_PORT;
    }
    if (isPortInActiveSession(candidate)) continue;
    const port = await tryReservePort(candidate);
    if (port !== null) return port;
  }

  const fallback = await tryReservePort(0);
  if (fallback !== null) return fallback;
  throw new Error('No free local port available for HyperFrames Studio');
}

function isPortInActiveSession(port: number): boolean {
  return [...studioSessions.values()].some((session) => session.port === port && !session.exited);
}

function tryReservePort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      resolve(value);
    };
    server.once('error', () => finish(null));
    server.listen({ host: '127.0.0.1', port }, () => {
      const address = server.address();
      const reservedPort = address && typeof address === 'object' ? address.port : null;
      server.close(() => finish(reservedPort));
    });
  });
}

async function isStudioHealthy(session: StudioSession): Promise<boolean> {
  if (!session.port) return false;
  try {
    const resp = await fetch(`http://127.0.0.1:${session.port}/__hyperframes_config`);
    if (!resp.ok) return false;
    const json = await resp.json() as { isHyperframes?: unknown; projectDir?: unknown };
    return json.isHyperframes === true && path.resolve(String(json.projectDir)) === session.projectDir;
  } catch {
    return false;
  }
}

function studioResponse(session: StudioSession): HyperFramesStudioResponse {
  return {
    studioUrl: session.studioUrl,
    projectName: session.projectName,
    compositionDir: session.compositionDir,
    port: session.port,
  };
}

async function listHyperFramesCompositions(
  projectRoot: string,
  projectId: string,
): Promise<HyperFramesCompositionSummary[]> {
  const cacheRoot = path.join(projectRoot, '.hyperframes-cache');
  let entries;
  try {
    entries = await readdir(cacheRoot, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }

  const compositions: HyperFramesCompositionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeCompositionId(entry.name)) continue;

    const compositionRoot = path.join(cacheRoot, entry.name);
    const indexPath = path.join(compositionRoot, 'index.html');
    let indexStat;
    try {
      indexStat = await stat(indexPath);
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue;
      throw err;
    }
    if (!indexStat.isFile()) continue;

    const meta = await readHyperFramesMeta(path.join(compositionRoot, 'meta.json'));
    const compositionDir = `.hyperframes-cache/${entry.name}`;
    compositions.push({
      id: entry.name,
      title: meta.name ?? entry.name,
      compositionDir,
      entryFile: 'index.html',
      previewUrl: `/api/projects/${encodeURIComponent(projectId)}/hyperframes/compositions/${encodeURIComponent(entry.name)}/preview`,
      ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
      updatedAt: new Date(indexStat.mtimeMs).toISOString(),
    });
  }

  compositions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return compositions;
}

async function readHyperFramesMeta(metaPath: string): Promise<{ name?: string; createdAt?: string }> {
  try {
    const raw = await readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown; createdAt?: unknown };
    return {
      ...(typeof parsed.name === 'string' && parsed.name.trim()
        ? { name: parsed.name.trim() }
        : {}),
      ...(typeof parsed.createdAt === 'string' && !Number.isNaN(Date.parse(parsed.createdAt))
        ? { createdAt: parsed.createdAt }
        : {}),
    };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {};
    return {};
  }
}

function isSafeCompositionId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) && value !== '.' && value !== '..';
}

function projectRawDirectoryUrl(projectId: string, compositionDir: string): string {
  const encodedPath = compositionDir
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/api/projects/${encodeURIComponent(projectId)}/raw/${encodedPath}/`;
}

function injectPreviewRuntime(html: string, assetBaseHref: string): string {
  const baseTag = `<base href="${escapeHtmlAttribute(assetBaseHref)}">`;
  const runtime = `<script data-open-design-hyperframes-preview>
(() => {
  const startedAt = performance.now();
  const findTimeline = () => {
    const timelines = window.__timelines || {};
    return timelines.main || Object.values(timelines)[0] || null;
  };
  const play = () => {
    const timeline = findTimeline();
    if (timeline && typeof timeline.play === 'function') {
      try {
        if (typeof timeline.repeat === 'function') timeline.repeat(-1);
        if (typeof timeline.pause === 'function') timeline.pause(0);
        timeline.play(0);
      } catch {}
      return;
    }
    if (performance.now() - startedAt < 5000) requestAnimationFrame(play);
  };
  requestAnimationFrame(play);
})();
</script>`;

  const withBase = /<head[^>]*>/i.test(html)
    ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
    : `${baseTag}${html}`;

  return /<\/body>/i.test(withBase)
    ? withBase.replace(/<\/body>/i, `${runtime}</body>`)
    : `${withBase}${runtime}`;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\[\?[0-9]+[hl]/g, '');
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
