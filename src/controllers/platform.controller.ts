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

