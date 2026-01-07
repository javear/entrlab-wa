const express = require('express');

/**
 * Create webhook routes
 * @param {WebhookController} controller - Webhook controller instance
 * @returns {express.Router} - Express router
 */
function createWebhookRoutes(controller) {
  const router = express.Router();

  // Register webhook
  router.post('/', controller.registerWebhook.bind(controller));

  // List all webhooks
  router.get('/', controller.listWebhooks.bind(controller));

  // Get webhook by ID
  router.get('/:id', controller.getWebhook.bind(controller));

  // Update webhook
  router.put('/:id', controller.updateWebhook.bind(controller));

  // Delete webhook
  router.delete('/:id', controller.deleteWebhook.bind(controller));

  // Test webhook
  router.post('/:id/test', controller.testWebhook.bind(controller));

  return router;
}

module.exports = { createWebhookRoutes };

