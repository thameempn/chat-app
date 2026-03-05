/**
 * Distributed Event Bus with Pub/Sub, Event Sourcing, and Saga Orchestration
 *
 * Provides a robust event-driven architecture for microservice communication patterns:
 * - Publish/Subscribe with topic-based routing
 * - Event sourcing with aggregate root pattern
 * - Saga orchestration for distributed transactions
 * - Dead letter queue for failed event processing
 * - Event replay and temporal queries
 * - Circuit breaker for resilient event handling
 */

import { EventEmitter } from 'events';

// ============================================================================
// Core Types
// ============================================================================

interface DomainEvent<T = unknown> {
  id: string;
  type: string;
  aggregateId: string;
  aggregateType: string;
  version: number;
  payload: T;
  metadata: EventMetadata;
  timestamp: Date;
  correlationId?: string;
  causationId?: string;
}

interface EventMetadata {
  userId?: string;
  source: string;
  traceId: string;
  spanId: string;
  environment: string;
  retryCount: number;
  originalTimestamp: Date;
  headers: Record<string, string>;
}

interface EventSubscription {
  id: string;
  topic: string;
  handler: EventHandler;
  filter?: EventFilter;
  priority: number;
  maxRetries: number;
  retryDelay: number;
  timeout: number;
  createdAt: Date;
  isActive: boolean;
  processedCount: number;
  errorCount: number;
  lastProcessedAt?: Date;
  lastErrorAt?: Date;
}

type EventHandler = (event: DomainEvent) => Promise<void>;
type EventFilter = (event: DomainEvent) => boolean;

interface EventStore {
  events: DomainEvent[];
  snapshots: Map<string, AggregateSnapshot>;
  maxEventsPerAggregate: number;
  snapshotInterval: number;
}

interface AggregateSnapshot {
  aggregateId: string;
  aggregateType: string;
  version: number;
  state: unknown;
  timestamp: Date;
}

interface DeadLetterEntry {
  event: DomainEvent;
  error: string;
  failedAt: Date;
  subscription: string;
  retryCount: number;
  lastRetryAt?: Date;
}

interface CircuitBreakerState {
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  successCount: number;
  lastFailureAt?: Date;
  lastSuccessAt?: Date;
  openedAt?: Date;
  halfOpenAllowed: number;
}

// ============================================================================
// Event Bus Core
// ============================================================================

class EventBus {
  private emitter: EventEmitter;
  private subscriptions: Map<string, EventSubscription[]>;
  private eventStore: EventStore;
  private deadLetterQueue: DeadLetterEntry[];
  private circuitBreakers: Map<string, CircuitBreakerState>;
  private middleware: EventMiddleware[];
  private metrics: EventBusMetrics;
  private isShuttingDown: boolean;

  constructor(config: Partial<EventBusConfig> = {}) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
    this.subscriptions = new Map();
    this.eventStore = {
      events: [],
      snapshots: new Map(),
      maxEventsPerAggregate: config.maxEventsPerAggregate || 1000,
      snapshotInterval: config.snapshotInterval || 100,
    };
    this.deadLetterQueue = [];
    this.circuitBreakers = new Map();
    this.middleware = [];
    this.isShuttingDown = false;
    this.metrics = {
      totalPublished: 0,
      totalProcessed: 0,
      totalFailed: 0,
      totalRetried: 0,
      totalDeadLettered: 0,
      avgProcessingTime: 0,
      topicCounts: new Map(),
      subscriptionHealth: new Map(),
    };
  }

  /**
   * Publish a domain event to all subscribers
   */
  async publish<T>(event: Omit<DomainEvent<T>, 'id' | 'timestamp' | 'metadata'> & { metadata?: Partial<EventMetadata> }): Promise<string> {
    if (this.isShuttingDown) throw new Error('Event bus is shutting down');

    const fullEvent: DomainEvent<T> = {
      ...event,
      id: this.generateEventId(),
      timestamp: new Date(),
      metadata: {
        source: event.metadata?.source || 'unknown',
        traceId: event.metadata?.traceId || this.generateTraceId(),
        spanId: event.metadata?.spanId || this.generateSpanId(),
        environment: event.metadata?.environment || 'production',
        retryCount: 0,
        originalTimestamp: new Date(),
        headers: event.metadata?.headers || {},
        userId: event.metadata?.userId,
      },
    };

    // Run middleware pipeline
    const processedEvent = await this.runMiddleware(fullEvent);
    if (!processedEvent) return fullEvent.id; // Middleware filtered the event

    // Store event
    this.eventStore.events.push(processedEvent as DomainEvent);

    // Check if snapshot needed
    await this.maybeCreateSnapshot(processedEvent as DomainEvent);

    // Get matching subscriptions
    const topicSubscriptions = this.subscriptions.get(event.type) || [];
    const wildcardSubscriptions = this.subscriptions.get('*') || [];
    const allSubscriptions = [...topicSubscriptions, ...wildcardSubscriptions]
      .filter(sub => sub.isActive)
      .sort((a, b) => b.priority - a.priority);

    // Dispatch to all matching subscriptions
    const deliveryPromises = allSubscriptions.map(sub =>
      this.deliverToSubscription(processedEvent as DomainEvent, sub)
    );

    await Promise.allSettled(deliveryPromises);

    this.metrics.totalPublished++;
    this.incrementTopicCount(event.type);

    return fullEvent.id;
  }

  /**
   * Subscribe to events of a specific type
   */
  subscribe(topic: string, handler: EventHandler, options: Partial<Omit<EventSubscription, 'id' | 'topic' | 'handler' | 'createdAt' | 'processedCount' | 'errorCount'>> = {}): string {
    const subscription: EventSubscription = {
      id: this.generateSubscriptionId(),
      topic,
      handler,
      filter: options.filter,
      priority: options.priority || 0,
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      timeout: options.timeout || 30000,
      isActive: options.isActive ?? true,
      createdAt: new Date(),
      processedCount: 0,
      errorCount: 0,
    };

    const existing = this.subscriptions.get(topic) || [];
    existing.push(subscription);
    this.subscriptions.set(topic, existing);

    return subscription.id;
  }

  /**
   * Unsubscribe from events
   */
  unsubscribe(subscriptionId: string): boolean {
    for (const [topic, subs] of this.subscriptions.entries()) {
      const index = subs.findIndex(s => s.id === subscriptionId);
      if (index !== -1) {
        subs.splice(index, 1);
        if (subs.length === 0) this.subscriptions.delete(topic);
        return true;
      }
    }
    return false;
  }

  /**
   * Add middleware to the event processing pipeline
   */
  use(middleware: EventMiddleware): void {
    this.middleware.push(middleware);
  }

  /**
   * Get events for a specific aggregate
   */
  getAggregateEvents(aggregateId: string, afterVersion?: number): DomainEvent[] {
    return this.eventStore.events
      .filter(e => e.aggregateId === aggregateId && (!afterVersion || e.version > afterVersion))
      .sort((a, b) => a.version - b.version);
  }

  /**
   * Replay events for rebuilding state
   */
  async replayEvents(options: {
    topic?: string;
    aggregateId?: string;
    from?: Date;
    to?: Date;
    handler: EventHandler;
  }): Promise<number> {
    let events = [...this.eventStore.events];

    if (options.topic) events = events.filter(e => e.type === options.topic);
    if (options.aggregateId) events = events.filter(e => e.aggregateId === options.aggregateId);
    if (options.from) events = events.filter(e => e.timestamp >= options.from!);
    if (options.to) events = events.filter(e => e.timestamp <= options.to!);

    events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    let processed = 0;
    for (const event of events) {
      await options.handler(event);
      processed++;
    }

    return processed;
  }

  /**
   * Get dead letter queue entries
   */
  getDeadLetterQueue(): DeadLetterEntry[] {
    return [...this.deadLetterQueue];
  }

  /**
   * Retry a dead letter entry
   */
  async retryDeadLetter(index: number): Promise<boolean> {
    if (index < 0 || index >= this.deadLetterQueue.length) return false;

    const entry = this.deadLetterQueue[index];
    const subs = this.subscriptions.get(entry.event.type) || [];
    const sub = subs.find(s => s.id === entry.subscription);

    if (!sub) return false;

    try {
      await this.executeHandler(sub, entry.event);
      this.deadLetterQueue.splice(index, 1);
      return true;
    } catch {
      entry.retryCount++;
      entry.lastRetryAt = new Date();
      return false;
    }
  }

  /**
   * Get event bus metrics
   */
  getMetrics(): EventBusMetrics & { deadLetterCount: number; activeSubscriptions: number } {
    let activeSubscriptions = 0;
    for (const subs of this.subscriptions.values()) {
      activeSubscriptions += subs.filter(s => s.isActive).length;
    }

    return {
      ...this.metrics,
      deadLetterCount: this.deadLetterQueue.length,
      activeSubscriptions,
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.emitter.removeAllListeners();
    this.subscriptions.clear();
    this.middleware = [];
  }

  // --- Private Methods ---

  private async deliverToSubscription(event: DomainEvent, subscription: EventSubscription): Promise<void> {
    // Check filter
    if (subscription.filter && !subscription.filter(event)) return;

    // Check circuit breaker
    const cbKey = `${subscription.id}`;
    const cb = this.getCircuitBreaker(cbKey);

    if (cb.state === 'open') {
      const timeSinceOpen = Date.now() - (cb.openedAt?.getTime() || 0);
      if (timeSinceOpen > 60000) { // 60 second timeout
        cb.state = 'half-open';
        cb.halfOpenAllowed = 1;
      } else {
        this.addToDeadLetterQueue(event, 'Circuit breaker is open', subscription.id);
        return;
      }
    }

    if (cb.state === 'half-open' && cb.halfOpenAllowed <= 0) {
      this.addToDeadLetterQueue(event, 'Circuit breaker half-open limit reached', subscription.id);
      return;
    }

    // Attempt delivery with retries
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= subscription.maxRetries; attempt++) {
      try {
        await this.executeHandler(subscription, event);

        subscription.processedCount++;
        subscription.lastProcessedAt = new Date();
        this.metrics.totalProcessed++;

        // Circuit breaker success
        cb.successCount++;
        if (cb.state === 'half-open') {
          cb.state = 'closed';
          cb.failureCount = 0;
        }
        cb.lastSuccessAt = new Date();

        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < subscription.maxRetries) {
          this.metrics.totalRetried++;
          await this.delay(subscription.retryDelay * Math.pow(2, attempt)); // Exponential backoff
        }
      }
    }

    // All retries exhausted
    subscription.errorCount++;
    subscription.lastErrorAt = new Date();
    this.metrics.totalFailed++;

    // Update circuit breaker
    cb.failureCount++;
    cb.lastFailureAt = new Date();
    if (cb.failureCount >= 5) {
      cb.state = 'open';
      cb.openedAt = new Date();
    }

    // Add to dead letter queue
    this.addToDeadLetterQueue(event, lastError?.message || 'Unknown error', subscription.id);
  }

  private async executeHandler(subscription: EventSubscription, event: DomainEvent): Promise<void> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Handler timeout after ${subscription.timeout}ms`)), subscription.timeout);
    });

    await Promise.race([subscription.handler(event), timeout]);
  }

  private async runMiddleware(event: DomainEvent): Promise<DomainEvent | null> {
    let current: DomainEvent | null = event;
    for (const mw of this.middleware) {
      if (!current) break;
      current = await mw(current);
    }
    return current;
  }

  private async maybeCreateSnapshot(event: DomainEvent): Promise<void> {
    const aggregateEvents = this.getAggregateEvents(event.aggregateId);
    if (aggregateEvents.length % this.eventStore.snapshotInterval === 0) {
      this.eventStore.snapshots.set(event.aggregateId, {
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        version: event.version,
        state: null, // Would be computed by aggregate root
        timestamp: new Date(),
      });
    }
  }

  private getCircuitBreaker(key: string): CircuitBreakerState {
    if (!this.circuitBreakers.has(key)) {
      this.circuitBreakers.set(key, {
        state: 'closed',
        failureCount: 0,
        successCount: 0,
        halfOpenAllowed: 0,
      });
    }
    return this.circuitBreakers.get(key)!;
  }

  private addToDeadLetterQueue(event: DomainEvent, error: string, subscriptionId: string): void {
    this.deadLetterQueue.push({
      event,
      error,
      failedAt: new Date(),
      subscription: subscriptionId,
      retryCount: 0,
    });
    this.metrics.totalDeadLettered++;

    // Keep DLQ bounded
    if (this.deadLetterQueue.length > 10000) {
      this.deadLetterQueue = this.deadLetterQueue.slice(-5000);
    }
  }

  private incrementTopicCount(topic: string): void {
    const current = this.metrics.topicCounts.get(topic) || 0;
    this.metrics.topicCounts.set(topic, current + 1);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  private generateSubscriptionId(): string {
    return `sub_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  private generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  private generateSpanId(): string {
    return `span_${Math.random().toString(36).substring(2, 11)}`;
  }
}

// ============================================================================
// Saga Orchestrator
// ============================================================================

interface SagaStep<T = unknown> {
  name: string;
  execute: (context: T) => Promise<T>;
  compensate: (context: T) => Promise<void>;
  timeout?: number;
}

interface SagaExecution<T = unknown> {
  id: string;
  name: string;
  steps: SagaStep<T>[];
  currentStep: number;
  context: T;
  status: 'running' | 'completed' | 'compensating' | 'failed';
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  completedSteps: string[];
  compensatedSteps: string[];
}

class SagaOrchestrator<T = unknown> {
  private eventBus: EventBus;
  private executions: Map<string, SagaExecution<T>>;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.executions = new Map();
  }

  /**
   * Execute a saga with automatic compensation on failure
   */
  async execute(name: string, steps: SagaStep<T>[], initialContext: T): Promise<SagaExecution<T>> {
    const execution: SagaExecution<T> = {
      id: `saga_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      name,
      steps,
      currentStep: 0,
      context: initialContext,
      status: 'running',
      startedAt: new Date(),
      completedSteps: [],
      compensatedSteps: [],
    };

    this.executions.set(execution.id, execution);

    try {
      for (let i = 0; i < steps.length; i++) {
        execution.currentStep = i;
        const step = steps[i];

        const timeout = step.timeout || 30000;
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Saga step "${step.name}" timed out after ${timeout}ms`)), timeout);
        });

        execution.context = await Promise.race([
          step.execute(execution.context),
          timeoutPromise,
        ]);

        execution.completedSteps.push(step.name);

        await this.eventBus.publish({
          type: 'saga.step.completed',
          aggregateId: execution.id,
          aggregateType: 'saga',
          version: i + 1,
          payload: { sagaName: name, stepName: step.name, stepIndex: i },
        });
      }

      execution.status = 'completed';
      execution.completedAt = new Date();

      await this.eventBus.publish({
        type: 'saga.completed',
        aggregateId: execution.id,
        aggregateType: 'saga',
        version: steps.length + 1,
        payload: { sagaName: name },
      });

    } catch (error) {
      execution.error = error instanceof Error ? error.message : String(error);
      execution.status = 'compensating';

      await this.eventBus.publish({
        type: 'saga.compensating',
        aggregateId: execution.id,
        aggregateType: 'saga',
        version: execution.currentStep + 1,
        payload: { sagaName: name, error: execution.error, failedStep: steps[execution.currentStep].name },
      });

      // Compensate completed steps in reverse order
      for (let i = execution.completedSteps.length - 1; i >= 0; i--) {
        const step = steps[i];
        try {
          await step.compensate(execution.context);
          execution.compensatedSteps.push(step.name);
        } catch (compensateError) {
          // Log compensation failure but continue compensating other steps
          execution.error += `; Compensation failed for "${step.name}": ${compensateError instanceof Error ? compensateError.message : String(compensateError)}`;
        }
      }

      execution.status = 'failed';
      execution.completedAt = new Date();

      await this.eventBus.publish({
        type: 'saga.failed',
        aggregateId: execution.id,
        aggregateType: 'saga',
        version: execution.currentStep + 2,
        payload: { sagaName: name, error: execution.error, compensatedSteps: execution.compensatedSteps },
      });
    }

    return execution;
  }

  /**
   * Get saga execution by ID
   */
  getExecution(id: string): SagaExecution<T> | undefined {
    return this.executions.get(id);
  }

  /**
   * Get all saga executions
   */
  getAllExecutions(): SagaExecution<T>[] {
    return Array.from(this.executions.values());
  }
}

// ============================================================================
// Event Sourced Aggregate
// ============================================================================

abstract class EventSourcedAggregate<TState, TEvent extends DomainEvent = DomainEvent> {
  protected id: string;
  protected version: number;
  protected state: TState;
  private uncommittedEvents: TEvent[];

  constructor(id: string, initialState: TState) {
    this.id = id;
    this.version = 0;
    this.state = initialState;
    this.uncommittedEvents = [];
  }

  /**
   * Apply an event to update state (must be implemented by subclasses)
   */
  protected abstract applyEvent(event: TEvent): TState;

  /**
   * Get the aggregate type name
   */
  protected abstract getAggregateType(): string;

  /**
   * Raise a new domain event
   */
  protected raise(type: string, payload: unknown): void {
    const event = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      type,
      aggregateId: this.id,
      aggregateType: this.getAggregateType(),
      version: this.version + 1,
      payload,
      timestamp: new Date(),
      metadata: {
        source: this.getAggregateType(),
        traceId: `trace_${Date.now()}`,
        spanId: `span_${Date.now()}`,
        environment: 'production',
        retryCount: 0,
        originalTimestamp: new Date(),
        headers: {},
      },
    } as TEvent;

    this.state = this.applyEvent(event);
    this.version++;
    this.uncommittedEvents.push(event);
  }

  /**
   * Load aggregate from event history
   */
  loadFromHistory(events: TEvent[]): void {
    for (const event of events) {
      this.state = this.applyEvent(event);
      this.version = event.version;
    }
  }

  /**
   * Get uncommitted events and clear the buffer
   */
  getUncommittedEvents(): TEvent[] {
    const events = [...this.uncommittedEvents];
    this.uncommittedEvents = [];
    return events;
  }

  /**
   * Get current state
   */
  getState(): TState {
    return this.state;
  }

  /**
   * Get current version
   */
  getVersion(): number {
    return this.version;
  }
}

// ============================================================================
// Types and Interfaces
// ============================================================================

type EventMiddleware = (event: DomainEvent) => Promise<DomainEvent | null>;

interface EventBusConfig {
  maxEventsPerAggregate: number;
  snapshotInterval: number;
}

interface EventBusMetrics {
  totalPublished: number;
  totalProcessed: number;
  totalFailed: number;
  totalRetried: number;
  totalDeadLettered: number;
  avgProcessingTime: number;
  topicCounts: Map<string, number>;
  subscriptionHealth: Map<string, { healthy: boolean; lastError?: string }>;
}

// ============================================================================
// Built-in Middleware
// ============================================================================

/**
 * Logging middleware - logs all events
 */
function createLoggingMiddleware(logger: { info: (msg: string) => void }): EventMiddleware {
  return async (event: DomainEvent) => {
    logger.info(`[EventBus] ${event.type} | aggregate=${event.aggregateId} | version=${event.version} | trace=${event.metadata.traceId}`);
    return event;
  };
}

/**
 * Validation middleware - validates event structure
 */
function createValidationMiddleware(schemas: Map<string, (payload: unknown) => boolean>): EventMiddleware {
  return async (event: DomainEvent) => {
    const validator = schemas.get(event.type);
    if (validator && !validator(event.payload)) {
      throw new Error(`Event validation failed for type ${event.type}`);
    }
    return event;
  };
}

/**
 * Enrichment middleware - adds metadata to events
 */
function createEnrichmentMiddleware(enricher: (event: DomainEvent) => Record<string, string>): EventMiddleware {
  return async (event: DomainEvent) => {
    const additionalHeaders = enricher(event);
    return {
      ...event,
      metadata: {
        ...event.metadata,
        headers: { ...event.metadata.headers, ...additionalHeaders },
      },
    };
  };
}

/**
 * Deduplication middleware - prevents duplicate event processing
 */
function createDeduplicationMiddleware(windowMs: number = 5000): EventMiddleware {
  const seen = new Map<string, number>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of seen.entries()) {
      if (now - timestamp > windowMs) seen.delete(key);
    }
  }, windowMs);

  return async (event: DomainEvent) => {
    const key = `${event.type}:${event.aggregateId}:${event.version}`;
    if (seen.has(key)) return null; // Filter duplicate
    seen.set(key, Date.now());
    return event;
  };
}

export {
  EventBus,
  SagaOrchestrator,
  EventSourcedAggregate,
  createLoggingMiddleware,
  createValidationMiddleware,
  createEnrichmentMiddleware,
  createDeduplicationMiddleware,
};

export type {
  DomainEvent,
  EventMetadata,
  EventSubscription,
  EventHandler,
  EventFilter,
  EventStore,
  AggregateSnapshot,
  DeadLetterEntry,
  CircuitBreakerState,
  SagaStep,
  SagaExecution,
  EventMiddleware,
  EventBusConfig,
  EventBusMetrics,
};
