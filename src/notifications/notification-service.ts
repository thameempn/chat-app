/**
 * Real-time Notification Service
 * Handles WebSocket-based notifications, push notifications, and in-app notification management
 */

import { EventEmitter } from 'events';

// Types
interface NotificationPayload {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success' | 'mention' | 'reaction' | 'reply' | 'system';
  title: string;
  body: string;
  icon?: string;
  url?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  readAt?: Date;
  expiresAt?: Date;
}

interface NotificationPreferences {
  userId: string;
  email: boolean;
  push: boolean;
  inApp: boolean;
  sound: boolean;
  desktop: boolean;
  quietHoursStart?: string; // HH:mm format
  quietHoursEnd?: string;
  mutedChannels: string[];
  mutedUsers: string[];
  mentionsOnly: boolean;
  threadUpdates: boolean;
  digestFrequency: 'instant' | 'hourly' | 'daily' | 'weekly';
}

interface WebSocketConnection {
  id: string;
  userId: string;
  socket: any;
  connectedAt: Date;
  lastPingAt: Date;
  isAlive: boolean;
  deviceType: 'web' | 'mobile' | 'desktop';
  userAgent: string;
}

interface NotificationChannel {
  name: string;
  subscribers: Set<string>;
  lastActivity: Date;
  messageCount: number;
}

interface DeliveryResult {
  notificationId: string;
  channel: 'websocket' | 'push' | 'email' | 'sms';
  status: 'delivered' | 'failed' | 'queued' | 'skipped';
  timestamp: Date;
  error?: string;
  retryCount: number;
}

interface NotificationBatch {
  id: string;
  notifications: NotificationPayload[];
  recipientIds: string[];
  scheduledAt?: Date;
  sentAt?: Date;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

// Constants
const MAX_CONNECTIONS_PER_USER = 5;
const PING_INTERVAL = 30000;
const RECONNECT_DELAY = 5000;
const MAX_RETRY_ATTEMPTS = 3;
const NOTIFICATION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const BATCH_SIZE = 100;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 100;

class NotificationService extends EventEmitter {
  private connections: Map<string, WebSocketConnection[]>;
  private channels: Map<string, NotificationChannel>;
  private preferences: Map<string, NotificationPreferences>;
  private notificationStore: Map<string, NotificationPayload[]>;
  private deliveryLog: DeliveryResult[];
  private rateLimiter: Map<string, { count: number; windowStart: number }>;
  private batchQueue: NotificationBatch[];
  private pingIntervalId: NodeJS.Timer | null;
  private isShuttingDown: boolean;
  private metrics: {
    totalSent: number;
    totalFailed: number;
    totalDelivered: number;
    avgDeliveryTime: number;
    activeConnections: number;
  };

  constructor() {
    super();
    this.connections = new Map();
    this.channels = new Map();
    this.preferences = new Map();
    this.notificationStore = new Map();
    this.deliveryLog = [];
    this.rateLimiter = new Map();
    this.batchQueue = [];
    this.pingIntervalId = null;
    this.isShuttingDown = false;
    this.metrics = {
      totalSent: 0,
      totalFailed: 0,
      totalDelivered: 0,
      avgDeliveryTime: 0,
      activeConnections: 0,
    };

    this.setupPingInterval();
    this.setupCleanupSchedule();
  }

  /**
   * Register a new WebSocket connection for a user
   */
  async registerConnection(userId: string, socket: any, deviceType: 'web' | 'mobile' | 'desktop', userAgent: string): Promise<string> {
    const existingConnections = this.connections.get(userId) || [];

    // Enforce connection limit
    if (existingConnections.length >= MAX_CONNECTIONS_PER_USER) {
      const oldest = existingConnections.sort((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime())[0];
      await this.closeConnection(oldest.id, 'Connection limit reached');
    }

    const connectionId = this.generateId();
    const connection: WebSocketConnection = {
      id: connectionId,
      userId,
      socket,
      connectedAt: new Date(),
      lastPingAt: new Date(),
      isAlive: true,
      deviceType,
      userAgent,
    };

    const userConnections = this.connections.get(userId) || [];
    userConnections.push(connection);
    this.connections.set(userId, userConnections);

    this.metrics.activeConnections++;
    this.emit('connection:open', { userId, connectionId, deviceType });

    // Send unread notifications on connect
    await this.sendUnreadNotifications(userId, connectionId);

    return connectionId;
  }

  /**
   * Close a specific WebSocket connection
   */
  async closeConnection(connectionId: string, reason: string = 'Normal closure'): Promise<void> {
    for (const [userId, connections] of this.connections.entries()) {
      const index = connections.findIndex(c => c.id === connectionId);
      if (index !== -1) {
        const connection = connections[index];
        try {
          connection.socket.close(1000, reason);
        } catch (e) {
          // Socket may already be closed
        }
        connections.splice(index, 1);
        if (connections.length === 0) {
          this.connections.delete(userId);
        }
        this.metrics.activeConnections--;
        this.emit('connection:close', { userId, connectionId, reason });
        break;
      }
    }
  }

  /**
   * Send a notification to a specific user
   */
  async sendNotification(userId: string, notification: Omit<NotificationPayload, 'id' | 'createdAt'>): Promise<DeliveryResult> {
    // Check rate limit
    if (this.isRateLimited(userId)) {
      return {
        notificationId: '',
        channel: 'websocket',
        status: 'failed',
        timestamp: new Date(),
        error: 'Rate limit exceeded',
        retryCount: 0,
      };
    }

    const fullNotification: NotificationPayload = {
      ...notification,
      id: this.generateId(),
      createdAt: new Date(),
    };

    // Store notification
    const userNotifications = this.notificationStore.get(userId) || [];
    userNotifications.push(fullNotification);
    this.notificationStore.set(userId, userNotifications);

    // Check user preferences
    const prefs = this.preferences.get(userId);
    if (prefs && this.isInQuietHours(prefs)) {
      return {
        notificationId: fullNotification.id,
        channel: 'websocket',
        status: 'queued',
        timestamp: new Date(),
        retryCount: 0,
      };
    }

    if (prefs?.mutedUsers.includes(notification.metadata?.senderId)) {
      return {
        notificationId: fullNotification.id,
        channel: 'websocket',
        status: 'skipped',
        timestamp: new Date(),
        retryCount: 0,
      };
    }

    // Deliver via WebSocket
    const result = await this.deliverViaWebSocket(userId, fullNotification);

    // If WebSocket delivery failed, try push notification
    if (result.status === 'failed' && prefs?.push) {
      return await this.deliverViaPush(userId, fullNotification);
    }

    this.deliveryLog.push(result);
    this.updateMetrics(result);

    return result;
  }

  /**
   * Send notification to multiple users (broadcast)
   */
  async broadcastNotification(
    userIds: string[],
    notification: Omit<NotificationPayload, 'id' | 'createdAt'>
  ): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];

    // Process in batches to avoid overwhelming the system
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      const batch = userIds.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(userId => this.sendNotification(userId, notification))
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({
            notificationId: '',
            channel: 'websocket',
            status: 'failed',
            timestamp: new Date(),
            error: result.reason?.message || 'Unknown error',
            retryCount: 0,
          });
        }
      }
    }

    this.emit('broadcast:complete', {
      totalRecipients: userIds.length,
      delivered: results.filter(r => r.status === 'delivered').length,
      failed: results.filter(r => r.status === 'failed').length,
    });

    return results;
  }

  /**
   * Subscribe a user to a notification channel
   */
  subscribeToChannel(userId: string, channelName: string): void {
    let channel = this.channels.get(channelName);
    if (!channel) {
      channel = {
        name: channelName,
        subscribers: new Set(),
        lastActivity: new Date(),
        messageCount: 0,
      };
      this.channels.set(channelName, channel);
    }
    channel.subscribers.add(userId);
    this.emit('channel:subscribe', { userId, channelName });
  }

  /**
   * Unsubscribe a user from a notification channel
   */
  unsubscribeFromChannel(userId: string, channelName: string): void {
    const channel = this.channels.get(channelName);
    if (channel) {
      channel.subscribers.delete(userId);
      if (channel.subscribers.size === 0) {
        this.channels.delete(channelName);
      }
      this.emit('channel:unsubscribe', { userId, channelName });
    }
  }

  /**
   * Send notification to all subscribers of a channel
   */
  async notifyChannel(
    channelName: string,
    notification: Omit<NotificationPayload, 'id' | 'createdAt'>,
    excludeUserIds: string[] = []
  ): Promise<DeliveryResult[]> {
    const channel = this.channels.get(channelName);
    if (!channel) return [];

    channel.lastActivity = new Date();
    channel.messageCount++;

    const recipients = Array.from(channel.subscribers).filter(
      id => !excludeUserIds.includes(id)
    );

    return this.broadcastNotification(recipients, notification);
  }

  /**
   * Mark a notification as read
   */
  markAsRead(userId: string, notificationId: string): boolean {
    const notifications = this.notificationStore.get(userId);
    if (!notifications) return false;

    const notification = notifications.find(n => n.id === notificationId);
    if (!notification) return false;

    notification.readAt = new Date();
    this.emit('notification:read', { userId, notificationId });
    return true;
  }

  /**
   * Mark all notifications as read for a user
   */
  markAllAsRead(userId: string): number {
    const notifications = this.notificationStore.get(userId);
    if (!notifications) return 0;

    let count = 0;
    const now = new Date();
    for (const notification of notifications) {
      if (!notification.readAt) {
        notification.readAt = now;
        count++;
      }
    }

    this.emit('notification:readAll', { userId, count });
    return count;
  }

  /**
   * Get unread notification count for a user
   */
  getUnreadCount(userId: string): number {
    const notifications = this.notificationStore.get(userId) || [];
    return notifications.filter(n => !n.readAt && !this.isExpired(n)).length;
  }

  /**
   * Get paginated notifications for a user
   */
  getNotifications(
    userId: string,
    options: { page?: number; limit?: number; type?: string; unreadOnly?: boolean } = {}
  ): { notifications: NotificationPayload[]; total: number; hasMore: boolean } {
    const { page = 1, limit = 20, type, unreadOnly = false } = options;

    let notifications = this.notificationStore.get(userId) || [];

    // Filter expired
    notifications = notifications.filter(n => !this.isExpired(n));

    // Apply filters
    if (type) {
      notifications = notifications.filter(n => n.type === type);
    }
    if (unreadOnly) {
      notifications = notifications.filter(n => !n.readAt);
    }

    // Sort by date (newest first)
    notifications.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = notifications.length;
    const start = (page - 1) * limit;
    const paginatedNotifications = notifications.slice(start, start + limit);

    return {
      notifications: paginatedNotifications,
      total,
      hasMore: start + limit < total,
    };
  }

  /**
   * Update user notification preferences
   */
  updatePreferences(userId: string, prefs: Partial<NotificationPreferences>): NotificationPreferences {
    const current = this.preferences.get(userId) || this.getDefaultPreferences(userId);
    const updated = { ...current, ...prefs, userId };
    this.preferences.set(userId, updated);
    this.emit('preferences:updated', { userId, preferences: updated });
    return updated;
  }

  /**
   * Get user notification preferences
   */
  getPreferences(userId: string): NotificationPreferences {
    return this.preferences.get(userId) || this.getDefaultPreferences(userId);
  }

  /**
   * Delete a specific notification
   */
  deleteNotification(userId: string, notificationId: string): boolean {
    const notifications = this.notificationStore.get(userId);
    if (!notifications) return false;

    const index = notifications.findIndex(n => n.id === notificationId);
    if (index === -1) return false;

    notifications.splice(index, 1);
    this.emit('notification:deleted', { userId, notificationId });
    return true;
  }

  /**
   * Clear all notifications for a user
   */
  clearNotifications(userId: string): number {
    const notifications = this.notificationStore.get(userId);
    if (!notifications) return 0;

    const count = notifications.length;
    this.notificationStore.delete(userId);
    this.emit('notification:cleared', { userId, count });
    return count;
  }

  /**
   * Schedule a batch of notifications for later delivery
   */
  scheduleBatch(batch: Omit<NotificationBatch, 'id' | 'status'>): string {
    const batchId = this.generateId();
    const fullBatch: NotificationBatch = {
      ...batch,
      id: batchId,
      status: 'pending',
    };
    this.batchQueue.push(fullBatch);
    this.emit('batch:scheduled', { batchId, scheduledAt: batch.scheduledAt });
    return batchId;
  }

  /**
   * Process pending batch notifications
   */
  async processBatchQueue(): Promise<void> {
    const now = new Date();
    const pendingBatches = this.batchQueue.filter(
      b => b.status === 'pending' && (!b.scheduledAt || b.scheduledAt <= now)
    );

    for (const batch of pendingBatches) {
      batch.status = 'processing';
      try {
        for (const notification of batch.notifications) {
          await this.broadcastNotification(batch.recipientIds, notification);
        }
        batch.status = 'completed';
        batch.sentAt = new Date();
      } catch (error) {
        batch.status = 'failed';
        this.emit('batch:failed', { batchId: batch.id, error });
      }
    }
  }

  /**
   * Get current service metrics
   */
  getMetrics(): typeof this.metrics & {
    channelCount: number;
    totalUsers: number;
    pendingBatches: number;
    deliveryRate: number;
  } {
    const totalAttempts = this.metrics.totalSent;
    return {
      ...this.metrics,
      channelCount: this.channels.size,
      totalUsers: this.notificationStore.size,
      pendingBatches: this.batchQueue.filter(b => b.status === 'pending').length,
      deliveryRate: totalAttempts > 0
        ? (this.metrics.totalDelivered / totalAttempts) * 100
        : 0,
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.pingIntervalId) {
      clearInterval(this.pingIntervalId as any);
    }

    // Close all connections
    const closePromises: Promise<void>[] = [];
    for (const [_, connections] of this.connections.entries()) {
      for (const conn of connections) {
        closePromises.push(this.closeConnection(conn.id, 'Server shutting down'));
      }
    }
    await Promise.all(closePromises);

    // Process remaining batches
    await this.processBatchQueue();

    this.emit('shutdown', { timestamp: new Date() });
    this.removeAllListeners();
  }

  // --- Private Methods ---

  private async deliverViaWebSocket(userId: string, notification: NotificationPayload): Promise<DeliveryResult> {
    const connections = this.connections.get(userId);
    if (!connections || connections.length === 0) {
      return {
        notificationId: notification.id,
        channel: 'websocket',
        status: 'failed',
        timestamp: new Date(),
        error: 'No active connections',
        retryCount: 0,
      };
    }

    let delivered = false;
    for (const connection of connections) {
      if (connection.isAlive) {
        try {
          connection.socket.send(JSON.stringify({
            type: 'notification',
            data: notification,
          }));
          delivered = true;
        } catch (e) {
          connection.isAlive = false;
        }
      }
    }

    this.metrics.totalSent++;

    if (delivered) {
      this.metrics.totalDelivered++;
      return {
        notificationId: notification.id,
        channel: 'websocket',
        status: 'delivered',
        timestamp: new Date(),
        retryCount: 0,
      };
    }

    return {
      notificationId: notification.id,
      channel: 'websocket',
      status: 'failed',
      timestamp: new Date(),
      error: 'All connections dead',
      retryCount: 0,
    };
  }

  private async deliverViaPush(userId: string, notification: NotificationPayload): Promise<DeliveryResult> {
    // Push notification delivery (placeholder for actual push service integration)
    try {
      // In production, this would call Firebase Cloud Messaging, APNs, etc.
      this.metrics.totalSent++;
      this.metrics.totalDelivered++;

      return {
        notificationId: notification.id,
        channel: 'push',
        status: 'delivered',
        timestamp: new Date(),
        retryCount: 0,
      };
    } catch (error) {
      this.metrics.totalFailed++;
      return {
        notificationId: notification.id,
        channel: 'push',
        status: 'failed',
        timestamp: new Date(),
        error: error instanceof Error ? error.message : 'Push delivery failed',
        retryCount: 0,
      };
    }
  }

  private async sendUnreadNotifications(userId: string, connectionId: string): Promise<void> {
    const notifications = this.notificationStore.get(userId) || [];
    const unread = notifications.filter(n => !n.readAt && !this.isExpired(n));

    const connections = this.connections.get(userId);
    const connection = connections?.find(c => c.id === connectionId);

    if (connection?.isAlive && unread.length > 0) {
      try {
        connection.socket.send(JSON.stringify({
          type: 'unread_notifications',
          data: unread,
          count: unread.length,
        }));
      } catch (e) {
        // Connection may have closed
      }
    }
  }

  private setupPingInterval(): void {
    this.pingIntervalId = setInterval(() => {
      if (this.isShuttingDown) return;

      for (const [userId, connections] of this.connections.entries()) {
        for (const connection of connections) {
          if (!connection.isAlive) {
            this.closeConnection(connection.id, 'Ping timeout');
            continue;
          }
          connection.isAlive = false;
          try {
            connection.socket.ping();
            connection.lastPingAt = new Date();
          } catch (e) {
            this.closeConnection(connection.id, 'Ping failed');
          }
        }
      }
    }, PING_INTERVAL);
  }

  private setupCleanupSchedule(): void {
    // Clean up expired notifications every hour
    setInterval(() => {
      if (this.isShuttingDown) return;

      for (const [userId, notifications] of this.notificationStore.entries()) {
        const active = notifications.filter(n => !this.isExpired(n));
        if (active.length !== notifications.length) {
          this.notificationStore.set(userId, active);
        }
      }

      // Clean up old delivery logs (keep last 10000)
      if (this.deliveryLog.length > 10000) {
        this.deliveryLog = this.deliveryLog.slice(-10000);
      }

      // Clean up completed batches older than 24 hours
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      this.batchQueue = this.batchQueue.filter(
        b => b.status === 'pending' || b.status === 'processing' ||
             (b.sentAt && b.sentAt > oneDayAgo)
      );
    }, 60 * 60 * 1000);
  }

  private isRateLimited(userId: string): boolean {
    const now = Date.now();
    const limiter = this.rateLimiter.get(userId);

    if (!limiter || now - limiter.windowStart > RATE_LIMIT_WINDOW) {
      this.rateLimiter.set(userId, { count: 1, windowStart: now });
      return false;
    }

    limiter.count++;
    return limiter.count > RATE_LIMIT_MAX;
  }

  private isInQuietHours(prefs: NotificationPreferences): boolean {
    if (!prefs.quietHoursStart || !prefs.quietHoursEnd) return false;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const [startH, startM] = prefs.quietHoursStart.split(':').map(Number);
    const [endH, endM] = prefs.quietHoursEnd.split(':').map(Number);

    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    } else {
      // Quiet hours span midnight
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }
  }

  private isExpired(notification: NotificationPayload): boolean {
    if (notification.expiresAt) {
      return notification.expiresAt < new Date();
    }
    return Date.now() - notification.createdAt.getTime() > NOTIFICATION_TTL;
  }

  private getDefaultPreferences(userId: string): NotificationPreferences {
    return {
      userId,
      email: true,
      push: true,
      inApp: true,
      sound: true,
      desktop: true,
      mutedChannels: [],
      mutedUsers: [],
      mentionsOnly: false,
      threadUpdates: true,
      digestFrequency: 'instant',
    };
  }

  private updateMetrics(result: DeliveryResult): void {
    if (result.status === 'delivered') {
      // Update running average delivery time
      const deliveryTime = Date.now() - result.timestamp.getTime();
      this.metrics.avgDeliveryTime =
        (this.metrics.avgDeliveryTime * (this.metrics.totalDelivered - 1) + deliveryTime) /
        this.metrics.totalDelivered;
    } else if (result.status === 'failed') {
      this.metrics.totalFailed++;
    }
  }

  private generateId(): string {
    return `ntf_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
}

// Notification template system
class NotificationTemplateEngine {
  private templates: Map<string, {
    title: string;
    body: string;
    type: NotificationPayload['type'];
    icon?: string;
  }>;

  constructor() {
    this.templates = new Map();
    this.registerDefaultTemplates();
  }

  registerTemplate(name: string, template: {
    title: string;
    body: string;
    type: NotificationPayload['type'];
    icon?: string;
  }): void {
    this.templates.set(name, template);
  }

  render(templateName: string, variables: Record<string, string>): Omit<NotificationPayload, 'id' | 'createdAt'> | null {
    const template = this.templates.get(templateName);
    if (!template) return null;

    return {
      title: this.interpolate(template.title, variables),
      body: this.interpolate(template.body, variables),
      type: template.type,
      icon: template.icon,
    };
  }

  private interpolate(text: string, variables: Record<string, string>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (match, key) => variables[key] || match);
  }

  private registerDefaultTemplates(): void {
    this.registerTemplate('new_message', {
      title: '{{senderName}} sent you a message',
      body: '{{preview}}',
      type: 'info',
      icon: 'message',
    });

    this.registerTemplate('mention', {
      title: '{{senderName}} mentioned you in {{channelName}}',
      body: '{{preview}}',
      type: 'mention',
      icon: 'at-sign',
    });

    this.registerTemplate('reaction', {
      title: '{{senderName}} reacted {{emoji}} to your message',
      body: '{{preview}}',
      type: 'reaction',
      icon: 'heart',
    });

    this.registerTemplate('thread_reply', {
      title: '{{senderName}} replied in a thread',
      body: '{{preview}}',
      type: 'reply',
      icon: 'reply',
    });

    this.registerTemplate('system_update', {
      title: 'System Update',
      body: '{{message}}',
      type: 'system',
      icon: 'info',
    });

    this.registerTemplate('channel_invite', {
      title: '{{inviterName}} invited you to {{channelName}}',
      body: 'You have been invited to join the channel',
      type: 'info',
      icon: 'users',
    });

    this.registerTemplate('file_shared', {
      title: '{{senderName}} shared a file',
      body: '{{fileName}} ({{fileSize}})',
      type: 'info',
      icon: 'file',
    });
  }
}

// Notification digest aggregator
class NotificationDigest {
  private pendingDigests: Map<string, {
    userId: string;
    notifications: NotificationPayload[];
    lastSentAt: Date;
    frequency: 'hourly' | 'daily' | 'weekly';
  }>;

  constructor() {
    this.pendingDigests = new Map();
  }

  addToDigest(userId: string, notification: NotificationPayload, frequency: 'hourly' | 'daily' | 'weekly'): void {
    let digest = this.pendingDigests.get(userId);
    if (!digest) {
      digest = {
        userId,
        notifications: [],
        lastSentAt: new Date(),
        frequency,
      };
      this.pendingDigests.set(userId, digest);
    }
    digest.notifications.push(notification);
  }

  getDigestsToSend(): Map<string, NotificationPayload[]> {
    const now = new Date();
    const result = new Map<string, NotificationPayload[]>();

    for (const [userId, digest] of this.pendingDigests.entries()) {
      const elapsed = now.getTime() - digest.lastSentAt.getTime();
      let shouldSend = false;

      switch (digest.frequency) {
        case 'hourly':
          shouldSend = elapsed >= 60 * 60 * 1000;
          break;
        case 'daily':
          shouldSend = elapsed >= 24 * 60 * 60 * 1000;
          break;
        case 'weekly':
          shouldSend = elapsed >= 7 * 24 * 60 * 60 * 1000;
          break;
      }

      if (shouldSend && digest.notifications.length > 0) {
        result.set(userId, [...digest.notifications]);
        digest.notifications = [];
        digest.lastSentAt = now;
      }
    }

    return result;
  }

  formatDigest(notifications: NotificationPayload[]): string {
    const grouped = new Map<string, NotificationPayload[]>();

    for (const notification of notifications) {
      const existing = grouped.get(notification.type) || [];
      existing.push(notification);
      grouped.set(notification.type, existing);
    }

    let digest = `You have ${notifications.length} notifications:\n\n`;

    for (const [type, items] of grouped.entries()) {
      digest += `## ${type.charAt(0).toUpperCase() + type.slice(1)} (${items.length})\n`;
      for (const item of items.slice(0, 5)) {
        digest += `- ${item.title}: ${item.body}\n`;
      }
      if (items.length > 5) {
        digest += `  ... and ${items.length - 5} more\n`;
      }
      digest += '\n';
    }

    return digest;
  }
}

export { NotificationService, NotificationTemplateEngine, NotificationDigest };
export type {
  NotificationPayload,
  NotificationPreferences,
  WebSocketConnection,
  NotificationChannel,
  DeliveryResult,
  NotificationBatch
};
