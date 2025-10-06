import mongoose, { Document, Schema } from 'mongoose';
import { SessionToken } from '@wppconnect-team/wppconnect/dist/token-store/types';

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
// Pure Remote TokenStore for MongoDB
// Follows the exact pattern from WPPConnect docs (like Redis example)
// No local files - 100% remote persistence
// ============================================

export const createRemoteTokenStore = () => {
  return {
    getToken: async (sessionName: string): Promise<SessionToken | undefined> => {
      try {
        console.log(`🔍 RemoteTokenStore.getToken() for: ${sessionName}`);
        
        const session = await WPPConnectSession.findOne({ sessionName });
        if (session?.tokenData) {
          console.log(`✅ Retrieved session from MongoDB: ${sessionName}`);
          console.log(`📦 Token keys: ${Object.keys(session.tokenData).join(', ')}`);
          return session.tokenData as SessionToken;
        }
        
        console.log(`⚠️  No session found in MongoDB for: ${sessionName}`);
        return undefined;
      } catch (error) {
        console.error(`❌ Error getting token for ${sessionName}:`, error);
        return undefined;
      }
    },

    setToken: async (sessionName: string, tokenData: SessionToken): Promise<boolean> => {
      try {
        console.log(`💾 RemoteTokenStore.setToken() for: ${sessionName}`);
        console.log(`💾 Token keys: ${Object.keys(tokenData || {}).join(', ')}`);
        
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
        
        console.log(`✅ Session saved to MongoDB: ${sessionName}`);
        return true;
      } catch (error) {
        console.error(`❌ Error setting token for ${sessionName}:`, error);
        return false;
      }
    },

    removeToken: async (sessionName: string): Promise<boolean> => {
      try {
        console.log(`🗑️  RemoteTokenStore.removeToken() for: ${sessionName}`);
        
        await WPPConnectSession.deleteOne({ sessionName });
        
        console.log(`✅ Session removed from MongoDB: ${sessionName}`);
        return true;
      } catch (error) {
        console.error(`❌ Error removing token for ${sessionName}:`, error);
        return false;
      }
    },

    listTokens: async (): Promise<string[]> => {
      try {
        console.log(`📋 RemoteTokenStore.listTokens()`);
        
        const sessions = await WPPConnectSession.find({}, 'sessionName');
        const sessionNames = sessions.map(s => s.sessionName);
        
        console.log(`✅ Found ${sessionNames.length} sessions: ${sessionNames.join(', ')}`);
        return sessionNames;
      } catch (error) {
        console.error(`❌ Error listing tokens:`, error);
        return [];
      }
    }
  };
};

