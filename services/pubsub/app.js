const express = require('express');
const { createWebhookRoutes } = require('./routes/webhook.routes');
const { createStreamRoutes } = require('./routes/stream.routes');
const WebhookController = require('./controllers/webhook.controller');
const StreamController = require('./controllers/stream.controller');
const StreamService = require('./services/stream.service');
const WeaviateConsumer = require('./services/weaviate-consumer');

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
    this.weaviateConsumer = null;
    
    // Register health endpoint FIRST, before any middleware
    // This ensures Railway health checks work immediately
    // Health endpoint must work even if Redis/Weaviate are not connected
    this.app.get('/health', (req, res) => {
      // Always return 200 OK - health check just verifies server is running
      // Don't check Redis/Weaviate connections here - that's handled in initialization
      res.status(200).json({ 
        status: 'ok', 
        service: 'pubsub',
        timestamp: new Date().toISOString()
      });
    });
    
    // Also register root endpoint for basic connectivity
    this.app.get('/', (req, res) => {
      res.status(200).json({ 
        service: 'pubsub',
        status: 'running',
        health: '/health'
      });
    });
  }

  async initialize() {
    // Middleware (registered after health endpoint in index.js)
    // Note: Health endpoint should work without these middleware
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Initialize stream service
    this.streamService = new StreamService();
    await this.streamService.connect();

    // Initialize controllers
    this.webhookController = new WebhookController(this.streamService);
    this.streamController = new StreamController(this.streamService);

    // Initialize webhook manager (starts consuming)
    await this.webhookController.webhookManager.initialize();

    // Initialize Weaviate consumer if enabled
    if (process.env.WEAVIATE_ENABLED === 'true' || process.env.WEAVIATE_URL) {
      try {
        this.weaviateConsumer = new WeaviateConsumer(this.streamService);
        await this.weaviateConsumer.start();
        console.log('✅ Weaviate consumer initialized and started');
      } catch (error) {
        console.error('❌ Failed to initialize Weaviate consumer:', error);
        console.log('⚠️  Pub/Sub service will continue without Weaviate storage');
      }
    } else {
      console.log('ℹ️  Weaviate consumer disabled (set WEAVIATE_ENABLED=true or WEAVIATE_URL to enable)');
    }

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
    if (this.weaviateConsumer) {
      await this.weaviateConsumer.stop();
    }
    if (this.streamService) {
      await this.streamService.disconnect();
    }
  }
}

module.exports = PubSubApp;
