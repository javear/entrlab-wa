const redis = require('redis');

/**
 * Stream Service for Valkey/Redis Stream operations
 * Handles connection, publishing, and consuming from streams
 */
class StreamService {
  constructor() {
    this.client = null;
    this.subscribers = new Map(); // Track active stream consumers
    this.isConnected = false;
    
    // Check if VALKEY_HOST or REDIS_HOST is a full URL
    const hostOrUrl = process.env.VALKEY_HOST || process.env.REDIS_HOST || 'localhost';
    const isUrl = hostOrUrl.startsWith('redis://') || hostOrUrl.startsWith('rediss://');
    
    this.config = {
      url: isUrl ? hostOrUrl : null,
      host: isUrl ? null : hostOrUrl,
      port: parseInt(process.env.VALKEY_PORT || process.env.REDIS_PORT || '6379'),
      password: process.env.VALKEY_PASSWORD || process.env.REDIS_PASSWORD || null,
      db: parseInt(process.env.VALKEY_DB || process.env.REDIS_DB || '0'),
      streamName: process.env.VALKEY_STREAM_NAME || 'whatsapp:events'
    };
  }

  /**
   * Connect to Valkey/Redis
   */
  async connect() {
    try {
      let connectionOptions;
      
      // If URL is provided, use it directly (Redis client supports URLs)
      if (this.config.url) {
        connectionOptions = {
          url: this.config.url,
          socket: {
            reconnectStrategy: (retries) => {
              if (retries > 10) {
                console.error('❌ Max reconnection attempts reached');
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
                console.error('❌ Max reconnection attempts reached');
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
        console.error('❌ Redis/Valkey connection error:', err);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        console.log('🔌 Connecting to Valkey/Redis...');
      });

      this.client.on('ready', () => {
        console.log('✅ Connected to Valkey/Redis');
        this.isConnected = true;
      });

      this.client.on('reconnecting', () => {
        console.log('🔄 Reconnecting to Valkey/Redis...');
      });

      await this.client.connect();
    } catch (error) {
      console.error('❌ Failed to connect to Valkey/Redis:', error);
      throw error;
    }
  }

  /**
   * Disconnect from Valkey/Redis
   */
  async disconnect() {
    try {
      if (this.client) {
        // Clean up all subscribers
        for (const [groupId, consumerGroup] of this.subscribers) {
          try {
            await consumerGroup.destroy();
          } catch (error) {
            console.error(`❌ Error destroying consumer group ${groupId}:`, error);
          }
        }
        this.subscribers.clear();

        await this.client.quit();
        this.isConnected = false;
        console.log('✅ Disconnected from Valkey/Redis');
      }
    } catch (error) {
      console.error('❌ Error disconnecting from Valkey/Redis:', error);
      throw error;
    }
  }

  /**
   * Publish event to stream
   * @param {Object} eventData - Event data to publish
   * @param {string} eventType - Type of event ('message:incoming' or 'ai:response')
   * @returns {Promise<string>} - Stream entry ID
   */
  async publish(eventType, eventData) {
    if (!this.isConnected || !this.client) {
      throw new Error('Stream service not connected');
    }

    try {
      const entryData = {
        eventType,
        timestamp: new Date().toISOString(),
        ...eventData
      };

      // Convert all values to strings (Redis Stream requirement)
      const streamEntry = {};
      for (const [key, value] of Object.entries(entryData)) {
        if (value === null || value === undefined) {
          streamEntry[key] = '';
        } else if (typeof value === 'object') {
          streamEntry[key] = JSON.stringify(value);
        } else {
          streamEntry[key] = String(value);
        }
      }

      const entryId = await this.client.xAdd(
        this.config.streamName,
        '*', // Auto-generate ID
        streamEntry
      );

      console.log(`📤 Published ${eventType} to stream: ${entryId}`);
      console.log(`📋 Event data:`, JSON.stringify({
        eventType,
        clientId: eventData.clientId,
        platform: eventData.platform,
        userIdentifier: eventData.userIdentifier,
        ...(eventType === 'message:incoming' ? {
          messageType: eventData.messageType,
          contentPreview: eventData.content ? eventData.content.substring(0, 100) : ''
        } : {
          agentCode: eventData.agentCode,
          responsePreview: eventData.response ? (eventData.response.messages ? `${eventData.response.messages.length} message(s)` : 'text response') : ''
        })
      }, null, 2));
      return entryId;
    } catch (error) {
      console.error(`❌ Error publishing to stream:`, error);
      throw error;
    }
  }

  /**
   * Publish incoming message event
   * @param {Object} messageData - Message data
   * @returns {Promise<string>} - Stream entry ID
   */
  async publishIncomingMessage(messageData) {
    return this.publish('message:incoming', messageData);
  }

  /**
   * Publish AI response event
   * @param {Object} responseData - AI response data
   * @returns {Promise<string>} - Stream entry ID
   */
  async publishAIResponse(responseData) {
    return this.publish('ai:response', responseData);
  }

  /**
   * Read from stream (simple read)
   * @param {Object} options - Read options
   * @returns {Promise<Array>} - Stream entries
   */
  async read(options = {}) {
    if (!this.isConnected || !this.client) {
      throw new Error('Stream service not connected');
    }

    try {
      const {
        count = 10,
        block = 0, // Blocking in milliseconds, 0 = non-blocking
        startId = '0', // Start from beginning, or use '-' for new entries only
        endId = '+'
      } = options;

      const entries = await this.client.xRead(
        [{ key: this.config.streamName, id: startId }],
        {
          COUNT: count,
          BLOCK: block
        }
      );

      if (!entries || entries.length === 0) {
        return [];
      }

      // Transform entries to a more usable format
      const result = [];
      for (const stream of entries) {
        for (const entry of stream.messages) {
          result.push({
            id: entry.id,
            data: this.parseEntryData(entry.message)
          });
        }
      }

      return result;
    } catch (error) {
      console.error('❌ Error reading from stream:', error);
      throw error;
    }
  }

  /**
   * Create consumer group
   * @param {string} groupName - Consumer group name
   * @param {string} startId - Starting ID (default: '0' for beginning, '$' for new entries)
   * @returns {Promise<void>}
   */
  async createConsumerGroup(groupName, startId = '0') {
    if (!this.isConnected || !this.client) {
      throw new Error('Stream service not connected');
    }

    try {
      await this.client.xGroupCreate(
        this.config.streamName,
        groupName,
        startId,
        {
          MKSTREAM: true // Create stream if it doesn't exist
        }
      );
      console.log(`✅ Created consumer group: ${groupName}`);
    } catch (error) {
      // Ignore BUSYGROUP error (group already exists)
      if (!error.message.includes('BUSYGROUP')) {
        console.error(`❌ Error creating consumer group ${groupName}:`, error);
        throw error;
      }
    }
  }

  /**
   * Read from stream using consumer group
   * @param {string} groupName - Consumer group name
   * @param {string} consumerName - Consumer name
   * @param {Object} options - Read options
   * @returns {Promise<Array>} - Stream entries
   */
  async readGroup(groupName, consumerName, options = {}) {
    if (!this.isConnected || !this.client) {
      throw new Error('Stream service not connected');
    }

    try {
      const {
        count = 10,
        block = 5000 // Default 5 seconds blocking
      } = options;

      const entries = await this.client.xReadGroup(
        groupName,
        consumerName,
        [{ key: this.config.streamName, id: '>' }], // '>' means new entries
        {
          COUNT: count,
          BLOCK: block
        }
      );

      if (!entries || entries.length === 0) {
        return [];
      }

      // Transform entries
      const result = [];
      for (const stream of entries) {
        for (const entry of stream.messages) {
          result.push({
            id: entry.id,
            data: this.parseEntryData(entry.message)
          });
        }
      }

      return result;
    } catch (error) {
      console.error(`❌ Error reading from consumer group ${groupName}:`, error);
      throw error;
    }
  }

  /**
   * Acknowledge processed message
   * @param {string} groupName - Consumer group name
   * @param {string} entryId - Entry ID to acknowledge
   * @returns {Promise<number>} - Number of acknowledged entries
   */
  async acknowledge(groupName, entryId) {
    if (!this.isConnected || !this.client) {
      throw new Error('Stream service not connected');
    }

    try {
      return await this.client.xAck(this.config.streamName, groupName, entryId);
    } catch (error) {
      console.error(`❌ Error acknowledging entry ${entryId}:`, error);
      throw error;
    }
  }

  /**
   * Get stream info
   * @returns {Promise<Object>} - Stream information
   */
  async getStreamInfo() {
    if (!this.isConnected || !this.client) {
      throw new Error('Stream service not connected');
    }

    try {
      const info = await this.client.xInfoStream(this.config.streamName);
      return {
        length: info.length,
        groups: info.groups,
        firstEntry: info.firstEntry ? { id: info.firstEntry.id, data: this.parseEntryData(info.firstEntry) } : null,
        lastEntry: info.lastEntry ? { id: info.lastEntry.id, data: this.parseEntryData(info.lastEntry) } : null
      };
    } catch (error) {
      // Stream might not exist yet
      if (error.message.includes('no such key')) {
        return {
          length: 0,
          groups: 0,
          firstEntry: null,
          lastEntry: null
        };
      }
      console.error('❌ Error getting stream info:', error);
      throw error;
    }
  }

  /**
   * Parse entry data (convert JSON strings back to objects)
   * @param {Object} message - Raw message from stream
   * @returns {Object} - Parsed message data
   */
  parseEntryData(message) {
    const parsed = {};
    for (const [key, value] of Object.entries(message)) {
      if (value === '') {
        parsed[key] = null;
      } else {
        try {
          parsed[key] = JSON.parse(value);
        } catch {
          parsed[key] = value;
        }
      }
    }
    return parsed;
  }

  /**
   * Check connection status
   * @returns {boolean}
   */
  getConnectionStatus() {
    return this.isConnected;
  }

  /**
   * Get stream name
   * @returns {string}
   */
  getStreamName() {
    return this.config.streamName;
  }
}

module.exports = StreamService;
