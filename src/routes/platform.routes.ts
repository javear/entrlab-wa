import { Router } from 'express';
import { PlatformController } from '../controllers/platform.controller';

export function createPlatformRoutes(platformController: PlatformController): Router {
    const router = Router();

    // Platform Client Management Routes
    router.post('/clients', (req, res) => platformController.createPlatformClient(req, res));
    
    // Agent Assignment Routes
    router.put('/clients/:clientId/agent', (req, res) => platformController.assignAgentToClient(req, res));

    return router;
}



