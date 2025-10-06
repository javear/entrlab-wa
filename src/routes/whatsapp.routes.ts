import { Router } from 'express';
import { WPPConnectWhatsAppController } from '../controllers/whatsapp.controller';

export function createWhatsAppRoutes(whatsappController: WPPConnectWhatsAppController): Router {
    const router = Router();

    // Client Management Routes
    router.post('/clients', (req, res) => whatsappController.createClient(req, res));
    router.get('/clients', (req, res) => whatsappController.getAllClients(req, res));
    
    // Specific routes must come before general ones
    router.get('/clients/:clientId/qr-image', (req, res) => whatsappController.getQRImage(req, res));
    router.post('/clients/:clientId/send', (req, res) => whatsappController.sendMessage(req, res));
    router.post('/clients/:clientId/disconnect', (req, res) => whatsappController.disconnectClient(req, res));
    router.post('/clients/:clientId/force-cleanup', (req, res) => whatsappController.forceCleanupClient(req, res));
    router.delete('/clients/:clientId', (req, res) => whatsappController.removeClient(req, res));
    // Note: WPPConnect doesn't have recover/reset methods - clients are managed differently
    
    // Client-Agent Assignment routes
    router.put('/clients/:clientId/agent', (req, res) => whatsappController.updateClientAgent(req, res));
    router.delete('/clients/:clientId/agent', (req, res) => whatsappController.removeClientAgent(req, res));
    router.get('/clients/:clientId/agent', (req, res) => whatsappController.getClientAgent(req, res));
    
    router.get('/clients/:clientId', (req, res) => whatsappController.getClientStatus(req, res));

    // QR Code Management Routes (WPPConnect handles QR differently)
    // router.get('/qr', (req, res) => whatsappController.getQRCode(req, res));
    // router.post('/qr/:clientId/refresh', (req, res) => whatsappController.refreshQRCode(req, res));

    // Health and Status Routes
    router.get('/health', (req, res) => whatsappController.getHealthStatus(req, res));

    // Agent Assignment Routes
    router.get('/agents', (req, res) => whatsappController.getAllAgentAssignments(req, res));

    return router;
}
