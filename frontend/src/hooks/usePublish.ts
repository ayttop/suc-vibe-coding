import { useCallback, useRef, useState } from "react";
import type { VirtualFile } from "./useVirtualFS";

export type PublishStatus = "idle" | "publishing" | "done" | "error";

export interface PublishStep {
  step: string;
  message: string;
  timestamp: number;
}

interface PublishArgs {
  repoName: string;
  isPrivate: boolean;
  overwrite: boolean;
  files: VirtualFile[];
  commitMessage?: string;
}

interface PublishResult {
  repoId?: string;
  spaceUrl?: string;
}

export function usePublish(accessToken: string | null) {
  const [status, setStatus] = useState<PublishStatus>("idle");
  const [steps, setSteps] = useState<PublishStep[]>([]);
  const [result, setResult] = useState<PublishResult>({});
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setStatus("idle");
    setSteps([]);
    setResult({});
    setError(null);
    setErrorCode(null);
  }, []);

  const publish = useCallback(
    async (args: PublishArgs) => {
      if (!accessToken) {
        setError("You must sign in with Hugging Face before publishing.");
        setStatus("error");
        return;
      }
      reset();
      setStatus("publishing");

      const controller = new AbortController();
      abortRef.current = controller;

      const pushStep = (step: string, message: string) =>
        setSteps((prev) => [
          ...prev,
          { step, message, timestamp: Date.now() },
        ]);

      try {
        const response = await fetch("/api/publish", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            repoName: args.repoName,
            private: args.isPrivate,
            overwrite: args.overwrite,
            commitMessage: args.commitMessage,
            files: args.files.map((f) => ({ path: f.path, content: f.content })),
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const text = await response.text().catch(() => "");
          throw new Error(
            text || `Publish request failed (${response.status})`,
          );
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let eventEnd;
          while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, eventEnd);
            buffer = buffer.slice(eventEnd + 2);
            const lines = raw.split("\n");
            let eventName = "message";
            let dataStr = "";
            for (const line of lines) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
            }
            if (!dataStr) continue;
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(dataStr);
            } catch {
              continue;
            }

            if (eventName === "progress") {
              pushStep(String(data.step ?? "?"), String(data.message ?? ""));
            } else if (eventName === "done") {
              pushStep("done", String(data.message ?? "Published"));
              setResult({
                repoId: data.repoId as string | undefined,
                spaceUrl: data.spaceUrl as string | undefined,
              });
              setStatus("done");
            } else if (eventName === "error") {
              setError(String(data.message ?? "Publish failed"));
              setErrorCode((data.code as string | undefined) ?? null);
              setStatus("error");
            }
          }
        }
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Unknown error");
        setStatus("error");
      } finally {
        abortRef.current = null;
      }
    },
    [accessToken, reset],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
  }, []);

  return {
    status,
    steps,
    result,
    error,
    errorCode,
    publish,
    cancel,
    reset,
  };
}
