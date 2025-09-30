import mongoose, { Document, Schema } from 'mongoose';

// ============================================
// WPPConnect MongoDB TokenStore Implementation
// ============================================

// MongoDB Schema for WPPConnect Session Storage (separate from whatsapp-web.js)
interface IWPPConnectSession extends Document {
  sessionName: string;
  tokenData: any;
  createdAt: Date;
  updatedAt: Date;
}

// Create model with error handling to avoid overwrite issues
let WPPConnectSession: mongoose.Model<IWPPConnectSession>;
try {
  WPPConnectSession = mongoose.model<IWPPConnectSession>('WPPConnectSession');
} catch (error) {
  const WPPConnectSessionSchema = new Schema<IWPPConnectSession>({
    sessionName: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    tokenData: {
      type: Schema.Types.Mixed,
      required: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  }, {
    timestamps: true,
    collection: 'wppconnect_sessions' // Separate collection from whatsapp-web.js
  });

  // Update the updatedAt timestamp on save
  WPPConnectSessionSchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
  });

  // Create indexes for better performance
  WPPConnectSessionSchema.index({ sessionName: 1 });
  WPPConnectSessionSchema.index({ createdAt: 1 });
  WPPConnectSessionSchema.index({ updatedAt: 1 });

  WPPConnectSession = mongoose.model<IWPPConnectSession>('WPPConnectSession', WPPConnectSessionSchema);
}

// ============================================
// Custom MongoDB TokenStore Class for WPPConnect
// ============================================

export class WPPConnectMongoTokenStore {
  private connected: boolean = false;

  constructor() {
    this.connected = false;
  }

  /**
   * List all tokens (required by WPPConnect TokenStore interface)
   * @returns {Promise<string[]>} Array of session names
   */
  async listTokens(): Promise<string[]> {
    try {
      const sessions = await WPPConnectSession.find({}, 'sessionName');
      return sessions.map(session => session.sessionName);
    } catch (error) {
      console.error('❌ Error listing WPPConnect tokens:', error);
      return [];
    }
  }

  /**
   * Connect to MongoDB (reuse existing connection)
   */
  async connect(): Promise<void> {
    try {
      if (!this.connected && mongoose.connection.readyState === 1) {
        this.connected = true;
        console.log('✅ WPPConnect MongoDB TokenStore connected successfully');
      } else if (mongoose.connection.readyState !== 1) {
        throw new Error('MongoDB connection not available');
      }
    } catch (error) {
      console.error('❌ WPPConnect MongoDB connection error:', error);
      throw error;
    }
  }

  /**
   * Get token data for a session
   * @param {string} sessionName - Name of the session
   * @returns {Promise<any|null>} Token data or null
   */
  async getToken(sessionName: string): Promise<any | null> {
    try {
      console.log(`🔍 TokenStore.getToken() called for: ${sessionName}`);
      const session = await WPPConnectSession.findOne({ sessionName });
      
      if (session) {
        console.log(`📥 Retrieved WPPConnect session from MongoDB: ${sessionName}`);
        console.log(`📥 Token data keys: ${Object.keys(session.tokenData || {}).join(', ')}`);
        return session.tokenData;
      }
      
      console.log(`⚠️  No WPPConnect session found in MongoDB: ${sessionName}`);
      return null;
    } catch (error) {
      console.error(`❌ Error getting WPPConnect token for ${sessionName}:`, error);
      return null;
    }
  }

  /**
   * Save or update token data for a session
   * @param {string} sessionName - Name of the session
   * @param {any} tokenData - Token data to store
   * @returns {Promise<boolean>} Success status
   */
  async setToken(sessionName: string, tokenData: any): Promise<boolean> {
    try {
      console.log(`💾 Saving WPPConnect session to MongoDB: ${sessionName}`);
      console.log(`💾 Token data keys: ${Object.keys(tokenData || {}).join(', ')}`);
      
      await WPPConnectSession.findOneAndUpdate(
        { sessionName },
        { 
          sessionName,
          tokenData,
          updatedAt: new Date()
        },
        { 
          upsert: true,  // Create if doesn't exist
          new: true 
        }
      );
      
      console.log(`✅ Successfully saved WPPConnect session: ${sessionName}`);
      return true;
    } catch (error) {
      console.error(`❌ Error setting WPPConnect token for ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Remove token data for a session
   * @param {string} sessionName - Name of the session
   * @returns {Promise<boolean>} Success status
   */
  async removeToken(sessionName: string): Promise<boolean> {
    try {
      await WPPConnectSession.deleteOne({ sessionName });
      console.log(`🗑️  Removed WPPConnect session: ${sessionName}`);
      return true;
    } catch (error) {
      console.error(`❌ Error removing WPPConnect token for ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * List all stored sessions
   * @returns {Promise<Array>} Array of session names
   */
  async listSessions(): Promise<any[]> {
    try {
      const sessions = await WPPConnectSession.find({}, 'sessionName createdAt updatedAt');
      return sessions;
    } catch (error) {
      console.error('❌ Error listing WPPConnect sessions:', error);
      return [];
    }
  }

  /**
   * Check if session exists
   * @param {string} sessionName - Name of the session
   * @returns {Promise<boolean>} Session exists status
   */
  async sessionExists(sessionName: string): Promise<boolean> {
    try {
      const session = await WPPConnectSession.findOne({ sessionName });
      return !!session;
    } catch (error) {
      console.error(`❌ Error checking WPPConnect session existence for ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Close MongoDB connection (reuse existing connection)
   */
  async disconnect(): Promise<void> {
    if (this.connected) {
      this.connected = false;
      console.log('🔌 WPPConnect MongoDB TokenStore disconnected');
    }
  }
}

export default WPPConnectMongoTokenStore;
