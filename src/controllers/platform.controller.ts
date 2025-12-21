import { Request, Response } from 'express';
import { WPPConnectWhatsAppService } from '../services/whatsapp.service';
import { Environment } from '../types';
import mongoose, { Document, Schema } from 'mongoose';
import { encryptWithVault, decryptWithVault } from '../utils/vault';
import crypto from 'crypto';

// ============================================
// Platform Client Model
// ============================================

interface IPlatformClientAgent extends Document {
  clientId: string;
  platform: 'wpp' | 'wa-official';
  ai_agent_code?: string;
  phone_number_id?: string; // Plain phone_number_id for wa-official clients (for easy querying)
  configuration?: string; // Encrypted configuration
  assignedAt?: Date;
  updatedAt?: Date;
  isActive: boolean;
}

// Create model with error handling
let PlatformClientAgent: mongoose.Model<IPlatformClientAgent>;
try {
  PlatformClientAgent = mongoose.model<IPlatformClientAgent>('PlatformClientAgent');
} catch (error) {
  const PlatformClientAgentSchema = new Schema<IPlatformClientAgent>({
    clientId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    platform: {
      type: String,
      required: true,
      enum: ['wpp', 'wa-official'],
      index: true
    },
    ai_agent_code: {
      type: String,
      index: true
    },
    phone_number_id: {
      type: String, // Plain phone_number_id for wa-official clients (for easy querying)
      index: true
    },
    configuration: {
      type: String // Encrypted configuration stored as string
    },
    assignedAt: {
      type: Date,
      default: Date.now
    },
    updatedAt: {
      type: Date,
      default: Date.now
    },
    isActive: {
      type: Boolean,
      default: true
    }
  }, {
    timestamps: true
  });

  PlatformClientAgentSchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
  });

  PlatformClientAgentSchema.index({ clientId: 1, platform: 1, isActive: 1 });
  PlatformClientAgentSchema.index({ platform: 1, isActive: 1 });
  PlatformClientAgentSchema.index({ phone_number_id: 1, platform: 1, isActive: 1 }); // Index for querying by phone_number_id

  PlatformClientAgent = mongoose.model<IPlatformClientAgent>('PlatformClientAgent', PlatformClientAgentSchema);
}

// Also extend the existing ClientAgent model
interface IClientAgent extends Document {
  clientId: string;
  ai_agent_code: string;
  platform?: 'wpp' | 'wa-official';
  phone_number_id?: string; // Plain phone_number_id for wa-official clients (for easy querying)
  configuration?: string;
  assignedAt: Date;
  updatedAt: Date;
  isActive: boolean;
}

let ClientAgent: mongoose.Model<IClientAgent>;
try {
  ClientAgent = mongoose.model<IClientAgent>('ClientAgent');
} catch (error) {
  // Model already exists or needs to be updated
  ClientAgent = mongoose.model<IClientAgent>('ClientAgent');
}

/**
 * Generate a random verify token
 */
function generateVerifyToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================
// Platform Controller
// ============================================

export class PlatformController {
  constructor(
    private whatsappService: WPPConnectWhatsAppService,
    private env: Environment
  ) {}

  /**
   * Create a platform client
   * POST /api/v1/platform/clients
   */
  async createPlatformClient(req: Request, res: Response): Promise<void> {
    try {
      const { clientId, platform, configuration } = req.body;

      // Validate input
      if (!clientId) {
        res.status(400).json({
          success: false,
          error: 'clientId is required'
        });
        return;
      }

      if (!platform || !['wpp', 'wa-official'].includes(platform)) {
        res.status(400).json({
          success: false,
          error: 'platform must be either "wpp" or "wa-official"'
        });
        return;
      }

      // Handle WPP platform
      if (platform === 'wpp') {
        try {
          // Check if client already exists in PlatformClientAgent
          const existingPlatformClient = await PlatformClientAgent.findOne({
            clientId,
            platform: 'wpp'
          });
          const isUpdate = !!existingPlatformClient;

          // Start WPPConnect client creation (asynchronously, don't await)
          this.whatsappService.createClient(clientId).catch((error) => {
            console.error(`❌ Error creating WPPConnect client ${clientId}:`, error);
          });

          // Create or update PlatformClientAgent record
          await PlatformClientAgent.findOneAndUpdate(
            { clientId },
            {
              clientId,
              platform: 'wpp',
              updatedAt: new Date(),
              isActive: true
            },
            { upsert: true, new: true }
          );

          console.log(`✅ ${isUpdate ? 'Updated' : 'Created'} PlatformClientAgent record for WPP client ${clientId}`);

          res.status(202).json({
            success: true,
            message: 'WPPConnect client creation started',
            client: {
              clientId: clientId,
              platform: 'wpp',
              status: 'initializing',
              isReady: false,
              hasQrCode: false,
              phoneNumber: null,
              message: 'Client is being initialized. Poll GET /api/whatsapp/clients/{clientId} to check status and QR code availability.'
            }
          });
          return;
        } catch (error) {
          console.error('❌ Error starting WPPConnect client creation:', error);
          res.status(500).json({
            success: false,
            message: 'Failed to start WPPConnect client creation',
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          return;
        }
      }

      // Handle WA-Official platform
      if (platform === 'wa-official') {
        if (!configuration || !configuration.access_token || !configuration.phone_number_id) {
          res.status(400).json({
            success: false,
            error: 'configuration with access_token and phone_number_id is required for wa-official platform'
          });
          return;
        }

        try {
          // Check if client already exists (before update)
          const existingClient = await PlatformClientAgent.findOne({
            clientId,
            platform: 'wa-official'
          });
          const isUpdate = !!existingClient;
          
          // Check if user explicitly wants to renew the verify_token
          const shouldRenewVerifyToken = configuration.renew_verifyToken === true;
          
          let existingVerifyToken: string | undefined;
          let verifyToken: string;
          
          if (shouldRenewVerifyToken) {
            // User explicitly requested renewal - generate new token
            console.log(`🔄 renew_verifyToken is true - generating new verify_token for client ${clientId}`);
            verifyToken = generateVerifyToken();
            console.log(`✅ Generated new verify_token (renewal requested)`);
          } else {
            // Check if client exists and has configuration to preserve verify_token
            if (existingClient && existingClient.configuration) {
              try {
                // Decrypt existing configuration to get the verify_token
                console.log(`🔓 Checking existing configuration for client ${clientId}...`);
                const existingConfig = await decryptWithVault(existingClient.configuration);
                
                if (existingConfig.verify_token) {
                  existingVerifyToken = existingConfig.verify_token;
                  console.log(`✅ Found existing verify_token for client ${clientId}, preserving it`);
                } else {
                  console.log(`⚠️ No verify_token found in existing configuration for ${clientId}, generating new one`);
                }
              } catch (decryptError: any) {
                console.warn(`⚠️ Could not decrypt existing configuration for ${clientId}:`, decryptError.message);
                console.log(`⚠️ Will generate new verify_token`);
              }
            } else {
              console.log(`📝 New client ${clientId}, generating verify_token`);
            }

            // Only generate verify_token if we don't have an existing one
            verifyToken = existingVerifyToken || generateVerifyToken();
            
            if (existingVerifyToken) {
              console.log(`✅ Using existing verify_token (preserved from previous creation)`);
            } else {
              console.log(`✅ Generated new verify_token`);
            }
          }

          // Prepare configuration object
          // app_secret is required for webhook signature verification (HMAC-SHA256)
          const configObject = {
            access_token: configuration.access_token,
            phone_number_id: configuration.phone_number_id,
            verify_token: verifyToken, // Preserve existing or use new
            app_secret: configuration.app_secret || '' // Optional but recommended for webhook signature verification
          };

          console.log(`🔐 Encrypting configuration for client ${clientId}...`);

          // Encrypt configuration with Vault
          const encryptedConfiguration = await encryptWithVault(configObject);

          // Create or update client in MongoDB
          // Save phone_number_id as plain field for easy querying
          const clientAgent = await PlatformClientAgent.findOneAndUpdate(
            { clientId },
            {
              clientId,
              platform: 'wa-official',
              phone_number_id: configuration.phone_number_id, // Save as plain field for easy querying
              configuration: encryptedConfiguration,
              updatedAt: new Date(),
              isActive: true
            },
            { upsert: true, new: true }
          );

          // Also update the existing ClientAgent collection for backward compatibility
          // Note: We skip creating ClientAgent if no ai_agent_code is provided, since it's required
          // The PlatformClientAgent is the primary storage for wa-official clients
          try {
            const existingClientAgent = await ClientAgent.findOne({ clientId });
            if (existingClientAgent) {
              // Update existing record with platform, phone_number_id, and configuration (only if it exists)
              await ClientAgent.findOneAndUpdate(
                { clientId },
                {
                  platform: 'wa-official',
                  phone_number_id: configuration.phone_number_id, // Save as plain field for easy querying
                  configuration: encryptedConfiguration,
                  updatedAt: new Date()
                }
              );
            }
            // Skip creating new ClientAgent record if it doesn't exist - will be created when agent is assigned
            // This is because ai_agent_code is required and we don't have it at client creation time
          } catch (clientAgentError) {
            console.warn('⚠️ Could not update ClientAgent collection:', clientAgentError);
            // Continue anyway - PlatformClientAgent is the primary storage for wa-official
          }

          console.log(`✅ ${isUpdate ? 'Updated' : 'Created'} wa-official client ${clientId} with encrypted configuration`);

          // Build response message based on verify_token handling
          let verifyTokenMessage: string;
          if (shouldRenewVerifyToken) {
            verifyTokenMessage = isUpdate 
              ? 'Client updated. verifyToken has been renewed - please update webhook configuration in Meta Dashboard with the new verifyToken.'
              : 'Client created with new verifyToken. Use the verifyToken to configure webhook in Meta Dashboard.';
          } else if (existingVerifyToken) {
            verifyTokenMessage = 'Client updated. Using existing verifyToken (webhook configuration unchanged).';
          } else {
            verifyTokenMessage = 'Client created. Use the verifyToken to configure webhook in Meta Dashboard.';
          }

          res.status(isUpdate ? 200 : 201).json({
            success: true,
            message: `WA-Official client ${isUpdate ? 'updated' : 'created'} successfully`,
            client: {
              clientId: clientId,
              platform: 'wa-official',
              status: isUpdate ? 'updated' : 'created',
              verifyToken: verifyToken, // Return the verify token (existing or new) so it can be used for webhook setup
              verifyTokenPreserved: !shouldRenewVerifyToken && !!existingVerifyToken, // Indicate if token was preserved
              verifyTokenRenewed: shouldRenewVerifyToken, // Indicate if token was explicitly renewed
              message: verifyTokenMessage
            }
          });
          return;
        } catch (error: any) {
          console.error('❌ Error creating wa-official client:', error);
          
          // Check if it's a Vault error
          if (error.message?.includes('Vault is not configured')) {
            res.status(500).json({
              success: false,
              error: 'Vault encryption is required but not configured. Please set VAULT_ADDR and VAULT_TOKEN in your .env file.'
            });
            return;
          }

          res.status(500).json({
            success: false,
            error: 'Failed to create wa-official client',
            details: error instanceof Error ? error.message : 'Unknown error'
          });
          return;
        }
      }
    } catch (error) {
      console.error('❌ Error in createPlatformClient:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get all platform clients (includes both platform clients and legacy WPP clients)
   * GET /api/v1/platform/clients
   */
  async getAllPlatformClients(req: Request, res: Response): Promise<void> {
    try {
      // Get all clients from PlatformClientAgent
      const platformClients = await PlatformClientAgent.find({ isActive: true }).sort({ updatedAt: -1 });
      
      // Get all in-memory WPPConnect clients (legacy clients)
      const allWppClients = this.whatsappService.getAllClients();
      
      // Create a map to track which clients we've already included
      const clientMap = new Map<string, any>();

      // First, add all platform clients
      for (const client of platformClients) {
        const clientData: any = {
          clientId: client.clientId,
          platform: client.platform,
          ai_agent_code: client.ai_agent_code || null,
          phone_number_id: client.phone_number_id || null,
          assignedAt: client.assignedAt || null,
          updatedAt: client.updatedAt,
          isActive: client.isActive,
          source: 'platform' // Mark as platform client
        };

        // For WPP clients, merge with in-memory client data
        if (client.platform === 'wpp') {
          const wppClient = this.whatsappService.getClient(client.clientId);
          if (wppClient) {
            clientData.status = wppClient.status;
            clientData.isReady = wppClient.isReady;
            clientData.hasQrCode = (wppClient.isReady || wppClient.status === 'ready') ? false : !!wppClient.qrCode;
            clientData.phoneNumber = wppClient.phoneNumber || null;
            clientData.lastActivity = wppClient.lastActivity;
            // Override ai_agent_code if present in memory (should be synced, but memory is source of truth for active session)
            if (wppClient.ai_agent_code) {
              clientData.ai_agent_code = wppClient.ai_agent_code;
            }
          } else {
            // Client exists in DB but not in memory (not initialized or disconnected)
            clientData.status = 'not_initialized';
            clientData.isReady = false;
            clientData.hasQrCode = false;
            clientData.phoneNumber = null;
            clientData.lastActivity = null;
          }
        } else {
          // WA-Official clients - no in-memory state
          clientData.status = 'active';
          clientData.isReady = true; // WA-Official clients are always "ready" (no QR needed)
          clientData.hasQrCode = false;
          clientData.phoneNumber = null;
          clientData.lastActivity = client.updatedAt;
        }

        clientMap.set(client.clientId, clientData);
      }

      // Then, add legacy WPP clients that aren't in PlatformClientAgent
      for (const wppClient of allWppClients) {
        if (!clientMap.has(wppClient.clientId)) {
          // Check if it exists in ClientAgent for agent assignment info
          let agentCode: string | null = null;
          let assignedAt: Date | null = null;
          let updatedAt: Date = new Date();
          
          try {
            const clientAgent = await ClientAgent.findOne({ 
              clientId: wppClient.clientId, 
              isActive: true 
            });
            if (clientAgent) {
              agentCode = clientAgent.ai_agent_code || null;
              assignedAt = clientAgent.assignedAt || null;
              updatedAt = clientAgent.updatedAt || new Date();
            }
          } catch (error) {
            // Silent fail - use in-memory agent code if available
          }

          const clientData: any = {
            clientId: wppClient.clientId,
            platform: 'wpp',
            status: wppClient.status,
            isReady: wppClient.isReady,
            hasQrCode: (wppClient.isReady || wppClient.status === 'ready') ? false : !!wppClient.qrCode,
            phoneNumber: wppClient.phoneNumber || null,
            phone_number_id: null,
            lastActivity: wppClient.lastActivity,
            ai_agent_code: wppClient.ai_agent_code || agentCode || null,
            assignedAt: assignedAt,
            updatedAt: updatedAt,
            isActive: true,
            source: 'legacy' // Mark as legacy client
          };

          clientMap.set(wppClient.clientId, clientData);
        }
      }

      // Convert map to array and sort by updatedAt (most recent first)
      const clients = Array.from(clientMap.values()).sort((a, b) => {
        const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return dateB - dateA;
      });

      res.json({
        success: true,
        clients: clients
      });
    } catch (error) {
      console.error('❌ Error getting all platform clients:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get platform clients',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get specific platform client
   * GET /api/v1/platform/clients/{clientId}
   */
  async getPlatformClient(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;

      if (!clientId) {
        res.status(400).json({
          success: false,
          error: 'clientId is required'
        });
        return;
      }

      // Find client in PlatformClientAgent
      const platformClient = await PlatformClientAgent.findOne({
        clientId,
        isActive: true
      });

      if (!platformClient) {
        res.status(404).json({
          success: false,
          message: `Platform client ${clientId} not found`
        });
        return;
      }

      const clientData: any = {
        clientId: platformClient.clientId,
        platform: platformClient.platform,
        ai_agent_code: platformClient.ai_agent_code || null,
        phone_number_id: platformClient.phone_number_id || null,
        assignedAt: platformClient.assignedAt || null,
        updatedAt: platformClient.updatedAt,
        isActive: platformClient.isActive
      };

      // For WPP clients, merge with in-memory client data
      if (platformClient.platform === 'wpp') {
        const wppClient = this.whatsappService.getClient(clientId);
        if (wppClient) {
          clientData.status = wppClient.status;
          clientData.isReady = wppClient.isReady;
          clientData.hasQrCode = (wppClient.isReady || wppClient.status === 'ready') ? false : !!wppClient.qrCode;
          clientData.phoneNumber = wppClient.phoneNumber || null;
          clientData.lastActivity = wppClient.lastActivity;
          // Override ai_agent_code if present in memory
          if (wppClient.ai_agent_code) {
            clientData.ai_agent_code = wppClient.ai_agent_code;
          }
        } else {
          // Client exists in DB but not in memory
          clientData.status = 'not_initialized';
          clientData.isReady = false;
          clientData.hasQrCode = false;
          clientData.phoneNumber = null;
          clientData.lastActivity = null;
        }
      } else if (platformClient.platform === 'wa-official') {
        // WA-Official clients - decrypt configuration to get verifyToken
        clientData.status = 'active';
        clientData.isReady = true;
        clientData.hasQrCode = false;
        clientData.phoneNumber = null;
        clientData.lastActivity = platformClient.updatedAt;

        // Decrypt configuration to get verifyToken and other details
        if (platformClient.configuration) {
          try {
            const decryptedConfig = await decryptWithVault(platformClient.configuration);
            clientData.verifyToken = decryptedConfig.verify_token || null;
            // Optionally include other config details (masked for security)
            clientData.configuration = {
              access_token: decryptedConfig.access_token ? `${decryptedConfig.access_token.substring(0, 20)}...` : null,
              app_secret: decryptedConfig.app_secret ? '***' : null,
              verify_token: decryptedConfig.verify_token || null
            };
          } catch (error) {
            console.error(`❌ Error decrypting configuration for client ${clientId}:`, error);
            clientData.verifyToken = null;
            clientData.configurationError = 'Failed to decrypt configuration';
          }
        } else {
          clientData.verifyToken = null;
          clientData.configurationError = 'No configuration found';
        }
      }

      res.json({
        success: true,
        client: clientData
      });
    } catch (error) {
      console.error('❌ Error getting platform client:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get platform client',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get agent assignment for a platform client
   * GET /api/v1/platform/clients/{clientId}/agent
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

      // Try PlatformClientAgent first
      let client = await PlatformClientAgent.findOne({
        clientId,
        isActive: true
      });

      if (client && client.ai_agent_code) {
        res.json({
          success: true,
          clientId: client.clientId,
          platform: client.platform,
          ai_agent_code: client.ai_agent_code,
          assignedAt: client.assignedAt || null,
          updatedAt: client.updatedAt
        });
        return;
      }

      // If not found in PlatformClientAgent, try ClientAgent (for backward compatibility)
      const clientAgent = await ClientAgent.findOne({
        clientId,
        isActive: true
      });

      if (clientAgent && clientAgent.ai_agent_code) {
        res.json({
          success: true,
          clientId: clientAgent.clientId,
          platform: clientAgent.platform || 'wpp',
          ai_agent_code: clientAgent.ai_agent_code,
          assignedAt: clientAgent.assignedAt,
          updatedAt: clientAgent.updatedAt
        });
        return;
      }

      // No agent assigned
      res.status(404).json({
        success: false,
        message: `No agent assigned to client ${clientId}`
      });
    } catch (error) {
      console.error('❌ Error getting client agent:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get client agent',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Assign agent to a platform client
   * PUT /api/v1/platform/clients/{clientId}/agent
   * This method searches for the client in both ClientAgent (WPPConnect) and PlatformClientAgent (WA-Official) collections
   */
  async assignAgentToClient(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;
      const { agentCode } = req.body;

      // Validate input
      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }

      if (!agentCode) {
        res.status(400).json({
          success: false,
          message: 'agentCode is required'
        });
        return;
      }

      let foundIn = '';
      let updated = false;

      // Try to find and update in PlatformClientAgent first (WA-Official clients)
      try {
        const platformClient = await PlatformClientAgent.findOne({
          clientId,
          isActive: true
        });

        if (platformClient) {
          platformClient.ai_agent_code = agentCode;
          platformClient.assignedAt = new Date();
          platformClient.updatedAt = new Date();
          await platformClient.save();

          foundIn = 'PlatformClientAgent';
          updated = true;
          console.log(`✅ Assigned agent ${agentCode} to platform client ${clientId} (${platformClient.platform}) in PlatformClientAgent`);

          // Also update ClientAgent collection for backward compatibility if it exists
          try {
            const existingClientAgent = await ClientAgent.findOne({ clientId });
            if (existingClientAgent) {
              existingClientAgent.ai_agent_code = agentCode;
              existingClientAgent.assignedAt = new Date();
              existingClientAgent.updatedAt = new Date();
              await existingClientAgent.save();
              console.log(`✅ Also updated ClientAgent collection for backward compatibility`);
            }
          } catch (clientAgentError) {
            console.warn('⚠️ Could not update ClientAgent collection:', clientAgentError);
          }
        }
      } catch (platformError) {
        console.error('❌ Error updating PlatformClientAgent:', platformError);
      }

      // If not found in PlatformClientAgent, try ClientAgent (WPPConnect clients)
      if (!updated) {
        try {
          const clientAgent = await ClientAgent.findOne({
            clientId,
            isActive: true
          });

          if (clientAgent) {
            clientAgent.ai_agent_code = agentCode;
            clientAgent.assignedAt = new Date();
            clientAgent.updatedAt = new Date();
            await clientAgent.save();

            foundIn = 'ClientAgent';
            updated = true;
            console.log(`✅ Assigned agent ${agentCode} to client ${clientId} in ClientAgent`);

            // Also update the in-memory client object for immediate use (WPPConnect)
            const clientInfo = this.whatsappService.getClient(clientId);
            if (clientInfo) {
              clientInfo.ai_agent_code = agentCode;
              console.log(`✅ Also updated in-memory client object for immediate use`);
            }
          }
        } catch (clientAgentError) {
          console.error('❌ Error updating ClientAgent:', clientAgentError);
        }
      }

      // If client was not found in either collection
      if (!updated) {
        res.status(404).json({
          success: false,
          message: `Client ${clientId} not found in ClientAgent or PlatformClientAgent collections. Please create the client first.`
        });
        return;
      }

      // Success response (matching the format of PUT /api/whatsapp/clients/{clientId}/agent)
      res.json({
        success: true,
        message: 'Agent assigned to client successfully'
      });
    } catch (error) {
      console.error('❌ Error assigning agent to client:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to assign agent to client',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}

