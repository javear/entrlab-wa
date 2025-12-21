import { Router } from 'express';
import { PlatformController } from '../controllers/platform.controller';

export function createPlatformRoutes(platformController: PlatformController): Router {
    const router = Router();

    // Platform Client Management Routes
    router.post('/clients', (req, res) => platformController.createPlatformClient(req, res));
    router.get('/clients', (req, res) => platformController.getAllPlatformClients(req, res));
    router.get('/clients/:clientId', (req, res) => platformController.getPlatformClient(req, res));
    
    // Agent Assignment Routes
    router.get('/clients/:clientId/agent', (req, res) => platformController.getClientAgent(req, res));
    router.put('/clients/:clientId/agent', (req, res) => platformController.assignAgentToClient(req, res));

    return router;
}



