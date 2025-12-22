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
    router.get('/clients/:clientId/agents', (req, res) => platformController.getClientAgents(req, res));
    router.put('/clients/:clientId/agent', (req, res) => platformController.assignAgentToClient(req, res));
    router.delete('/clients/:clientId/agent', (req, res) => platformController.removeAgentFromClient(req, res));
    router.delete('/clients/:clientId/agent/:userIdentifier', (req, res) => platformController.removePrivateAgentAssignment(req, res));
    
    // Need Attention Routes
    router.get('/clients/:clientId/needattention', (req, res) => platformController.getNeedAttention(req, res));
    router.post('/clients/:clientId/needattention/:userIdentifier', (req, res) => platformController.setNeedAttention(req, res));

    return router;
}



