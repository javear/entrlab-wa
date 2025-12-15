const express = require('express');

function createMessageRoutes(messageController) {
  const router = express.Router();

  // Send text message - POST /api/v1/messages/:clientId/text
  router.post('/:clientId/text', (req, res) => messageController.sendText(req, res));

  // Send media message - POST /api/v1/messages/:clientId/media
  router.post('/:clientId/media', (req, res) => messageController.sendMedia(req, res));

  // Send template message - POST /api/v1/messages/:clientId/template
  router.post('/:clientId/template', (req, res) => messageController.sendTemplate(req, res));

  // Get message status - GET /api/v1/messages/:clientId/status/:messageId
  router.get('/:clientId/status/:messageId', (req, res) => messageController.getMessageStatus(req, res));

  return router;
}

module.exports = { createMessageRoutes };

