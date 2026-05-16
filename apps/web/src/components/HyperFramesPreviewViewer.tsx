import { useEffect, useRef, useState } from 'react';
import type { HyperFramesCompositionSummary } from '../types';
import {
  generateHyperFramesVideo,
  startHyperFramesStudio,
  stopHyperFramesStudio,
  waitMediaTask,
  type MediaTaskSnapshot,
} from '../providers/registry';
import { Icon } from './Icon';

interface Props {
  projectId: string;
  composition: HyperFramesCompositionSummary;
  onRefreshFiles: () => Promise<void> | void;
  onOpenFile: (name: string) => void;
}

export function HyperFramesPreviewViewer({
  projectId,
  composition,
  onRefreshFiles,
  onOpenFile,
}: Props) {
  const [rendering, setRendering] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [studioUrl, setStudioUrl] = useState<string | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [studioStarting, setStudioStarting] = useState(false);
  const runIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setStudioUrl(null);
    setStudioError(null);
    setStudioStarting(true);
    void startHyperFramesStudio(projectId, composition.id)
      .then((studio) => {
        if (!cancelled) setStudioUrl(studio.studioUrl);
      })
      .catch((err) => {
        if (!cancelled) {
          setStudioError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setStudioStarting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, composition.id]);

  useEffect(() => {
    const stopStudio = (keepalive = false) => {
      void stopHyperFramesStudio(projectId, composition.id, { keepalive }).catch(() => {
        // best effort cleanup when the tab closes or switches compositions
      });
    };
    const handlePageHide = () => stopStudio(true);
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      runIdRef.current += 1;
      stopStudio();
    };
  }, [projectId, composition.id]);

  async function handleRender() {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setRendering(true);
    setStatus('Stopping Studio before MP4 render');
    setProgress([]);
    setError(null);

    try {
      await stopHyperFramesStudio(projectId, composition.id);
      if (runIdRef.current !== runId) return;
      setStudioUrl(null);
      setStudioError(null);
      setStudioStarting(false);
      setStatus('Starting MP4 render');
      let snapshot = await generateHyperFramesVideo(projectId, {
        compositionDir: composition.compositionDir,
        output: suggestedOutputName(composition),
      });
      let since = snapshot.nextSince ?? 0;
      appendProgress(snapshot, setProgress);

      while (runIdRef.current === runId && isPending(snapshot.status)) {
        setStatus('Rendering MP4');
        snapshot = await waitMediaTask(snapshot.taskId, { since, timeoutMs: 1000 });
        since = snapshot.nextSince ?? since;
        appendProgress(snapshot, setProgress);
      }

      if (runIdRef.current !== runId) return;
      if (snapshot.status === 'done' && snapshot.file?.name) {
        setStatus(`Rendered ${snapshot.file.name}`);
        await onRefreshFiles();
        onOpenFile(snapshot.file.name);
      } else {
        const message = snapshot.error?.message ?? `Render ended with ${snapshot.status}`;
        setError(message);
        setStatus(null);
      }
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    } finally {
      if (runIdRef.current === runId) setRendering(false);
    }
  }

  return (
    <div className="viewer hyperframes-preview-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            HyperFrames · {composition.title}
          </span>
          <span className="viewer-meta faint">{composition.compositionDir}</span>
        </div>
        <div className="viewer-toolbar-actions">
          <a
            className="ghost-link"
            href={studioUrl ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
            aria-disabled={studioUrl ? undefined : true}
            onClick={(event) => {
              if (!studioUrl) event.preventDefault();
            }}
          >
            Open
          </a>
          <button
            type="button"
            className="viewer-action primary"
            data-running={rendering ? 'true' : undefined}
            disabled={rendering}
            onClick={() => void handleRender()}
          >
            <Icon name={rendering ? 'spinner' : 'download'} size={13} />
            <span>{rendering ? 'Rendering' : 'Render MP4'}</span>
          </button>
        </div>
      </div>
      <div className="viewer-body hyperframes-preview-body">
        {studioUrl ? (
          <iframe
            title={`HyperFrames Studio: ${composition.title}`}
            src={studioUrl}
            sandbox="allow-scripts allow-same-origin allow-downloads allow-forms allow-popups"
          />
        ) : (
          <div className="hyperframes-studio-loading" role="status">
            <span>{studioError ? 'HyperFrames Studio failed to start' : 'Starting HyperFrames Studio'}</span>
            <small>
              {studioError ?? (studioStarting ? composition.compositionDir : 'Preparing preview')}
            </small>
          </div>
        )}
        {status || error || progress.length > 0 ? (
          <div className="hyperframes-render-status" role="status">
            {error ? (
              <span className="hyperframes-render-error">{error}</span>
            ) : (
              <span>{status}</span>
            )}
            {progress.length > 0 ? (
              <span className="hyperframes-render-progress">
                {progress[progress.length - 1]}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function isPending(status: MediaTaskSnapshot['status']): boolean {
  return status === 'queued' || status === 'running';
}

function appendProgress(
  snapshot: MediaTaskSnapshot,
  setProgress: (updater: (prev: string[]) => string[]) => void,
) {
  if (!snapshot.progress || snapshot.progress.length === 0) return;
  setProgress((prev) => [...prev, ...snapshot.progress!.filter(Boolean)].slice(-12));
}

function suggestedOutputName(composition: HyperFramesCompositionSummary): string {
  const slug = (composition.title || composition.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'hyperframes-render'}.mp4`;
}
