import { Request, Response } from 'express';
import { WPPConnectWhatsAppService } from '../services/whatsapp.service';
import { Environment } from '../types';
import mongoose, { Document, Schema } from 'mongoose';
import { encryptWithVault, decryptWithVault } from '../utils/vault';
import crypto from 'crypto';
import { WeaviateService } from '../services/weaviate.service';
import jwt from 'jsonwebtoken';
import axios from 'axios';

// Stream Producer for publishing events
const { StreamProducer } = require('../../services/pubsub/client/producer');

// ============================================
// Platform Client Model
// ============================================

interface IPrivateAgentAssignment {
  userIdentifier: string;
  agentCode: string;
}

interface INeedAttention {
  userIdentifier: string;
  option: 'pause' | 'release' | 'block' | 'taken';
  from?: Date;
  to?: Date;
  reason?: string;
  updatedAt?: Date;
  taken?: {
    by: {
      id: string;          // sender.senderId from JWT
      name: string;        // sender.senderDisplayName from JWT
      role: string;        // sender.senderRoleLabel from JWT
      avatarUrl?: string;  // sender.senderAvatarUrl from JWT
    }
  };
}

interface INeedAttentionHistory {
  userIdentifier: string;
  option: 'pause' | 'release' | 'block' | 'taken';
  previousOption?: string;
  from?: Date;
  to?: Date;
  reason?: string;
  changedAt: Date;
  changedBy?: {
    id: string;
    name: string;
    role: string;
    avatarUrl?: string;
  };
  taken?: {
    by: {
      id: string;
      name: string;
      role: string;
      avatarUrl?: string;
    };
  };
}

interface IPlatformClientAgent extends Document {
  clientId: string;
  platform: 'wpp' | 'wa-official';
  ai_agent_code?: string;
  phone_number_id?: string; // Plain phone_number_id for wa-official clients (for easy querying)
  configuration?: string; // Encrypted configuration
  privateAgentAssignment?: IPrivateAgentAssignment[]; // Array of user-specific agent assignments
  needAttention?: INeedAttention[]; // Array of users needing attention (pause, block, etc.)
  needAttentionHistory?: INeedAttentionHistory[]; // Audit trail of needAttention changes
  assignedAt?: Date;
  updatedAt?: Date;
  isActive: boolean;
}

// Create model with error handling
let PlatformClientAgent: mongoose.Model<IPlatformClientAgent>;
try {
  // Try to get existing model
  PlatformClientAgent = mongoose.model<IPlatformClientAgent>('PlatformClientAgent');
  // If model exists, try to add the privateAgentAssignment and needAttention fields to its schema if they don't exist
  try {
    const schema = PlatformClientAgent.schema;
    if (!schema.path('privateAgentAssignment')) {
      // Add the field to the existing schema
      schema.add({
        privateAgentAssignment: [{
          userIdentifier: { type: String, required: true },
          agentCode: { type: String, required: true }
        }]
      });
      console.log('✅ Added privateAgentAssignment field to existing PlatformClientAgent schema');
    }
    if (!schema.path('needAttention')) {
      // Add the needAttention field to the existing schema
      schema.add({
        needAttention: [{
          userIdentifier: { type: String, required: true },
          option: { type: String, required: true, enum: ['pause', 'release', 'block', 'taken'] },
          from: { type: Date },
          to: { type: Date },
          reason: { type: String },
          updatedAt: { type: Date, default: Date.now },
          taken: {
            type: {
              by: {
                id: { type: String, required: true },
                name: { type: String, required: true },
                role: { type: String, required: true },
                avatarUrl: { type: String, required: false }
              }
            },
            required: false
          }
        }],
        needAttentionHistory: [{
          userIdentifier: { type: String, required: true },
          option: { type: String, required: true, enum: ['pause', 'release', 'block', 'taken'] },
          previousOption: { type: String },
          from: { type: Date },
          to: { type: Date },
          reason: { type: String },
          changedAt: { type: Date, default: Date.now, required: true },
          changedBy: {
            type: {
              id: { type: String },
              name: { type: String },
              role: { type: String },
              avatarUrl: { type: String }
            },
            required: false
          },
          taken: {
            type: {
              by: {
                id: { type: String, required: true },
                name: { type: String, required: true },
                role: { type: String, required: true },
                avatarUrl: { type: String, required: false }
              }
            },
            required: false
          }
        }]
      });
      console.log('✅ Added needAttention and needAttentionHistory fields to existing PlatformClientAgent schema');
    } else if (!schema.path('needAttentionHistory')) {
      // Add only needAttentionHistory field if needAttention already exists
      schema.add({
        needAttentionHistory: [{
          userIdentifier: { type: String, required: true },
          option: { type: String, required: true, enum: ['pause', 'release', 'block', 'taken'] },
          previousOption: { type: String },
          from: { type: Date },
          to: { type: Date },
          reason: { type: String },
          changedAt: { type: Date, default: Date.now, required: true },
          changedBy: {
            type: {
              id: { type: String },
              name: { type: String },
              role: { type: String },
              avatarUrl: { type: String }
            },
            required: false
          },
          taken: {
            type: {
              by: {
                id: { type: String, required: true },
                name: { type: String, required: true },
                role: { type: String, required: true },
                avatarUrl: { type: String, required: false }
              }
            },
            required: false
          }
        }]
      });
      console.log('✅ Added needAttentionHistory field to existing PlatformClientAgent schema');
    }
  } catch (schemaError) {
    console.warn('⚠️ Could not add fields to existing schema:', schemaError);
  }
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
    privateAgentAssignment: {
      type: [{
        userIdentifier: {
          type: String,
          required: true
        },
        agentCode: {
          type: String,
          required: true
        }
      }],
      default: undefined
    },
    needAttention: {
      type: [{
        userIdentifier: {
          type: String,
          required: true
        },
        option: {
          type: String,
          required: true,
          enum: ['pause', 'release', 'block', 'taken']
        },
        from: {
          type: Date
        },
        to: {
          type: Date
        },
        reason: {
          type: String
        },
        updatedAt: {
          type: Date,
          default: Date.now
        },
        taken: {
          type: {
            by: {
              id: { type: String, required: true },
              name: { type: String, required: true },
              role: { type: String, required: true },
              avatarUrl: { type: String, required: false }
            }
          },
          required: false
        }
      }],
      default: undefined
    },
    needAttentionHistory: {
      type: [{
        userIdentifier: {
          type: String,
          required: true
        },
        option: {
          type: String,
          required: true,
          enum: ['pause', 'release', 'block', 'taken']
        },
        previousOption: {
          type: String
        },
        from: {
          type: Date
        },
        to: {
          type: Date
        },
        reason: {
          type: String
        },
        changedAt: {
          type: Date,
          default: Date.now,
          required: true
        },
        changedBy: {
          type: {
            id: { type: String },
            name: { type: String },
            role: { type: String },
            avatarUrl: { type: String }
          },
          required: false
        },
        taken: {
          type: {
            by: {
              id: { type: String, required: true },
              name: { type: String, required: true },
              role: { type: String, required: true },
              avatarUrl: { type: String, required: false }
            }
          },
          required: false
        }
      }],
      default: undefined
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
    if (this.isModified() || this.isNew) {
      (this as any).updatedAt = new Date();
    }
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
    private env: Environment,
    private weaviateService?: WeaviateService
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
  /**
   * Get all clients for the authenticated agent
   * GET /api/v1/platform/clients
   * 
   * - Extracts agentCode from JWT token
   * - Returns all clients from PlatformClientAgent that have matching ai_agent_code
   * - Only returns active clients
   */
  async getClientsByAgent(req: Request, res: Response): Promise<void> {
    try {
      // Extract agentCode from JWT token (tenant for Weaviate) - REQUIRED
      const agentCode = (req as any).user?.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token'
        });
        return;
      }

      // Query PlatformClientAgent for all clients with matching agent code
      const clients = await PlatformClientAgent.find({
        ai_agent_code: agentCode,
        isActive: true
      }).sort({ updatedAt: -1 }).lean();

      // Filter and format response - only return active and ready clients
      const formattedClients = clients
        .map((client: any) => {
          // For WPP clients, check if they are ready
          if (client.platform === 'wpp') {
            const wppClient = this.whatsappService.getClient(client.clientId);
            // Filter out WPP clients that are not ready
            if (!wppClient || !wppClient.isReady) {
              return null;
            }
          }
          // For WA-Official clients, isActive: true is sufficient (no isReady concept)

          // Return only the requested fields
          return {
            clientId: client.clientId,
            platform: client.platform,
            phone_number_id: client.phone_number_id || null
          };
        })
        .filter((client: any) => client !== null); // Remove null entries

      res.json({
        success: true,
        data: {
          clients: formattedClients,
          total: formattedClients.length
        }
      });
    } catch (error: any) {
      console.error('❌ Error getting clients by agent:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to get clients'
      });
    }
  }

  async getAllPlatformClients(req: Request, res: Response): Promise<void> {
    try {
      // Get all clients from PlatformClientAgent (only those with platform field)
      const platformClients = await PlatformClientAgent.find({ 
        isActive: true,
        platform: { $exists: true, $ne: null } // Only clients with platform field
      }).sort({ updatedAt: -1 });
      
      const clients: any[] = [];

      // Process each platform client
      for (const client of platformClients) {
        const clientData: any = {
          clientId: client.clientId,
          platform: client.platform,
          ai_agent_code: client.ai_agent_code || null,
          phone_number_id: client.phone_number_id || null,
          assignedAt: client.assignedAt || null,
          updatedAt: client.updatedAt,
          isActive: client.isActive
        };

        // For WPP clients, only include if they exist in both PlatformClientAgent AND in-memory whatsappService
        if (client.platform === 'wpp') {
          const wppClient = this.whatsappService.getClient(client.clientId);
          if (wppClient) {
            // Client exists in both places - include it
            clientData.status = wppClient.status;
            clientData.isReady = wppClient.isReady;
            clientData.hasQrCode = (wppClient.isReady || wppClient.status === 'ready') ? false : !!wppClient.qrCode;
            clientData.phoneNumber = wppClient.phoneNumber || null;
            clientData.lastActivity = wppClient.lastActivity;
            // Override ai_agent_code if present in memory (should be synced, but memory is source of truth for active session)
            if (wppClient.ai_agent_code) {
              clientData.ai_agent_code = wppClient.ai_agent_code;
            }
            clients.push(clientData);
          }
          // If WPP client doesn't exist in memory, skip it (don't include in response)
        } else if (client.platform === 'wa-official') {
          // WA-Official clients - include all from PlatformClientAgent
          clientData.status = 'active';
          clientData.isReady = true; // WA-Official clients are always "ready" (no QR needed)
          clientData.hasQrCode = false;
          clientData.phoneNumber = null;
          clientData.lastActivity = client.updatedAt;
          clients.push(clientData);
        }
        // If platform is neither 'wpp' nor 'wa-official', skip it (shouldn't happen due to enum, but safety check)
      }

      // Sort by updatedAt (most recent first)
      clients.sort((a, b) => {
        const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return dateB - dateA;
      });

      res.json({
        success: true,
        clients: clients,
        count: clients.length
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
            
            // Construct webhook URL from environment variable
            const webhookHost = process.env.META_WEBHOOK_HOST;
            const webhookUrl = webhookHost ? `${webhookHost}/webhook/v1/${clientId}` : null;
            
            // Optionally include other config details (masked for security)
            clientData.configuration = {
              access_token: decryptedConfig.access_token ? `${decryptedConfig.access_token.substring(0, 20)}...` : null,
              app_secret: decryptedConfig.app_secret ? '***' : null,
              verify_token: decryptedConfig.verify_token || null,
              webhook_url: webhookUrl
            };
          } catch (error) {
            console.error(`❌ Error decrypting configuration for client ${clientId}:`, error);
            clientData.verifyToken = null;
            clientData.configurationError = 'Failed to decrypt configuration';
          }
        } else {
          clientData.verifyToken = null;
          clientData.configurationError = 'No configuration found';
          
          // Still include webhook_url even if configuration is missing
          const webhookHost = process.env.META_WEBHOOK_HOST;
          const webhookUrl = webhookHost ? `${webhookHost}/webhook/v1/${clientId}` : null;
          clientData.configuration = {
            webhook_url: webhookUrl
          };
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
   * Delete a platform client (supports both WPP and WA-Official)
   * DELETE /api/v1/platform/clients/{clientId}
   */
  async deletePlatformClient(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;

      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }

      console.log(`🗑️  Removing platform client ${clientId} permanently (deleting all data)...`);

      // Find the client in PlatformClientAgent to determine platform
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

      const platform = platformClient.platform;
      let deleted = false;

      // Handle deletion based on platform
      if (platform === 'wpp') {
        // For WPP clients, use the WPPConnect deletion logic
        // This will delete from ClientAgent, PlatformClientAgent, and all session data
        const clientExists = this.whatsappService.getClient(clientId) !== undefined;
        const disconnectSuccess = await this.whatsappService.disconnectClient(clientId, true);

        // If client wasn't in memory, try to delete session data anyway
        if (!clientExists) {
          const clientManager = (this.whatsappService as any).clientManager;
          if (clientManager) {
            const sessionDataDeleted = await clientManager['deleteAllSessionData'](clientId);
            deleted = sessionDataDeleted || disconnectSuccess;
          } else {
            deleted = disconnectSuccess;
          }
        } else {
          deleted = disconnectSuccess;
        }

        if (!deleted) {
          // Even if WPPConnect deletion failed, try to delete from PlatformClientAgent
          const result = await PlatformClientAgent.deleteOne({ clientId });
          deleted = result.deletedCount > 0;
        }
      } else if (platform === 'wa-official') {
        // For WA-Official clients, delete from PlatformClientAgent and ClientAgent
        try {
          // Delete from PlatformClientAgent
          const platformResult = await PlatformClientAgent.deleteOne({ clientId });
          if (platformResult.deletedCount > 0) {
            console.log(`✅ Deleted WA-Official client ${clientId} from PlatformClientAgent`);
            deleted = true;
          }

          // Also delete from ClientAgent for backward compatibility
          try {
            const ClientAgent = mongoose.model('ClientAgent');
            const clientAgentResult = await ClientAgent.deleteOne({ clientId });
            if (clientAgentResult.deletedCount > 0) {
              console.log(`✅ Deleted WA-Official client ${clientId} from ClientAgent (backward compatibility)`);
            }
          } catch (error) {
            console.warn(`⚠️  Error deleting WA-Official client ${clientId} from ClientAgent:`, error);
            // Continue even if ClientAgent deletion fails
          }
        } catch (error) {
          console.error(`❌ Error deleting WA-Official client ${clientId}:`, error);
          throw error;
        }
      } else {
        // Unknown platform - just delete from PlatformClientAgent
        const result = await PlatformClientAgent.deleteOne({ clientId });
        deleted = result.deletedCount > 0;
      }

      if (!deleted) {
        res.status(404).json({
          success: false,
          message: `Platform client ${clientId} not found or could not be deleted`
        });
        return;
      }

      res.json({
        success: true,
        message: `Platform client ${clientId} (${platform}) removed successfully (all data deleted permanently)`
      });
    } catch (error) {
      console.error('❌ Error deleting platform client:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to delete platform client',
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

      if (client) {
        const response: any = {
          success: true,
          clientId: client.clientId,
          platform: client.platform,
          ai_agent_code: client.ai_agent_code || null,
          assignedAt: client.assignedAt || null,
          updatedAt: client.updatedAt
        };
        
        // Include privateAgentAssignment if it exists
        if (client.privateAgentAssignment && client.privateAgentAssignment.length > 0) {
          response.privateAgentAssignment = client.privateAgentAssignment;
        }
        
        res.json(response);
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
   * Get all agents for a platform client (agentCode and privateAgentAssignment)
   * GET /api/v1/platform/clients/{clientId}/agents
   */
  async getClientAgents(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;

      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }

      // Query with lean() to get raw MongoDB data including privateAgentAssignment
      const client = await PlatformClientAgent.findOne({
        clientId,
        isActive: true
      }).lean();

      if (!client) {
        // If not found in PlatformClientAgent, try ClientAgent for backward compatibility
        const clientAgent = await ClientAgent.findOne({
          clientId,
          isActive: true
        }).lean();

        if (!clientAgent) {
          res.status(404).json({
            success: false,
            message: `Client ${clientId} not found`
          });
          return;
        }

        // Return from ClientAgent (legacy, no privateAgentAssignment support)
        res.json({
          success: true,
          agents: {
            agentCode: clientAgent.ai_agent_code || null,
            privateAgentAssignment: []
          }
        });
        return;
      }

      // Return from PlatformClientAgent
      res.json({
        success: true,
        agents: {
          agentCode: (client as any).ai_agent_code || null,
          privateAgentAssignment: (client as any).privateAgentAssignment || []
        }
      });
    } catch (error) {
      console.error('❌ Error getting client agents:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get client agents',
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
      const { agentCode, privateAgentAssignment } = req.body;

      // Validate input
      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }

      // Either agentCode or privateAgentAssignment must be provided
      if (!agentCode && !privateAgentAssignment) {
        res.status(400).json({
          success: false,
          message: 'Either agentCode or privateAgentAssignment is required'
        });
        return;
      }

      // Validate privateAgentAssignment format if provided
      if (privateAgentAssignment) {
        if (!Array.isArray(privateAgentAssignment)) {
          res.status(400).json({
            success: false,
            message: 'privateAgentAssignment must be an array'
          });
          return;
        }
        for (const assignment of privateAgentAssignment) {
          if (!assignment.userIdentifier || !assignment.agentCode) {
            res.status(400).json({
              success: false,
              message: 'Each privateAgentAssignment must have userIdentifier and agentCode'
            });
            return;
          }
        }
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
          // Build update object
          const updateData: any = {
            updatedAt: new Date()
          };

          // Update agentCode if provided
          if (agentCode) {
            updateData.ai_agent_code = agentCode;
            updateData.assignedAt = new Date();
          }
          
          // Handle privateAgentAssignment if provided
          if (privateAgentAssignment) {
            // IMPORTANT: Query the document with lean() to get the raw MongoDB data including privateAgentAssignment
            // This ensures we get the field even if it's not in the Mongoose schema
            const existingDoc = await PlatformClientAgent.findOne({ clientId, isActive: true }).lean();
            const existingAssignments = (existingDoc?.privateAgentAssignment as IPrivateAgentAssignment[]) || [];
            
            console.log(`📋 Existing privateAgentAssignment from DB (${existingAssignments.length} items):`, JSON.stringify(existingAssignments, null, 2));
            console.log(`📥 New assignments to upsert (${privateAgentAssignment.length} items):`, JSON.stringify(privateAgentAssignment, null, 2));
            
            // Always use upsert logic - start with existing assignments
            const finalAssignments = [...existingAssignments];
            
            for (const newAssignment of privateAgentAssignment) {
              const existingIndex = finalAssignments.findIndex(
                (a: IPrivateAgentAssignment) => a.userIdentifier === newAssignment.userIdentifier
              );
              if (existingIndex >= 0) {
                // Update existing assignment - preserve other existing items
                finalAssignments[existingIndex] = newAssignment;
                console.log(`✅ Updated existing assignment for userIdentifier ${newAssignment.userIdentifier} to agentCode ${newAssignment.agentCode}`);
              } else {
                // Add new assignment - preserve all existing items
                finalAssignments.push(newAssignment);
                console.log(`✅ Added new assignment for userIdentifier ${newAssignment.userIdentifier} with agentCode ${newAssignment.agentCode}`);
              }
            }
            
            console.log(`💾 Final privateAgentAssignment after upsert (${finalAssignments.length} items, all existing preserved):`, JSON.stringify(finalAssignments, null, 2));
            updateData.privateAgentAssignment = finalAssignments;
          }

          // Log what we're about to save
          if (privateAgentAssignment) {
            console.log(`💾 About to save privateAgentAssignment for ${clientId}:`, JSON.stringify(updateData.privateAgentAssignment, null, 2));
            console.log(`📦 Full updateData:`, JSON.stringify(updateData, null, 2));
          }

          // Use findOneAndUpdate to ensure the update is saved
          // Use strict: false in options to allow fields not in schema
          const savedClient = await PlatformClientAgent.findOneAndUpdate(
            { clientId, isActive: true },
            { $set: updateData },
            { new: true, runValidators: false, strict: false }
          );

          // Verify the save - query directly using lean to get raw MongoDB document
          if (privateAgentAssignment) {
            const verifyClient = await PlatformClientAgent.findOne({ clientId, isActive: true }).lean();
            console.log(`✅ Query result after save (lean):`, JSON.stringify(verifyClient, null, 2));
            console.log(`🔍 privateAgentAssignment field:`, verifyClient?.privateAgentAssignment);
            console.log(`📋 All document keys:`, Object.keys(verifyClient || {}));
            
            // Also try a raw MongoDB query to double-check what's actually in the database
            const db = mongoose.connection.db;
            if (db) {
              const rawDoc = await db.collection('platformclientagents').findOne({ clientId, isActive: true });
              console.log(`🔬 Raw MongoDB document (bypassing Mongoose):`, JSON.stringify(rawDoc, null, 2));
              if (rawDoc && rawDoc.privateAgentAssignment) {
                console.log(`✅ CONFIRMED: privateAgentAssignment exists in MongoDB!`);
              } else {
                console.log(`❌ WARNING: privateAgentAssignment NOT found in raw MongoDB document!`);
              }
            }
          }

          foundIn = 'PlatformClientAgent';
          updated = true;
          if (agentCode) {
            console.log(`✅ Assigned agent ${agentCode} to platform client ${clientId} (${savedClient?.platform || 'unknown'}) in PlatformClientAgent`);
          }

          // Also update ClientAgent collection for backward compatibility if it exists (only if agentCode is provided)
          if (agentCode) {
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
        }
      } catch (platformError) {
        console.error('❌ Error updating PlatformClientAgent:', platformError);
      }

      // If not found in PlatformClientAgent, try ClientAgent (WPPConnect clients)
      // Note: privateAgentAssignment only applies to PlatformClientAgent, so we only update ClientAgent if agentCode is provided
      if (!updated && agentCode) {
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
        // If only privateAgentAssignment was provided and client not found, return specific error
        if (privateAgentAssignment && !agentCode) {
          res.status(404).json({
            success: false,
            message: `Client ${clientId} not found in PlatformClientAgent collection. privateAgentAssignment can only be set for clients in PlatformClientAgent. Please create the client first.`
          });
        } else {
          res.status(404).json({
            success: false,
            message: `Client ${clientId} not found in ClientAgent or PlatformClientAgent collections. Please create the client first.`
          });
        }
        return;
      }

      // Build response message
      let message = 'Agent assignment updated successfully';
      if (agentCode && privateAgentAssignment) {
        message = 'Agent code and private agent assignments updated successfully';
      } else if (privateAgentAssignment) {
        message = 'Private agent assignments updated successfully';
      }

      // Success response (matching the format of PUT /api/whatsapp/clients/{clientId}/agent)
      res.json({
        success: true,
        message: message
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

  /**
   * Remove main agent assignment from a platform client
   * DELETE /api/v1/platform/clients/{clientId}/agent
   */
  async removeAgentFromClient(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;

      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }

      let updated = false;

      // Try to remove from PlatformClientAgent first
      try {
        const platformClient = await PlatformClientAgent.findOneAndUpdate(
          { clientId, isActive: true },
          { 
            $unset: { ai_agent_code: '', assignedAt: '' },
            $set: { updatedAt: new Date() }
          },
          { new: true }
        );

        if (platformClient) {
          updated = true;
          console.log(`✅ Removed main agent assignment from platform client ${clientId} in PlatformClientAgent`);

          // Also update ClientAgent collection for backward compatibility
          try {
            const existingClientAgent = await ClientAgent.findOne({ clientId });
            if (existingClientAgent) {
              existingClientAgent.ai_agent_code = undefined as any;
              existingClientAgent.assignedAt = undefined as any;
              existingClientAgent.updatedAt = new Date();
              await existingClientAgent.save();
              console.log(`✅ Also removed agent assignment from ClientAgent collection for backward compatibility`);
            }
          } catch (clientAgentError) {
            console.warn('⚠️ Could not update ClientAgent collection:', clientAgentError);
          }
        }
      } catch (platformError) {
        console.error('❌ Error removing agent from PlatformClientAgent:', platformError);
      }

      // If not found in PlatformClientAgent, try ClientAgent
      if (!updated) {
        try {
          const clientAgent = await ClientAgent.findOneAndUpdate(
            { clientId, isActive: true },
            { 
              $unset: { ai_agent_code: '', assignedAt: '' },
              $set: { updatedAt: new Date() }
            },
            { new: true }
          );

          if (clientAgent) {
            updated = true;
            console.log(`✅ Removed agent assignment from client ${clientId} in ClientAgent`);
          }
        } catch (clientAgentError) {
          console.error('❌ Error removing agent from ClientAgent:', clientAgentError);
        }
      }

      // If client was not found in either collection
      if (!updated) {
        res.status(404).json({
          success: false,
          message: `Client ${clientId} not found in ClientAgent or PlatformClientAgent collections.`
        });
        return;
      }

      res.json({
        success: true,
        message: 'Agent assignment removed successfully'
      });
    } catch (error) {
      console.error('❌ Error removing agent from client:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to remove agent assignment',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Remove private agent assignment for a specific user
   * DELETE /api/v1/platform/clients/{clientId}/agent/{userIdentifier}
   */
  async removePrivateAgentAssignment(req: Request, res: Response): Promise<void> {
    try {
      const { clientId, userIdentifier } = req.params;

      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }

      if (!userIdentifier) {
        res.status(400).json({
          success: false,
          message: 'userIdentifier is required'
        });
        return;
      }

      // Query with lean() to get raw MongoDB data including privateAgentAssignment
      const existingDoc = await PlatformClientAgent.findOne({ clientId, isActive: true }).lean();
      
      if (!existingDoc) {
        res.status(404).json({
          success: false,
          message: `Client ${clientId} not found in PlatformClientAgent collection.`
        });
        return;
      }

      const existingAssignments = (existingDoc.privateAgentAssignment as IPrivateAgentAssignment[]) || [];
      
      // Check if userIdentifier exists in privateAgentAssignment
      const assignmentIndex = existingAssignments.findIndex(
        (a: IPrivateAgentAssignment) => a.userIdentifier === userIdentifier
      );

      if (assignmentIndex === -1) {
        res.status(404).json({
          success: false,
          message: `Private agent assignment for userIdentifier ${userIdentifier} not found for client ${clientId}`
        });
        return;
      }

      // Remove the assignment from the array
      const updatedAssignments = existingAssignments.filter(
        (a: IPrivateAgentAssignment) => a.userIdentifier !== userIdentifier
      );

      // Update the document
      const updatedClient = await PlatformClientAgent.findOneAndUpdate(
        { clientId, isActive: true },
        { 
          $set: { 
            privateAgentAssignment: updatedAssignments,
            updatedAt: new Date()
          }
        },
        { new: true, runValidators: false, strict: false }
      );

      if (!updatedClient) {
        res.status(404).json({
          success: false,
          message: `Failed to update client ${clientId}`
        });
        return;
      }

      console.log(`✅ Removed private agent assignment for userIdentifier ${userIdentifier} from client ${clientId}`);
      console.log(`💾 Remaining privateAgentAssignment count: ${updatedAssignments.length}`);

      res.json({
        success: true,
        message: `Private agent assignment for userIdentifier ${userIdentifier} removed successfully`,
        remainingAssignments: updatedAssignments.length
      });
    } catch (error) {
      console.error('❌ Error removing private agent assignment:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to remove private agent assignment',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get all need attention users for a client
   * GET /api/v1/platform/clients/{clientId}/needattention
   */
  async getNeedAttention(req: Request, res: Response): Promise<void> {
    try {
      const { clientId } = req.params;

      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }

      // Query with lean() to get raw MongoDB data including needAttention
      const client = await PlatformClientAgent.findOne({
        clientId,
        isActive: true
      }).lean();

      if (!client) {
        res.status(404).json({
          success: false,
          message: `Client ${clientId} not found in PlatformClientAgent collection.`
        });
        return;
      }

      const needAttentionList = (client.needAttention as INeedAttention[]) || [];

      // Format response - only include userIdentifier (number), option, and reason
      const formattedList = needAttentionList.map(item => ({
        userIdentifier: item.userIdentifier,
        option: item.option,
        reason: item.reason || null,
        from: item.from || null,
        to: item.to || null,
        updatedAt: item.updatedAt || null,
        taken: item.taken || null
      }));

      res.json({
        success: true,
        needAttention: formattedList,
        count: formattedList.length
      });
    } catch (error) {
      console.error('❌ Error getting need attention list:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get need attention list',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Set need attention status for a user
   * POST /api/v1/platform/clients/{clientId}/needattention/{userIdentifier}
   */
  async setNeedAttention(req: Request, res: Response): Promise<void> {
    try {
      const { clientId, userIdentifier: identifierParam } = req.params;
      const { option, from, to, reason } = req.body;

      if (!clientId) {
        res.status(400).json({
          success: false,
          message: 'clientId is required'
        });
        return;
      }

      if (!identifierParam) {
        res.status(400).json({
          success: false,
          message: 'userIdentifier or conversationId (hashedId) is required'
        });
        return;
      }

      if (!option) {
        res.status(400).json({
          success: false,
          message: 'option is required (pause, release, block, or taken)'
        });
        return;
      }

      if (!['pause', 'release', 'block', 'taken'].includes(option)) {
        res.status(400).json({
          success: false,
          message: 'option must be one of: pause, release, block, taken'
        });
        return;
      }

      // Resolve identifier - check if it's a hashedId or userIdentifier
      let userIdentifier: string = identifierParam;
      let actualClientId = clientId;
      
      // Check if identifier looks like a hashedId (base64 encoded, ~44 chars)
      // HashedId is base64, userIdentifier is typically a phone number
      const looksLikeHashId = /^[A-Za-z0-9+\/]{40,}={0,2}$/.test(identifierParam);
      
      if (looksLikeHashId && this.weaviateService) {
        // Try to find conversation by hashedId
        const jwtUser = (req as any).user || {};
        const agentCode = jwtUser.agentCode;
        
        if (agentCode) {
          try {
            const conversation = await this.weaviateService.getConversationById(
              identifierParam,
              agentCode
            );
            
            if (conversation) {
              // Extract from conversation_id format: "clientId:userIdentifier"
              const parts = conversation.conversation_id.split(':');
              if (parts.length === 2 && parts[0] && parts[1]) {
                actualClientId = parts[0];
                userIdentifier = parts[1];
                
                // Verify route clientId matches conversation clientId (if provided in route)
                if (clientId && clientId !== actualClientId) {
                  res.status(400).json({
                    success: false,
                    message: `Client ID mismatch: conversation belongs to '${actualClientId}', not '${clientId}'. Use /api/v1/platform/clients/${actualClientId}/needattention/${identifierParam}`
                  });
                  return;
                }
                
                console.log(`🔍 Resolved hashedId ${identifierParam} to clientId: ${actualClientId}, userIdentifier: ${userIdentifier}`);
              }
            }
          } catch (error) {
            console.warn('⚠️ Error querying Weaviate for hashedId, treating as userIdentifier:', error);
            // Fall through to use identifierParam as userIdentifier
          }
        }
      }

      // Query with lean() to get raw MongoDB data including needAttention
      const existingDoc = await PlatformClientAgent.findOne({ clientId: actualClientId, isActive: true }).lean();
      
      if (!existingDoc) {
        res.status(404).json({
          success: false,
          message: `Client ${actualClientId} not found in PlatformClientAgent collection.`
        });
        return;
      }

      const existingNeedAttention = (existingDoc.needAttention as INeedAttention[]) || [];
      const existingHistory = (existingDoc.needAttentionHistory as any[]) || [];
      let updatedNeedAttention: INeedAttention[];
      let previousOption: string | undefined;

      // Extract sender information from JWT for history tracking
      const jwtUser = (req as any).user || {};
      const sender = jwtUser.sender || {};

      if (option === 'release') {
        // Find the previous option before release
        const existingItem = existingNeedAttention.find(
          (item: INeedAttention) => item.userIdentifier === userIdentifier
        );
        previousOption = existingItem?.option;

        // Remove the user from needAttention array
        updatedNeedAttention = existingNeedAttention.filter(
          (item: INeedAttention) => item.userIdentifier !== userIdentifier
        );
        console.log(`✅ Released user ${userIdentifier} from needAttention for client ${actualClientId}`);
      } else {
        // Upsert: update if exists, add if not
        const existingIndex = existingNeedAttention.findIndex(
          (item: INeedAttention) => item.userIdentifier === userIdentifier
        );

        // Get previous option if updating existing entry
        if (existingIndex >= 0 && existingNeedAttention[existingIndex]) {
          previousOption = existingNeedAttention[existingIndex].option;
        }

        const needAttentionItem: INeedAttention = {
          userIdentifier,
          option: option as 'pause' | 'block' | 'taken',
          updatedAt: new Date()
        };

        // Add optional fields if provided
        if (from) {
          needAttentionItem.from = new Date(from);
        }
        if (to) {
          needAttentionItem.to = new Date(to);
        }
        if (reason) {
          needAttentionItem.reason = reason;
        }

        // Extract sender information from JWT for 'taken' option
        if (option === 'taken') {
          if (!sender.senderId && !sender.id) {
            res.status(400).json({
              success: false,
              message: 'sender information is required in JWT for "taken" option'
            });
            return;
          }
          
          needAttentionItem.taken = {
            by: {
              id: sender.senderId || sender.id || '',
              name: sender.senderDisplayName || sender.displayName || '',
              role: sender.senderRoleLabel || sender.roleLabel || 'agent',
              avatarUrl: sender.senderAvatarUrl || sender.avatarUrl || null
            }
          };
        }

        if (existingIndex >= 0) {
          // Update existing entry
          existingNeedAttention[existingIndex] = needAttentionItem;
          updatedNeedAttention = existingNeedAttention;
          console.log(`✅ Updated needAttention for userIdentifier ${userIdentifier} to option ${option}`);
        } else {
          // Add new entry
          existingNeedAttention.push(needAttentionItem);
          updatedNeedAttention = existingNeedAttention;
          console.log(`✅ Added needAttention for userIdentifier ${userIdentifier} with option ${option}`);
        }
      }

      // Create history entry
      const historyEntry: any = {
        userIdentifier,
        option: option as 'pause' | 'release' | 'block' | 'taken',
        changedAt: new Date()
      };

      if (previousOption) {
        historyEntry.previousOption = previousOption;
      }

      // Add optional fields to history
      if (from) {
        historyEntry.from = new Date(from);
      }
      if (to) {
        historyEntry.to = new Date(to);
      }
      if (reason) {
        historyEntry.reason = reason;
      }

      // Add changedBy if sender info is available
      if (sender.senderId || sender.id) {
        historyEntry.changedBy = {
          id: sender.senderId || sender.id || '',
          name: sender.senderDisplayName || sender.displayName || '',
          role: sender.senderRoleLabel || sender.roleLabel || 'agent',
          avatarUrl: sender.senderAvatarUrl || sender.avatarUrl || null
        };
      }

      // Add taken info to history if present
      const updatedItem = updatedNeedAttention.find(item => item.userIdentifier === userIdentifier);
      if (updatedItem?.taken) {
        historyEntry.taken = updatedItem.taken;
      }

      // Add history entry to array
      const updatedHistory = [...existingHistory, historyEntry];

      // Update the document
      const updatedClient = await PlatformClientAgent.findOneAndUpdate(
        { clientId: actualClientId, isActive: true },
        { 
          $set: { 
            needAttention: updatedNeedAttention,
            needAttentionHistory: updatedHistory,
            updatedAt: new Date()
          }
        },
        { new: true, runValidators: false, strict: false }
      );

      if (!updatedClient) {
        res.status(404).json({
          success: false,
          message: `Failed to update client ${actualClientId}`
        });
        return;
      }

      // Publish needattention:changed event to stream
      try {
        const producer = new StreamProducer();
        await producer.connect();

        // Get agentCode from JWT or from existingDoc
        const jwtUser = (req as any).user || {};
        const agentCode = jwtUser.agentCode || existingDoc.ai_agent_code;
        
        if (agentCode) {
          // Get the needAttention item that was updated (for taken object if option === 'taken')
          const updatedItem = option === 'release' 
            ? null 
            : updatedNeedAttention.find((item: INeedAttention) => item.userIdentifier === userIdentifier);

          const attentionData: any = {
            clientId: actualClientId,
            platform: existingDoc.platform || 'wpp',
            userIdentifier,
            agentCode,
            option: option === 'release' ? null : option, // null means released
            reason: updatedItem?.reason || reason || null,
            from: updatedItem?.from ? updatedItem.from.toISOString() : (from || null),
            to: updatedItem?.to ? updatedItem.to.toISOString() : (to || null),
            taken: updatedItem?.taken || null
          };

          await producer.publishNeedAttentionChanged(attentionData);
          console.log(`✅ Published needattention:changed event to stream for ${userIdentifier}`);
        } else {
          console.warn(`⚠️  Cannot publish needattention:changed event: agentCode not found (clientId: ${actualClientId})`);
        }
      } catch (streamError) {
        // Log error but don't fail API response (MongoDB update succeeded)
        console.error('❌ Error publishing needattention:changed event to stream:', streamError);
      }

      const responseMessage = option === 'release' 
        ? `User ${userIdentifier} released from needAttention successfully`
        : `Need attention status for user ${userIdentifier} updated successfully (option: ${option})`;

      const responseData: any = {
        success: true,
        message: responseMessage
      };

      // Only include needAttention in response if it's not release (since release removes it)
      if (option !== 'release') {
        responseData.needAttention = updatedNeedAttention.find(item => item.userIdentifier === userIdentifier) || null;
      }

      res.json(responseData);
    } catch (error) {
      console.error('❌ Error setting need attention:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to set need attention status',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Broadcast messages to multiple users via Mastra workflow
   * POST /api/v1/platform/wpp/chat/messages/broadcast
   * 
   * - Validates clientId belongs to agentCode from JWT
   * - Creates signed JWT for Mastra workflow API
   * - Calls Mastra workflow endpoint with broadcast data
   */
  async broadcastMessages(req: Request, res: Response): Promise<void> {
    try {
      const { batch, client, targets, startIn, startAt } = req.body;

      // Validate request body
      if (!batch || !client || !client.clientId || !targets || !Array.isArray(targets) || targets.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid request body. Required: batch, client.clientId, and targets array'
        });
        return;
      }

      // Validate scheduling parameters (startIn OR startAt, not both)
      if (startIn && startAt) {
        res.status(400).json({
          success: false,
          error: 'Cannot specify both startIn and startAt. Please use only one.'
        });
        return;
      }

      // Validate startIn format if provided
      if (startIn) {
        const startInRegex = /^(\d+)([smhd])$/i;
        if (!startInRegex.test(startIn)) {
          res.status(400).json({
            success: false,
            error: 'Invalid startIn format. Expected format: "1s", "5m", "2h", "3d" (seconds, minutes, hours, days)'
          });
          return;
        }
      }

      // Validate startAt format and ensure it's in the future if provided
      if (startAt) {
        const startAtDate = new Date(startAt);
        if (isNaN(startAtDate.getTime())) {
          res.status(400).json({
            success: false,
            error: 'Invalid startAt format. Expected ISO 8601 format (e.g., "2026-01-28T20:00:00+07:00")'
          });
          return;
        }

        const now = new Date();
        if (startAtDate <= now) {
          res.status(400).json({
            success: false,
            error: 'startAt must be a future time'
          });
          return;
        }
      }

      // Extract data from JWT token
      const jwtUser = (req as any).user;
      if (!jwtUser) {
        res.status(401).json({
          success: false,
          error: 'JWT token is required'
        });
        return;
      }

      const agentCode = jwtUser.agentCode;
      const sender = jwtUser.sender;
      const jwtClientId = jwtUser.clientId;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token'
        });
        return;
      }

      if (!sender || !sender.senderId) {
        res.status(400).json({
          success: false,
          error: 'sender.senderId is required in JWT token'
        });
        return;
      }

      // Validate that the clientId from request belongs to the agentCode from JWT
      const platformClient = await PlatformClientAgent.findOne({
        clientId: client.clientId,
        ai_agent_code: agentCode,
        isActive: true
      }).lean();

      if (!platformClient) {
        res.status(403).json({
          success: false,
          error: `Client ${client.clientId} does not belong to agent ${agentCode} or is not active`
        });
        return;
      }

      // Get platform from PlatformClientAgent
      const platform = platformClient.platform || 'wpp';

      // Validate JWT_SECRET is available
      const jwtSecret = this.env.JWT_SECRET;
      if (!jwtSecret) {
        res.status(500).json({
          success: false,
          error: 'JWT_SECRET environment variable is not set'
        });
        return;
      }

      // Validate MASTRA_ENDPOINT_WORKFLOW is available
      const mastraEndpoint = this.env.MASTRA_ENDPOINT_WORKFLOW;
      if (!mastraEndpoint) {
        res.status(500).json({
          success: false,
          error: 'MASTRA_ENDPOINT_WORKFLOW environment variable is not set'
        });
        return;
      }

      // Create signed JWT token for Mastra workflow API
      const now = Math.floor(Date.now() / 1000);
      const jwtPayload = {
        identifier: sender.senderId,
        role: 'authenticated',
        agent_metadata: {
          agent_code: agentCode,
          status: 'active'
        },
        client_metadata: {
          client_id: jwtClientId,
          client_name: 'WhatsApp Bot',
          app_metadata: {
            provider: 'wa'
          }
        },
        user_metadata: sender,
        iat: now,
        exp: now + 3600 // 1 hour expiration
      };

      const authToken = jwt.sign(jwtPayload, jwtSecret, { algorithm: 'HS256' });

      // Prepare request body for Mastra workflow
      const requestBody: any = {
        inputData: {
          batch: batch,
          client: {
            platform: platform,
            clientId: client.clientId,
            agentCode: agentCode,
            sender: sender
          },
          targets: targets
        }
      };

      // Add scheduling parameters if provided
      if (startIn) {
        requestBody.inputData.startIn = startIn;
      }
      if (startAt) {
        requestBody.inputData.startAt = startAt;
      }

      // Call Mastra workflow endpoint
      const workflowUrl = `${mastraEndpoint}/api/workflows/batchedBroadcastWorkflow/start-async`;
      
      console.log(`📤 [Broadcast] Calling Mastra workflow: ${workflowUrl}`);
      console.log(`📤 [Broadcast] Client: ${client.clientId}, Agent: ${agentCode}, Targets: ${targets.length}`);

      const response = await axios.post(workflowUrl, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        timeout: 30000 // 30 seconds timeout
      });

      console.log(`✅ [Broadcast] Mastra workflow responded: ${response.status}`);

      // Extract result from workflow response
      const workflowResult = response.data?.result || response.data;

      res.json({
        success: true,
        data: {
          ...workflowResult,
          clientId: client.clientId,
          agentCode: agentCode,
          targetsCount: targets.length
        }
      });
    } catch (error: any) {
      console.error('❌ Error broadcasting messages:', error);
      
      if (error.response) {
        // Axios error with response
        res.status(error.response.status || 500).json({
          success: false,
          error: error.response.data?.error || error.response.data?.message || error.message || 'Failed to broadcast messages',
          details: error.response.data
        });
      } else {
        // Other errors
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to broadcast messages'
        });
      }
    }
  }
}

