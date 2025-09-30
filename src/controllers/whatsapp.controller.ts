import { Request, Response } from 'express';
import { WPPConnectWhatsAppService } from '../services/whatsapp.service';
import { WPPConnectMessageHandler } from '../core/message-handler';
import { Environment } from '../types';

// ============================================
// WPPConnect WhatsApp Controller
// ============================================

export class WPPConnectWhatsAppController {
  constructor(
    private whatsappService: WPPConnectWhatsAppService,
    private messageHandler: WPPConnectMessageHandler,
    private env: Environment
  ) {}

  /**
   * @swagger
   * /api/whatsapp/clients:
   *   post:
   *     summary: Create a new WPPConnect WhatsApp client
   *     tags: [WPPConnect WhatsApp]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - clientId
   *             properties:
   *               clientId:
   *                 type: string
   *                 description: Unique identifier for the client
   *                 example: "my-whatsapp-client"
   *     responses:
   *       201:
   *         description: Client created successfully
   *       400:
   *         description: Bad request
   *       500:
   *         description: Internal server error
   */
  async createClient(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.body;

      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }

      // Start client creation asynchronously (don't await)
      this.whatsappService.createClient(clientId).catch((error) => {
        console.error(`❌ Error creating WPPConnect client ${clientId}:`, error);
      });
      
      // Return immediately with initializing status
      res.status(202).json({
        success: true,
        message: 'WPPConnect client creation started',
        client: {
          clientId: clientId,
          status: 'initializing',
          isReady: false,
          hasQrCode: false,
          phoneNumber: null,
          message: 'Client is being initialized. Poll GET /api/whatsapp/clients/{clientId} to check status and QR code availability.'
        }
      });
    } catch (error) {
      console.error('❌ Error starting WPPConnect client creation:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to start WPPConnect client creation',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients:
   *   get:
   *     summary: Get all WPPConnect WhatsApp clients
   *     tags: [WPPConnect WhatsApp]
   *     responses:
   *       200:
   *         description: List of all clients
   */
  async getAllClients(req: Request, res: Response): Promise<void> {
    try {
      const clients = this.whatsappService.getAllClients();
      
      res.json({
        success: true,
        clients: clients.map(client => ({
          clientId: client.clientId,
          status: client.status,
          isReady: client.isReady,
          hasQrCode: !!client.qrCode,
          phoneNumber: client.phoneNumber,
          lastActivity: client.lastActivity
        }))
      });
    } catch (error) {
      console.error('❌ Error getting WPPConnect clients:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get WPPConnect clients',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}:
   *   get:
   *     summary: Get WPPConnect client status
   *     tags: [WPPConnect WhatsApp]
   *     parameters:
   *       - in: path
   *         name: clientId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Client status
   *       404:
   *         description: Client not found
   */
  async getClientStatus(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;
      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }
      const client = this.whatsappService.getClient(clientId);

      if (!client) {
        res.status(404).json({
          success: false,
          message: 'WPPConnect client not found'
        });
        return;
      }

      res.json({
        success: true,
        client: {
          clientId: client.clientId,
          status: client.status,
          isReady: client.isReady,
          hasQrCode: !!client.qrCode,
          phoneNumber: client.phoneNumber,
          lastActivity: client.lastActivity
        }
      });
    } catch (error) {
      console.error('❌ Error getting WPPConnect client status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get WPPConnect client status',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}/qr-image:
   *   get:
   *     summary: Get QR code image for WPPConnect client
   *     tags: [WPPConnect WhatsApp]
   *     parameters:
   *       - in: path
   *         name: clientId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: QR code image
   *       404:
   *         description: Client not found or no QR code available
   */
  async getQRImage(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;
      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }
      const client = this.whatsappService.getClient(clientId);

      if (!client) {
        res.status(404).json({
          success: false,
          message: 'WPPConnect client not found'
        });
        return;
      }

      if (!client.qrCode) {
        res.status(404).json({
          success: false,
          message: 'No QR code available for this client'
        });
        return;
      }

      // Convert base64 QR code to image
      const base64Data = client.qrCode.replace(/^data:image\/png;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');

      res.set({
        'Content-Type': 'image/png',
        'Content-Length': imageBuffer.length
      });
      res.send(imageBuffer);
    } catch (error) {
      console.error('❌ Error getting WPPConnect QR code:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get WPPConnect QR code',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}/send:
   *   post:
   *     summary: Send message via WPPConnect client
   *     tags: [WPPConnect WhatsApp]
   *     parameters:
   *       - in: path
   *         name: clientId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - number
   *               - message
   *             properties:
   *               number:
   *                 type: string
   *                 description: Phone number (with country code, no +)
   *                 example: "6281234567890"
   *               message:
   *                 type: string
   *                 description: Message to send
   *                 example: "Hello from WPPConnect!"
   *     responses:
   *       200:
   *         description: Message sent successfully
   *       400:
   *         description: Bad request
   *       404:
   *         description: Client not found
   *       500:
   *         description: Internal server error
   */
  async sendMessage(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;
      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }
      const { number, message } = req.body;

      if (!number || !message) {
        res.status(400).json({
          success: false,
          message: 'number and message are required'
        });
        return;
      }

      const client = this.whatsappService.getClient(clientId);
      if (!client) {
        res.status(404).json({
          success: false,
          message: 'WPPConnect client not found'
        });
        return;
      }

      if (!client.isReady) {
        res.status(400).json({
          success: false,
          message: 'WPPConnect client is not ready'
        });
        return;
      }

      await this.whatsappService.sendMessage(clientId, number, message);
      
      res.json({
        success: true,
        message: 'Message sent successfully'
      });
    } catch (error) {
      console.error('❌ Error sending message via WPPConnect:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to send message',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}/disconnect:
   *   post:
   *     summary: Disconnect WPPConnect client
   *     tags: [WPPConnect WhatsApp]
   *     parameters:
   *       - in: path
   *         name: clientId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Client disconnected successfully
   *       404:
   *         description: Client not found
   */
  async disconnectClient(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;
      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }
      const success = await this.whatsappService.disconnectClient(clientId);

      if (!success) {
        res.status(404).json({
          success: false,
          message: 'WPPConnect client not found'
        });
        return;
      }

      res.json({
        success: true,
        message: 'WPPConnect client disconnected successfully'
      });
    } catch (error) {
      console.error('❌ Error disconnecting WPPConnect client:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to disconnect WPPConnect client',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}:
   *   delete:
   *     summary: Remove WPPConnect client
   *     tags: [WPPConnect WhatsApp]
   *     parameters:
   *       - in: path
   *         name: clientId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Client removed successfully
   *       404:
   *         description: Client not found
   */
  async removeClient(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;
      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }
      const success = await this.whatsappService.disconnectClient(clientId);

      if (!success) {
        res.status(404).json({
          success: false,
          message: 'WPPConnect client not found'
        });
        return;
      }

      res.json({
        success: true,
        message: 'WPPConnect client removed successfully'
      });
    } catch (error) {
      console.error('❌ Error removing WPPConnect client:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to remove WPPConnect client',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/health:
   *   get:
   *     summary: Get WPPConnect health status
   *     tags: [WPPConnect WhatsApp]
   *     responses:
   *       200:
   *         description: Health status
   */
  async getHealthStatus(req: Request, res: Response): Promise<void> {
    try {
      const healthStatus = this.whatsappService.getHealthStatus();
      
      res.json({
        success: true,
        message: 'WPPConnect WhatsApp Bot API is healthy',
        status: healthStatus,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error getting WPPConnect health status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get WPPConnect health status',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}/agent:
   *   put:
   *     summary: Assign agent to WPPConnect client
   *     tags: [WPPConnect WhatsApp]
   *     parameters:
   *       - in: path
   *         name: clientId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - agentCode
   *             properties:
   *               agentCode:
   *                 type: string
   *                 description: AI agent code
   *                 example: "goa-konsul"
   *     responses:
   *       200:
   *         description: Agent assigned successfully
   */
  async updateClientAgent(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;
      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }
      const { agentCode } = req.body;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          message: 'agentCode is required'
        });
        return;
      }

      const success = await this.whatsappService.assignAgentToClient(clientId, agentCode);
      
      if (!success) {
        res.status(500).json({
          success: false,
          message: 'Failed to assign agent to WPPConnect client'
        });
        return;
      }

      res.json({
        success: true,
        message: 'Agent assigned to WPPConnect client successfully'
      });
    } catch (error) {
      console.error('❌ Error assigning agent to WPPConnect client:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to assign agent to WPPConnect client',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}/agent:
   *   delete:
   *     summary: Remove agent from WPPConnect client
   *     tags: [WPPConnect WhatsApp]
   *     parameters:
   *       - in: path
   *         name: clientId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Agent removed successfully
   */
  async removeClientAgent(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;
      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }
      const success = await this.whatsappService.removeAgentFromClient(clientId);
      
      if (!success) {
        res.status(500).json({
          success: false,
          message: 'Failed to remove agent from WPPConnect client'
        });
        return;
      }

      res.json({
        success: true,
        message: 'Agent removed from WPPConnect client successfully'
      });
    } catch (error) {
      console.error('❌ Error removing agent from WPPConnect client:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to remove agent from WPPConnect client',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}/agent:
   *   get:
   *     summary: Get agent assigned to WPPConnect client
   *     tags: [WPPConnect WhatsApp]
   *     parameters:
   *       - in: path
   *         name: clientId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Agent information
   */
  async getClientAgent(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;
      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }
      const agentCode = await this.whatsappService.getClientAgent(clientId);
      
      res.json({
        success: true,
        clientId,
        agentCode
      });
    } catch (error) {
      console.error('❌ Error getting WPPConnect client agent:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get WPPConnect client agent',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/agents:
   *   get:
   *     summary: Get all agent assignments
   *     tags: [WPPConnect WhatsApp]
   *     responses:
   *       200:
   *         description: List of all agent assignments
   */
  async getAllAgentAssignments(req: Request, res: Response): Promise<void> {
    try {
      const assignments = await this.whatsappService.getAllAgentAssignments();
      
      res.json({
        success: true,
        assignments
      });
    } catch (error) {
      console.error('❌ Error getting WPPConnect agent assignments:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get WPPConnect agent assignments',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}

export default WPPConnectWhatsAppController;
