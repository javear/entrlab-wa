import { Router } from 'express';
import { PubSubController } from '../controllers/pubsub.controller';

export function createPubSubRoutes(pubSubController: PubSubController): Router {
    const router = Router();

    // Webhook Routes
    router.post('/webhooks', (req, res, next) => pubSubController.registerWebhook(req, res, next));
    router.get('/webhooks', (req, res, next) => pubSubController.listWebhooks(req, res, next));
    router.get('/webhooks/:id', (req, res, next) => pubSubController.getWebhook(req, res, next));
    router.put('/webhooks/:id', (req, res, next) => pubSubController.updateWebhook(req, res, next));
    router.delete('/webhooks/:id', (req, res, next) => pubSubController.deleteWebhook(req, res, next));
    router.post('/webhooks/:id/test', (req, res, next) => pubSubController.testWebhook(req, res, next));

    // Stream Routes
    router.get('/streams/info', (req, res, next) => pubSubController.getStreamInfo(req, res, next));
    router.get('/streams/read', (req, res, next) => pubSubController.readStream(req, res, next));
    router.post('/streams/groups', (req, res, next) => pubSubController.createConsumerGroup(req, res, next));
    router.get('/streams/groups/:groupName/read', (req, res, next) => pubSubController.readConsumerGroup(req, res, next));
    router.post('/streams/groups/:groupName/ack', (req, res, next) => pubSubController.acknowledgeMessage(req, res, next));

    return router;
}

