import type http from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  configureHyperFramesStudioLauncherForTests,
  resetHyperFramesStudioRoutesForTests,
} from '../src/hyperframes-routes.js';
import { startServer } from '../src/server.js';

describe('HyperFrames composition routes', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => {
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await resetHyperFramesStudioRoutesForTests();
  });

  it('lists valid hidden cache compositions without adding them to normal files', async () => {
    const projectId = `hf-routes-${Date.now()}`;
    await createProject(projectId);
    await writeComposition(projectId, 'comp-a', {
      name: 'Launch Cards',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    await mkdir(projectPath(projectId, '.hyperframes-cache', 'missing-index'), {
      recursive: true,
    });

    const resp = await fetch(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/hyperframes/compositions`,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      compositions: Array<{
        id: string;
        title: string;
        compositionDir: string;
        entryFile: string;
        previewUrl: string;
        createdAt?: string;
      }>;
    };
    expect(body.compositions).toHaveLength(1);
    expect(body.compositions[0]).toMatchObject({
      id: 'comp-a',
      title: 'Launch Cards',
      compositionDir: '.hyperframes-cache/comp-a',
      entryFile: 'index.html',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(body.compositions[0]?.previewUrl).toBe(
      `/api/projects/${encodeURIComponent(projectId)}/hyperframes/compositions/comp-a/preview`,
    );

    const filesResp = await fetch(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/files`,
    );
    expect(filesResp.status).toBe(200);
    const filesBody = (await filesResp.json()) as { files: Array<{ name: string }> };
    expect(filesBody.files.some((file) => file.name.includes('.hyperframes-cache'))).toBe(false);
  });

  it('serves a preview wrapper with a raw-file base URL and timeline autoplay runtime', async () => {
    const projectId = `hf-preview-${Date.now()}`;
    await createProject(projectId);
    await writeComposition(projectId, 'comp-preview', { name: 'Preview Fixture' });

    const resp = await fetch(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/hyperframes/compositions/comp-preview/preview`,
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    const html = await resp.text();
    expect(html).toContain(
      `<base href="/api/projects/${encodeURIComponent(projectId)}/raw/.hyperframes-cache/comp-preview/">`,
    );
    expect(html).toContain('data-open-design-hyperframes-preview');
    expect(html).toContain('window.__timelines');
  });

  it('rejects cross-origin Studio starts without launching HyperFrames', async () => {
    const projectId = `hf-studio-origin-${Date.now()}`;
    await createProject(projectId);
    await writeComposition(projectId, 'comp-a', { name: 'Preview Fixture' });
    let launchCount = 0;
    configureHyperFramesStudioLauncherForTests(async ({ composition, port }) => {
      launchCount += 1;
      return {
        studioUrl: `http://127.0.0.1:${port}/#project/${encodeURIComponent(composition.id)}`,
        projectName: composition.id,
        compositionDir: composition.compositionDir,
        port,
      };
    });

    const resp = await fetch(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/hyperframes/compositions/comp-a/studio`,
      { method: 'POST', headers: { Origin: 'https://example.invalid' } },
    );

    expect(resp.status).toBe(403);
    expect(launchCount).toBe(0);
  });

  it('starts Studio on clean fresh ports and stops stale preview sessions', async () => {
    const projectId = `hf-studio-${Date.now()}`;
    await createProject(projectId);
    await writeComposition(projectId, 'comp-a', { name: 'Comp A' });
    await writeComposition(projectId, 'comp-b', { name: 'Comp B' });
    const children: FakeStudioChild[] = [];
    configureHyperFramesStudioLauncherForTests(async ({ composition, port, onChild }) => {
      const child = new FakeStudioChild();
      children.push(child);
      onChild(child as unknown as ChildProcess);
      return {
        studioUrl: `http://127.0.0.1:${port}/#project/${encodeURIComponent(composition.id)}`,
        projectName: composition.id,
        compositionDir: composition.compositionDir,
        port,
      };
    });

    const firstResp = await fetch(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/hyperframes/compositions/comp-a/studio`,
      { method: 'POST' },
    );
    expect(firstResp.status).toBe(200);
    const first = (await firstResp.json()) as { studioUrl: string; port: number };
    expect(first.studioUrl).toBe(`http://127.0.0.1:${first.port}/#project/comp-a`);
    expect(first.studioUrl).not.toContain('?');
    expect(first.studioUrl).not.toContain('tab=renders');

    const secondResp = await fetch(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/hyperframes/compositions/comp-b/studio`,
      { method: 'POST' },
    );
    expect(secondResp.status).toBe(200);
    const second = (await secondResp.json()) as { port: number };
    expect(second.port).not.toBe(first.port);
    expect(children[0]?.signals).toContain('SIGTERM');

    const stopResp = await fetch(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/hyperframes/compositions/comp-b/studio`,
      { method: 'DELETE' },
    );
    expect(stopResp.status).toBe(200);
    expect(await stopResp.json()).toMatchObject({ stopped: true });
    expect(children[1]?.signals).toContain('SIGTERM');
  });

  async function createProject(projectId: string) {
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: projectId,
        skillId: 'hyperframes',
        metadata: { kind: 'video', videoModel: 'hyperframes-html' },
      }),
    });
    expect(resp.status).toBe(200);
  }

  async function writeComposition(
    projectId: string,
    compositionId: string,
    meta: Record<string, unknown>,
  ) {
    const dir = projectPath(projectId, '.hyperframes-cache', compositionId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html><head><title>HF</title></head><body><script>window.__timelines = { main: { play(){}, pause(){}, repeat(){} } };</script></body></html>',
      'utf8',
    );
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
  }

  function projectPath(projectId: string, ...parts: string[]): string {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required');
    return path.join(dataDir, 'projects', projectId, ...parts);
  }
});

class FakeStudioChild extends EventEmitter {
  killed = false;
  signals: string[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal ?? 'SIGTERM'));
    if (!this.killed) {
      this.killed = true;
      queueMicrotask(() => this.emit('close', null, signal ?? 'SIGTERM'));
    }
    return true;
  }
}
