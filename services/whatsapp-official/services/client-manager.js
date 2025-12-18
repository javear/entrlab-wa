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
      phone_number_id: {
        type: String, // Plain phone_number_id for wa-official clients (for easy querying)
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

    // Create indexes for better performance
    PlatformClientAgentSchema.index({ clientId: 1, platform: 1, isActive: 1 });
    PlatformClientAgentSchema.index({ phone_number_id: 1, platform: 1, isActive: 1 }); // Index for querying by phone_number_id

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
      // Note: phone_number_id is now stored in MongoDB plain field, not in vault config
      console.log(`✅ Decrypted configuration for ${clientId}:`);
      console.log(`   - access_token: ${decryptedConfig.access_token ? `${decryptedConfig.access_token.substring(0, 20)}...` : 'MISSING'}`);
      console.log(`   - verify_token: ${decryptedConfig.verify_token ? '***' : 'MISSING'}`);
      console.log(`   - app_secret: ${decryptedConfig.app_secret ? '***' : 'MISSING'}`);
      console.log(`   - phone_number_id: (read from MongoDB plain field, not from vault)`);

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
   * Reads ONLY from MongoDB plain field (single source of truth)
   */
  async getPhoneNumberId(clientId) {
    try {
      await this.initialize();
      const ClientAgent = this.getClientAgentModel();
      
      const client = await ClientAgent.findOne({
        clientId,
        platform: 'wa-official',
        isActive: true
      }).select('phone_number_id');
      
      if (!client) {
        throw new Error(`Client ${clientId} not found or not active`);
      }
      
      if (!client.phone_number_id) {
        throw new Error(`Phone number ID not found for client ${clientId} in MongoDB. Please ensure phone_number_id is saved in the client configuration.`);
      }
      
      // Warn if placeholder/dummy phone number ID is detected
      if (client.phone_number_id.includes('your_phone_number') || client.phone_number_id.includes('YOUR_PHONE_NUMBER')) {
        console.warn(`⚠️ [${clientId}] Warning: Using placeholder phone_number_id. Please update with real credentials.`);
      }
      
      return client.phone_number_id;
    } catch (error) {
      console.error(`❌ Error getting phone_number_id for client ${clientId}:`, error.message);
      throw error;
    }
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

  /**
   * Find clientId by phone_number_id
   * This is useful when receiving webhooks where we need to identify which client a phone_number_id belongs to
   */
  async findClientIdByPhoneNumberId(phoneNumberId) {
    try {
      await this.initialize();
      const ClientAgent = this.getClientAgentModel();

      const client = await ClientAgent.findOne({
        phone_number_id: phoneNumberId,
        platform: 'wa-official',
        isActive: true
      }).select('clientId');

      if (!client) {
        return null;
      }

      return client.clientId;
    } catch (error) {
      console.error(`❌ Error finding clientId by phone_number_id ${phoneNumberId}:`, error.message);
      return null;
    }
  }
}

module.exports = new WhatsAppOfficialClientManager();

