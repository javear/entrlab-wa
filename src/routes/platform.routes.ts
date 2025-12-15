import { Router } from 'express';
import { PlatformController } from '../controllers/platform.controller';

export function createPlatformRoutes(platformController: PlatformController): Router {
    const router = Router();

    // Platform Client Management Routes
    router.post('/clients', (req, res) => platformController.createPlatformClient(req, res));

    return router;
}



