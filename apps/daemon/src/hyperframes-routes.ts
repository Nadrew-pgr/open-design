import type { Express } from 'express';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  HyperFramesCompositionSummary,
  HyperFramesCompositionsResponse,
} from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';

export interface RegisterHyperFramesRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'projectFiles'> {}

export function registerHyperFramesRoutes(
  app: Express,
  ctx: RegisterHyperFramesRoutesDeps,
) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { PROJECTS_DIR } = ctx.paths;
  const { getProject } = ctx.projectStore;
  const { resolveProjectDir } = ctx.projectFiles;

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

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
