import type {
  MonacoSessionLease,
  MonacoSessionRegistry,
  MonacoSessionRegistryPort
} from "./sessionRegistry";
import { loadMonacoOutlineRuntime } from "./runtimeLoader";

export class LazyMonacoOutlineSessionRegistry
implements MonacoSessionRegistry {
  private registry: MonacoSessionRegistry | null = null;
  private loading: Promise<MonacoSessionRegistry> | null = null;

  constructor(private readonly port: MonacoSessionRegistryPort) {}

  async acquire(pageId: string): Promise<MonacoSessionLease> {
    return (await this.load()).acquire(pageId);
  }

  async flushPage(
    pageId: string,
    reason: "navigation" | "close"
  ): Promise<void> {
    if (!this.registry && !this.loading) return;
    await (await this.load()).flushPage(pageId, reason);
  }

  async flushAll(reason: "close"): Promise<void> {
    if (!this.registry && !this.loading) return;
    await (await this.load()).flushAll(reason);
  }

  hasFocusedEditor(target: EventTarget | null): boolean {
    return this.registry?.hasFocusedEditor(target) ?? false;
  }

  async dispose(): Promise<void> {
    if (!this.registry && !this.loading) return;
    await (await this.load()).dispose();
  }

  private load(): Promise<MonacoSessionRegistry> {
    this.loading ??= loadMonacoOutlineRuntime().then(
      ({ MonacoOutlineSessionRegistry }) => {
        const registry = new MonacoOutlineSessionRegistry(this.port);
        this.registry = registry;
        return registry;
      }
    );
    return this.loading;
  }
}
