export type ImageLease =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "error"; readonly message: string };

export interface ResidentImageIdentity {
  readonly nodeId: string;
  readonly contentHash: string;
  readonly mimeType: string;
}

interface ResidencyOptions {
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
  readonly maximumUrls?: number;
}

interface Entry {
  identity: string;
  image: ResidentImageIdentity;
  state: ImageLease;
  active: number;
  generation: number;
  lastUsed: number;
  readonly listeners: Set<() => void>;
}

const idle: ImageLease = { status: "idle" };

export class ImageResidency {
  private readonly entries = new Map<string, Entry>();
  private readonly createObjectURL: (blob: Blob) => string;
  private readonly revokeObjectURL: (url: string) => void;
  private readonly maximumUrls: number;
  private clock = 0;
  private disposed = false;

  constructor(
    private readonly read: (nodeId: string) => Promise<Uint8Array>,
    options: ResidencyOptions = {}
  ) {
    this.createObjectURL = options.createObjectURL ??
      ((blob) => URL.createObjectURL(blob));
    this.revokeObjectURL = options.revokeObjectURL ??
      ((url) => URL.revokeObjectURL(url));
    this.maximumUrls = options.maximumUrls ?? 8;
  }

  subscribe(
    image: ResidentImageIdentity,
    listener: () => void
  ): () => void {
    if (this.disposed) return () => undefined;
    const entry = this.ensure(image);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  getSnapshot(image: ResidentImageIdentity): ImageLease {
    if (this.disposed) return idle;
    return this.ensure(image).state;
  }

  activate(image: ResidentImageIdentity): () => void {
    if (this.disposed) return () => undefined;
    const entry = this.ensure(image);
    entry.active += 1;
    this.touch(entry);
    if (entry.state.status === "idle" || entry.state.status === "error") {
      this.loadEntry(entry);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.active = Math.max(0, entry.active - 1);
      if (entry.active === 0 && entry.state.status === "loading") {
        entry.generation += 1;
        this.setState(entry, idle);
      }
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.generation += 1;
      this.revokeReady(entry);
      entry.state = idle;
      entry.listeners.forEach((listener) => listener());
      entry.listeners.clear();
    }
    this.entries.clear();
  }

  private ensure(image: ResidentImageIdentity): Entry {
    const identity = imageIdentity(image);
    const existing = this.entries.get(image.nodeId);
    if (existing && existing.identity === identity) return existing;
    if (existing) {
      existing.generation += 1;
      this.revokeReady(existing);
      existing.identity = identity;
      existing.image = image;
      existing.state = idle;
      this.touch(existing);
      return existing;
    }
    const entry: Entry = {
      identity,
      image,
      state: idle,
      active: 0,
      generation: 0,
      lastUsed: ++this.clock,
      listeners: new Set()
    };
    this.entries.set(image.nodeId, entry);
    return entry;
  }

  private loadEntry(entry: Entry): void {
    const generation = entry.generation + 1;
    entry.generation = generation;
    this.setState(entry, { status: "loading" });
    void this.read(entry.image.nodeId).then((bytes) => {
      if (
        this.disposed ||
        entry.generation !== generation ||
        entry.active === 0
      ) {
        return;
      }
      const ownedBytes = new Uint8Array(bytes.length);
      ownedBytes.set(bytes);
      const url = this.createObjectURL(new Blob([ownedBytes.buffer], {
        type: entry.image.mimeType
      }));
      if (
        this.disposed ||
        entry.generation !== generation ||
        entry.active === 0
      ) {
        this.revokeObjectURL(url);
        return;
      }
      this.touch(entry);
      this.setState(entry, { status: "ready", url });
      this.evictOverflow();
    }).catch((cause: unknown) => {
      if (
        this.disposed ||
        entry.generation !== generation ||
        entry.active === 0
      ) {
        return;
      }
      this.setState(entry, {
        status: "error",
        message: cause instanceof Error ? cause.message : "Image unavailable"
      });
    });
  }

  private evictOverflow(): void {
    while (this.readyCount() > this.maximumUrls) {
      const oldest = [...this.entries.values()]
        .filter((entry) => entry.state.status === "ready")
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!oldest) return;
      oldest.generation += 1;
      this.revokeReady(oldest);
      this.setState(oldest, idle);
    }
  }

  private readyCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.state.status === "ready") count += 1;
    }
    return count;
  }

  private revokeReady(entry: Entry): void {
    if (entry.state.status === "ready") {
      this.revokeObjectURL(entry.state.url);
    }
  }

  private touch(entry: Entry): void {
    entry.lastUsed = ++this.clock;
  }

  private setState(entry: Entry, state: ImageLease): void {
    entry.state = state;
    entry.listeners.forEach((listener) => listener());
  }
}

function imageIdentity(image: ResidentImageIdentity): string {
  return `${image.contentHash}:${image.mimeType}`;
}
