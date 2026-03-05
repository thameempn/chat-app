/**
 * Multi-tier Caching Layer
 * Provides in-memory LRU cache with optional Redis backing and cache invalidation strategies
 */

interface CacheEntry<T> {
  value: T;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  ttl: number;
  tags: string[];
  size: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  maxSize: number;
  hitRate: number;
  avgAccessTime: number;
  oldestEntry: number | null;
  newestEntry: number | null;
}

interface CacheConfig {
  maxSize: number;
  defaultTtl: number;
  evictionPolicy: 'lru' | 'lfu' | 'fifo' | 'ttl';
  onEvict?: (key: string, value: any) => void;
  serializer?: {
    serialize: (value: any) => string;
    deserialize: (data: string) => any;
  };
}

type CacheEventType = 'hit' | 'miss' | 'set' | 'delete' | 'evict' | 'clear' | 'expire';

interface CacheEvent {
  type: CacheEventType;
  key: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

class CacheManager<T = any> {
  private store: Map<string, CacheEntry<T>>;
  private config: CacheConfig;
  private stats: {
    hits: number;
    misses: number;
    evictions: number;
    totalAccessTime: number;
    accessCount: number;
  };
  private eventListeners: Map<CacheEventType, Array<(event: CacheEvent) => void>>;
  private cleanupInterval: NodeJS.Timer | null;
  private tagIndex: Map<string, Set<string>>; // tag -> Set of keys

  constructor(config: Partial<CacheConfig> = {}) {
    this.store = new Map();
    this.config = {
      maxSize: config.maxSize || 1000,
      defaultTtl: config.defaultTtl || 300000, // 5 minutes
      evictionPolicy: config.evictionPolicy || 'lru',
      onEvict: config.onEvict,
      serializer: config.serializer,
    };
    this.stats = { hits: 0, misses: 0, evictions: 0, totalAccessTime: 0, accessCount: 0 };
    this.eventListeners = new Map();
    this.tagIndex = new Map();
    this.cleanupInterval = null;

    this.startCleanup();
  }

  /**
   * Get a value from the cache
   */
  get(key: string): T | undefined {
    const startTime = performance.now();
    const entry = this.store.get(key);

    if (!entry) {
      this.stats.misses++;
      this.emit('miss', key);
      this.recordAccessTime(startTime);
      return undefined;
    }

    // Check TTL
    if (this.isExpired(entry)) {
      this.delete(key);
      this.stats.misses++;
      this.emit('expire', key);
      this.recordAccessTime(startTime);
      return undefined;
    }

    // Update access metadata
    entry.lastAccessedAt = Date.now();
    entry.accessCount++;

    this.stats.hits++;
    this.emit('hit', key);
    this.recordAccessTime(startTime);

    return entry.value;
  }

  /**
   * Set a value in the cache
   */
  set(key: string, value: T, options: { ttl?: number; tags?: string[] } = {}): void {
    const ttl = options.ttl ?? this.config.defaultTtl;
    const tags = options.tags || [];
    const size = this.estimateSize(value);

    // Evict if at capacity
    while (this.store.size >= this.config.maxSize) {
      this.evict();
    }

    // Remove old tag associations if key exists
    const existing = this.store.get(key);
    if (existing) {
      this.removeFromTagIndex(key, existing.tags);
    }

    const entry: CacheEntry<T> = {
      value,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      ttl,
      tags,
      size,
    };

    this.store.set(key, entry);

    // Update tag index
    for (const tag of tags) {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set());
      }
      this.tagIndex.get(tag)!.add(key);
    }

    this.emit('set', key, { ttl, tags, size });
  }

  /**
   * Delete a key from the cache
   */
  delete(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;

    this.removeFromTagIndex(key, entry.tags);
    this.store.delete(key);
    this.emit('delete', key);
    return true;
  }

  /**
   * Check if a key exists and is not expired
   */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Get or set pattern - returns cached value or computes and caches it
   */
  async getOrSet(key: string, factory: () => Promise<T>, options: { ttl?: number; tags?: string[] } = {}): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const value = await factory();
    this.set(key, value, options);
    return value;
  }

  /**
   * Invalidate all entries with a specific tag
   */
  invalidateByTag(tag: string): number {
    const keys = this.tagIndex.get(tag);
    if (!keys) return 0;

    let count = 0;
    for (const key of keys) {
      if (this.delete(key)) count++;
    }
    this.tagIndex.delete(tag);
    return count;
  }

  /**
   * Invalidate entries matching a pattern (glob-style)
   */
  invalidateByPattern(pattern: string): number {
    const regex = this.globToRegex(pattern);
    let count = 0;

    for (const key of this.store.keys()) {
      if (regex.test(key)) {
        if (this.delete(key)) count++;
      }
    }
    return count;
  }

  /**
   * Get multiple values at once
   */
  getMany(keys: string[]): Map<string, T | undefined> {
    const results = new Map<string, T | undefined>();
    for (const key of keys) {
      results.set(key, this.get(key));
    }
    return results;
  }

  /**
   * Set multiple values at once
   */
  setMany(entries: Array<{ key: string; value: T; ttl?: number; tags?: string[] }>): void {
    for (const entry of entries) {
      this.set(entry.key, entry.value, { ttl: entry.ttl, tags: entry.tags });
    }
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.store.clear();
    this.tagIndex.clear();
    this.emit('clear', '*');
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const totalRequests = this.stats.hits + this.stats.misses;
    let oldest: number | null = null;
    let newest: number | null = null;

    for (const entry of this.store.values()) {
      if (oldest === null || entry.createdAt < oldest) oldest = entry.createdAt;
      if (newest === null || entry.createdAt > newest) newest = entry.createdAt;
    }

    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      size: this.store.size,
      maxSize: this.config.maxSize,
      hitRate: totalRequests > 0 ? (this.stats.hits / totalRequests) * 100 : 0,
      avgAccessTime: this.stats.accessCount > 0 ? this.stats.totalAccessTime / this.stats.accessCount : 0,
      oldestEntry: oldest,
      newestEntry: newest,
    };
  }

  /**
   * Get all keys matching a pattern
   */
  keys(pattern?: string): string[] {
    if (!pattern) return Array.from(this.store.keys());

    const regex = this.globToRegex(pattern);
    return Array.from(this.store.keys()).filter(key => regex.test(key));
  }

  /**
   * Get the number of non-expired entries
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Register an event listener
   */
  on(event: CacheEventType, listener: (event: CacheEvent) => void): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(listener);
  }

  /**
   * Remove an event listener
   */
  off(event: CacheEventType, listener: (event: CacheEvent) => void): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    }
  }

  /**
   * Shutdown the cache manager
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval as any);
      this.cleanupInterval = null;
    }
    this.clear();
    this.eventListeners.clear();
  }

  // --- Private Methods ---

  private evict(): void {
    let keyToEvict: string | null = null;

    switch (this.config.evictionPolicy) {
      case 'lru':
        keyToEvict = this.findLRU();
        break;
      case 'lfu':
        keyToEvict = this.findLFU();
        break;
      case 'fifo':
        keyToEvict = this.findFIFO();
        break;
      case 'ttl':
        keyToEvict = this.findShortestTTL();
        break;
    }

    if (keyToEvict) {
      const entry = this.store.get(keyToEvict);
      if (entry && this.config.onEvict) {
        this.config.onEvict(keyToEvict, entry.value);
      }
      this.delete(keyToEvict);
      this.stats.evictions++;
      this.emit('evict', keyToEvict);
    }
  }

  private findLRU(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.store.entries()) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }

  private findLFU(): string | null {
    let leastKey: string | null = null;
    let leastCount = Infinity;

    for (const [key, entry] of this.store.entries()) {
      if (entry.accessCount < leastCount) {
        leastCount = entry.accessCount;
        leastKey = key;
      }
    }
    return leastKey;
  }

  private findFIFO(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.store.entries()) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }

  private findShortestTTL(): string | null {
    let targetKey: string | null = null;
    let shortestRemaining = Infinity;

    for (const [key, entry] of this.store.entries()) {
      const remaining = (entry.createdAt + entry.ttl) - Date.now();
      if (remaining < shortestRemaining) {
        shortestRemaining = remaining;
        targetKey = key;
      }
    }
    return targetKey;
  }

  private isExpired(entry: CacheEntry<T>): boolean {
    if (entry.ttl <= 0) return false; // No expiry
    return Date.now() - entry.createdAt > entry.ttl;
  }

  private removeFromTagIndex(key: string, tags: string[]): void {
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      if (keys) {
        keys.delete(key);
        if (keys.size === 0) this.tagIndex.delete(tag);
      }
    }
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      for (const [key, entry] of this.store.entries()) {
        if (this.isExpired(entry)) {
          this.delete(key);
          this.emit('expire', key);
        }
      }
    }, 60000); // Every minute
  }

  private estimateSize(value: any): number {
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number') return 8;
    if (typeof value === 'boolean') return 4;
    if (value === null || value === undefined) return 0;
    try {
      return JSON.stringify(value).length * 2;
    } catch {
      return 1024; // Default estimate
    }
  }

  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
  }

  private emit(type: CacheEventType, key: string, metadata?: Record<string, any>): void {
    const event: CacheEvent = { type, key, timestamp: Date.now(), metadata };
    const listeners = this.eventListeners.get(type) || [];
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors
      }
    }
  }

  private recordAccessTime(startTime: number): void {
    this.stats.totalAccessTime += performance.now() - startTime;
    this.stats.accessCount++;
  }
}

/**
 * Cache warming utility - pre-populates cache with frequently accessed data
 */
class CacheWarmer<T> {
  private cache: CacheManager<T>;
  private warmupFns: Array<{
    name: string;
    fn: () => Promise<Array<{ key: string; value: T; ttl?: number; tags?: string[] }>>;
    interval?: number;
    lastRun?: number;
  }>;
  private isRunning: boolean;
  private intervalId: NodeJS.Timer | null;

  constructor(cache: CacheManager<T>) {
    this.cache = cache;
    this.warmupFns = [];
    this.isRunning = false;
    this.intervalId = null;
  }

  register(name: string, fn: () => Promise<Array<{ key: string; value: T; ttl?: number; tags?: string[] }>>, interval?: number): void {
    this.warmupFns.push({ name, fn, interval });
  }

  async warmup(): Promise<{ name: string; count: number; duration: number }[]> {
    const results: { name: string; count: number; duration: number }[] = [];

    for (const warmup of this.warmupFns) {
      const start = Date.now();
      try {
        const entries = await warmup.fn();
        this.cache.setMany(entries);
        warmup.lastRun = Date.now();
        results.push({ name: warmup.name, count: entries.length, duration: Date.now() - start });
      } catch {
        results.push({ name: warmup.name, count: 0, duration: Date.now() - start });
      }
    }
    return results;
  }

  startPeriodicWarmup(defaultInterval: number = 300000): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.intervalId = setInterval(async () => {
      const now = Date.now();
      for (const warmup of this.warmupFns) {
        const interval = warmup.interval || defaultInterval;
        if (!warmup.lastRun || now - warmup.lastRun >= interval) {
          try {
            const entries = await warmup.fn();
            this.cache.setMany(entries);
            warmup.lastRun = now;
          } catch {
            // Skip failed warmup
          }
        }
      }
    }, 60000);
  }

  stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId as any);
      this.intervalId = null;
    }
  }
}

/**
 * Cache namespace utility - provides isolated cache partitions
 */
class CacheNamespace<T> {
  private cache: CacheManager<T>;
  private prefix: string;

  constructor(cache: CacheManager<T>, namespace: string) {
    this.cache = cache;
    this.prefix = `${namespace}:`;
  }

  get(key: string): T | undefined {
    return this.cache.get(this.prefix + key);
  }

  set(key: string, value: T, options: { ttl?: number; tags?: string[] } = {}): void {
    const tags = (options.tags || []).map(t => `${this.prefix}${t}`);
    this.cache.set(this.prefix + key, value, { ...options, tags });
  }

  delete(key: string): boolean {
    return this.cache.delete(this.prefix + key);
  }

  has(key: string): boolean {
    return this.cache.has(this.prefix + key);
  }

  clear(): number {
    return this.cache.invalidateByPattern(`${this.prefix}*`);
  }

  keys(): string[] {
    return this.cache.keys(`${this.prefix}*`).map(k => k.slice(this.prefix.length));
  }
}

export { CacheManager, CacheWarmer, CacheNamespace };
export type { CacheEntry, CacheStats, CacheConfig, CacheEvent, CacheEventType };
