const redis = require('redis');

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
    if (this.isConnected && this.client) {
      return;
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
        console.error('❌ Stream producer connection error:', err);
        this.isConnected = false;
      });

      this.client.on('ready', () => {
        this.isConnected = true;
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
    console.log(`🔄 [Producer] publishIncomingMessage called, isConnected: ${this.isConnected}, hasClient: ${!!this.client}`);
    if (!this.isConnected || !this.client) {
      console.log(`🔄 [Producer] Connecting to stream...`);
      await this.connect();
      console.log(`✅ [Producer] Connection established, isConnected: ${this.isConnected}`);
    }

    if (!this.client) {
      throw new Error('Stream producer client not available after connection attempt');
    }

    try {
      const entryData = {
        eventType: 'message:incoming',
        timestamp: new Date().toISOString(),
        ...messageData
      };

      const streamEntry = this.prepareStreamEntry(entryData);
      const entryId = await this.client.xAdd(
        this.config.streamName,
        '*',
        streamEntry
      );

      console.log(`📤 [Producer] Published incoming message to stream: ${entryId}`);
      console.log(`📋 [Producer] Message data:`, JSON.stringify({
        clientId: messageData.clientId,
        platform: messageData.platform,
        userIdentifier: messageData.userIdentifier,
        agentCode: messageData.agentCode || null,
        messageType: messageData.messageType,
        contentPreview: messageData.content ? messageData.content.substring(0, 100) : '',
        messageId: messageData.messageId
      }, null, 2));

      return entryId;
    } catch (error) {
      console.error('❌ Error publishing incoming message:', error);
      throw error;
    }
  }

  /**
   * Publish AI response event
   * @param {Object} responseData - AI response data
   * @returns {Promise<string>} - Stream entry ID
   */
  async publishAIResponse(responseData) {
    console.log(`🔄 [Producer] publishAIResponse called, isConnected: ${this.isConnected}, hasClient: ${!!this.client}`);
    if (!this.isConnected || !this.client) {
      console.log(`🔄 [Producer] Connecting to stream...`);
      await this.connect();
      console.log(`✅ [Producer] Connection established, isConnected: ${this.isConnected}`);
    }

    if (!this.client) {
      throw new Error('Stream producer client not available after connection attempt');
    }

    try {
      const entryData = {
        eventType: 'ai:response',
        timestamp: new Date().toISOString(),
        ...responseData
      };

      const streamEntry = this.prepareStreamEntry(entryData);
      const entryId = await this.client.xAdd(
        this.config.streamName,
        '*',
        streamEntry
      );

      console.log(`📤 [Producer] Published AI response to stream: ${entryId}`);
      console.log(`📋 [Producer] Response data:`, JSON.stringify({
        clientId: responseData.clientId,
        platform: responseData.platform,
        userIdentifier: responseData.userIdentifier,
        agentCode: responseData.agentCode,
        requestPreview: responseData.requestMessage ? responseData.requestMessage.substring(0, 100) : '',
        responseType: responseData.response?.messages ? `${responseData.response.messages.length} message(s)` : responseData.response?.text ? 'text' : 'unknown',
        processingTime: responseData.metadata?.processingTime
      }, null, 2));

      return entryId;
    } catch (error) {
      console.error('❌ Error publishing AI response:', error);
      throw error;
    }
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
      await this.client.quit();
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
  getProducer
};
