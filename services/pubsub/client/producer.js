const redis = require('redis');
const crypto = require('crypto');

/**
 * Stream Producer Client
 * Can be used from other services to publish events to the stream
 */
class StreamProducer {
  constructor(options = {}) {
    this.client = null;
    this.isConnected = false;
    
    // Check if host is a full URL
    const hostOrUrl = options.host || process.env.VALKEY_HOST || process.env.REDIS_HOST || 'localhost';
    const isUrl = hostOrUrl.startsWith('redis://') || hostOrUrl.startsWith('rediss://');
    
    this.config = {
      url: isUrl ? hostOrUrl : null,
      host: isUrl ? null : hostOrUrl,
      port: parseInt(options.port || process.env.VALKEY_PORT || process.env.REDIS_PORT || '6379'),
      password: options.password || process.env.VALKEY_PASSWORD || process.env.REDIS_PASSWORD || null,
      db: parseInt(options.db || process.env.VALKEY_DB || process.env.REDIS_DB || '0'),
      streamName: options.streamName || process.env.VALKEY_STREAM_NAME || 'whatsapp:events'
    };
  }

  /**
   * Connect to Valkey/Redis
   */
  async connect() {
    // Check if already connected and ready
    if (this.isConnected && this.client && this.client.isReady) {
      return;
    }

    // If client exists but not ready, close it first
    if (this.client && !this.client.isReady) {
      try {
        await this.client.quit().catch(() => {}); // Ignore errors on close
      } catch (e) {
        // Ignore
      }
      this.client = null;
      this.isConnected = false;
    }

    try {
      let connectionOptions;
      
      // If URL is provided, use it directly (Redis client supports URLs)
      if (this.config.url) {
        connectionOptions = {
          url: this.config.url,
          socket: {
            reconnectStrategy: (retries) => {
              if (retries > 10) {
                console.error('❌ Max reconnection attempts reached for stream producer');
                return new Error('Max reconnection attempts reached');
              }
              return Math.min(retries * 100, 3000);
            }
          }
        };
      } else {
        // Use host/port configuration
        connectionOptions = {
          socket: {
            host: this.config.host,
            port: this.config.port,
            reconnectStrategy: (retries) => {
              if (retries > 10) {
                console.error('❌ Max reconnection attempts reached for stream producer');
                return new Error('Max reconnection attempts reached');
              }
              return Math.min(retries * 100, 3000);
            }
          }
        };

        if (this.config.password) {
          connectionOptions.password = this.config.password;
        }

        if (this.config.db !== 0) {
          connectionOptions.database = this.config.db;
        }
      }

      this.client = redis.createClient(connectionOptions);

      this.client.on('error', (err) => {
        console.error('❌ Stream producer connection error:', err.message || err);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        console.log('🔌 Stream producer connecting...');
        this.isConnected = false; // Not ready yet
      });

      this.client.on('ready', () => {
        console.log('✅ Stream producer ready');
        this.isConnected = true;
      });

      this.client.on('reconnecting', () => {
        console.log('🔄 Stream producer reconnecting...');
        this.isConnected = false;
      });

      this.client.on('end', () => {
        console.log('🔌 Stream producer connection ended');
        this.isConnected = false;
      });

      await this.client.connect();
      console.log('✅ Stream producer connected');
    } catch (error) {
      console.error('❌ Failed to connect stream producer:', error);
      throw error;
    }
  }

  /**
   * Publish incoming message event
   * @param {Object} messageData - Message data
   * @returns {Promise<string>} - Stream entry ID
   */
  async publishIncomingMessage(messageData) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check connection state - both flag and actual client state
        const isReallyConnected = this.isConnected && 
                                 this.client && 
                                 this.client.isReady;
        
        if (!isReallyConnected) {
          console.log(`🔄 [Producer] Not connected (attempt ${attempt}/${maxRetries}), reconnecting...`);
          await this.connect();
          // Wait a bit for connection to stabilize
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!this.client || !this.client.isReady) {
          throw new Error('Stream producer client not ready');
        }

        // Calculate hashed room ID if agentCode, clientId, and userIdentifier are available
        let hashedId = null;
        if (messageData.agentCode && messageData.clientId && messageData.userIdentifier) {
          try {
            hashedId = this.hashRoomId(messageData.agentCode, messageData.clientId, messageData.userIdentifier);
            console.log(`🔑 [Producer] Calculated hashedId for incoming message: ${hashedId} (agentCode: ${messageData.agentCode}, clientId: ${messageData.clientId}, userIdentifier: ${messageData.userIdentifier})`);
          } catch (error) {
            console.warn(`⚠️  [Producer] Failed to hash room ID: ${error.message}`);
          }
        } else {
          console.warn(`⚠️  [Producer] Cannot calculate hashedId - missing required fields (agentCode: ${!!messageData.agentCode}, clientId: ${!!messageData.clientId}, userIdentifier: ${!!messageData.userIdentifier})`);
        }

        const entryData = {
          eventType: 'message:incoming',
          timestamp: new Date().toISOString(),
          ...messageData,
          ...(hashedId && { hashedId }) // Include hashed_id if calculated
        };

        const streamEntry = this.prepareStreamEntry(entryData);
        console.log(`📤 [Producer] Publishing to stream: ${this.config.streamName}`);
        const entryId = await this.client.xAdd(
          this.config.streamName,
          '*',
          streamEntry
        );

        console.log(`📤 [Producer] Published incoming message to stream: ${entryId} (stream: ${this.config.streamName})`);
        return entryId;
      } catch (error) {
        lastError = error;
        const isConnectionError = error.code === 'ECONNRESET' || 
                                 error.code === 'EPIPE' || 
                                 error.message?.includes('Connection') ||
                                 error.message?.includes('closed');
        
        if (isConnectionError && attempt < maxRetries) {
          console.log(`⚠️  [Producer] Connection error on attempt ${attempt}, will retry:`, error.message);
          this.isConnected = false;
          // Wait before retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, attempt * 200));
          continue;
        }
        
        // If not a connection error or last attempt, throw
        if (!isConnectionError || attempt === maxRetries) {
          console.error('❌ Error publishing incoming message:', error.message || error);
          throw error;
        }
      }
    }

    throw lastError;
  }

  /**
   * Publish AI response event
   * @param {Object} responseData - AI response data
   * @returns {Promise<string>} - Stream entry ID
   */
  async publishAIResponse(responseData) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check connection state - both flag and actual client state
        const isReallyConnected = this.isConnected && 
                                 this.client && 
                                 this.client.isReady;
        
        if (!isReallyConnected) {
          console.log(`🔄 [Producer] Not connected (attempt ${attempt}/${maxRetries}), reconnecting...`);
          await this.connect();
          // Wait a bit for connection to stabilize
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!this.client || !this.client.isReady) {
          throw new Error('Stream producer client not ready');
        }

        // Calculate hashed room ID if agentCode, clientId, and userIdentifier are available
        let hashedId = null;
        if (responseData.agentCode && responseData.clientId && responseData.userIdentifier) {
          try {
            hashedId = this.hashRoomId(responseData.agentCode, responseData.clientId, responseData.userIdentifier);
            console.log(`🔑 [Producer] Calculated hashedId for AI response: ${hashedId} (agentCode: ${responseData.agentCode}, clientId: ${responseData.clientId}, userIdentifier: ${responseData.userIdentifier})`);
          } catch (error) {
            console.warn(`⚠️  [Producer] Failed to hash room ID: ${error.message}`);
          }
        } else {
          console.warn(`⚠️  [Producer] Cannot calculate hashedId for AI response - missing required fields (agentCode: ${!!responseData.agentCode}, clientId: ${!!responseData.clientId}, userIdentifier: ${!!responseData.userIdentifier})`);
        }

        const entryData = {
          eventType: 'ai:response',
          timestamp: new Date().toISOString(),
          ...responseData,
          ...(hashedId && { hashedId }) // Include hashed_id if calculated
        };

        const streamEntry = this.prepareStreamEntry(entryData);
        console.log(`📤 [Producer] Publishing AI response to stream: ${this.config.streamName}`);
        const entryId = await this.client.xAdd(
          this.config.streamName,
          '*',
          streamEntry
        );

        console.log(`📤 [Producer] Published AI response to stream: ${entryId} (stream: ${this.config.streamName})`);
        return entryId;
      } catch (error) {
        lastError = error;
        const isConnectionError = error.code === 'ECONNRESET' || 
                                 error.code === 'EPIPE' || 
                                 error.message?.includes('Connection') ||
                                 error.message?.includes('closed');
        
        if (isConnectionError && attempt < maxRetries) {
          console.log(`⚠️  [Producer] Connection error on attempt ${attempt}, will retry:`, error.message);
          this.isConnected = false;
          // Wait before retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, attempt * 200));
          continue;
        }
        
        // If not a connection error or last attempt, throw
        if (!isConnectionError || attempt === maxRetries) {
          console.error('❌ Error publishing AI response:', error.message || error);
          throw error;
        }
      }
    }

    throw lastError;
  }

  /**
   * Publish agent response event (for API-initiated messages)
   * @param {Object} responseData - Agent response data
   * @returns {Promise<string>} - Stream entry ID
   */
  async publishAgentResponse(responseData) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check connection state - both flag and actual client state
        const isReallyConnected = this.isConnected && 
                                 this.client && 
                                 this.client.isReady;
        
        if (!isReallyConnected) {
          console.log(`🔄 [Producer] Not connected (attempt ${attempt}/${maxRetries}), reconnecting...`);
          await this.connect();
          // Wait a bit for connection to stabilize
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!this.client || !this.client.isReady) {
          throw new Error('Stream producer client not ready');
        }

        // Calculate hashed room ID if agentCode, clientId, and userIdentifier are available
        let hashedId = null;
        if (responseData.agentCode && responseData.clientId && responseData.userIdentifier) {
          try {
            hashedId = this.hashRoomId(responseData.agentCode, responseData.clientId, responseData.userIdentifier);
            console.log(`🔑 [Producer] Calculated hashedId for agent response: ${hashedId} (agentCode: ${responseData.agentCode}, clientId: ${responseData.clientId}, userIdentifier: ${responseData.userIdentifier})`);
          } catch (error) {
            console.warn(`⚠️  [Producer] Failed to hash room ID: ${error.message}`);
          }
        } else {
          console.warn(`⚠️  [Producer] Cannot calculate hashedId for agent response - missing required fields (agentCode: ${!!responseData.agentCode}, clientId: ${!!responseData.clientId}, userIdentifier: ${!!responseData.userIdentifier})`);
        }

        const entryData = {
          eventType: 'agent:response',
          timestamp: new Date().toISOString(),
          ...responseData,
          ...(hashedId && { hashedId }) // Include hashed_id if calculated
        };

        const streamEntry = this.prepareStreamEntry(entryData);
        console.log(`📤 [Producer] Publishing agent response to stream: ${this.config.streamName}`);
        const entryId = await this.client.xAdd(
          this.config.streamName,
          '*',
          streamEntry
        );

        console.log(`📤 [Producer] Published agent response to stream: ${entryId} (stream: ${this.config.streamName})`);
        return entryId;
      } catch (error) {
        lastError = error;
        const isConnectionError = error.code === 'ECONNRESET' || 
                                 error.code === 'EPIPE' || 
                                 error.message?.includes('Connection') ||
                                 error.message?.includes('closed');
        
        if (isConnectionError && attempt < maxRetries) {
          console.log(`⚠️  [Producer] Connection error on attempt ${attempt}, will retry:`, error.message);
          this.isConnected = false;
          // Wait before retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, attempt * 200));
          continue;
        }
        
        // If not a connection error or last attempt, throw
        if (!isConnectionError || attempt === maxRetries) {
          console.error('❌ Error publishing agent response:', error.message || error);
          throw error;
        }
      }
    }

    throw lastError;
  }

  /**
   * Publish outgoing message event (API-initiated messages)
   * @param {Object} messageData - Outgoing message data
   * @returns {Promise<string>} - Stream entry ID
   */
  async publishOutgoingMessage(messageData) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check connection state - both flag and actual client state
        const isReallyConnected = this.isConnected && 
                                 this.client && 
                                 this.client.isReady;
        
        if (!isReallyConnected) {
          console.log(`🔄 [Producer] Not connected (attempt ${attempt}/${maxRetries}), reconnecting...`);
          await this.connect();
          // Wait a bit for connection to stabilize
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!this.client || !this.client.isReady) {
          throw new Error('Stream producer client not ready');
        }

        // Calculate hashed room ID if agentCode, clientId, and userIdentifier are available
        let hashedId = null;
        if (messageData.agentCode && messageData.clientId && messageData.userIdentifier) {
          try {
            hashedId = this.hashRoomId(messageData.agentCode, messageData.clientId, messageData.userIdentifier);
          } catch (error) {
            console.warn(`⚠️  [Producer] Failed to hash room ID: ${error.message}`);
          }
        }

        const entryData = {
          eventType: 'message:outgoing',
          timestamp: new Date().toISOString(),
          ...messageData,
          ...(hashedId && { hashedId }) // Include hashed_id if calculated
        };

        const streamEntry = this.prepareStreamEntry(entryData);
        console.log(`📤 [Producer] Publishing outgoing message to stream: ${this.config.streamName}`);
        const entryId = await this.client.xAdd(
          this.config.streamName,
          '*',
          streamEntry
        );

        console.log(`📤 [Producer] Published outgoing message to stream: ${entryId} (stream: ${this.config.streamName})`);
        return entryId;
      } catch (error) {
        lastError = error;
        const isConnectionError = error.code === 'ECONNRESET' || 
                                 error.code === 'EPIPE' || 
                                 error.message?.includes('Connection') ||
                                 error.message?.includes('closed');
        
        if (isConnectionError && attempt < maxRetries) {
          console.log(`⚠️  [Producer] Connection error on attempt ${attempt}, will retry:`, error.message);
          this.isConnected = false;
          // Wait before retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, attempt * 200));
          continue;
        }
        
        // If not a connection error or last attempt, throw
        if (!isConnectionError || attempt === maxRetries) {
          console.error('❌ Error publishing outgoing message:', error.message || error);
          throw error;
        }
      }
    }

    throw lastError;
  }

  /**
   * Hash room ID using HMAC-SHA256 (matches Elixir implementation)
   * @param {string} agentCode - Agent code
   * @param {string} clientId - Client ID
   * @param {string} userIdentifier - User identifier
   * @returns {string} - Base64 encoded hash
   */
  hashRoomId(agentCode, clientId, userIdentifier) {
    const secret = process.env.ROOM_HASH_SECRET;
    
    if (!secret) {
      throw new Error('ROOM_HASH_SECRET environment variable is required for room hashing');
    }
    
    // Construct input: "agentCode:clientId:userIdentifier"
    const input = `${agentCode}:${clientId}:${userIdentifier}`;
    
    // Hash using HMAC-SHA256
    const hash = crypto.createHmac('sha256', secret).update(input).digest('base64');
    
    return hash;
  }

  /**
   * Prepare stream entry (convert all values to strings)
   * @param {Object} data - Data to prepare
   * @returns {Object} - Prepared stream entry
   */
  prepareStreamEntry(data) {
    const streamEntry = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === null || value === undefined) {
        streamEntry[key] = '';
      } else if (typeof value === 'object') {
        streamEntry[key] = JSON.stringify(value);
      } else {
        streamEntry[key] = String(value);
      }
    }
    return streamEntry;
  }

  /**
   * Disconnect
   */
  async disconnect() {
    if (this.client) {
      try {
        await this.client.quit().catch(() => {}); // Ignore errors
      } catch (e) {
        // Ignore
      }
      this.client = null;
      this.isConnected = false;
    }
  }
}

// Singleton instance
let producerInstance = null;

/**
 * Get or create producer instance
 * @param {Object} options - Connection options
 * @returns {StreamProducer} - Producer instance
 */
function getProducer(options = {}) {
  if (!producerInstance) {
    producerInstance = new StreamProducer(options);
  }
  return producerInstance;
}

module.exports = {
  StreamProducer,
  getProducer,
  publishAgentResponse: (responseData) => {
    const producer = getProducer();
    return producer.publishAgentResponse(responseData);
  }
};
