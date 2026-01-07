const express = require('express');

/**
 * Create stream routes
 * @param {StreamController} controller - Stream controller instance
 * @returns {express.Router} - Express router
 */
function createStreamRoutes(controller) {
  const router = express.Router();

  // Get stream info
  router.get('/info', controller.getStreamInfo.bind(controller));

  // Read from stream
  router.get('/read', controller.readStream.bind(controller));

  // Create consumer group
  router.post('/groups', controller.createConsumerGroup.bind(controller));

  // Read from consumer group
  router.get('/groups/:groupName/read', controller.readConsumerGroup.bind(controller));

  // Acknowledge message
  router.post('/groups/:groupName/ack', controller.acknowledgeMessage.bind(controller));

  return router;
}

module.exports = { createStreamRoutes };

