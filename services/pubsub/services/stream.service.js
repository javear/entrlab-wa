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
        this.isConnected = false; // Not ready yet, just connecting
      });

      this.client.on('ready', () => {
        console.log('✅ Connected to Valkey/Redis');
        this.isConnected = true;
      });

      this.client.on('reconnecting', () => {
        console.log('🔄 Reconnecting to Valkey/Redis...');
        this.isConnected = false; // Set to false while reconnecting
      });

      this.client.on('end', () => {
        console.log('🔌 Redis/Valkey connection ended');
        this.isConnected = false;
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
   * Get consumer group info (last delivered ID, pending count, etc.)
   * @param {string} groupName - Consumer group name
   * @returns {Promise<Object|null>} - Group info or null if not found
   */
  async getConsumerGroupInfo(groupName) {
    if (!this.isConnected || !this.client) {
      throw new Error('Stream service not connected');
    }

    try {
      const groups = await this.client.xInfoGroups(this.config.streamName);
      const group = groups.find(g => g.name === groupName);
      if (!group) {
        return null;
      }
      return {
        name: group.name,
        consumers: group.consumers,
        pending: group.pending,
        lastDeliveredId: group.lastDeliveredId || '0-0'
      };
    } catch (error) {
      if (error.message && (
        error.message.includes('NOGROUP') ||
        error.message.includes('no such key') ||
        error.message.includes('not found')
      )) {
        return null;
      }
      console.error(`❌ Error getting consumer group info:`, error.message || error);
      return null;
    }
  }

  /**
   * Read from stream using consumer group
   * 
   * Best Practice Implementation:
   * 1. Read pending messages first (id: '0') - messages that were read but not ACKed (retries)
   * 2. If no pending, read new messages (id: '>') - messages published after group's lastDeliveredId
   * 
   * This ensures:
   * - No message loss: Pending messages are retried before processing new ones
   * - No duplicate processing: '>' only reads messages after the group's position
   * - Graceful failure handling: Failed messages remain pending and can be retried
   * 
   * @param {string} groupName - Consumer group name
   * @param {string} consumerName - Consumer name
   * @param {Object} options - Read options
   * @returns {Promise<Array>} - Stream entries with isPending flag
   */
  async readGroup(groupName, consumerName, options = {}) {
    if (!this.isConnected || !this.client) {
      throw new Error('Stream service not connected');
    }

    try {
      const {
        count = 10,
        block = 5000 // Default 5 seconds blocking for new messages
      } = options;

      let entries = null;
      let isPending = false;
      
      // STEP 1: Read pending messages first (id: '0')
      // These are messages that were read but not ACKed - they need to be retried
      // This ensures no message loss if a consumer crashed or failed to ACK
      try {
        entries = await this.client.xReadGroup(
          groupName,
          consumerName,
          [{ key: this.config.streamName, id: '0' }],
          {
            COUNT: count,
            BLOCK: 0 // Non-blocking - don't wait for pending messages
          }
        );
        
        // Check if we actually got any messages
        if (entries && entries.length > 0) {
          const messageCount = entries.reduce((sum, stream) => sum + (stream.messages?.length || 0), 0);
          if (messageCount > 0) {
            isPending = true; // Mark as pending/retry messages
            console.log(`🔄 [Stream Service] Found ${messageCount} pending message(s) for ${groupName} (retries)`);
          } else {
            entries = null; // No actual messages
          }
        } else {
          entries = null; // No entries at all
        }
      } catch (err) {
        // xReadGroup with id '0' returns empty/null when no pending messages
        // This is expected, not an error - just continue to read new messages
        if (err.message && !err.message.includes('timeout') && !err.message.includes('NOGROUP')) {
          // Only log actual errors (not timeouts or missing groups)
          console.error(`❌ [Stream Service] Error checking pending messages:`, err.message);
        }
        entries = null;
      }

      // STEP 2: If no pending messages, read new messages (id: '>')
      // '>' reads messages published AFTER the group's lastDeliveredId
      // This ensures we only process messages we haven't seen yet
      if (!entries || entries.length === 0) {
        try {
                  entries = await this.client.xReadGroup(
                    groupName,
                    consumerName,
            [{ key: this.config.streamName, id: '>' }],
                {
                  COUNT: count,
                  BLOCK: block // Block for new messages (use provided block time)
                }
              );
              
          isPending = false; // Messages from '>' are new, not retries
              
          // Log successful reads
              if (entries && entries.length > 0) {
                const messageCount = entries.reduce((sum, stream) => sum + (stream.messages?.length || 0), 0);
                if (messageCount > 0) {
                  console.log(`✅ [Stream Service] Read ${messageCount} new message(s) for ${groupName} from ${this.config.streamName}`);
                }
              }
            } catch (readError) {
              // Handle timeout gracefully - it's expected when no new messages
              if (readError.message && readError.message.includes('timeout')) {
                // This is normal - no new messages available
                entries = null;
              } else {
                // Log actual errors
            console.error(`❌ [Stream Service] Error reading new messages:`, readError.message || readError);
                entries = null;
              }
            }
          }

      // Return empty array if no messages
      if (!entries || entries.length === 0) {
        return [];
      }

      // Transform entries and mark which are pending
      const result = [];
      for (const stream of entries) {
        for (const entry of stream.messages) {
          result.push({
            id: entry.id,
            data: this.parseEntryData(entry.message),
            isPending: isPending // Flag to indicate if this is a pending/retry message
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
   * Get pending message info (delivery count, time since last delivery)
   * @param {string} groupName - Consumer group name
   * @param {string} entryId - Stream entry ID
   * @returns {Promise<Object|null>} - Pending info or null if not pending
   */
  async getPendingInfo(groupName, entryId, consumerName = null) {
    if (!this.isConnected || !this.client) {
      throw new Error('Stream service not connected');
    }

    try {
      // Query all pending messages for this consumer group (or specific consumer)
      // XPENDING stream group [start] [end] [count] [consumer]
      // Use '-' and '+' to get all pending messages, then filter by entryId
      let pendingInfo;
      if (consumerName) {
        // Filter by consumer name
        pendingInfo = await this.client.xPending(
          this.config.streamName,
          groupName,
          '-', // Start from beginning
          '+', // To end
          1000, // Get up to 1000 pending messages
          consumerName // Filter by consumer name
        );
      } else {
        // Get all pending messages for the group
        pendingInfo = await this.client.xPending(
          this.config.streamName,
          groupName,
          '-', // Start from beginning
          '+', // To end
          1000 // Get up to 1000 pending messages
        );
      }

      // If no pending info or empty array, entry is not pending
      if (!pendingInfo || !Array.isArray(pendingInfo) || pendingInfo.length === 0) {
        return null;
      }

      // Find the specific entry ID in the pending list
      // pendingInfo structure: array of arrays
      // Each item: [entryId, consumerName, timeSinceLastDelivery, deliveryCount]
      const info = pendingInfo.find(item => {
        if (!item || !Array.isArray(item) || item.length < 4) {
          return false;
        }
        // Compare entry IDs (they should match exactly)
        // Note: entryId might be in format "timestamp-sequence" (e.g., "1767866946192-0")
        const itemId = String(item[0]);
        const searchId = String(entryId);
        return itemId === searchId;
      });
      
      if (!info || !Array.isArray(info) || info.length < 4) {
        // Entry not found in pending list - might have been just read or ACKed
        return null;
      }

      // deliveryCount is the 4th element (index 3)
      // This is the number of times the message has been delivered to a consumer
      const deliveryCount = parseInt(info[3]) || 0;
      
      return {
        entryId: String(info[0]),
        consumerName: String(info[1]),
        timeSinceLastDelivery: parseInt(info[2]) || 0, // milliseconds since last delivery
        deliveryCount: deliveryCount // number of times delivered
      };
    } catch (error) {
      // If entry doesn't exist in pending or group doesn't exist, that's okay
      // Return null instead of throwing - this means the message is not pending
      if (error.message && (
        error.message.includes('NOGROUP') || 
        error.message.includes('no such key') ||
        error.message.includes('not found')
      )) {
        return null;
      }
      // Log unexpected errors but don't throw - return null to continue processing
      console.error(`❌ Error getting pending info for ${entryId}:`, error.message || error);
      return null;
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
