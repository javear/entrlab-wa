import { Request, Response } from 'express';
import { WPPConnectWhatsAppService } from '../services/whatsapp.service';
import { WPPConnectMessageHandler } from '../core/message-handler';
import { Environment } from '../types';
import { UserPauseService } from '../services/user-pause.service';

// ============================================
// WPPConnect WhatsApp Controller
// ============================================

export class WPPConnectWhatsAppController {
  private userPauseService: UserPauseService;

  constructor(
    private whatsappService: WPPConnectWhatsAppService,
    private messageHandler: WPPConnectMessageHandler,
    private env: Environment
  ) {
    this.userPauseService = new UserPauseService();
  }

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
          // QR code should never be true if client is ready or status is ready
          hasQrCode: (client.isReady || client.status === 'ready') ? false : !!client.qrCode,
          phoneNumber: client.phoneNumber,
          lastActivity: client.lastActivity,
          ai_agent_code: client.ai_agent_code || null
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

      // Debug logging
      console.log(`🔍 Client ${clientId} - qrCode exists: ${!!client.qrCode}, length: ${client.qrCode?.length || 0}`);
      
      res.json({
        success: true,
        client: {
          clientId: client.clientId,
          status: client.status,
          isReady: client.isReady,
          // QR code should never be true if client is ready or status is ready
          hasQrCode: (client.isReady || client.status === 'ready') ? false : !!client.qrCode,
          phoneNumber: client.phoneNumber,
          lastActivity: client.lastActivity,
          ai_agent_code: client.ai_agent_code || null
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

      // If no QR code stored, try to fetch a fresh one from WPPConnect
      if (!client.qrCode) {
        console.log(`📱 [${clientId}] No stored QR code, attempting to fetch fresh QR from WPPConnect...`);
        try {
          const clientManager = (this.whatsappService as any).clientManager;
          const clientInfo = clientManager?.clients?.get?.(clientId);
          if (clientInfo?.client) {
            const qrData = await clientInfo.client.getQrCode();
            if (qrData?.base64Image) {
              console.log(`✅ [${clientId}] Fresh QR code fetched successfully`);
              client.qrCode = qrData.base64Image;
            }
          }
        } catch (qrError: any) {
          console.warn(`⚠️  [${clientId}] Could not fetch fresh QR code: ${qrError?.message || qrError}`);
        }
      }

      if (!client.qrCode) {
        res.status(404).json({
          success: false,
          message: `No QR code available for this client (status: ${client.status}). QR codes expire after ~20 seconds. Try resetting the client or wait for a new QR to be generated.`
        });
        return;
      }

      // Convert base64 QR code to image
      const base64Data = client.qrCode.replace(/^data:image\/png;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');

      console.log(`📱 [${clientId}] Serving QR code image (${imageBuffer.length} bytes)`);

      res.set({
        'Content-Type': 'image/png',
        'Content-Length': imageBuffer.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate', // Prevent caching of QR codes
        'Pragma': 'no-cache',
        'Expires': '0'
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
   * /api/whatsapp/clients/{clientId}/reset:
   *   delete:
   *     summary: Reset WPPConnect client (delete session and recreate for fresh QR)
   *     tags: [WPPConnect WhatsApp]
   *     parameters:
   *       - in: path
   *         name: clientId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Client reset successfully
   */
  async resetClient(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;
      
      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }
      
      console.log(`🔄 Resetting client: ${clientId}`);
      
      // Disconnect existing client
      await this.whatsappService.disconnectClient(clientId);
      
      // Delete session backup from MongoDB
      const clientManager = (this.whatsappService as any).clientManager;
      if (clientManager && clientManager.sessionBackup) {
        // Note: We don't delete backups on reset, just recreate client
        console.log(`🔄 [${clientId}] Will create fresh session (backups preserved)`);
      }
      
      // Recreate client (will generate fresh QR)
      await this.whatsappService.createClient(clientId);
      
      res.json({
        success: true,
        message: `Client ${clientId} reset successfully - new QR code will be generated`,
        clientId
      });
    } catch (error) {
      console.error(`❌ Error resetting client:`, error);
      res.status(500).json({
        success: false,
        message: 'Failed to reset client',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}/send:
   *   post:
   *     summary: Send message via WPPConnect client with full media support
   *     description: |
   *       Sends a message with support for:
   *       - Text messages with WhatsApp formatting (bold, italic, etc.)
   *       - Stickers: Use #sticker:https://example.com/image.png
   *       - Images: Include image URLs (jpg, png, gif, webp, etc.)
   *       - Videos: Include video URLs (mp4, webm, etc.)
   *       - Files: Include file URLs (pdf, doc, etc.)
   *       - Links: URLs are automatically sent as link previews
   *       - Locations: Use #loc:latitude;longitude;title format
   *       - Markdown images: Use ![alt](https://example.com/image.png)
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
   *                 description: Message to send (supports media markers like #sticker:, #loc:, markdown images, etc.)
   *                 example: "Hello! #sticker:https://example.com/sticker.png Check out this image: https://example.com/image.jpg"
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

      // Use message handler to send with full media support (stickers, images, links, etc.)
      await this.messageHandler.sendMessageWithMedia(clientId, number, message);
      
      res.json({
        success: true,
        message: 'Message sent successfully'
      });
    } catch (error) {
      console.error('❌ Error sending message via WPPConnect:', error);
      
      // Check if it's an invalid WhatsApp number error
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isInvalidNumber = errorMessage.includes('invalid wid') || 
                              errorMessage.includes('InvalidWidError') ||
                              errorMessage.includes('wid error');
      
      if (isInvalidNumber) {
        res.status(400).json({
          success: false,
          message: 'Invalid WhatsApp number',
          error: 'The provided number is not a valid WhatsApp account'
        });
        return;
      }
      
      // Other errors
      res.status(500).json({
        success: false,
        message: 'Failed to send message',
        error: errorMessage
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
   * Force cleanup of a stuck client session from MongoDB
   * This endpoint can be used to manually clean up broken sessions
   */
  async forceCleanupClient(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;
      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }

      console.log(`🧹 Force cleanup requested for client: ${clientId}`);
      const success = await this.whatsappService.forceCleanupSession(clientId);

      if (success) {
        res.json({
          success: true,
          message: `Force cleaned up session for client ${clientId} from MongoDB`
        });
      } else {
        res.status(404).json({
          success: false,
          message: `Session for client ${clientId} was not found in MongoDB`
        });
      }
    } catch (error) {
      console.error('❌ Error force cleaning client session:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to force cleanup client session',
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

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}/pause:
   *   post:
   *     summary: Pause a user from receiving automated responses
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
   *               - phoneNumber
   *               - pausedTill
   *             properties:
   *               phoneNumber:
   *                 type: string
   *                 description: User's phone number (without @c.us)
   *                 example: "6282121547121"
   *               pausedTill:
   *                 type: string
   *                 format: date-time
   *                 description: ISO date string for when pause expires
   *                 example: "2025-10-09T12:00:00.000Z"
   *               pauseReason:
   *                 type: string
   *                 description: Optional reason for pausing the user
   *                 example: "User requested to pause notifications"
   *     responses:
   *       200:
   *         description: User paused successfully
   */
  async pauseUser(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;
      const { phoneNumber, pausedTill, pauseReason } = req.body;

      if (!clientId || !phoneNumber || !pausedTill) {
        res.status(400).json({
          success: false,
          message: 'clientId, phoneNumber, and pausedTill are required'
        });
        return;
      }

      const pausedTillDate = new Date(pausedTill);
      if (isNaN(pausedTillDate.getTime())) {
        res.status(400).json({
          success: false,
          message: 'Invalid pausedTill date format'
        });
        return;
      }

      const pauseRecord = await this.userPauseService.pauseUser(
        clientId,
        phoneNumber,
        pausedTillDate,
        pauseReason
      );

      res.json({
        success: true,
        message: `User ${phoneNumber} paused on client ${clientId}`,
        pause: {
          clientId: pauseRecord.clientId,
          phoneNumber: pauseRecord.phoneNumber,
          paused: pauseRecord.paused,
          paused_at: pauseRecord.paused_at,
          paused_till: pauseRecord.paused_till,
          pause_reason: pauseRecord.pause_reason
        }
      });
    } catch (error) {
      console.error('❌ Error pausing user:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to pause user',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}/pause/{phoneNumber}:
   *   delete:
   *     summary: Unpause a user to resume automated responses
   *     tags: [WPPConnect WhatsApp]
   *     parameters:
   *       - in: path
   *         name: clientId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: phoneNumber
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: User unpaused successfully
   */
  async unpauseUser(req: Request, res: Response): Promise<void> {
    try {
      const { clientId, phoneNumber } = req.params;

      if (!clientId || !phoneNumber) {
        res.status(400).json({
          success: false,
          message: 'clientId and phoneNumber are required'
        });
        return;
      }

      const unpaused = await this.userPauseService.unpauseUser(clientId, phoneNumber);

      if (unpaused) {
        res.json({
          success: true,
          message: `User ${phoneNumber} unpaused on client ${clientId}`
        });
      } else {
        res.status(404).json({
          success: false,
          message: `No pause record found for ${phoneNumber} on client ${clientId}`
        });
      }
    } catch (error) {
      console.error('❌ Error unpausing user:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to unpause user',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}/pause/{phoneNumber}:
   *   get:
   *     summary: Get pause status for a user
   *     tags: [WPPConnect WhatsApp]
   *     parameters:
   *       - in: path
   *         name: clientId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: phoneNumber
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Pause status retrieved
   */
  async getPauseStatus(req: Request, res: Response): Promise<void> {
    try {
      const { clientId, phoneNumber } = req.params;

      if (!clientId || !phoneNumber) {
        res.status(400).json({
          success: false,
          message: 'clientId and phoneNumber are required'
        });
        return;
      }

      const pauseRecord = await this.userPauseService.getPauseStatus(clientId, phoneNumber);

      if (pauseRecord) {
        const now = new Date();
        const isActive = pauseRecord.paused && now <= pauseRecord.paused_till;

        res.json({
          success: true,
          pause: {
            clientId: pauseRecord.clientId,
            phoneNumber: pauseRecord.phoneNumber,
            paused: pauseRecord.paused,
            paused_at: pauseRecord.paused_at,
            paused_till: pauseRecord.paused_till,
            pause_reason: pauseRecord.pause_reason,
            is_active: isActive
          }
        });
      } else {
        res.json({
          success: true,
          pause: null,
          message: 'User is not paused'
        });
      }
    } catch (error) {
      console.error('❌ Error getting pause status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get pause status',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * @swagger
   * /api/whatsapp/clients/{clientId}/pauses:
   *   get:
   *     summary: Get all paused users for a client
   *     tags: [WPPConnect WhatsApp]
   *     parameters:
   *       - in: path
   *         name: clientId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: List of paused users
   */
  async getPausedUsers(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;

      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }

      const pausedUsers = await this.userPauseService.getPausedUsers(clientId);

      res.json({
        success: true,
        paused_users: pausedUsers.map(p => ({
          phoneNumber: p.phoneNumber,
          paused_at: p.paused_at,
          paused_till: p.paused_till,
          paused: p.paused,
          pause_reason: p.pause_reason
        })),
        total: pausedUsers.length
      });
    } catch (error) {
      console.error('❌ Error getting paused users:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get paused users',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}

export default WPPConnectWhatsAppController;
