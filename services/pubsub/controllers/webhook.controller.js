const WebhookManager = require('../services/webhook-manager');

/**
 * Webhook Controller
 * Manages webhook subscriptions and delivery
 */
class WebhookController {
  constructor(streamService) {
    this.streamService = streamService;
    this.webhookManager = new WebhookManager(streamService);
  }

  /**
   * Register a webhook
   * POST /api/v1/webhooks
   */
  async registerWebhook(req, res, next) {
    try {
      const { url, eventTypes, secret, headers } = req.body;

      if (!url) {
        return res.status(400).json({
          success: false,
          error: 'URL is required'
        });
      }

      // Validate URL
      try {
        new URL(url);
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: 'Invalid URL format'
        });
      }

      const webhook = await this.webhookManager.register({
        url,
        eventTypes: eventTypes || ['message:incoming', 'ai:response'], // Default to all events
        secret,
        headers: headers || {}
      });

      res.status(201).json({
        success: true,
        webhook: {
          id: webhook.id,
          url: webhook.url,
          eventTypes: webhook.eventTypes,
          status: webhook.status,
          createdAt: webhook.createdAt
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List all webhooks
   * GET /api/v1/webhooks
   */
  async listWebhooks(req, res, next) {
    try {
      const webhooks = await this.webhookManager.list();
      res.json({
        success: true,
        webhooks: webhooks.map(w => ({
          id: w.id,
          url: w.url,
          eventTypes: w.eventTypes,
          status: w.status,
          createdAt: w.createdAt,
          lastTriggered: w.lastTriggered,
          successCount: w.successCount,
          failureCount: w.failureCount
        }))
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get webhook by ID
   * GET /api/v1/webhooks/:id
   */
  async getWebhook(req, res, next) {
    try {
      const { id } = req.params;
      const webhook = await this.webhookManager.get(id);

      if (!webhook) {
        return res.status(404).json({
          success: false,
          error: 'Webhook not found'
        });
      }

      res.json({
        success: true,
        webhook: {
          id: webhook.id,
          url: webhook.url,
          eventTypes: webhook.eventTypes,
          status: webhook.status,
          createdAt: webhook.createdAt,
          lastTriggered: webhook.lastTriggered,
          successCount: webhook.successCount,
          failureCount: webhook.failureCount
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update webhook
   * PUT /api/v1/webhooks/:id
   */
  async updateWebhook(req, res, next) {
    try {
      const { id } = req.params;
      const { url, eventTypes, secret, headers, status } = req.body;

      // Validate URL if provided
      if (url) {
        try {
          new URL(url);
        } catch (error) {
          return res.status(400).json({
            success: false,
            error: 'Invalid URL format'
          });
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
        return res.status(404).json({
          success: false,
          error: 'Webhook not found'
        });
      }

      res.json({
        success: true,
        webhook: {
          id: webhook.id,
          url: webhook.url,
          eventTypes: webhook.eventTypes,
          status: webhook.status,
          updatedAt: webhook.updatedAt
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete webhook
   * DELETE /api/v1/webhooks/:id
   */
  async deleteWebhook(req, res, next) {
    try {
      const { id } = req.params;
      const deleted = await this.webhookManager.delete(id);

      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: 'Webhook not found'
        });
      }

      res.json({
        success: true,
        message: 'Webhook deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Test webhook
   * POST /api/v1/webhooks/:id/test
   */
  async testWebhook(req, res, next) {
    try {
      const { id } = req.params;
      const testEvent = req.body.event || {
        eventType: 'test',
        timestamp: new Date().toISOString(),
        test: true
      };

      const webhook = await this.webhookManager.get(id);
      if (!webhook) {
        return res.status(404).json({
          success: false,
          error: 'Webhook not found'
        });
      }

      const result = await this.webhookManager.trigger(webhook, testEvent);

      res.json({
        success: result.success,
        message: result.success ? 'Webhook triggered successfully' : 'Webhook trigger failed',
        statusCode: result.statusCode,
        error: result.error
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = WebhookController;

