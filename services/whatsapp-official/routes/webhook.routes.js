const express = require('express');

function createWebhookRoutes(webhookController) {
  const router = express.Router();

  // Webhook routes with clientId parameter
  // GET /webhook/v1/:clientId - Webhook verification (Meta requires this for webhook setup)
  router.get('/v1/:clientId', (req, res) => webhookController.verify(req, res));

  // POST /webhook/v1/:clientId - Webhook callback (Meta sends messages here)
  router.post('/v1/:clientId', (req, res) => webhookController.handleWebhook(req, res));

  return router;
}

module.exports = { createWebhookRoutes };

