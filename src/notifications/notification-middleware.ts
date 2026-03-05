/**
 * Notification Middleware
 * Express/Hono-style middleware for handling notification-related HTTP requests
 * and WebSocket upgrade handling
 */

import type {
  NotificationPayload,
  NotificationPreferences,
  DeliveryResult
} from './notification-service';

// Types for middleware context
interface NotificationContext {
  userId: string;
  workspaceId: string;
  deviceType: 'web' | 'mobile' | 'desktop';
  connectionId?: string;
}

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  message: string;
  skipSuccessfulRequests: boolean;
  keyGenerator: (ctx: NotificationContext) => string;
}

interface WebSocketUpgradeOptions {
  path: string;
  maxPayloadSize: number;
  heartbeatInterval: number;
  protocols: string[];
  verifyClient: (ctx: NotificationContext) => Promise<boolean>;
}

interface NotificationFilterRule {
  field: keyof NotificationPayload;
  operator: 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'regex' | 'in' | 'notIn';
  value: string | string[];
  action: 'allow' | 'block' | 'mute' | 'redirect';
  redirectChannel?: string;
}

// Middleware implementations

/**
 * Creates authentication middleware for notification endpoints
 */
function createAuthMiddleware(options: {
  tokenHeader: string;
  tokenPrefix: string;
  validateToken: (token: string) => Promise<{ userId: string; workspaceId: string } | null>;
}) {
  return async (req: any, res: any, next: () => void) => {
    const authHeader = req.headers[options.tokenHeader.toLowerCase()];
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authentication token' });
    }

    const token = authHeader.startsWith(options.tokenPrefix)
      ? authHeader.slice(options.tokenPrefix.length).trim()
      : authHeader;

    const payload = await options.validateToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.notificationContext = {
      userId: payload.userId,
      workspaceId: payload.workspaceId,
      deviceType: detectDeviceType(req.headers['user-agent'] || ''),
    };

    next();
  };
}

/**
 * Creates rate limiting middleware for notification APIs
 */
function createRateLimitMiddleware(config: Partial<RateLimitConfig> = {}) {
  const windowMs = config.windowMs || 60000;
  const maxRequests = config.maxRequests || 100;
  const message = config.message || 'Too many notification requests';
  const keyGenerator = config.keyGenerator || ((ctx: NotificationContext) => ctx.userId);

  const store = new Map<string, { count: number; resetAt: number }>();

  // Cleanup old entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of store.entries()) {
      if (now > value.resetAt) {
        store.delete(key);
      }
    }
  }, windowMs);

  return (req: any, res: any, next: () => void) => {
    const ctx = req.notificationContext as NotificationContext;
    if (!ctx) return next();

    const key = keyGenerator(ctx);
    const now = Date.now();
    let entry = store.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count));
    res.setHeader('X-RateLimit-Reset', new Date(entry.resetAt).toISOString());

    if (entry.count > maxRequests) {
      return res.status(429).json({
        error: message,
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      });
    }

    next();
  };
}

/**
 * Creates WebSocket upgrade middleware
 */
function createWebSocketUpgrade(options: Partial<WebSocketUpgradeOptions> = {}) {
  const maxPayloadSize = options.maxPayloadSize || 64 * 1024; // 64KB
  const heartbeatInterval = options.heartbeatInterval || 30000;
  const protocols = options.protocols || ['notification-v1'];
  const verifyClient = options.verifyClient || (async () => true);

  return async (req: any, res: any, next: () => void) => {
    // Check if this is a WebSocket upgrade request
    if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
      return next();
    }

    const ctx = req.notificationContext as NotificationContext;
    if (!ctx) {
      return res.status(401).end();
    }

    // Verify client authorization
    const isAuthorized = await verifyClient(ctx);
    if (!isAuthorized) {
      return res.status(403).end();
    }

    // The actual WebSocket upgrade would be handled by the server framework
    // This middleware just validates and prepares the context
    req.wsOptions = {
      maxPayloadSize,
      heartbeatInterval,
      protocols,
      context: ctx,
    };

    next();
  };
}

/**
 * Creates notification filter middleware
 * Applies rules to incoming notifications before delivery
 */
function createNotificationFilter(rules: NotificationFilterRule[]) {
  return (notification: NotificationPayload, context: NotificationContext): {
    action: 'allow' | 'block' | 'mute' | 'redirect';
    redirectChannel?: string;
    matchedRule?: NotificationFilterRule;
  } => {
    for (const rule of rules) {
      const fieldValue = String(notification[rule.field] || '');
      let matches = false;

      switch (rule.operator) {
        case 'equals':
          matches = fieldValue === rule.value;
          break;
        case 'contains':
          matches = fieldValue.includes(rule.value as string);
          break;
        case 'startsWith':
          matches = fieldValue.startsWith(rule.value as string);
          break;
        case 'endsWith':
          matches = fieldValue.endsWith(rule.value as string);
          break;
        case 'regex':
          try {
            matches = new RegExp(rule.value as string).test(fieldValue);
          } catch {
            matches = false;
          }
          break;
        case 'in':
          matches = Array.isArray(rule.value) && rule.value.includes(fieldValue);
          break;
        case 'notIn':
          matches = Array.isArray(rule.value) && !rule.value.includes(fieldValue);
          break;
      }

      if (matches) {
        return {
          action: rule.action,
          redirectChannel: rule.redirectChannel,
          matchedRule: rule,
        };
      }
    }

    return { action: 'allow' };
  };
}

/**
 * Creates notification enrichment middleware
 * Adds additional metadata to notifications before delivery
 */
function createNotificationEnricher(enrichers: Array<{
  condition: (notification: NotificationPayload) => boolean;
  enrich: (notification: NotificationPayload, context: NotificationContext) => NotificationPayload;
}>) {
  return (notification: NotificationPayload, context: NotificationContext): NotificationPayload => {
    let enriched = { ...notification };

    for (const enricher of enrichers) {
      if (enricher.condition(enriched)) {
        enriched = enricher.enrich(enriched, context);
      }
    }

    return enriched;
  };
}

/**
 * Creates notification deduplication middleware
 * Prevents duplicate notifications within a time window
 */
function createDeduplicationMiddleware(options: {
  windowMs?: number;
  keyFn?: (notification: NotificationPayload) => string;
} = {}) {
  const windowMs = options.windowMs || 5000;
  const keyFn = options.keyFn || ((n: NotificationPayload) => `${n.type}:${n.title}:${n.body}`);

  const seen = new Map<string, number>();

  // Cleanup old entries
  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of seen.entries()) {
      if (now - timestamp > windowMs) {
        seen.delete(key);
      }
    }
  }, windowMs);

  return (notification: NotificationPayload): boolean => {
    const key = keyFn(notification);
    const lastSeen = seen.get(key);

    if (lastSeen && Date.now() - lastSeen < windowMs) {
      return true; // Is duplicate
    }

    seen.set(key, Date.now());
    return false; // Not duplicate
  };
}

/**
 * Creates notification priority middleware
 * Assigns priority scores to notifications for ordering
 */
function createPriorityMiddleware(config: {
  typeWeights: Record<string, number>;
  urgentKeywords: string[];
  defaultWeight: number;
}) {
  return (notification: NotificationPayload): number => {
    let score = config.typeWeights[notification.type] || config.defaultWeight;

    // Boost for urgent keywords
    const text = `${notification.title} ${notification.body}`.toLowerCase();
    for (const keyword of config.urgentKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        score *= 1.5;
        break;
      }
    }

    // Recency boost (newer = higher priority)
    const ageMinutes = (Date.now() - notification.createdAt.getTime()) / 60000;
    if (ageMinutes < 1) score *= 2;
    else if (ageMinutes < 5) score *= 1.5;
    else if (ageMinutes < 30) score *= 1.2;

    return Math.round(score * 100) / 100;
  };
}

/**
 * Creates notification throttle middleware
 * Groups rapid notifications and delivers summary instead
 */
function createThrottleMiddleware(options: {
  windowMs: number;
  maxPerWindow: number;
  summarize: (notifications: NotificationPayload[]) => NotificationPayload;
}) {
  const buckets = new Map<string, {
    notifications: NotificationPayload[];
    windowStart: number;
    timer: NodeJS.Timer | null;
  }>();

  return (userId: string, notification: NotificationPayload, deliver: (n: NotificationPayload) => void): void => {
    let bucket = buckets.get(userId);

    if (!bucket || Date.now() - bucket.windowStart > options.windowMs) {
      bucket = {
        notifications: [],
        windowStart: Date.now(),
        timer: null,
      };
      buckets.set(userId, bucket);
    }

    bucket.notifications.push(notification);

    if (bucket.notifications.length <= options.maxPerWindow) {
      // Under threshold, deliver immediately
      deliver(notification);
    } else if (bucket.notifications.length === options.maxPerWindow + 1) {
      // Just exceeded threshold, set up summary delivery
      if (bucket.timer) clearTimeout(bucket.timer as any);
      bucket.timer = setTimeout(() => {
        const pending = bucket!.notifications.slice(options.maxPerWindow);
        if (pending.length > 0) {
          deliver(options.summarize(pending));
        }
        bucket!.notifications = [];
      }, options.windowMs);
    }
    // If already over threshold, notification is batched (will be included in summary)
  };
}

// Helper functions

function detectDeviceType(userAgent: string): 'web' | 'mobile' | 'desktop' {
  const ua = userAgent.toLowerCase();
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    return 'mobile';
  }
  if (ua.includes('electron') || ua.includes('tauri')) {
    return 'desktop';
  }
  return 'web';
}

/**
 * Validates notification payload before processing
 */
function validateNotificationPayload(payload: any): {
  valid: boolean;
  errors: string[]
} {
  const errors: string[] = [];

  if (!payload.type) {
    errors.push('type is required');
  } else if (!['info', 'warning', 'error', 'success', 'mention', 'reaction', 'reply', 'system'].includes(payload.type)) {
    errors.push(`Invalid notification type: ${payload.type}`);
  }

  if (!payload.title || typeof payload.title !== 'string') {
    errors.push('title is required and must be a string');
  } else if (payload.title.length > 200) {
    errors.push('title must be 200 characters or less');
  }

  if (!payload.body || typeof payload.body !== 'string') {
    errors.push('body is required and must be a string');
  } else if (payload.body.length > 2000) {
    errors.push('body must be 2000 characters or less');
  }

  if (payload.url && typeof payload.url !== 'string') {
    errors.push('url must be a string');
  }

  if (payload.metadata && typeof payload.metadata !== 'object') {
    errors.push('metadata must be an object');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Creates notification route handlers for common CRUD operations
 */
function createNotificationRoutes(service: any) {
  return {
    // GET /notifications
    list: async (req: any, res: any) => {
      const ctx = req.notificationContext as NotificationContext;
      const { page, limit, type, unreadOnly } = req.query;

      const result = service.getNotifications(ctx.userId, {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
        type,
        unreadOnly: unreadOnly === 'true',
      });

      return res.json(result);
    },

    // GET /notifications/count
    unreadCount: async (req: any, res: any) => {
      const ctx = req.notificationContext as NotificationContext;
      const count = service.getUnreadCount(ctx.userId);
      return res.json({ count });
    },

    // POST /notifications/:id/read
    markRead: async (req: any, res: any) => {
      const ctx = req.notificationContext as NotificationContext;
      const success = service.markAsRead(ctx.userId, req.params.id);
      return success
        ? res.json({ success: true })
        : res.status(404).json({ error: 'Notification not found' });
    },

    // POST /notifications/read-all
    markAllRead: async (req: any, res: any) => {
      const ctx = req.notificationContext as NotificationContext;
      const count = service.markAllAsRead(ctx.userId);
      return res.json({ success: true, count });
    },

    // DELETE /notifications/:id
    delete: async (req: any, res: any) => {
      const ctx = req.notificationContext as NotificationContext;
      const success = service.deleteNotification(ctx.userId, req.params.id);
      return success
        ? res.json({ success: true })
        : res.status(404).json({ error: 'Notification not found' });
    },

    // DELETE /notifications
    clearAll: async (req: any, res: any) => {
      const ctx = req.notificationContext as NotificationContext;
      const count = service.clearNotifications(ctx.userId);
      return res.json({ success: true, count });
    },

    // GET /notifications/preferences
    getPreferences: async (req: any, res: any) => {
      const ctx = req.notificationContext as NotificationContext;
      const prefs = service.getPreferences(ctx.userId);
      return res.json(prefs);
    },

    // PUT /notifications/preferences
    updatePreferences: async (req: any, res: any) => {
      const ctx = req.notificationContext as NotificationContext;
      const updated = service.updatePreferences(ctx.userId, req.body);
      return res.json(updated);
    },

    // GET /notifications/metrics (admin only)
    metrics: async (req: any, res: any) => {
      const metrics = service.getMetrics();
      return res.json(metrics);
    },
  };
}

export {
  createAuthMiddleware,
  createRateLimitMiddleware,
  createWebSocketUpgrade,
  createNotificationFilter,
  createNotificationEnricher,
  createDeduplicationMiddleware,
  createPriorityMiddleware,
  createThrottleMiddleware,
  validateNotificationPayload,
  createNotificationRoutes,
  detectDeviceType,
};

export type {
  NotificationContext,
  RateLimitConfig,
  WebSocketUpgradeOptions,
  NotificationFilterRule,
};
