import { useCallback, useMemo, useRef, useState } from "react";

export interface VirtualFile {
  path: string;
  content: string;
  updatedAt: number;
}

/**
 * In-memory virtual file system for the app the agent is building.
 *
 * The agent mutates it through client-side tool execution (`onToolCall` in
 * `useAgentChat`), the user can also edit files by hand in the Monaco pane.
 * `version` is bumped on every mutation so the preview iframe and the
 * publish flow can react to changes.
 */
export function useVirtualFS(initial?: VirtualFile[]) {
  const [files, setFiles] = useState<Map<string, VirtualFile>>(() => {
    const map = new Map<string, VirtualFile>();
    (initial ?? []).forEach((f) => map.set(f.path, f));
    return map;
  });
  const [version, setVersion] = useState(0);
  // `filesRef.current` is the source of truth for the *synchronous* view of
  // the VFS. React re-renders only between frames, but the agent can fire
  // several tool calls inside the same microtask (one stream chunk). If we
  // let `filesRef` lag behind until the next render, the second tool call
  // reads the state from BEFORE the first one and either errors out or
  // operates on stale content - silently dropping the first edit.
  //
  // To avoid that, every mutation updates `filesRef.current` synchronously
  // (in addition to scheduling the React state update). All reads (editFile,
  // deleteFile, readFile, listFiles, getAll) go through the ref.
  const filesRef = useRef(files);

  const bump = () => setVersion((v) => v + 1);

  const commit = useCallback((next: Map<string, VirtualFile>) => {
    filesRef.current = next;
    setFiles(next);
    bump();
  }, []);

  const writeFile = useCallback(
    (path: string, content: string) => {
      const next = new Map(filesRef.current);
      next.set(path, { path, content, updatedAt: Date.now() });
      commit(next);
    },
    [commit],
  );

  const editFile = useCallback(
    (
      path: string,
      oldString: string,
      newString: string,
    ): { ok: boolean; error?: string } => {
      const current = filesRef.current.get(path);
      if (!current) {
        return { ok: false, error: `File "${path}" does not exist (call write_file first).` };
      }
      const count = current.content.split(oldString).length - 1;
      if (count === 0) {
        return { ok: false, error: `old_string not found in "${path}".` };
      }
      if (count > 1) {
        return {
          ok: false,
          error: `old_string is not unique in "${path}" (${count} occurrences). Add more surrounding context.`,
        };
      }
      const nextContent = current.content.replace(oldString, newString);
      const next = new Map(filesRef.current);
      next.set(path, { path, content: nextContent, updatedAt: Date.now() });
      commit(next);
      return { ok: true };
    },
    [commit],
  );

  const deleteFile = useCallback(
    (path: string): { ok: boolean; error?: string } => {
      if (!filesRef.current.has(path)) {
        return { ok: false, error: `File "${path}" does not exist.` };
      }
      const next = new Map(filesRef.current);
      next.delete(path);
      commit(next);
      return { ok: true };
    },
    [commit],
  );

  const readFile = useCallback((path: string): VirtualFile | null => {
    return filesRef.current.get(path) ?? null;
  }, []);

  const listFiles = useCallback((): VirtualFile[] => {
    return Array.from(filesRef.current.values()).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  }, []);

  const clear = useCallback(() => {
    commit(new Map());
  }, [commit]);

  // Referentially stable across re-renders that don't mutate the VFS. The
  // `files` Map is only replaced on `commit`, so this array keeps the same
  // identity until an actual edit happens. Critical: PreviewFrame's build
  // effect depends on `files`; a fresh array every render would re-fire it
  // on each unrelated parent re-render (e.g. after onDocReady -> setDocId),
  // looping rebuild -> new docId -> remount -> the preview "flicker".
  const sortedFiles = useMemo(
    () =>
      Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path)),
    [files],
  );

  return {
    files: sortedFiles,
    filesMap: files,
    version,
    writeFile,
    editFile,
    deleteFile,
    readFile,
    listFiles,
    clear,
    getAll: () => Array.from(filesRef.current.values()),
  };
}

export type VirtualFSHandle = ReturnType<typeof useVirtualFS>;
