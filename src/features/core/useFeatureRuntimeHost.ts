import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { featureRegistry } from "./featureRegistry";
import type {
  FeatureDefinition,
  FeatureId,
  FeatureRuntime
} from "./featureTypes";

export type FeatureRuntimeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; runtime: FeatureRuntime }
  | { status: "failed"; error: Error };

export interface FeatureRuntimeHost {
  active: FeatureRuntimeState;
  readyRuntimes: ReadonlyMap<FeatureId, FeatureRuntime>;
  retry: () => void;
}

interface RuntimeRequest {
  generation: number;
  promise: Promise<FeatureRuntime>;
}

function eagerRuntimes(
  definitions: readonly FeatureDefinition[]
): Map<FeatureId, FeatureRuntime> {
  return new Map(
    definitions.flatMap((definition) =>
      definition.runtime ? [[definition.id, definition.runtime]] : []
    )
  );
}

function runtimeError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export function useFeatureRuntimeHost(
  activeFeatureId: FeatureId,
  definitions: readonly FeatureDefinition[] = featureRegistry
): FeatureRuntimeHost {
  const definitionsById = useMemo(
    () => new Map(definitions.map((definition) => [definition.id, definition])),
    [definitions]
  );
  const [readyRuntimes, setReadyRuntimes] = useState(() =>
    eagerRuntimes(definitions)
  );
  const [states, setStates] = useState<
    ReadonlyMap<FeatureId, FeatureRuntimeState>
  >(() => new Map());
  const requestsRef = useRef(new Map<FeatureId, RuntimeRequest>());
  const generationsRef = useRef(new Map<FeatureId, number>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    (featureId: FeatureId, force: boolean) => {
      const definition = definitionsById.get(featureId);
      if (!definition || !definition.loadRuntime) {
        return;
      }
      if (!force && readyRuntimes.has(featureId)) {
        return;
      }
      if (!force && requestsRef.current.has(featureId)) {
        return;
      }

      const generation = (generationsRef.current.get(featureId) ?? 0) + 1;
      generationsRef.current.set(featureId, generation);
      const promise = Promise.resolve().then(definition.loadRuntime);
      requestsRef.current.set(featureId, { generation, promise });

      if (force) {
        setReadyRuntimes((current) => {
          if (!current.has(featureId)) {
            return current;
          }
          const next = new Map(current);
          next.delete(featureId);
          return next;
        });
      }
      setStates((current) => {
        const next = new Map(current);
        next.set(featureId, { status: "loading" });
        return next;
      });

      void promise.then(
        (runtime) => {
          if (
            !mountedRef.current ||
            generationsRef.current.get(featureId) !== generation
          ) {
            return;
          }
          requestsRef.current.delete(featureId);
          setReadyRuntimes((current) =>
            new Map(current).set(featureId, runtime)
          );
          setStates((current) => {
            const next = new Map(current);
            next.set(featureId, { status: "ready", runtime });
            return next;
          });
        },
        (reason) => {
          if (
            !mountedRef.current ||
            generationsRef.current.get(featureId) !== generation
          ) {
            return;
          }
          requestsRef.current.delete(featureId);
          setStates((current) => {
            const next = new Map(current);
            next.set(featureId, {
              status: "failed",
              error: runtimeError(reason)
            });
            return next;
          });
        }
      );
    },
    [definitionsById, readyRuntimes]
  );

  useEffect(() => {
    load(activeFeatureId, false);
  }, [activeFeatureId, load]);

  const retry = useCallback(() => {
    load(activeFeatureId, true);
  }, [activeFeatureId, load]);

  const activeRuntime = readyRuntimes.get(activeFeatureId);
  const active = activeRuntime
    ? ({ status: "ready", runtime: activeRuntime } as const)
    : states.get(activeFeatureId) ?? ({ status: "idle" } as const);

  return { active, readyRuntimes, retry };
}
