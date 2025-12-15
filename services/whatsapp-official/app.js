const express = require('express');
const { createWebhookRoutes } = require('./routes/webhook.routes');
const { createMessageRoutes } = require('./routes/message.routes');
const WhatsAppWebhookController = require('./controllers/webhook.controller');
const WhatsAppMessageController = require('./controllers/message.controller');

/**
 * WhatsApp Business API Application
 * Handles webhooks and messaging for Meta WhatsApp Business API
 * Documentation: https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform
 */
class WhatsAppOfficialApp {
  constructor() {
    this.app = express();
    this.webhookController = null;
    this.messageController = null;
  }

  initialize() {
    // Important: Capture raw body for webhook signature verification
    // Meta's signature is calculated on the RAW body string, not the parsed JSON
    // This middleware must run BEFORE express.json() to capture the raw body
    this.app.use('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
      // Store raw body for signature verification
      req.rawBody = req.body; // Buffer containing raw body
      // Parse as JSON for processing (req.body will be used by route handlers)
      try {
        req.body = JSON.parse(req.body.toString('utf8'));
      } catch (error) {
        // If parsing fails, continue with raw body
        console.warn('⚠️ Failed to parse webhook body as JSON:', error.message);
      }
      next();
    });
    
    // Regular JSON parsing for other routes (will skip /webhook routes as body already parsed)
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        service: 'whatsapp-official',
        timestamp: new Date().toISOString()
      });
    });

    // Initialize controllers
    this.webhookController = new WhatsAppWebhookController();
    this.messageController = new WhatsAppMessageController();

    // Routes
    this.app.use('/webhook', createWebhookRoutes(this.webhookController));
    this.app.use('/api/v1/messages', createMessageRoutes(this.messageController));

    // Error handling middleware
    this.app.use((err, req, res, next) => {
      console.error('❌ Error:', err);
      res.status(err.status || 500).json({
        success: false,
        error: err.message || 'Internal server error'
      });
    });

    console.log('✅ WhatsApp Business API app initialized');
  }

  getApp() {
    return this.app;
  }
}

module.exports = WhatsAppOfficialApp;

