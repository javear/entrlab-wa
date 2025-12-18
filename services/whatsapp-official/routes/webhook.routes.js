const express = require('express');

function createWebhookRoutes(webhookController) {
  const router = express.Router();

  // Webhook routes with optional clientId parameter
  // The clientId in the route is optional - the system will auto-detect from phone_number_id in metadata
  // GET /webhook/v1/:clientId - Webhook verification (Meta requires this for webhook setup)
  // Note: clientId is optional but recommended for backward compatibility
  router.get('/v1/:clientId?', (req, res) => webhookController.verify(req, res));

  // POST /webhook/v1/:clientId - Webhook callback (Meta sends messages here)
  // Note: clientId in route is optional - system will auto-detect from phone_number_id in webhook metadata
  router.post('/v1/:clientId?', (req, res) => webhookController.handleWebhook(req, res));

  return router;
}

module.exports = { createWebhookRoutes };

