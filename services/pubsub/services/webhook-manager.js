const axios = require('axios');
const crypto = require('crypto');
const redis = require('redis');

/**
 * Webhook Manager
 * Manages webhook subscriptions and delivers events to registered webhooks
 * Stores webhooks in Valkey/Redis (different database from streams)
 */
class WebhookManager {
  constructor(streamService) {
    this.streamService = streamService;
    this.redisClient = null; // Separate Redis client for webhook storage
    this.isConnected = false;
    this.isConsuming = false;
    // Consumer group configuration - configurable via env var for prod/dev separation
    // IMPORTANT: Use different consumer group names for prod and dev to avoid competition
    this.consumerGroupName = process.env.WEBHOOK_CONSUMER_GROUP || 'webhook-delivery';
    this.consumerName = process.env.WEBHOOK_CONSUMER_NAME || `webhook-consumer-${process.pid}`;
    
    // Use DB 1 for webhooks (DB 0 is for streams)
    // Can be overridden with VALKEY_WEBHOOK_DB env var
    this.webhookDb = parseInt(process.env.VALKEY_WEBHOOK_DB || process.env.REDIS_WEBHOOK_DB || '1');
    this.webhookKeyPrefix = 'webhook:';
    this.webhookIndexKey = 'webhooks:index'; // SET to track all webhook IDs
    this.retryCountKeyPrefix = 'webhook-retry:'; // Track retry counts per message ID
    
    // Retry configuration
    this.maxRetries = parseInt(process.env.WEBHOOK_MAX_RETRIES || '10'); // Default: 10 retries
    this.retryDelayMs = parseInt(process.env.WEBHOOK_RETRY_DELAY_MS || '5000'); // Default: 5 seconds between retries
  }

  /**
   * Connect to Valkey/Redis for webhook storage
   */
  async connectRedis() {
    if (this.isConnected && this.redisClient) {
      return;
    }

    try {
      // Check if VALKEY_HOST or REDIS_HOST is a full URL
      const hostOrUrl = process.env.VALKEY_HOST || process.env.REDIS_HOST || 'localhost';
      const isUrl = hostOrUrl.startsWith('redis://') || hostOrUrl.startsWith('rediss://');
      
      let connectionOptions;
      
      if (isUrl) {
        // For URLs, we can still specify database separately
        connectionOptions = {
          url: hostOrUrl,
          database: this.webhookDb,
          socket: {
            reconnectStrategy: (retries) => {
              if (retries > 10) {
                console.error('❌ Max reconnection attempts reached for webhook storage');
                return new Error('Max reconnection attempts reached');
              }
              return Math.min(retries * 100, 3000);
            }
          }
        };
      } else {
        connectionOptions = {
          socket: {
            host: hostOrUrl,
            port: parseInt(process.env.VALKEY_PORT || process.env.REDIS_PORT || '6379'),
            reconnectStrategy: (retries) => {
              if (retries > 10) {
                console.error('❌ Max reconnection attempts reached for webhook storage');
                return new Error('Max reconnection attempts reached');
              }
              return Math.min(retries * 100, 3000);
            }
          },
          database: this.webhookDb
        };

        const password = process.env.VALKEY_PASSWORD || process.env.REDIS_PASSWORD || null;
        if (password) {
          connectionOptions.password = password;
        }
      }

      this.redisClient = redis.createClient(connectionOptions);

      this.redisClient.on('error', (err) => {
        console.error('❌ Webhook Redis/Valkey connection error:', err);
        this.isConnected = false;
      });

      this.redisClient.on('connect', () => {
        console.log(`🔌 Connecting to Valkey/Redis (DB ${this.webhookDb}) for webhook storage...`);
      });

      this.redisClient.on('ready', () => {
        console.log(`✅ Connected to Valkey/Redis (DB ${this.webhookDb}) for webhook storage`);
        this.isConnected = true;
      });

      this.redisClient.on('reconnecting', () => {
        console.log(`🔄 Reconnecting to Valkey/Redis (DB ${this.webhookDb}) for webhook storage...`);
      });

      await this.redisClient.connect();
    } catch (error) {
      console.error('❌ Failed to connect to Valkey/Redis for webhook storage:', error);
      throw error;
    }
  }

  /**
   * Initialize webhook consumer
   */
  async initialize() {
    try {
      // Connect to Redis for webhook storage
      await this.connectRedis();
      
      // Wait for stream service to be connected before creating consumer group
      let retries = 0;
      const maxRetries = 10;
      while (retries < maxRetries) {
        const streamConnected = this.streamService.getConnectionStatus ? 
          this.streamService.getConnectionStatus() : 
          (this.streamService.isConnected === true);
        
        if (streamConnected) {
          break;
        }
        
        console.log(`⏳ [Webhook Manager] Waiting for stream service connection (${retries + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        retries++;
      }

      // Check if stream service is connected
      const streamConnected = this.streamService.getConnectionStatus ? 
        this.streamService.getConnectionStatus() : 
        (this.streamService.isConnected === true);
      
      if (!streamConnected) {
        console.error('❌ [Webhook Manager] Stream service not connected after retries, starting consumer loop anyway (will retry)');
      } else {
        // Create consumer group if it doesn't exist
        try {
          // Best Practice: Use '$' to start from new messages only
          // This ensures:
          // - No processing of historical messages (unless explicitly needed)
          // - Consumer group tracks its position via lastDeliveredId
          // - '>' will read messages after the group's position
          const startId = process.env.WEBHOOK_CONSUMER_START_ID || '$';
          await this.streamService.createConsumerGroup(this.consumerGroupName, startId);
        } catch (error) {
          // Consumer group might already exist, which is fine
          if (!error.message || !error.message.includes('BUSYGROUP')) {
            console.error('❌ [Webhook Manager] Error creating consumer group:', error.message);
          }
        }
      }
      
      // Start consuming (will handle connection issues in the loop)
      this.startConsuming();
    } catch (error) {
      console.error('❌ Error initializing webhook manager:', error);
    }
  }

  /**
   * Start consuming from stream and delivering to webhooks
   */
  startConsuming() {
    if (this.isConsuming) {
      return;
    }

    this.isConsuming = true;
    console.log('📡 Starting webhook consumer...');
    this.consumeLoop();
  }

  /**
   * Consumer loop - continuously read from stream and deliver to webhooks
   */
  async consumeLoop() {
    while (this.isConsuming) {
      try {
        // Check both the flag and the actual Redis client state
        const streamConnected = this.streamService.isConnected && 
                               this.streamService.client && 
                               this.streamService.client.isReady;
        
        if (!streamConnected) {
          console.log('⏳ [Webhook Manager] Waiting for stream service to connect...');
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
          continue;
        }

        const entries = await this.streamService.readGroup(
          this.consumerGroupName,
          this.consumerName,
          {
            count: 10, // Read up to 10 messages at a time
            block: 1000 // Block for 1 second if no messages
          }
        );

        if (entries && entries.length > 0) {
          for (const entry of entries) {
            try {
              // Check if this is a retry (pending message) and get retry count
              // We track retry counts in Redis to avoid timing issues with XPENDING
              let retryCount = 0;
              const retryKey = `${this.retryCountKeyPrefix}${entry.id}`;
              
              if (entry.isPending) {
                // This is a retry - increment and get the retry count from Redis
                // First retry: count goes 0 -> 1
                // Second retry: count goes 1 -> 2
                // etc.
                retryCount = await this.redisClient.incr(retryKey);
                
                // Set expiration on the retry key (cleanup after 24 hours)
                await this.redisClient.expire(retryKey, 86400);
                
                // Check if we've exceeded max retries
                if (retryCount > this.maxRetries) {
                  console.error(`❌ [Webhook Manager] Message ${entry.id} exceeded max retries (${retryCount}/${this.maxRetries}). Acknowledging to prevent infinite loop.`);
                  // Clean up retry counter
                  await this.redisClient.del(retryKey);
                  await this.streamService.acknowledge(
                    this.consumerGroupName,
                    entry.id
                  );
                  continue; // Skip to next message
                }
                
                // Wait before retrying (exponential backoff)
                // For retryCount=1 (first retry), delay = 0
                // For retryCount=2 (second retry), delay = retryDelayMs
                // For retryCount=3 (third retry), delay = 2*retryDelayMs, etc.
                const delayMs = this.retryDelayMs * Math.max(0, retryCount - 1);
                if (delayMs > 0) {
                  await new Promise(resolve => setTimeout(resolve, delayMs));
                }
              } else {
                // First attempt - initialize retry counter to 0
                // We don't need to set it, but we'll check if it exists from a previous attempt
                const existingCount = await this.redisClient.get(retryKey);
                if (existingCount) {
                  // This shouldn't happen, but if it does, use the existing count
                  retryCount = parseInt(existingCount) || 0;
                }
              }
              
              const eventData = entry.data; // Already parsed by readGroup
              const deliveryResults = await this.deliverToWebhooks(eventData);
              
              // Only acknowledge if ALL webhooks succeeded (or no webhooks registered)
              // If no webhooks registered, deliveryResults will be empty array or undefined
              const allSucceeded = !deliveryResults || deliveryResults.length === 0 || 
                                  deliveryResults.every(result => result.success !== false);
              
              if (allSucceeded) {
                // Clean up retry counter on success
                const retryKey = `${this.retryCountKeyPrefix}${entry.id}`;
                await this.redisClient.del(retryKey);
                
                await this.streamService.acknowledge(
                  this.consumerGroupName,
                  entry.id
                );
              } else {
                const failedCount = deliveryResults.filter(r => !r.success).length;
                // Log failure with accurate retry count
                if (entry.isPending) {
                  // This is a retry - log as "Retry X/5"
                  console.warn(`⚠️  [Webhook Manager] Webhook delivery failed for ${entry.id} - ${failedCount} webhook(s) failed. Retry ${retryCount}/${this.maxRetries}.`);
                } else {
                  // First failure - log as "Will retry" or "Attempt 1"
                  console.warn(`⚠️  [Webhook Manager] Webhook delivery failed for ${entry.id} - ${failedCount} webhook(s) failed. Will retry (attempt 1/${this.maxRetries}).`);
                  
                  // Initialize retry counter if this is the first failure (not a retry)
                  // Set retry counter to 0 for first attempt
                  await this.redisClient.set(retryKey, '0', 'EX', 86400); // Expire after 24 hours
                }
                // Message will be retried on next readGroup call (as pending)
                // Retry counter will be incremented on next retry (when entry.isPending = true)
              }
            } catch (error) {
              console.error('❌ Error processing stream message:', error);
              // Don't acknowledge on error - will retry (unless max retries exceeded)
              // Only check retry count for pending messages
              if (entry.isPending) {
                try {
                  const pendingInfo = await this.streamService.getPendingInfo(
                    this.consumerGroupName,
                    entry.id
                  );
                  const retryCount = pendingInfo ? pendingInfo.deliveryCount : 0;
                  if (retryCount >= this.maxRetries) {
                    console.error(`❌ [Webhook Manager] Message ${entry.id} exceeded max retries due to error. Acknowledging.`);
                    await this.streamService.acknowledge(
                      this.consumerGroupName,
                      entry.id
                    );
                  }
                } catch (ackError) {
                  // Ignore ack errors
                }
              }
            }
          }
        }
      } catch (error) {
        // Check if error is due to connection issue
        if (error.message && error.message.includes('not connected')) {
          console.log('⏳ [Webhook Manager] Stream service disconnected, waiting for reconnection...');
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
        } else {
          console.error('❌ Error in consumer loop:', error.message || error);
          // Wait a bit before retrying for other errors
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  /**
   * Deliver event to all matching webhooks
   * @param {Object} eventData - Event data from stream
   */
  async deliverToWebhooks(eventData) {
    const eventType = eventData.eventType;
    
    if (!eventType) {
      console.log(`⚠️  [Webhook Manager] Event data missing eventType, skipping`);
      return []; // Return empty array - no webhooks to deliver, consider it success
    }

    // Find all webhooks that match this event type and agentCode (if scoped)
    const eventAgentCode = eventData.agentCode || null; // Extract agentCode from event
    
    try {
      if (!this.isConnected) {
        await this.connectRedis();
      }

      // Get all webhook IDs from the index
      const webhookIds = await this.redisClient.sMembers(this.webhookIndexKey);
      
      // Removed verbose webhook checking logs
      
      if (webhookIds.length === 0) {
        console.log(`ℹ️  [Webhook Manager] No webhooks registered (checked DB ${this.webhookDb}, key: ${this.webhookIndexKey})`);
        return []; // Return empty array - no webhooks to deliver, consider it success
      }

      // Filter webhooks that match the criteria
      const matchingWebhooks = [];
      
      for (const webhookId of webhookIds) {
        const webhookData = await this.redisClient.hGetAll(`${this.webhookKeyPrefix}${webhookId}`);
        
        if (!webhookData || Object.keys(webhookData).length === 0) {
          continue; // Webhook not found, skip
        }

        // Parse webhook data
        const webhook = this.parseWebhookFromHash(webhookData);
        
        // Check if webhook is active
        if (webhook.status !== 'active') {
          continue;
        }

        // Check if webhook subscribes to this event type
        const eventTypes = JSON.parse(webhook.eventTypes || '[]');
        if (!eventTypes.includes(eventType)) {
          continue; // Webhook doesn't subscribe to this event type
        }

        // Check agentCode scope
        if (webhook.agentCode) {
          // Webhook is scoped to an agentCode - only receive events for that agentCode
          if (eventAgentCode !== webhook.agentCode) {
            continue; // Event doesn't match webhook's agentCode
          }
        }
        // Global webhooks (no agentCode) receive ALL events (with or without agentCode)

        matchingWebhooks.push(webhook);
      }

      if (matchingWebhooks.length === 0) {
        console.log(`ℹ️  [Webhook Manager] No active webhooks registered for event type: ${eventType}${eventAgentCode ? ` (agentCode: ${eventAgentCode})` : ''}`);
        return []; // Return empty array - no matching webhooks, consider it success
      }

      // Removed delivery start log

      // Deliver to all matching webhooks in parallel
      const deliveries = matchingWebhooks.map(webhook => 
        this.trigger(webhook, eventData)
      );

      const results = await Promise.allSettled(deliveries);
      
      // Log delivery results and collect return values
      const deliveryResults = results.map((result, index) => {
        const webhook = matchingWebhooks[index];
        if (result.status === 'fulfilled') {
          const deliveryResult = result.value;
          // Only log failures, not successes
          if (!deliveryResult.success) {
            console.log(`⚠️  [Webhook Manager] Failed to deliver to ${webhook.url} (status: ${deliveryResult.statusCode})`);
          }
          return deliveryResult;
        } else {
          console.error(`❌ [Webhook Manager] Error delivering to ${webhook.url}:`, result.reason);
          return { success: false, error: result.reason?.message || 'Unknown error' };
        }
      });

      // Return results for acknowledgment decision
      return deliveryResults;
    } catch (error) {
      console.error('❌ Error delivering to webhooks:', error);
      // Return empty array with failure if error occurs
      return [{ success: false, error: error.message }];
    }
  }

  /**
   * Parse webhook data from Redis hash
   */
  parseWebhookFromHash(hashData) {
    return {
      id: hashData.id,
      url: hashData.url,
      eventTypes: hashData.eventTypes || '[]',
      secret: hashData.secret || null,
      headers: hashData.headers ? JSON.parse(hashData.headers) : {},
      agentCode: hashData.agentCode || null,
      status: hashData.status || 'active',
      createdAt: hashData.createdAt || new Date().toISOString(),
      updatedAt: hashData.updatedAt || new Date().toISOString(),
      lastTriggered: hashData.lastTriggered || null,
      successCount: parseInt(hashData.successCount || '0'),
      failureCount: parseInt(hashData.failureCount || '0')
    };
  }

  /**
   * Convert webhook object to Redis hash
   */
  webhookToHash(webhook) {
    return {
      id: webhook.id,
      url: webhook.url,
      eventTypes: JSON.stringify(webhook.eventTypes),
      secret: webhook.secret || '',
      headers: JSON.stringify(webhook.headers || {}),
      agentCode: webhook.agentCode || '',
      status: webhook.status,
      createdAt: webhook.createdAt || new Date().toISOString(),
      updatedAt: webhook.updatedAt || new Date().toISOString(),
      lastTriggered: webhook.lastTriggered || '',
      successCount: (webhook.successCount || 0).toString(),
      failureCount: (webhook.failureCount || 0).toString()
    };
  }

  /**
   * Register a webhook
   * @param {Object} config - Webhook configuration
   * @param {string} config.url - Webhook URL
   * @param {string[]} config.eventTypes - Event types to subscribe to
   * @param {string} config.secret - Secret for signature verification
   * @param {Object} config.headers - Custom headers
   * @param {string} config.agentCode - Optional agent code to scope webhook to specific agent
   * @returns {Object} - Registered webhook
   */
  async register(config) {
    const { url, eventTypes, secret, headers, agentCode } = config;

    const webhook = {
      id: crypto.randomUUID(),
      url,
      eventTypes: Array.isArray(eventTypes) ? eventTypes : ['message:incoming', 'ai:response'],
      secret,
      headers: headers || {},
      agentCode: agentCode || null, // Scope to specific agent if provided
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastTriggered: null,
      successCount: 0,
      failureCount: 0
    };

    try {
      if (!this.isConnected) {
        await this.connectRedis();
      }

      // Store webhook as Redis hash
      const webhookKey = `${this.webhookKeyPrefix}${webhook.id}`;
      const hashData = this.webhookToHash(webhook);
      await this.redisClient.hSet(webhookKey, hashData);
      
      // Add to index SET
      await this.redisClient.sAdd(this.webhookIndexKey, webhook.id);
      
      // Verify it was saved
      const savedCount = await this.redisClient.sCard(this.webhookIndexKey);
      console.log(`💾 [Webhook Manager] Webhook saved to Redis (DB ${this.webhookDb}), total webhooks in index: ${savedCount}`);

      if (agentCode) {
        console.log(`✅ Registered webhook: ${webhook.id} -> ${url} (scoped to agentCode: ${agentCode})`);
      } else {
        console.log(`✅ Registered webhook: ${webhook.id} -> ${url} (global - receives all events)`);
      }

      // Initialize consumer if not already running
      if (!this.isConsuming) {
        await this.initialize();
      }

      return webhook;
    } catch (error) {
      console.error('❌ Error saving webhook to Valkey/Redis:', error);
      throw error;
    }
  }

  /**
   * List all webhooks
   * @returns {Array} - List of webhooks
   */
  async list() {
    try {
      if (!this.isConnected) {
        await this.connectRedis();
      }

      const webhookIds = await this.redisClient.sMembers(this.webhookIndexKey);
      const webhooks = [];

      for (const webhookId of webhookIds) {
        const hashData = await this.redisClient.hGetAll(`${this.webhookKeyPrefix}${webhookId}`);
        if (hashData && Object.keys(hashData).length > 0) {
          const webhook = this.parseWebhookFromHash(hashData);
          webhooks.push({
            id: webhook.id,
            url: webhook.url,
            eventTypes: JSON.parse(webhook.eventTypes),
            secret: webhook.secret,
            headers: webhook.headers,
            agentCode: webhook.agentCode,
            status: webhook.status,
            createdAt: webhook.createdAt,
            updatedAt: webhook.updatedAt,
            lastTriggered: webhook.lastTriggered,
            successCount: webhook.successCount,
            failureCount: webhook.failureCount
          });
        }
      }

      // Sort by createdAt (newest first)
      webhooks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return webhooks;
    } catch (error) {
      console.error('❌ Error listing webhooks from Valkey/Redis:', error);
      return [];
    }
  }

  /**
   * Get webhook by ID
   * @param {string} id - Webhook ID
   * @returns {Object|null} - Webhook or null
   */
  async get(id) {
    try {
      if (!this.isConnected) {
        await this.connectRedis();
      }

      const hashData = await this.redisClient.hGetAll(`${this.webhookKeyPrefix}${id}`);
      
      if (!hashData || Object.keys(hashData).length === 0) {
        return null;
      }

      const webhook = this.parseWebhookFromHash(hashData);
      return {
        id: webhook.id,
        url: webhook.url,
        eventTypes: JSON.parse(webhook.eventTypes),
        secret: webhook.secret,
        headers: webhook.headers,
        agentCode: webhook.agentCode,
        status: webhook.status,
        createdAt: webhook.createdAt,
        updatedAt: webhook.updatedAt,
        lastTriggered: webhook.lastTriggered,
        successCount: webhook.successCount,
        failureCount: webhook.failureCount
      };
    } catch (error) {
      console.error('❌ Error getting webhook from Valkey/Redis:', error);
      return null;
    }
  }

  /**
   * Update webhook
   * @param {string} id - Webhook ID
   * @param {Object} updates - Updates to apply
   * @returns {Object|null} - Updated webhook or null
   */
  async update(id, updates) {
    try {
      if (!this.isConnected) {
        await this.connectRedis();
      }

      const webhookKey = `${this.webhookKeyPrefix}${id}`;
      const existingHash = await this.redisClient.hGetAll(webhookKey);
      
      if (!existingHash || Object.keys(existingHash).length === 0) {
        return null;
      }

      const webhook = this.parseWebhookFromHash(existingHash);

      // Apply updates (agentCode cannot be updated)
      if (updates.url !== undefined) webhook.url = updates.url;
      if (updates.eventTypes !== undefined) webhook.eventTypes = JSON.stringify(updates.eventTypes);
      if (updates.secret !== undefined) webhook.secret = updates.secret || '';
      if (updates.headers !== undefined) webhook.headers = JSON.stringify(updates.headers);
      if (updates.status !== undefined) webhook.status = updates.status;
      webhook.updatedAt = new Date().toISOString();

      // Save back to Redis
      const hashData = this.webhookToHash(webhook);
      await this.redisClient.hSet(webhookKey, hashData);

      return {
        id: webhook.id,
        url: webhook.url,
        eventTypes: JSON.parse(webhook.eventTypes),
        secret: webhook.secret,
        headers: JSON.parse(webhook.headers),
        agentCode: webhook.agentCode,
        status: webhook.status,
        createdAt: webhook.createdAt,
        updatedAt: webhook.updatedAt,
        lastTriggered: webhook.lastTriggered,
        successCount: webhook.successCount,
        failureCount: webhook.failureCount
      };
    } catch (error) {
      console.error('❌ Error updating webhook in Valkey/Redis:', error);
      return null;
    }
  }

  /**
   * Delete webhook
   * @param {string} id - Webhook ID
   * @returns {boolean} - True if deleted, false if not found
   */
  async delete(id) {
    try {
      if (!this.isConnected) {
        await this.connectRedis();
      }

      const webhookKey = `${this.webhookKeyPrefix}${id}`;
      const deleted = await this.redisClient.del(webhookKey);
      
      // Remove from index
      await this.redisClient.sRem(this.webhookIndexKey, id);

      return deleted > 0;
    } catch (error) {
      console.error('❌ Error deleting webhook from Valkey/Redis:', error);
      return false;
    }
  }

  /**
   * Trigger webhook with event data
   * @param {Object} webhook - Webhook configuration
   * @param {Object} eventData - Event data to send
   * @returns {Object} - Delivery result
   */
  async trigger(webhook, eventData) {
    try {
      const payload = {
        event: eventData,
        timestamp: new Date().toISOString()
      };

      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'WhatsApp-PubSub-Service/1.0',
        ...(webhook.headers || {})
      };

      // Add signature if secret is provided
      if (webhook.secret) {
        const signature = crypto
          .createHmac('sha256', webhook.secret)
          .update(JSON.stringify(payload))
          .digest('hex');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
      }

      const response = await axios.post(webhook.url, payload, {
        headers,
        timeout: 10000, // 10 second timeout
        validateStatus: (status) => status < 500 // Accept 2xx, 3xx, 4xx (but not 5xx)
      });

      // Update webhook stats in Redis (atomic operation)
      try {
        if (!this.isConnected) {
          await this.connectRedis();
        }
        const webhookKey = `${this.webhookKeyPrefix}${webhook.id}`;
        const updateFields = {
          lastTriggered: new Date().toISOString()
        };
        
        if (response.status >= 200 && response.status < 300) {
          await this.redisClient.hIncrBy(webhookKey, 'successCount', 1);
        } else {
          await this.redisClient.hIncrBy(webhookKey, 'failureCount', 1);
        }
        await this.redisClient.hSet(webhookKey, updateFields);
      } catch (error) {
        console.error('❌ Error updating webhook stats in Valkey/Redis:', error);
      }

      return {
        success: response.status >= 200 && response.status < 300,
        statusCode: response.status
      };
    } catch (error) {
      // Update webhook stats in Redis (atomic operation)
      try {
        if (!this.isConnected) {
          await this.connectRedis();
        }
        const webhookKey = `${this.webhookKeyPrefix}${webhook.id}`;
        await this.redisClient.hSet(webhookKey, {
          lastTriggered: new Date().toISOString()
        });
        await this.redisClient.hIncrBy(webhookKey, 'failureCount', 1);
      } catch (statsError) {
        console.error('❌ Error updating webhook stats in Valkey/Redis:', statsError);
      }

      return {
        success: false,
        statusCode: error.response?.status || 0,
        error: error.message
      };
    }
  }

  /**
   * Test webhook delivery
   * @param {string} id - Webhook ID
   * @returns {Object} - Test result
   */
  async test(id) {
    const webhook = await this.get(id);
    if (!webhook) {
      return null;
    }

    const testEvent = {
      eventType: 'test',
      message: 'This is a test event',
      timestamp: new Date().toISOString()
    };

    return await this.trigger(webhook, testEvent);
  }
}

module.exports = WebhookManager;
