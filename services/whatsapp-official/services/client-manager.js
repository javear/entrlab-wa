const mongoose = require('mongoose');
const { decryptWithVault } = require('../utils/vault');

/**
 * WhatsApp Official Client Manager Service
 * Manages multiple WhatsApp Business API clients with encrypted configurations
 */
class WhatsAppOfficialClientManager {
  constructor() {
    this.clientCache = new Map(); // Cache decrypted configurations
    this.mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-bot';
    this.isConnected = false;
  }

  /**
   * Initialize MongoDB connection
   */
  async initialize() {
    if (this.isConnected) {
      return;
    }

    try {
      await mongoose.connect(this.mongoUri);
      this.isConnected = true;
      console.log('✅ MongoDB connected for WhatsApp Official client manager');
    } catch (error) {
      console.error('❌ MongoDB connection failed:', error);
      throw error;
    }
  }

  /**
   * Get PlatformClientAgent model
   */
  getClientAgentModel() {
    const Schema = mongoose.Schema;

    const PlatformClientAgentSchema = new Schema({
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
      configuration: {
        type: String // Encrypted configuration
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

    try {
      return mongoose.model('PlatformClientAgent');
    } catch (error) {
      return mongoose.model('PlatformClientAgent', PlatformClientAgentSchema);
    }
  }

  /**
   * Get client configuration from MongoDB and decrypt it
   */
  async getClientConfig(clientId) {
    // Check cache first
    if (this.clientCache.has(clientId)) {
      const cached = this.clientCache.get(clientId);
      // Cache for 2 minutes (reduced from 5 to avoid stale tokens)
      // Cache will also be cleared on 401/403 errors
      if (Date.now() - cached.timestamp < 2 * 60 * 1000) {
        return cached.config;
      }
      this.clientCache.delete(clientId);
    }

    try {
      await this.initialize();
      const ClientAgent = this.getClientAgentModel();

      const client = await ClientAgent.findOne({
        clientId,
        platform: 'wa-official',
        isActive: true
      });

      if (!client) {
        throw new Error(`Client ${clientId} not found or not active`);
      }

      if (!client.configuration) {
        throw new Error(`Client ${clientId} has no configuration`);
      }

      // Decrypt configuration using Vault
      console.log(`🔓 Decrypting configuration for client ${clientId}...`);
      const decryptedConfig = await decryptWithVault(client.configuration);

      // Log decrypted values for debugging (mask sensitive data)
      console.log(`✅ Decrypted configuration for ${clientId}:`);
      console.log(`   - access_token: ${decryptedConfig.access_token ? `${decryptedConfig.access_token.substring(0, 20)}...` : 'MISSING'}`);
      console.log(`   - phone_number_id: ${decryptedConfig.phone_number_id || 'MISSING'}`);
      console.log(`   - verify_token: ${decryptedConfig.verify_token ? '***' : 'MISSING'}`);
      console.log(`   - app_secret: ${decryptedConfig.app_secret ? '***' : 'MISSING'}`);

      // Cache the decrypted configuration
      this.clientCache.set(clientId, {
        config: decryptedConfig,
        timestamp: Date.now()
      });

      return decryptedConfig;
    } catch (error) {
      console.error(`❌ Error getting client config for ${clientId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get verify token for a client
   */
  async getVerifyToken(clientId) {
    const config = await this.getClientConfig(clientId);
    return config.verify_token;
  }

  /**
   * Get access token for a client
   */
  async getAccessToken(clientId) {
    const config = await this.getClientConfig(clientId);
    const token = config.access_token;
    
    // Warn if placeholder/dummy token is detected
    if (token && (token.includes('your_access_token') || token.includes('YOUR_ACCESS_TOKEN'))) {
      console.warn(`⚠️ [${clientId}] Warning: Using placeholder access_token. Please update with real credentials.`);
    }
    
    return token;
  }

  /**
   * Get phone number ID for a client
   */
  async getPhoneNumberId(clientId) {
    const config = await this.getClientConfig(clientId);
    const phoneNumberId = config.phone_number_id;
    
    // Warn if placeholder/dummy phone number ID is detected
    if (phoneNumberId && (phoneNumberId.includes('your_phone_number') || phoneNumberId.includes('YOUR_PHONE_NUMBER'))) {
      console.warn(`⚠️ [${clientId}] Warning: Using placeholder phone_number_id. Please update with real credentials.`);
    }
    
    return phoneNumberId;
  }

  /**
   * Get app secret for a client (for webhook signature verification)
   */
  async getAppSecret(clientId) {
    const config = await this.getClientConfig(clientId);
    return config.app_secret || null;
  }

  /**
   * Clear cache for a specific client
   */
  clearCache(clientId) {
    this.clientCache.delete(clientId);
  }

  /**
   * Clear all cache
   */
  clearAllCache() {
    this.clientCache.clear();
  }

  /**
   * Check if client exists and is active
   */
  async clientExists(clientId) {
    try {
      await this.initialize();
      const ClientAgent = this.getClientAgentModel();

      const client = await ClientAgent.findOne({
        clientId,
        platform: 'wa-official',
        isActive: true
      });

      return !!client;
    } catch (error) {
      console.error(`❌ Error checking if client exists ${clientId}:`, error.message);
      return false;
    }
  }
}

module.exports = new WhatsAppOfficialClientManager();

