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
      required: true,
      index: true
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

  ClientAgent = mongoose.model<IClientAgent>('ClientAgent', ClientAgentSchema);
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

  public async disconnectClient(clientId: string): Promise<boolean> {
    return await this.clientManager.disconnectClient(clientId);
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
      
      console.log(`✅ Assigned agent ${agentCode} to WPPConnect client ${clientId}`);
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
      
      console.log(`✅ Removed agent assignment from WPPConnect client ${clientId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error removing agent from WPPConnect client ${clientId}:`, error);
      return false;
    }
  }

  async getClientAgent(clientId: string): Promise<string | null> {
    try {
      const assignment = await ClientAgent.findOne({ clientId, isActive: true });
      return assignment ? assignment.ai_agent_code : null;
    } catch (error) {
      console.error(`❌ Error getting agent for WPPConnect client ${clientId}:`, error);
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
      console.log('🔄 Starting to load agent assignments...');
      
      if (!ClientAgent) {
        console.log('⚠️ ClientAgent model not found');
        return;
      }

      const assignments = await ClientAgent.find({ isActive: true });
      console.log(`📋 Found ${assignments.length} agent assignments in MongoDB:`, assignments);

      for (const assignment of assignments) {
        const clientInfo = this.clientManager.getClient(assignment.clientId);
        if (clientInfo) {
          console.log(`🔍 Looking for WPPConnect client ${assignment.clientId} in clients map: ${!!clientInfo}`);
          console.log(`🤖 Loaded agent assignment for WPPConnect client ${assignment.clientId}: ${assignment.ai_agent_code}`);
        } else {
          console.log(`⚠️ WPPConnect client ${assignment.clientId} not found in active clients`);
        }
      }

      console.log(`✅ Loaded ${assignments.length} agent assignments from MongoDB`);
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
