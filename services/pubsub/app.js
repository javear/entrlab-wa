const express = require('express');
const { createWebhookRoutes } = require('./routes/webhook.routes');
const { createStreamRoutes } = require('./routes/stream.routes');
const WebhookController = require('./controllers/webhook.controller');
const StreamController = require('./controllers/stream.controller');
const StreamService = require('./services/stream.service');

/**
 * Pub/Sub Service Application
 * Handles pub/sub operations using Valkey Stream for WhatsApp messages and AI responses
 * Supports webhook subscriptions and stream consumption
 */
class PubSubApp {
  constructor() {
    this.app = express();
    this.webhookController = null;
    this.streamController = null;
    this.streamService = null;
  }

  async initialize() {
    // Middleware
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        service: 'pubsub',
        timestamp: new Date().toISOString(),
        stream: process.env.VALKEY_STREAM_NAME || 'whatsapp:events'
      });
    });

    // Initialize stream service
    this.streamService = new StreamService();
    await this.streamService.connect();

    // Initialize controllers
    this.webhookController = new WebhookController(this.streamService);
    this.streamController = new StreamController(this.streamService);

    // Initialize webhook manager (starts consuming)
    await this.webhookController.webhookManager.initialize();

    // Routes
    this.app.use('/api/v1/webhooks', createWebhookRoutes(this.webhookController));
    this.app.use('/api/v1/streams', createStreamRoutes(this.streamController));

    // Error handling middleware
    this.app.use((err, req, res, next) => {
      console.error('❌ Error:', err);
      res.status(err.status || 500).json({
        success: false,
        error: err.message || 'Internal server error'
      });
    });

    console.log('✅ Pub/Sub app initialized');
  }

  getApp() {
    return this.app;
  }

  getStreamService() {
    return this.streamService;
  }

  async shutdown() {
    if (this.streamService) {
      await this.streamService.disconnect();
    }
  }
}

module.exports = PubSubApp;
