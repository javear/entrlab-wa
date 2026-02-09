import { WPPConnectClientManager, WPPConnectClientInfo, WPPConnectClientManagerConfig } from './client-manager';
import { Environment } from '../types';
import mongoose, { Document, Schema } from 'mongoose';

// ============================================
// WPPConnect WhatsApp Service
// ============================================

// Client-Agent Assignment Model (reuse existing)
interface IClientAgent extends Document {
  clientId: string;
  ai_agent_code: string;
  platform?: 'wpp' | 'wa-official';
  phone_number_id?: string; // Plain phone_number_id for wa-official clients (for easy querying)
  configuration?: string; // Encrypted configuration
  assignedAt: Date;
  updatedAt: Date;
  isActive: boolean;
}

// Create model with error handling to avoid overwrite issues
let ClientAgent: mongoose.Model<IClientAgent>;
try {
  ClientAgent = mongoose.model<IClientAgent>('ClientAgent');
} catch (error) {
  const ClientAgentSchema = new Schema<IClientAgent>({
    clientId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    ai_agent_code: {
      type: String,
      required: false, // Made optional for wa-official clients that may not have agent assigned at creation
      index: true
    },
    platform: {
      type: String,
      enum: ['wpp', 'wa-official'],
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

  // Update the updatedAt field before saving
  ClientAgentSchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
  });

  // Create indexes for better performance
  ClientAgentSchema.index({ clientId: 1, isActive: 1 });
  ClientAgentSchema.index({ ai_agent_code: 1, isActive: 1 });
  ClientAgentSchema.index({ phone_number_id: 1, platform: 1, isActive: 1 }); // Index for querying by phone_number_id

  ClientAgent = mongoose.model<IClientAgent>('ClientAgent', ClientAgentSchema);
}

// Platform Client-Agent Assignment Model (for clients created via /api/v1/platform/clients)
interface IPlatformClientAgent extends Document {
  clientId: string;
  platform: 'wpp' | 'wa-official';
  ai_agent_code?: string;
  phone_number_id?: string;
  configuration?: string;
  assignedAt?: Date;
  updatedAt?: Date;
  isActive: boolean;
}

// Create PlatformClientAgent model with error handling
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
      type: String,
      index: true
    },
    configuration: {
      type: String
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
  PlatformClientAgentSchema.index({ phone_number_id: 1, platform: 1, isActive: 1 });

  PlatformClientAgent = mongoose.model<IPlatformClientAgent>('PlatformClientAgent', PlatformClientAgentSchema);
}

export class WPPConnectWhatsAppService {
  public clientManager: WPPConnectClientManager;
  private messageHandlers: ((clientId: string, message: any) => Promise<void>)[] = [];

  constructor(config: WPPConnectClientManagerConfig) {
    this.clientManager = new WPPConnectClientManager(config);
  }

  public async initialize(): Promise<void> {
    console.log('🔗 Initializing WPPConnect WhatsApp Service...');
    await this.clientManager.initialize();
    console.log('✅ WPPConnect WhatsApp service initialized');
  }

  public async createClient(clientId: string): Promise<WPPConnectClientInfo> {
    return await this.clientManager.createClient(clientId);
  }

  public async sendMessage(clientId: string, number: string, message: string): Promise<boolean> {
    return await this.clientManager.sendMessage(clientId, number, message);
  }

  public async disconnectClient(clientId: string, deletePermanently: boolean = false): Promise<boolean> {
    return await this.clientManager.disconnectClient(clientId, deletePermanently);
  }

  public async forceCleanupSession(clientId: string): Promise<boolean> {
    return await this.clientManager.forceCleanupSession(clientId);
  }

  public getClient(clientId: string): WPPConnectClientInfo | undefined {
    return this.clientManager.getClient(clientId);
  }

  public getAllClients(): WPPConnectClientInfo[] {
    return this.clientManager.getAllClients();
  }

  public addMessageHandler(handler: (clientId: string, message: any) => Promise<void>): void {
    this.messageHandlers.push(handler);
    this.clientManager.addMessageHandler(handler);
  }

  public addReadReceiptHandler(handler: (clientId: string, userIdentifier: string, readAt: string) => Promise<void>): void {
    this.clientManager.addReadReceiptHandler(handler);
  }

  // Session Management
  async restoreExistingSessions(): Promise<void> {
    return await this.clientManager.restoreExistingSessions();
  }

  // Health and Status
  isHealthy(): boolean {
    return this.clientManager.isHealthy();
  }

  getHealthStatus(): any {
    return this.clientManager.getHealthStatus();
  }

  // Client-Agent Assignment Management
  async assignAgentToClient(clientId: string, agentCode: string): Promise<boolean> {
    try {
      await ClientAgent.findOneAndUpdate(
        { clientId },
        {
          clientId,
          ai_agent_code: agentCode,
          assignedAt: new Date(),
          updatedAt: new Date(),
          isActive: true
        },
        { upsert: true, new: true }
      );
      
      // Also set it directly on the client object for immediate use (matching main branch)
      const clientInfo = this.clientManager.getClient(clientId);
      if (clientInfo) {
        clientInfo.ai_agent_code = agentCode;
        console.log(`✅ Assigned agent ${agentCode} to WPPConnect client ${clientId} (set on client object)`);
      } else {
        console.log(`✅ Assigned agent ${agentCode} to WPPConnect client ${clientId} (saved to DB, client not active)`);
      }
      
      return true;
    } catch (error) {
      console.error(`❌ Error assigning agent to WPPConnect client ${clientId}:`, error);
      return false;
    }
  }

  async removeAgentFromClient(clientId: string): Promise<boolean> {
    try {
      await ClientAgent.findOneAndUpdate(
        { clientId },
        { isActive: false, updatedAt: new Date() }
      );
      
      // Also remove it from the client object (matching main branch)
      const clientInfo = this.clientManager.getClient(clientId);
      if (clientInfo) {
        delete clientInfo.ai_agent_code;
        console.log(`✅ Removed agent assignment from WPPConnect client ${clientId} (removed from client object)`);
      } else {
        console.log(`✅ Removed agent assignment from WPPConnect client ${clientId} (removed from DB, client not active)`);
      }
      
      return true;
    } catch (error) {
      console.error(`❌ Error removing agent from WPPConnect client ${clientId}:`, error);
      return false;
    }
  }

  async getClientAgent(clientId: string): Promise<string | null> {
    try {
      // First, try to find in ClientAgent (for backward compatibility with existing clients)
      let assignment = await ClientAgent.findOne({ clientId, isActive: true });
      if (assignment && assignment.ai_agent_code) {
        return assignment.ai_agent_code;
      }

      // If not found, try PlatformClientAgent (for clients created via /api/v1/platform/clients)
      const platformAssignment = await PlatformClientAgent.findOne({ 
        clientId, 
        platform: 'wpp',
        isActive: true 
      });
      if (platformAssignment && platformAssignment.ai_agent_code) {
        console.log(`✅ Found agent for WPP client ${clientId} in PlatformClientAgent: ${platformAssignment.ai_agent_code}`);
        return platformAssignment.ai_agent_code;
      }

      return null;
    } catch (error) {
      console.error(`❌ Error getting agent for WPPConnect client ${clientId}:`, error);
      return null;
    }
  }

  /**
   * Get agent code for a specific user, checking privateAgentAssignment first
   * @param clientId - The client ID
   * @param userIdentifier - The user identifier (phone number for WPP, display_phone_number for WA-Official)
   * @param platform - The platform ('wpp' or 'wa-official')
   * @returns The agent code for this user, or null if not found
   */
  async getAgentForUser(clientId: string, userIdentifier: string, platform: 'wpp' | 'wa-official' = 'wpp'): Promise<string | null> {
    try {
      // Query PlatformClientAgent with lean() to get privateAgentAssignment
      const platformClient = await PlatformClientAgent.findOne({
        clientId,
        platform,
        isActive: true
      }).lean();

      if (platformClient) {
        // Check privateAgentAssignment first
        const privateAssignments = (platformClient as any).privateAgentAssignment || [];
        if (privateAssignments.length > 0) {
          const privateAssignment = privateAssignments.find(
            (assignment: any) => assignment.userIdentifier === userIdentifier
          );
          
          if (privateAssignment && privateAssignment.agentCode) {
            console.log(`✅ Found private agent assignment for user ${userIdentifier} (client: ${clientId}): ${privateAssignment.agentCode}`);
            return privateAssignment.agentCode;
          }
        }

        // Fallback to main agent code
        if ((platformClient as any).ai_agent_code) {
          return (platformClient as any).ai_agent_code;
        }
      }

      // If not found in PlatformClientAgent, try ClientAgent (for backward compatibility)
      const clientAgent = await ClientAgent.findOne({
        clientId,
        isActive: true
      });

      if (clientAgent && clientAgent.ai_agent_code) {
        return clientAgent.ai_agent_code;
      }

      return null;
    } catch (error) {
      console.error(`❌ Error getting agent for user ${userIdentifier} (client ${clientId}):`, error);
      return null;
    }
  }

  async getAllAgentAssignments(): Promise<any[]> {
    try {
      const assignments = await ClientAgent.find({ isActive: true });
      return assignments.map(assignment => ({
        clientId: assignment.clientId,
        ai_agent_code: assignment.ai_agent_code,
        assignedAt: assignment.assignedAt,
        updatedAt: assignment.updatedAt
      }));
    } catch (error) {
      console.error('❌ Error getting all agent assignments:', error);
      return [];
    }
  }

  async loadAgentAssignments(): Promise<void> {
    try {
      let totalLoaded = 0;

      // Load from ClientAgent (for backward compatibility)
      if (ClientAgent) {
      const assignments = await ClientAgent.find({ isActive: true });
        console.log(`📋 Loaded ${assignments.length} agent assignment(s) from ClientAgent collection`);

      for (const assignment of assignments) {
        const clientInfo = this.clientManager.getClient(assignment.clientId);
          if (clientInfo && assignment.ai_agent_code) {
          // Set the ai_agent_code on the client object (matching main branch behavior)
          clientInfo.ai_agent_code = assignment.ai_agent_code;
          console.log(`🤖 Loaded agent assignment for WPPConnect client ${assignment.clientId}: ${assignment.ai_agent_code}`);
            totalLoaded++;
          } else if (!clientInfo) {
            console.log(`⚠️ WPPConnect client ${assignment.clientId} not found in active clients`);
          }
        }
        } else {
        console.warn('⚠️ ClientAgent model not found');
      }

      // Also load from PlatformClientAgent (for clients created via /api/v1/platform/clients)
      if (PlatformClientAgent) {
        const platformAssignments = await PlatformClientAgent.find({ 
          platform: 'wpp', 
          isActive: true,
          ai_agent_code: { $exists: true, $ne: null }
        });
        console.log(`📋 Loaded ${platformAssignments.length} agent assignment(s) from PlatformClientAgent collection (WPP)`);

        for (const assignment of platformAssignments) {
          const clientInfo = this.clientManager.getClient(assignment.clientId);
          if (clientInfo && assignment.ai_agent_code) {
            // Set the ai_agent_code on the client object (override if exists - PlatformClientAgent takes precedence)
            clientInfo.ai_agent_code = assignment.ai_agent_code;
            console.log(`🤖 Loaded agent assignment for WPPConnect client ${assignment.clientId} from PlatformClientAgent: ${assignment.ai_agent_code}`);
            totalLoaded++;
          } else if (!clientInfo) {
          console.log(`⚠️ WPPConnect client ${assignment.clientId} not found in active clients`);
          }
        }
      }

      console.log(`✅ Loaded ${totalLoaded} total agent assignments for active WPPConnect clients`);
    } catch (error) {
      console.error('❌ Error loading agent assignments:', error);
    }
  }

  // Cleanup
  async cleanup(): Promise<void> {
    await this.clientManager.cleanup();
    console.log('✅ WPPConnect WhatsApp service cleanup completed');
  }
}

export default WPPConnectWhatsAppService;
