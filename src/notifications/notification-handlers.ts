/**
 * Notification Event Handlers
 * Handles various application events and creates appropriate notifications
 */

import type { NotificationPayload } from './notification-service';

// Event types that can trigger notifications
interface ChatMessageEvent {
  type: 'chat.message.new';
  channelId: string;
  channelName: string;
  messageId: string;
  senderId: string;
  senderName: string;
  content: string;
  mentionedUserIds: string[];
  isThread: boolean;
  parentMessageId?: string;
  attachments?: Array<{ name: string; size: number; type: string }>;
}

interface UserPresenceEvent {
  type: 'user.presence.changed';
  userId: string;
  userName: string;
  status: 'online' | 'offline' | 'away' | 'dnd';
  previousStatus: string;
  timestamp: Date;
}

interface ChannelEvent {
  type: 'channel.created' | 'channel.archived' | 'channel.member.added' | 'channel.member.removed';
  channelId: string;
  channelName: string;
  actorId: string;
  actorName: string;
  targetUserId?: string;
  targetUserName?: string;
}

interface ReactionEvent {
  type: 'message.reaction.added' | 'message.reaction.removed';
  messageId: string;
  channelId: string;
  channelName: string;
  actorId: string;
  actorName: string;
  emoji: string;
  messageAuthorId: string;
  messagePreview: string;
}

interface FileEvent {
  type: 'file.shared' | 'file.uploaded';
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  uploaderId: string;
  uploaderName: string;
  channelId: string;
  channelName: string;
  sharedWithUserIds?: string[];
}

interface SystemEvent {
  type: 'system.maintenance' | 'system.update' | 'system.alert';
  title: string;
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedServices?: string[];
  scheduledAt?: Date;
  estimatedDuration?: number; // minutes
}

interface IntegrationEvent {
  type: 'integration.webhook' | 'integration.error' | 'integration.connected' | 'integration.disconnected';
  integrationName: string;
  integrationId: string;
  details: string;
  errorMessage?: string;
  webhookPayload?: Record<string, any>;
}

type NotificationEvent =
  | ChatMessageEvent
  | UserPresenceEvent
  | ChannelEvent
  | ReactionEvent
  | FileEvent
  | SystemEvent
  | IntegrationEvent;

// Handler registry
type EventHandler<T extends NotificationEvent> = (
  event: T
) => Array<{ userId: string; notification: Omit<NotificationPayload, 'id' | 'createdAt'> }>;

class NotificationEventRouter {
  private handlers: Map<string, EventHandler<any>[]>;
  private interceptors: Array<(event: NotificationEvent) => NotificationEvent | null>;
  private postProcessors: Array<(notifications: Array<{ userId: string; notification: Omit<NotificationPayload, 'id' | 'createdAt'> }>) => Array<{ userId: string; notification: Omit<NotificationPayload, 'id' | 'createdAt'> }>>;

  constructor() {
    this.handlers = new Map();
    this.interceptors = [];
    this.postProcessors = [];
    this.registerDefaultHandlers();
  }

  /**
   * Register a handler for a specific event type
   */
  on<T extends NotificationEvent>(
    eventType: T['type'],
    handler: EventHandler<T>
  ): void {
    const existing = this.handlers.get(eventType) || [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  /**
   * Add an interceptor that can modify or cancel events before processing
   */
  addInterceptor(interceptor: (event: NotificationEvent) => NotificationEvent | null): void {
    this.interceptors.push(interceptor);
  }

  /**
   * Add a post-processor that can modify generated notifications
   */
  addPostProcessor(processor: (notifications: Array<{ userId: string; notification: Omit<NotificationPayload, 'id' | 'createdAt'> }>) => Array<{ userId: string; notification: Omit<NotificationPayload, 'id' | 'createdAt'> }>): void {
    this.postProcessors.push(processor);
  }

  /**
   * Process an event and generate notifications
   */
  process(event: NotificationEvent): Array<{ userId: string; notification: Omit<NotificationPayload, 'id' | 'createdAt'> }> {
    // Run interceptors
    let processedEvent: NotificationEvent | null = event;
    for (const interceptor of this.interceptors) {
      processedEvent = interceptor(processedEvent);
      if (!processedEvent) return []; // Event cancelled
    }

    // Get handlers for this event type
    const handlers = this.handlers.get(processedEvent.type) || [];

    // Collect all generated notifications
    let notifications: Array<{ userId: string; notification: Omit<NotificationPayload, 'id' | 'createdAt'> }> = [];

    for (const handler of handlers) {
      const result = handler(processedEvent);
      notifications.push(...result);
    }

    // Run post-processors
    for (const processor of this.postProcessors) {
      notifications = processor(notifications);
    }

    return notifications;
  }

  /**
   * Register default handlers for common event types
   */
  private registerDefaultHandlers(): void {
    // Chat message handler
    this.on<ChatMessageEvent>('chat.message.new', (event) => {
      const notifications: Array<{ userId: string; notification: Omit<NotificationPayload, 'id' | 'createdAt'> }> = [];

      // Notify mentioned users
      for (const mentionedUserId of event.mentionedUserIds) {
        if (mentionedUserId === event.senderId) continue; // Don't notify self

        notifications.push({
          userId: mentionedUserId,
          notification: {
            type: 'mention',
            title: `${event.senderName} mentioned you in #${event.channelName}`,
            body: this.truncate(event.content, 100),
            url: `/channels/${event.channelId}/messages/${event.messageId}`,
            metadata: {
              channelId: event.channelId,
              messageId: event.messageId,
              senderId: event.senderId,
              isThread: event.isThread,
            },
          },
        });
      }

      // Notify about thread replies
      if (event.isThread && event.parentMessageId) {
        notifications.push({
          userId: '', // Will be resolved to thread participants
          notification: {
            type: 'reply',
            title: `${event.senderName} replied in a thread`,
            body: this.truncate(event.content, 100),
            url: `/channels/${event.channelId}/messages/${event.parentMessageId}`,
            metadata: {
              channelId: event.channelId,
              messageId: event.messageId,
              parentMessageId: event.parentMessageId,
              senderId: event.senderId,
            },
          },
        });
      }

      // Handle file attachments
      if (event.attachments && event.attachments.length > 0) {
        const fileNames = event.attachments.map(a => a.name).join(', ');
        notifications.push({
          userId: '', // Channel participants
          notification: {
            type: 'info',
            title: `${event.senderName} shared ${event.attachments.length} file(s)`,
            body: fileNames,
            url: `/channels/${event.channelId}/messages/${event.messageId}`,
            metadata: {
              channelId: event.channelId,
              attachments: event.attachments,
            },
          },
        });
      }

      return notifications;
    });

    // Reaction handler
    this.on<ReactionEvent>('message.reaction.added', (event) => {
      if (event.actorId === event.messageAuthorId) return [];

      return [{
        userId: event.messageAuthorId,
        notification: {
          type: 'reaction' as const,
          title: `${event.actorName} reacted ${event.emoji} to your message`,
          body: this.truncate(event.messagePreview, 80),
          url: `/channels/${event.channelId}/messages/${event.messageId}`,
          metadata: {
            messageId: event.messageId,
            emoji: event.emoji,
            actorId: event.actorId,
          },
        },
      }];
    });

    // Channel event handler
    this.on<ChannelEvent>('channel.member.added', (event) => {
      if (!event.targetUserId) return [];

      return [{
        userId: event.targetUserId,
        notification: {
          type: 'info' as const,
          title: `${event.actorName} added you to #${event.channelName}`,
          body: 'You can now participate in this channel',
          url: `/channels/${event.channelId}`,
          metadata: {
            channelId: event.channelId,
            actorId: event.actorId,
          },
        },
      }];
    });

    this.on<ChannelEvent>('channel.member.removed', (event) => {
      if (!event.targetUserId) return [];

      return [{
        userId: event.targetUserId,
        notification: {
          type: 'warning' as const,
          title: `You were removed from #${event.channelName}`,
          body: `${event.actorName} removed you from the channel`,
          metadata: {
            channelId: event.channelId,
            actorId: event.actorId,
          },
        },
      }];
    });

    this.on<ChannelEvent>('channel.archived', (event) => {
      return [{
        userId: '', // All channel members
        notification: {
          type: 'system' as const,
          title: `#${event.channelName} has been archived`,
          body: `${event.actorName} archived this channel`,
          metadata: {
            channelId: event.channelId,
            actorId: event.actorId,
          },
        },
      }];
    });

    // File event handler
    this.on<FileEvent>('file.shared', (event) => {
      const notifications: Array<{ userId: string; notification: Omit<NotificationPayload, 'id' | 'createdAt'> }> = [];

      if (event.sharedWithUserIds) {
        for (const userId of event.sharedWithUserIds) {
          if (userId === event.uploaderId) continue;

          notifications.push({
            userId,
            notification: {
              type: 'info' as const,
              title: `${event.uploaderName} shared a file with you`,
              body: `${event.fileName} (${this.formatFileSize(event.fileSize)})`,
              url: `/files/${event.fileId}`,
              metadata: {
                fileId: event.fileId,
                fileName: event.fileName,
                fileSize: event.fileSize,
                fileType: event.fileType,
                uploaderId: event.uploaderId,
              },
            },
          });
        }
      }

      return notifications;
    });

    // System event handler
    this.on<SystemEvent>('system.maintenance', (event) => {
      return [{
        userId: '', // All users
        notification: {
          type: 'system' as const,
          title: event.title,
          body: event.message,
          metadata: {
            severity: event.severity,
            affectedServices: event.affectedServices,
            scheduledAt: event.scheduledAt,
            estimatedDuration: event.estimatedDuration,
          },
        },
      }];
    });

    this.on<SystemEvent>('system.alert', (event) => {
      const type = event.severity === 'critical' || event.severity === 'high' ? 'error' : 'warning';
      return [{
        userId: '', // All users or admins depending on severity
        notification: {
          type: type as 'error' | 'warning',
          title: event.title,
          body: event.message,
          metadata: {
            severity: event.severity,
            affectedServices: event.affectedServices,
          },
        },
      }];
    });

    // Integration event handler
    this.on<IntegrationEvent>('integration.error', (event) => {
      return [{
        userId: '', // Integration owner
        notification: {
          type: 'error' as const,
          title: `${event.integrationName} integration error`,
          body: event.errorMessage || event.details,
          metadata: {
            integrationId: event.integrationId,
            integrationName: event.integrationName,
          },
        },
      }];
    });

    this.on<IntegrationEvent>('integration.connected', (event) => {
      return [{
        userId: '', // Integration owner
        notification: {
          type: 'success' as const,
          title: `${event.integrationName} connected successfully`,
          body: event.details,
          metadata: {
            integrationId: event.integrationId,
          },
        },
      }];
    });

    this.on<IntegrationEvent>('integration.webhook', (event) => {
      return [{
        userId: '', // Integration owner
        notification: {
          type: 'info' as const,
          title: `Webhook received from ${event.integrationName}`,
          body: event.details,
          url: `/integrations/${event.integrationId}/webhooks`,
          metadata: {
            integrationId: event.integrationId,
            webhookPayload: event.webhookPayload,
          },
        },
      }];
    });
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  private formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }
}

/**
 * Notification sound manager
 * Manages notification sound preferences and playback
 */
class NotificationSoundManager {
  private sounds: Map<string, { url: string; volume: number }>;
  private isMuted: boolean;
  private globalVolume: number;

  constructor() {
    this.sounds = new Map();
    this.isMuted = false;
    this.globalVolume = 0.7;
    this.registerDefaultSounds();
  }

  registerSound(type: string, url: string, volume: number = 1.0): void {
    this.sounds.set(type, { url, volume: Math.min(1, Math.max(0, volume)) });
  }

  getSoundForType(type: string): { url: string; volume: number } | null {
    if (this.isMuted) return null;
    const sound = this.sounds.get(type) || this.sounds.get('default');
    if (!sound) return null;
    return { url: sound.url, volume: sound.volume * this.globalVolume };
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
  }

  setGlobalVolume(volume: number): void {
    this.globalVolume = Math.min(1, Math.max(0, volume));
  }

  private registerDefaultSounds(): void {
    this.registerSound('default', '/sounds/notification.mp3', 0.5);
    this.registerSound('mention', '/sounds/mention.mp3', 0.8);
    this.registerSound('error', '/sounds/error.mp3', 0.9);
    this.registerSound('success', '/sounds/success.mp3', 0.6);
    this.registerSound('warning', '/sounds/warning.mp3', 0.7);
    this.registerSound('system', '/sounds/system.mp3', 0.4);
  }
}

export { NotificationEventRouter, NotificationSoundManager };
export type {
  NotificationEvent,
  ChatMessageEvent,
  UserPresenceEvent,
  ChannelEvent,
  ReactionEvent,
  FileEvent,
  SystemEvent,
  IntegrationEvent
};
