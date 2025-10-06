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
        const session = await WPPConnectSession.findOne({ sessionName });
        if (session?.tokenData) {
          console.log(`✅ [${sessionName}] Session loaded from MongoDB`);
          return session.tokenData as SessionToken;
        }
        return undefined;
      } catch (error) {
        console.error(`❌ [${sessionName}] Error loading session:`, error);
        return undefined;
      }
    },

    setToken: async (sessionName: string, tokenData: SessionToken): Promise<boolean> => {
      try {
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
        return true;
      } catch (error) {
        console.error(`❌ [${sessionName}] Error saving session:`, error);
        return false;
      }
    },

    removeToken: async (sessionName: string): Promise<boolean> => {
      try {
        await WPPConnectSession.deleteOne({ sessionName });
        console.log(`🗑️  [${sessionName}] Session removed from MongoDB`);
        return true;
      } catch (error) {
        console.error(`❌ [${sessionName}] Error removing session:`, error);
        return false;
      }
    },

    listTokens: async (): Promise<string[]> => {
      try {
        const sessions = await WPPConnectSession.find({}, 'sessionName');
        const sessionNames = sessions.map(s => s.sessionName);
        console.log(`📋 Found ${sessionNames.length} sessions in MongoDB`);
        return sessionNames;
      } catch (error) {
        console.error(`❌ Error listing sessions:`, error);
        return [];
      }
    }
  };
};

