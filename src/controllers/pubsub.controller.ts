import { Request, Response, NextFunction } from 'express';

// Import JavaScript services (they're in services/pubsub)
const StreamService = require('../../services/pubsub/services/stream.service');
const WebhookManager = require('../../services/pubsub/services/webhook-manager');

/**
 * PubSub Controller
 * Manages webhook subscriptions and stream consumption
 */
export class PubSubController {
  private streamService: any;
  private webhookManager: any;
  private initialized: boolean = false;

  constructor() {
    // Lazy initialization - only connect when first needed
  }

  private async ensureInitialized() {
    if (this.initialized) {
      return;
    }

    try {
      this.streamService = new StreamService();
      await this.streamService.connect();
      
      this.webhookManager = new WebhookManager(this.streamService);
      await this.webhookManager.initialize();
      
      this.initialized = true;
      console.log('✅ PubSub controller initialized');
    } catch (error: any) {
      console.error('❌ Failed to initialize PubSub controller:', error);
      throw error;
    }
  }

  // ==================== Webhook Methods ====================

  /**
   * Register a webhook
   * POST /api/v1/pubsub/webhooks
   * If JWT contains agentCode, webhook will only receive events for that agent
   */
  async registerWebhook(req: any, res: Response, next: NextFunction) {
    try {
      await this.ensureInitialized();
      
      const { url, eventTypes, secret, headers } = req.body;

      if (!url) {
        res.status(400).json({
          success: false,
          error: 'URL is required'
        });
        return;
      }

      // Validate URL
      try {
        new URL(url);
      } catch (error) {
        res.status(400).json({
          success: false,
          error: 'Invalid URL format'
        });
        return;
      }

      // Extract agentCode from JWT token (if present)
      const agentCode = req.user?.agentCode || null;
      
      const webhook = await this.webhookManager.register({
        url,
        eventTypes: eventTypes || ['message:incoming', 'ai:response'],
        secret,
        headers: headers || {},
        agentCode // Scope webhook to specific agent if JWT contains agentCode
      });

      res.status(201).json({
        success: true,
        webhook: {
          id: webhook.id,
          url: webhook.url,
          eventTypes: webhook.eventTypes,
          agentCode: webhook.agentCode || null, // Show if webhook is scoped to an agent
          status: webhook.status,
          createdAt: webhook.createdAt
        }
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * List all webhooks
   * GET /api/v1/pubsub/webhooks
   */
  async listWebhooks(req: Request, res: Response, next: NextFunction) {
    try {
      await this.ensureInitialized();
      
      const webhooks = await this.webhookManager.list();
      res.json({
        success: true,
        webhooks: webhooks.map((w: any) => ({
          id: w.id,
          url: w.url,
          eventTypes: w.eventTypes,
          agentCode: w.agentCode || null, // Show if webhook is scoped to an agent
          status: w.status,
          createdAt: w.createdAt,
          lastTriggered: w.lastTriggered,
          successCount: w.successCount,
          failureCount: w.failureCount
        }))
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get webhook by ID
   * GET /api/v1/pubsub/webhooks/:id
   */
  async getWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      await this.ensureInitialized();
      
      const { id } = req.params;
      const webhook = await this.webhookManager.get(id);

      if (!webhook) {
        res.status(404).json({
          success: false,
          error: 'Webhook not found'
        });
        return;
      }

      res.json({
        success: true,
        webhook: {
          id: webhook.id,
          url: webhook.url,
          eventTypes: webhook.eventTypes,
          agentCode: webhook.agentCode || null, // Show if webhook is scoped to an agent
          status: webhook.status,
          createdAt: webhook.createdAt,
          lastTriggered: webhook.lastTriggered,
          successCount: webhook.successCount,
          failureCount: webhook.failureCount
        }
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Update webhook
   * PUT /api/v1/pubsub/webhooks/:id
   */
  async updateWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      await this.ensureInitialized();
      
      const { id } = req.params;
      const { url, eventTypes, secret, headers, status } = req.body;

      // Validate URL if provided
      if (url) {
        try {
          new URL(url);
        } catch (error) {
          res.status(400).json({
            success: false,
            error: 'Invalid URL format'
          });
          return;
        }
      }

      const webhook = await this.webhookManager.update(id, {
        url,
        eventTypes,
        secret,
        headers,
        status
      });

      if (!webhook) {
        res.status(404).json({
          success: false,
          error: 'Webhook not found'
        });
        return;
      }

      res.json({
        success: true,
        webhook: {
          id: webhook.id,
          url: webhook.url,
          eventTypes: webhook.eventTypes,
          agentCode: webhook.agentCode || null, // Show if webhook is scoped to an agent
          status: webhook.status,
          updatedAt: webhook.updatedAt
        }
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Delete webhook
   * DELETE /api/v1/pubsub/webhooks/:id
   */
  async deleteWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      await this.ensureInitialized();
      
      const { id } = req.params;
      const deleted = await this.webhookManager.delete(id);

      if (!deleted) {
        res.status(404).json({
          success: false,
          error: 'Webhook not found'
        });
        return;
      }

      res.json({
        success: true,
        message: 'Webhook deleted successfully'
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Test webhook
   * POST /api/v1/pubsub/webhooks/:id/test
   */
  async testWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      await this.ensureInitialized();
      
      const { id } = req.params;
      const testEvent = req.body.event || {
        eventType: 'test',
        timestamp: new Date().toISOString(),
        test: true
      };

      const webhook = await this.webhookManager.get(id);
      if (!webhook) {
        res.status(404).json({
          success: false,
          error: 'Webhook not found'
        });
        return;
      }

      const result = await this.webhookManager.trigger(webhook, testEvent);

      res.json({
        success: result.success,
        message: result.success ? 'Webhook triggered successfully' : 'Webhook trigger failed',
        statusCode: result.statusCode,
        error: result.error
      });
    } catch (error: any) {
      next(error);
    }
  }

  // ==================== Stream Methods ====================

  /**
   * Get stream info
   * GET /api/v1/pubsub/streams/info
   */
  async getStreamInfo(req: Request, res: Response, next: NextFunction) {
    try {
      await this.ensureInitialized();
      
      const info = await this.streamService.getStreamInfo();
      res.json({
        success: true,
        stream: {
          name: this.streamService.getStreamName(),
          ...info
        }
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Read from stream (simple read)
   * GET /api/v1/pubsub/streams/read
   */
  async readStream(req: Request, res: Response, next: NextFunction) {
    try {
      await this.ensureInitialized();
      
      const {
        count = 10,
        block = 0,
        startId = '-',
        endId = '+'
      } = req.query;

      const entries = await this.streamService.read({
        count: parseInt(count as string),
        block: parseInt(block as string),
        startId: startId as string,
        endId: endId as string
      });

      res.json({
        success: true,
        entries,
        count: entries.length
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Create consumer group
   * POST /api/v1/pubsub/streams/groups
   */
  async createConsumerGroup(req: Request, res: Response, next: NextFunction) {
    try {
      await this.ensureInitialized();
      
      const { groupName, startId = '0' } = req.body;

      if (!groupName) {
        res.status(400).json({
          success: false,
          error: 'groupName is required'
        });
        return;
      }

      await this.streamService.createConsumerGroup(groupName, startId);

      res.status(201).json({
        success: true,
        message: `Consumer group '${groupName}' created successfully`
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Read from consumer group
   * GET /api/v1/pubsub/streams/groups/:groupName/read
   */
  async readConsumerGroup(req: Request, res: Response, next: NextFunction) {
    try {
      await this.ensureInitialized();
      
      const { groupName } = req.params;
      const {
        consumerName = `consumer-${Date.now()}`,
        count = 10,
        block = 5000
      } = req.query;

      const entries = await this.streamService.readGroup(
        groupName,
        consumerName as string,
        {
          count: parseInt(count as string),
          block: parseInt(block as string)
        }
      );

      res.json({
        success: true,
        groupName,
        consumerName,
        entries,
        count: entries.length
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Acknowledge message
   * POST /api/v1/pubsub/streams/groups/:groupName/ack
   */
  async acknowledgeMessage(req: Request, res: Response, next: NextFunction) {
    try {
      await this.ensureInitialized();
      
      const { groupName } = req.params;
      const { entryId } = req.body;

      if (!entryId) {
        res.status(400).json({
          success: false,
          error: 'entryId is required'
        });
        return;
      }

      const count = await this.streamService.acknowledge(groupName, entryId);

      res.json({
        success: true,
        acknowledged: count
      });
    } catch (error: any) {
      next(error);
    }
  }
}
