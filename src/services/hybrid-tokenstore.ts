import mongoose, { Document, Schema } from 'mongoose';
import { SessionToken } from '@wppconnect-team/wppconnect/dist/token-store/types';
import { FileTokenStore } from '@wppconnect-team/wppconnect/dist/token-store';
import fs from 'fs';
import path from 'path';

// MongoDB Schema for WPPConnect Session Storage
interface IWPPConnectSession extends Document {
  sessionName: string;
  tokenData: SessionToken;
  createdAt: Date;
  updatedAt: Date;
}

let WPPConnectSession: mongoose.Model<IWPPConnectSession>;
try {
  WPPConnectSession = mongoose.model<IWPPConnectSession>('WPPConnectSession');
} catch (error) {
  const WPPConnectSessionSchema = new Schema<IWPPConnectSession>({
    sessionName: { type: String, required: true, unique: true, index: true },
    tokenData: { type: Object, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  });
  WPPConnectSessionSchema.index({ sessionName: 1 });
  WPPConnectSessionSchema.index({ updatedAt: 1 });
  WPPConnectSession = mongoose.model<IWPPConnectSession>('WPPConnectSession', WPPConnectSessionSchema);
}

// ============================================
// Hybrid TokenStore: FileTokenStore + MongoDB Sync
// Uses WPPConnect's FileTokenStore (which works for MultiDevice!)
// then syncs to MongoDB for cross-server persistence
// ============================================

export class HybridMongoTokenStore {
  private fileTokenStore: FileTokenStore;
  private tokenPath: string;

  constructor() {
    this.tokenPath = path.join(process.cwd(), 'tokens_data');
    
    // Use WPPConnect's FileTokenStore - it actually works for MultiDevice!
    this.fileTokenStore = new FileTokenStore({
      path: this.tokenPath,
      encodeFunction: JSON.stringify,
      decodeFunction: JSON.parse
    });
    
    console.log(`✅ Using FileTokenStore with MongoDB sync at: ${this.tokenPath}`);
  }

  getTokenStore() {
    return {
      getToken: (sessionName: string) => this.getToken(sessionName),
      setToken: (sessionName: string, tokenData: SessionToken) => this.setToken(sessionName, tokenData),
      removeToken: (sessionName: string) => this.removeToken(sessionName),
      listTokens: () => this.listTokens()
    };
  }

  async connect(): Promise<void> {
    // Ensure token directory exists
    if (!fs.existsSync(this.tokenPath)) {
      fs.mkdirSync(this.tokenPath, { recursive: true });
    }
    console.log('✅ Hybrid MongoDB TokenStore initialized');
  }

  async getToken(sessionName: string): Promise<SessionToken | undefined> {
    try {
      console.log(`🔍 HybridTokenStore.getToken() called for: ${sessionName}`);
      
      // First try MongoDB (source of truth for cross-server)
      const mongoSession = await WPPConnectSession.findOne({ sessionName });
      if (mongoSession?.tokenData) {
        console.log(`📥 Retrieved session from MongoDB for ${sessionName}`);
        console.log(`📥 Token keys: ${Object.keys(mongoSession.tokenData).join(', ')}`);
        
        // Also restore to file so FileTokenStore has it locally
        await this.fileTokenStore.setToken(sessionName, mongoSession.tokenData);
        console.log(`✅ Synced MongoDB session to local FileTokenStore`);
        
        return mongoSession.tokenData as SessionToken;
      }
      
      // Fallback to FileTokenStore (local only)
      const fileToken = await this.fileTokenStore.getToken(sessionName);
      if (fileToken) {
        console.log(`📥 Retrieved session from local FileTokenStore for ${sessionName}`);
        return fileToken;
      }
      
      console.log(`⚠️  No session found for ${sessionName}`);
      return undefined;
    } catch (error) {
      console.error(`❌ Error getting token for ${sessionName}:`, error);
      return undefined;
    }
  }

  async setToken(sessionName: string, tokenData: SessionToken): Promise<boolean> {
    try {
      console.log(`💾 HybridTokenStore.setToken() called for: ${sessionName}`);
      console.log(`💾 Token data keys: ${Object.keys(tokenData || {}).join(', ')}`);
      console.log(`💾 Sample data:`, JSON.stringify(tokenData, null, 2).substring(0, 200) + '...');
      
      // Save to FileTokenStore first (WPPConnect needs this)
      const fileSaved = await this.fileTokenStore.setToken(sessionName, tokenData);
      if (fileSaved) {
        console.log(`✅ Saved to local FileTokenStore for ${sessionName}`);
      }
      
      // Also save to MongoDB for persistence across servers
      await WPPConnectSession.findOneAndUpdate(
        { sessionName },
        { 
          sessionName,
          tokenData,
          updatedAt: new Date()
        },
        { 
          upsert: true,
          new: true 
        }
      );
      console.log(`✅ Synced to MongoDB for ${sessionName}`);
      console.log(`🎯 Session saved! Will work across ANY server!`);
      
      return true;
    } catch (error) {
      console.error(`❌ Error setting token for ${sessionName}:`, error);
      return false;
    }
  }

  async removeToken(sessionName: string): Promise<boolean> {
    try {
      console.log(`🗑️  HybridTokenStore.removeToken() called for: ${sessionName}`);
      
      // Remove from both stores
      await this.fileTokenStore.removeToken(sessionName);
      await WPPConnectSession.deleteOne({ sessionName });
      
      console.log(`✅ Removed session from both stores: ${sessionName}`);
      return true;
    } catch (error) {
      console.error(`❌ Error removing token for ${sessionName}:`, error);
      return false;
    }
  }

  async listTokens(): Promise<string[]> {
    try {
      console.log(`🔍 HybridTokenStore.listTokens() called`);
      
      // List from MongoDB (source of truth)
      const sessions = await WPPConnectSession.find({});
      const sessionNames = sessions.map(s => s.sessionName);
      
      console.log(`📋 Found ${sessionNames.length} sessions in MongoDB: ${sessionNames.join(', ')}`);
      return sessionNames;
    } catch (error) {
      console.error('❌ Error listing tokens:', error);
      // Fallback to FileTokenStore
      return this.fileTokenStore.listTokens();
    }
  }

  async disconnect(): Promise<void> {
    console.log('🔌 Hybrid MongoDB TokenStore disconnected');
  }
}

export function createHybridTokenStore(): any {
  const store = new HybridMongoTokenStore();
  return store.getTokenStore();
}

