const weaviateModule = require('weaviate-ts-client');
const weaviate = weaviateModule.default || weaviateModule;
const generateUuid5 = weaviateModule.generateUuid5 || (weaviate && weaviate.generateUuid5);
const { initializeSchemas } = require('../schemas/weaviate-schemas');

// Namespaces for deterministic UUID generation
const CONVERSATION_UUID_NAMESPACE = 'd95d4cb8-5d6b-4a7f-9f22-0f6dbd6e2a01';
const EVENT_UUID_NAMESPACE = '2b64c458-b1be-4f9f-9d78-6efba9f62a2d';

/**
 * Weaviate Consumer Service
 * 
 * Consumes events from Redis Streams and persists them to Weaviate
 * Uses multi-tenancy with agent_code as the tenant
 * 
 * Responsibilities:
 * - Consume events from Redis Streams
 * - Parse event payload (as-is, no reshaping)
 * - Resolve tenant = agent_code
 * - Ensure Conversation exists
 * - Insert ChatEvent (idempotent by event_id)
 * - Update Conversation.last_event_at and participant_ids
 * - ACK Redis stream message only after successful insert
 */
class WeaviateConsumer {
  constructor(streamService) {
    this.streamService = streamService;
    this.weaviateClient = null;
    this.isRunning = false;
    this.consumeLoopPromise = null;
    this.lastPollLog = null; // For periodic polling logs
    this.processedEntryIds = new Set(); // Track processed entry IDs to detect duplicates
    this.duplicateCount = 0; // Count of duplicate entry IDs
    
    // Consumer group configuration
    this.consumerGroupName = process.env.WEAVIATE_CONSUMER_GROUP || 'weaviate-consumer';
    this.consumerName = process.env.WEAVIATE_CONSUMER_NAME || `weaviate-consumer-${process.pid}`;
    
    // Weaviate configuration
    this.weaviateUrl = process.env.WEAVIATE_URL || 'http://localhost:8080';
    this.weaviateApiKey = process.env.WEAVIATE_API_KEY || null;
    this.openAiApiKey = process.env.OPENAI_API_KEY || null;
    
    // Initialize Weaviate client
    this.initializeWeaviateClient();
  }

  /**
   * Initialize Weaviate client
   */
  initializeWeaviateClient() {
    try {
      let scheme = 'http';
      let host = '';
      let port = 8080;

      // Handle URL parsing - support both full URLs and hostnames
      if (this.weaviateUrl.startsWith('http://') || this.weaviateUrl.startsWith('https://')) {
        // Full URL provided
        const url = new URL(this.weaviateUrl);
        scheme = url.protocol === 'https:' ? 'https' : 'http';
        host = url.hostname;
        port = url.port ? parseInt(url.port) : (scheme === 'https' ? 443 : 8080);
      } else {
        // Just hostname provided - parse it manually
        const parts = this.weaviateUrl.split(':');
        host = parts[0];
        if (parts.length > 1) {
          port = parseInt(parts[1]) || 8080;
        } else {
          // Default ports based on common patterns
          // If hostname contains 'railway' or looks like a production domain, use https
          if (this.weaviateUrl.includes('railway') || 
              this.weaviateUrl.includes('.up.') || 
              this.weaviateUrl.includes('.app') ||
              this.weaviateUrl.includes('heroku') ||
              this.weaviateUrl.includes('.cloud')) {
            scheme = 'https';
            port = 443;
          } else {
            scheme = 'http';
            port = 8080;
          }
        }
      }

      // Build client configuration
      const clientConfig = {
        scheme,
        host,
      };

      // Add port if not default
      if ((scheme === 'http' && port !== 8080) || (scheme === 'https' && port !== 443)) {
        clientConfig.port = port;
      }

      // Add API key headers if provided
      if (this.weaviateApiKey || this.openAiApiKey) {
        clientConfig.headers = {};
        if (this.weaviateApiKey) {
          clientConfig.headers['Authorization'] = `Bearer ${this.weaviateApiKey}`;
        }
        if (this.openAiApiKey) {
          clientConfig.headers['X-OpenAI-Api-Key'] = this.openAiApiKey;
        }
      }

      this.weaviateClient = weaviate.client(clientConfig);

      const portDisplay = ((scheme === 'http' && port !== 8080) || (scheme === 'https' && port !== 443)) 
        ? `:${port}` 
        : '';
      console.log(`✅ Weaviate client initialized: ${scheme}://${host}${portDisplay}`);
    } catch (error) {
      console.error('❌ Error initializing Weaviate client:', error);
      throw error;
    }
  }

  /**
   * Connect to Weaviate and initialize schemas
   */
  async connect() {
    try {
      // Test connection
      await this.weaviateClient.misc
        .metaGetter()
        .do()
        .then((meta) => {
          console.log('✅ Connected to Weaviate:', meta.version);
        })
        .catch((error) => {
          console.error('❌ Failed to connect to Weaviate:', error);
          throw error;
        });

      // Initialize schemas
      await initializeSchemas(this.weaviateClient);
    } catch (error) {
      console.error('❌ Error connecting to Weaviate:', error);
      throw error;
    }
  }

  /**
   * Start consuming from Redis Stream
   */
  async start() {
    if (this.isRunning) {
      console.log('⚠️  Weaviate consumer is already running');
      return;
    }

    try {
      // Ensure consumer group exists
      await this.ensureConsumerGroup();

      // Connect to Weaviate
      await this.connect();

      // Start consumption loop
      this.isRunning = true;
      this.consumeLoopPromise = this.consumeLoop();

      console.log(`✅ Weaviate consumer started (group: ${this.consumerGroupName}, consumer: ${this.consumerName})`);
      console.log(`📡 Stream: ${this.streamService.config.streamName}`);
      console.log(`🔄 Consumer loop started - polling for messages...`);
    } catch (error) {
      console.error('❌ Error starting Weaviate consumer:', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop consuming
   */
  async stop() {
    this.isRunning = false;
    if (this.consumeLoopPromise) {
      await this.consumeLoopPromise;
    }
    console.log('🛑 Weaviate consumer stopped');
  }

  /**
   * Ensure consumer group exists in Redis Stream
   */
  async ensureConsumerGroup() {
    try {
      // Check both the flag and the actual Redis client state
      const streamConnected = this.streamService.isConnected && 
                             this.streamService.client && 
                             this.streamService.client.isReady;
      if (!streamConnected) {
        throw new Error('Stream service not connected');
      }

      // Best Practice: Use '$' to start from new messages only
      // This ensures:
      // - No processing of historical messages (unless explicitly needed)
      // - Consumer group tracks its position via lastDeliveredId
      // - '>' will read messages after the group's position
      // 
      // Note: Once created, startId can't be changed - only affects new consumer groups
      // If you need to process historical messages, set WEAVIATE_CONSUMER_START_ID='0' before first run
      const startId = process.env.WEAVIATE_CONSUMER_START_ID || '$';
      let groupCreated = false;
      let groupExists = false;
      try {
        await this.streamService.createConsumerGroup(this.consumerGroupName, startId);
        console.log(`✅ Created consumer group: ${this.consumerGroupName} (startId: ${startId === '$' ? 'new messages only' : 'from beginning'})`);
        groupCreated = true;
      } catch (error) {
        if (error.message && error.message.includes('BUSYGROUP')) {
          console.log(`ℹ️  Consumer group ${this.consumerGroupName} already exists`);
          groupExists = true;
          // If consumer group already exists, it will use its current position
          // readGroup will handle: pending messages first, then new messages with '>'
          console.log(`ℹ️  Will read from group's current position (pending first, then new messages)`);
        } else {
          throw error;
        }
      }

      // Diagnostic: Check stream length and consumer group info
      try {
        const streamLength = await this.streamService.client.xLen(this.streamService.config.streamName);
        console.log(`📊 Stream info: ${this.streamService.config.streamName} has ${streamLength} total message(s)`);
        
        const groupInfo = await this.streamService.getConsumerGroupInfo(this.consumerGroupName);
        if (groupInfo) {
          console.log(`📊 Consumer group info:`);
          console.log(`   - Name: ${groupInfo.name}`);
          console.log(`   - Last Delivered ID: ${groupInfo.lastDeliveredId}`);
          console.log(`   - Pending: ${groupInfo.pending}`);
          console.log(`   - Consumers: ${groupInfo.consumers}`);
        }
        
        if (groupCreated && streamLength > 0 && startId === '$') {
          console.log(`ℹ️  Consumer group was just created with ${streamLength} existing message(s) in stream`);
          console.log(`   Will only read NEW messages going forward (startId: '$')`);
          console.log(`   Existing messages will NOT be read (use WEAVIATE_CONSUMER_START_ID='0' if you need to process history)`);
        } else if (groupCreated && streamLength > 0 && startId === '0') {
          console.log(`⚠️  Consumer group was just created with ${streamLength} existing message(s)`);
          console.log(`   Will attempt to read ALL messages from beginning (startId: '0')`);
        } else if (groupExists && streamLength > 0) {
          console.log(`ℹ️  Consumer group exists - will read from its current position`);
          console.log(`   Stream has ${streamLength} total message(s)`);
          console.log(`   Will read: pending messages first (retries), then new messages (after lastDeliveredId)`);
        }
      } catch (diagError) {
        console.warn(`⚠️  Could not get stream diagnostics:`, diagError.message);
      }
    } catch (error) {
      console.error('❌ Error ensuring consumer group:', error);
      throw error;
    }
  }

  /**
   * Main consumption loop
   * Reads one message at a time from the stream
   */
  async consumeLoop() {
    while (this.isRunning) {
      try {
        // Check both the flag and the actual Redis client state
        const streamConnected = this.streamService.isConnected && 
                               this.streamService.client && 
                               this.streamService.client.isReady;
        if (!streamConnected) {
          console.log('⏳ [Weaviate Consumer] Waiting for stream service to connect...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        // Read one message at a time (MVP requirement: no batching)
        let entries;
        try {
          entries = await this.streamService.readGroup(
            this.consumerGroupName,
            this.consumerName,
            {
              count: 1, // Read one message at a time
              block: 5000 // Block for 5 seconds if no messages (increased to catch new messages faster)
            }
          );
          
          // Log when messages are read (minimal logging)
          if (entries && entries.length > 0) {
            const entryCount = entries.reduce((sum, entry) => {
              if (entry && entry.data) return sum + 1;
              return sum;
            }, 0);
            if (entryCount > 0) {
              // Only log occasionally to reduce noise
              if (Math.random() < 0.2) { // 20% of the time
                console.log(`📥 [Weaviate] Read ${entryCount} message(s) from stream`);
              }
            }
          }
        } catch (readError) {
          // Only log non-timeout errors
          if (!readError.message || !readError.message.includes('timeout')) {
            console.error(`❌ [Weaviate Consumer] Error in readGroup:`, readError.message || readError);
          }
          entries = [];
        }
        
        // Add periodic log to show consumer is alive (every 60 seconds, only when no messages)
        if (!entries || entries.length === 0) {
          const now = Date.now();
          if (!this.lastPollLog || (now - this.lastPollLog) > 60000) {
            // Get current group info for debugging
            try {
              const groupInfo = await this.streamService.getConsumerGroupInfo(this.consumerGroupName);
              const streamLength = await this.streamService.client.xLen(this.streamService.config.streamName);
              
              console.log(`🔍 [Weaviate] Polling stream: ${this.streamService.config.streamName} (${streamLength} messages, lastDeliveredId: ${groupInfo?.lastDeliveredId || 'unknown'})`);
            } catch (debugError) {
              // Silent - don't log debug errors
            }
            this.lastPollLog = now;
          }
        }

        if (entries && entries.length > 0) {
          for (const entry of entries) {
            try {
              const eventData = entry.data; // Already parsed by readGroup
              
              // Log minimal info about processing (reduced verbosity)
              const eventType = eventData?.eventType || 'unknown';
              const agentCode = eventData?.agentCode || 'none';
              
              // Check if we've seen this entry ID before (detect if same message is being read repeatedly)
              if (this.processedEntryIds.has(entry.id)) {
                this.duplicateCount++;
                console.error(`⚠️  [Weaviate] DUPLICATE ENTRY ID DETECTED: ${entry.id} (seen ${this.duplicateCount} times) - Consumer group position may not be advancing!`);
                // Keep the entry ID in the set to track how many times it's seen
              } else {
                this.processedEntryIds.add(entry.id);
                // Limit set size to prevent memory issues (keep last 10000)
                if (this.processedEntryIds.size > 10000) {
                  const firstId = this.processedEntryIds.values().next().value;
                  this.processedEntryIds.delete(firstId);
                }
              }
              
              console.log(`📥 [Weaviate] Processing ${eventType} (entry: ${entry.id}, agentCode: ${agentCode})`);
              
              // Process the stream message
              // processStreamMessage returns true if message was processed or skipped (both should be ACKed)
              const wasProcessed = await this.processStreamMessage(entry.id, eventData);
              
              // Always ACK the message to advance the consumer group position
              // This prevents the same message from being read repeatedly
              // Both inserted and skipped (already exists) messages should be ACKed
              await this.streamService.acknowledge(
                this.consumerGroupName,
                entry.id
              );
              
              // Log based on whether it was a new insert or a duplicate
              // Track entry ID to detect if we're reading the same message repeatedly
              if (wasProcessed === false) {
                // This indicates the event already existed - still ACKed to prevent reprocessing
                // Reduce verbosity - only log occasionally for duplicates to avoid spam
                // This is normal when dev consumer reads messages already processed by prod
                if (Math.random() < 0.05) { // Log only 5% of skipped duplicates
                  console.log(`✅ [Weaviate] Skipped duplicate ${eventType} (entry: ${entry.id}) - already exists, ACKed`);
                }
              } else {
                console.log(`✅ [Weaviate] Processed ${eventType} (entry: ${entry.id}) - ACKed`);
              }
              
              // Periodically log consumer group position and stats to verify it's advancing
              if (Math.random() < 0.01) { // Log 1% of the time
                try {
                  const groupInfo = await this.streamService.getConsumerGroupInfo(this.consumerGroupName);
                  if (groupInfo) {
                    console.log(`📍 [Weaviate] Consumer group position: lastDeliveredId=${groupInfo.lastDeliveredId}, pending=${groupInfo.pending}, processed=${this.processedEntryIds.size}, duplicates=${this.duplicateCount}`);
                    
                    // Warn if we're seeing duplicates
                    if (this.duplicateCount > 0) {
                      console.warn(`⚠️  [Weaviate] WARNING: ${this.duplicateCount} duplicate entry IDs detected - consumer group may not be advancing correctly!`);
                    }
                  }
                } catch (e) {
                  // Ignore errors
                }
              }
            } catch (error) {
              console.error(`❌ [Weaviate Consumer] Error processing message ${entry.id}:`, error);
              // Don't acknowledge on error - will retry
            }
          }
        }
      } catch (error) {
        // Check if error is due to connection issue
        if (error.message && error.message.includes('not connected')) {
          console.log('⏳ [Weaviate Consumer] Stream service disconnected, waiting for reconnection...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          console.error('❌ [Weaviate Consumer] Error in consume loop:', error.message || error);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  /**
   * Process a stream message
   * 
   * @param {string} entryId - Stream entry ID
   * @param {Object} eventData - Event data from stream
   */
  async processStreamMessage(entryId, eventData) {
    // Validate minimal required fields
    if (!eventData.eventType) {
      throw new Error('Event data missing eventType');
    }

    // Skip message:outgoing events - these are internal routing events, not chat events
    if (eventData.eventType === 'message:outgoing') {
      console.log(`⏭️  [Weaviate Consumer] Skipping message:outgoing event (entryId: ${entryId}) - internal routing event`);
      return;
    }

    // Handle needattention:changed events - update Conversation.last_attention
    if (eventData.eventType === 'needattention:changed') {
      if (!eventData.agentCode) {
        console.log(`⚠️  [Weaviate Consumer] needattention:changed event missing agentCode, skipping (entryId: ${entryId})`);
        return true; // ACK to prevent reprocessing
      }

      const tenant = eventData.agentCode;
      const clientId = eventData.clientId;
      const userIdentifier = eventData.userIdentifier;

      if (!clientId || !userIdentifier) {
        console.log(`⚠️  [Weaviate Consumer] needattention:changed event missing clientId or userIdentifier, skipping (entryId: ${entryId})`);
        return true;
      }

      const conversationId = `${clientId}:${userIdentifier}`;
      
      // If option is null, it means released - store null instead of object with all null values
      let lastAttentionValue;
      if (eventData.option === null || eventData.option === undefined) {
        // Released - store null (Weaviate text fields use empty string for null)
        lastAttentionValue = null;
      } else {
        // Build lastAttention object from event data
        const lastAttention = {
          option: eventData.option,
          reason: eventData.reason || null,
          from: eventData.from || null,
          to: eventData.to || null,
          taken: eventData.taken || null
        };
        lastAttentionValue = JSON.stringify(lastAttention);
      }

      try {
        // Update conversation's last_attention field
        await this.updateConversation(tenant, {
          conversation_id: conversationId,
          last_attention: lastAttentionValue
        });

        console.log(`✅ [Weaviate Consumer] Updated last_attention for conversation ${conversationId} (option: ${eventData.option || 'released'})`);
        return true; // ACK the event
      } catch (error) {
        console.error(`❌ [Weaviate Consumer] Error updating last_attention for conversation ${conversationId}:`, error);
        // Still ACK to prevent reprocessing (conversation might not exist yet)
        return true;
      }
    }

    if (!eventData.agentCode) {
      console.log(`⚠️  [Weaviate Consumer] Event missing agentCode, skipping (entryId: ${entryId}, eventType: ${eventData.eventType})`);
      return true; // Return true to ACK - we intentionally skip events without agentCode
    }

    // Extract required fields (assume payload already contains all required fields)
    // 
    // agentCode is retrieved DYNAMICALLY from getAgentForUser() in the message handler:
    // 1. Checks privateAgentAssignment first (user-specific agent override)
    // 2. Falls back to ai_agent_code (client default agent)
    // 3. This allows different users to have different agents, and the agent can change over time
    // 
    // The agentCode comes from the stream event and can vary per user/conversation
    // If you see "CSNEW" or any other value, it's the agent assigned to that user in the database
    const tenant = eventData.agentCode; // tenant = agent_code (dynamic per user/conversation)
    const eventType = eventData.eventType;
    const userIdentifier = eventData.userIdentifier;
    const clientId = eventData.clientId;
    
    // Log agentCode to verify it's being extracted correctly (will show dynamic values)
    // This confirms the agentCode is coming from the stream event, not hardcoded

    // Generate conversation_id from clientId + userIdentifier
    const conversationId = `${clientId}:${userIdentifier}`;

    // Generate UUIDs for Weaviate object IDs (must be UUID)
    const conversationUuid = generateUuid5
      ? generateUuid5(`${tenant}:${conversationId}`, CONVERSATION_UUID_NAMESPACE)
      : undefined;

    // Generate event_id from messageId or entryId
    const eventId = eventData.messageId || entryId;
    const eventUuid = generateUuid5
      ? generateUuid5(`${tenant}:${conversationId}:${eventId}`, EVENT_UUID_NAMESPACE)
      : undefined;

    // Extract sender information from metadata
    const senderInfo = this.extractSenderInfo(eventData);
    
    // Extract participant_ids
    const participantIds = this.extractParticipantIds(eventData, userIdentifier);

    // Parse created_at from timestamp
    const createdAt = eventData.timestamp || new Date().toISOString();
    
    // Use timestamp as sequence (milliseconds since epoch) - no query needed, reduces resource consumption
    const sequence = new Date(createdAt).getTime();

    // Extract visibility (default to 'visible' if not provided)
    const visibility = eventData.visibility || 'visible';

    // Extract embedding if provided (optional)
    const embedding = eventData.embedding || null;

    // Extract and format content based on event type
    const content = this.extractFormattedContent(eventData, eventType);

    // Build ChatEvent object
    const chatEvent = {
      conversation_id: conversationId,
      event_id: eventId,
      event_type: eventType,
      sender_type: senderInfo.type,
      sender_id: senderInfo.id,
      sender_display_name: senderInfo.displayName || null,
      sender_role_label: senderInfo.roleLabel || null,
      sender_avatar_url: senderInfo.avatarUrl || null,
      participant_ids: participantIds,
      content: content, // Formatted message content as JSON string
      sequence: sequence,
      created_at: createdAt,
      visibility: visibility
    };

    // Store last_event_content as JSON string (same format as ChatEvent.content)
    // content is already a JSON string from extractFormattedContent
    const lastEventContentString = content || '[]';

    // Extract hashed_id from event data (pre-calculated by producer)
    const hashedId = eventData.hashedId || eventData.hashed_id || null;
    if (hashedId) {
      console.log(`🔑 [Weaviate Consumer] Extracted hashedId from event: ${hashedId} (conversationId: ${conversationId}, tenant: ${tenant})`);
    } else {
      console.warn(`⚠️  [Weaviate Consumer] No hashedId in event data (conversationId: ${conversationId}, tenant: ${tenant}, eventType: ${eventType})`);
    }

    // Ensure Conversation exists
    await this.ensureConversation(tenant, {
      conversation_id: conversationId,
      hashed_id: hashedId,
      client_id: eventData.clientId || null,
      platform: eventData.platform || null,
      participant_ids: participantIds,
      created_at: createdAt,
      last_event_id: eventId,
      last_event_type: eventType,
      last_event_content: lastEventContentString, // Store as JSON string (same as ChatEvent.content)
      last_sender_type: senderInfo.type,
      last_sender_id: senderInfo.id,
      last_sender_display_name: senderInfo.displayName,
      status: 'open'
    }, conversationUuid);

    // Insert ChatEvent (idempotent by event_id)
    // Returns true if inserted, false if already exists (skipped)
    const wasInserted = await this.insertChatEvent(tenant, chatEvent, embedding, eventUuid);

    // Update Conversation state (also update client_id and platform if they're missing)
    // Extract client_id and platform from event data (clientId is already declared above)
    const clientIdValue = eventData.clientId || null;
    const platformValue = eventData.platform || null;
    
    // Reuse lastEventContentString from above for the update
    // The content is already a JSON string
    // Reuse hashedId from above (already extracted)

    await this.updateConversation(tenant, {
      conversation_id: conversationId,
      hashed_id: hashedId,
      client_id: clientIdValue,
      platform: platformValue,
      last_event_at: createdAt,
      last_event_id: eventId,
      last_event_type: eventType,
      last_event_content: lastEventContentString, // Use JSON string
      last_sender_type: senderInfo.type,
      last_sender_id: senderInfo.id,
      last_sender_display_name: senderInfo.displayName,
      participant_ids: participantIds
    });

    // Return true if inserted, false if skipped (already exists)
    // Both cases should be ACKed to prevent reprocessing
    return wasInserted !== false;
  }

  /**
   * Extract sender information from event data
   * 
   * @param {Object} eventData - Event data
   * @returns {Object} Sender information
   */
  extractSenderInfo(eventData) {
    const eventType = eventData.eventType;
    
    // Determine sender type based on event type
    let senderType = 'user';
    let senderId = eventData.userIdentifier || 'unknown';
    let displayName = null;
    let roleLabel = null;
    let avatarUrl = null;

    if (eventType === 'ai:response') {
      senderType = 'ai:agent'; // Use "ai:agent" instead of just "agent"
      senderId = eventData.agentCode || 'unknown';
      roleLabel = 'assistant';
      // For AI agents, use agentCode as display name if not available
      displayName = eventData.agentCode || senderId;
    } else if (eventType === 'agent:response') {
      senderType = 'agent'; // Human agent or API-initiated
      
      // Extract sender information from metadata (from JWT) if available
      if (eventData.metadata && eventData.metadata.sender) {
        const sender = eventData.metadata.sender;
        senderId = sender.senderId || sender.id || eventData.agentCode || eventData.metadata?.postedBy || 'unknown';
        displayName = sender.senderDisplayName || sender.displayName || sender.name || eventData.metadata?.postedBy || eventData.agentCode || senderId;
        roleLabel = sender.senderRoleLabel || sender.roleLabel || 'agent';
        avatarUrl = sender.senderAvatarUrl || sender.avatarUrl || null;
      } else {
        // Fallback to default values if sender info not provided
        senderId = eventData.agentCode || eventData.metadata?.postedBy || 'unknown';
        displayName = eventData.metadata?.postedBy || eventData.agentCode || senderId;
        roleLabel = 'agent';
        avatarUrl = null;
      }
    } else if (eventType === 'message:incoming') {
      senderType = 'user';
      senderId = eventData.userIdentifier || 'unknown';
      
      // Extract from metadata if available
      if (eventData.metadata && eventData.metadata.sender) {
        const sender = eventData.metadata.sender;
        displayName = sender.name || sender.pushname || sender.formattedName || null;
        avatarUrl = sender.profilePicUrl || sender.avatarUrl || null;
      }
      
      // If display name is not available, use sender_id
      if (!displayName) {
        displayName = senderId;
      }
    }

    return {
      type: senderType,
      id: senderId,
      displayName: displayName || senderId, // Fallback to sender_id if display name is not available
      roleLabel,
      avatarUrl
    };
  }

  /**
   * Extract participant IDs from event data
   * 
   * @param {Object} eventData - Event data
   * @param {string} userIdentifier - User identifier
   * @returns {string[]} Array of participant IDs
   */
  extractParticipantIds(eventData, userIdentifier) {
    const participants = new Set();
    
    // Always include the user (the actual participant)
    if (userIdentifier) {
      participants.add(String(userIdentifier));
    }
    
    // Include agent if it's an AI response (agent is a participant when it responds)
    // Note: For message:incoming events, we don't include the agent yet (only when they respond)
    if ((eventData.eventType === 'ai:response' || eventData.eventType === 'agent:response') && eventData.agentCode) {
      participants.add(String(eventData.agentCode));
    }
    
    // Note: clientId (e.g., "javear-client-wpp") is NOT a participant - it's just a platform/client identifier
    // The clientId identifies which WhatsApp client instance handled the message, not who participated
    
    // Return as array of strings, ensuring all are strings
    return Array.from(participants).map(p => String(p));
  }

  /**
   * Extract and format message content based on event type
   * 
   * @param {Object} eventData - Event data
   * @param {string} eventType - Event type (message:incoming, ai:response, or agent:response)
   * @returns {string} JSON stringified array of formatted messages
   */
  extractFormattedContent(eventData, eventType) {
    try {
      if (eventType === 'ai:response' || eventType === 'agent:response') {
        // Extract formatted messages from AI/agent response
        // Try response.messages first (already formatted)
        if (eventData.response && eventData.response.messages && Array.isArray(eventData.response.messages)) {
          return JSON.stringify(eventData.response.messages);
        }
        
        // Try response.formatted.whatsapp
        if (eventData.response && 
            eventData.response.formatted && 
            eventData.response.formatted.whatsapp && 
            Array.isArray(eventData.response.formatted.whatsapp)) {
          return JSON.stringify(eventData.response.formatted.whatsapp);
        }
        
        // For agent:response, also try content field directly (fallback for API messages)
        if (eventType === 'agent:response' && eventData.content) {
          // Check if this is a media message
          const messageType = eventData.messageType || eventData.message_type || 'text';
          const mediaTypes = ['image', 'video', 'audio', 'file', 'document', 'sticker'];
          const isMediaType = mediaTypes.includes(messageType);
          const mediaUrl = eventData.mediaUrl || eventData.media_url;
          const caption = eventData.caption || null;
          
          // If content is a string
          if (typeof eventData.content === 'string') {
            if (isMediaType && mediaUrl) {
              // Format as media message
              const messageObj = {
                type: messageType,
                url: mediaUrl
              };
              
              // Add caption if available (prefer explicit caption, fallback to content)
              if (caption && caption.trim() !== '') {
                messageObj.caption = caption;
              } else if (eventData.content && eventData.content.trim() !== '') {
                messageObj.caption = eventData.content;
              }
              
              return JSON.stringify([messageObj]);
            } else {
              // Format as text message
              return JSON.stringify([{
                type: messageType || 'text',
                text: eventData.content
              }]);
            }
          }
          // If content is already an array, stringify it
          if (Array.isArray(eventData.content)) {
            return JSON.stringify(eventData.content);
          }
        }
        
        // Fallback: empty array
        console.warn(`⚠️  [Weaviate Consumer] No content found for ${eventType} event (entryId: ${eventData.messageId || 'unknown'})`);
        return JSON.stringify([]);
      } else if (eventType === 'message:incoming') {
        // Check if this is a media message
        const messageType = eventData.messageType || eventData.message_type || 'text';
        const mediaTypes = ['image', 'video', 'audio', 'file', 'document', 'sticker'];
        const isMediaType = mediaTypes.includes(messageType);
        
        // For media messages, extract mediaUrl from metadata.message.mediaUrls (array)
        let mediaUrl = eventData.mediaUrl || eventData.media_url;
        if (!mediaUrl && isMediaType && eventData.metadata && eventData.metadata.message) {
          const mediaUrls = eventData.metadata.message.mediaUrls || eventData.metadata.message.media_urls || [];
          if (Array.isArray(mediaUrls) && mediaUrls.length > 0) {
            mediaUrl = mediaUrls[0]; // Use first media URL
          }
        }
        
        const content = eventData.content || ''; // Caption for media, text for regular messages
        
        if (isMediaType && mediaUrl) {
          // Format as media message
          const messageObj = {
            type: messageType,
            url: mediaUrl
          };
          
          // Add caption if available
          if (content && content.trim() !== '') {
            messageObj.caption = content;
          }
          
          return JSON.stringify([messageObj]);
        } else {
          // Format as text message
          return JSON.stringify([{
            type: 'text',
            text: String(content)
          }]);
        }
      }
      
      // Default: empty array
      return JSON.stringify([]);
    } catch (error) {
      console.error('❌ Error extracting formatted content:', error);
      return JSON.stringify([]);
    }
  }

  /**
   * Ensure tenant exists, create if missing
   * 
   * @param {string} tenant - Tenant name (agent_code)
   */
  async ensureTenant(tenant) {
    try {
      // Try to get existing tenants for Conversation class
      let conversationTenants = [];
      try {
        const result = await this.weaviateClient.schema.tenantsGetter('Conversation').do();
        conversationTenants = (result || []).map(t => t.name || t);
      } catch (error) {
        // If error, assume tenant doesn't exist yet - will create
      }

      // Create tenant for Conversation if it doesn't exist
      if (!conversationTenants.includes(tenant)) {
        try {
          await this.weaviateClient.schema.tenantsCreator('Conversation', [{ name: tenant }]).do();
          console.log(`✅ [Weaviate Consumer] Created tenant "${tenant}" for Conversation class`);
        } catch (error) {
          if (error.message && (error.message.includes('already exists') || error.message.includes('already active'))) {
          } else {
            throw error;
          }
        }
      }

      // Try to get existing tenants for ChatEvent class
      let chatEventTenants = [];
      try {
        const result = await this.weaviateClient.schema.tenantsGetter('ChatEvent').do();
        chatEventTenants = (result || []).map(t => t.name || t);
      } catch (error) {
        // If error, assume tenant doesn't exist yet - will create
      }

      // Create tenant for ChatEvent if it doesn't exist
      if (!chatEventTenants.includes(tenant)) {
        try {
          await this.weaviateClient.schema.tenantsCreator('ChatEvent', [{ name: tenant }]).do();
          console.log(`✅ [Weaviate Consumer] Created tenant "${tenant}" for ChatEvent class`);
        } catch (error) {
          if (error.message && (error.message.includes('already exists') || error.message.includes('already active'))) {
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      // Log error but don't throw - we'll try to continue
      console.error(`⚠️  [Weaviate Consumer] Error ensuring tenant "${tenant}":`, error.message || error);
    }
  }


  /**
   * Ensure Conversation exists, create if missing
   * 
   * @param {string} tenant - Tenant (agent_code)
   * @param {Object} conversationData - Conversation data
   */
  async ensureConversation(tenant, conversationData, conversationUuid) {
    try {
      // Ensure tenant exists first
      await this.ensureTenant(tenant);

      // Check if conversation exists by querying (also check hashed_id)
      const checkResult = await this.weaviateClient.graphql
        .get()
        .withClassName('Conversation')
        .withFields('conversation_id hashed_id _additional { id }')
        .withTenant(tenant)
        .withWhere({
          path: ['conversation_id'],
          operator: 'Equal',
          valueString: conversationData.conversation_id
        })
        .withLimit(1)
        .do();

      const exists = checkResult.data && 
                     checkResult.data.Get && 
                     checkResult.data.Get.Conversation && 
                     checkResult.data.Get.Conversation.length > 0;

      if (exists && conversationData.hashed_id) {
        // Conversation exists - check if it needs hashed_id update
        const existingConv = checkResult.data.Get.Conversation[0];
        const existingHashedId = existingConv.hashed_id;
        const conversationUuid = existingConv._additional?.id;
        
        // If conversation exists but doesn't have hashed_id, update it
        if (!existingHashedId && conversationData.hashed_id && conversationUuid) {
          try {
            await this.weaviateClient.data
              .merger()
              .withId(conversationUuid)
              .withClassName('Conversation')
              .withTenant(tenant)
              .withProperties({
                hashed_id: String(conversationData.hashed_id)
              })
              .do();
            console.log(`✅ [Weaviate Consumer] Updated hashed_id for conversation ${conversationData.conversation_id} (tenant: ${tenant})`);
          } catch (updateError) {
            console.warn(`⚠️  [Weaviate Consumer] Failed to update hashed_id for conversation ${conversationData.conversation_id}:`, updateError.message);
          }
        }
      }

      if (!exists) {
        // Conversation doesn't exist, create it
        // Ensure participant_ids are all strings and properly formatted as array
        const participantIds = Array.isArray(conversationData.participant_ids) 
          ? conversationData.participant_ids.map(p => String(p))
          : [];
        
        // Store last_event_content as JSON string (same format as ChatEvent.content)
        const lastEventContent = conversationData.last_event_content || '[]';

        const creator = this.weaviateClient.data
          .creator()
          .withClassName('Conversation')
          .withTenant(tenant)
          .withProperties({
            conversation_id: conversationData.conversation_id,
            hashed_id: conversationData.hashed_id ? String(conversationData.hashed_id) : null,
            client_id: conversationData.client_id ? String(conversationData.client_id) : null,
            platform: conversationData.platform ? String(conversationData.platform) : null,
            participant_ids: participantIds.length > 0 ? participantIds : [], // Ensure it's always an array
            created_at: conversationData.created_at,
            last_event_at: conversationData.created_at,
            last_event_id: conversationData.last_event_id ? String(conversationData.last_event_id) : null,
            last_event_type: conversationData.last_event_type ? String(conversationData.last_event_type) : null,
            last_event_content: typeof lastEventContent === 'string' ? lastEventContent : JSON.stringify(lastEventContent || []), // Store as JSON string
            last_sender_type: conversationData.last_sender_type ? String(conversationData.last_sender_type) : null,
            last_sender_id: conversationData.last_sender_id ? String(conversationData.last_sender_id) : null,
            last_sender_display_name: conversationData.last_sender_display_name ? String(conversationData.last_sender_display_name) : null,
            status: conversationData.status || 'open',
            last_attention: conversationData.last_attention || '{}',
            metadata: '{}' // Empty JSON object as string (for flexible structure)
          });

        if (conversationUuid) {
          creator.withId(conversationUuid);
        }

        await creator.do();

        console.log(`✅ [Weaviate Consumer] Created conversation ${conversationData.conversation_id} (tenant: ${tenant})`);
      }
    } catch (error) {
      console.error('❌ Error ensuring conversation:', error);
      throw error;
    }
  }

  /**
   * Insert ChatEvent (idempotent by event_id)
   * 
   * @param {string} tenant - Tenant (agent_code)
   * @param {Object} chatEvent - ChatEvent data
   * @param {number[]} embedding - Optional embedding vector
   */
  async insertChatEvent(tenant, chatEvent, embedding, eventUuid) {
    try {
      // Ensure tenant exists first
      await this.ensureTenant(tenant);

      // Check if event already exists (idempotency check)
      const existingResult = await this.weaviateClient.graphql
        .get()
        .withClassName('ChatEvent')
        .withFields('event_id')
        .withTenant(tenant)
        .withWhere({
          operator: 'And',
          operands: [
            {
              path: ['conversation_id'],
              operator: 'Equal',
              valueString: chatEvent.conversation_id
            },
            {
              path: ['event_id'],
              operator: 'Equal',
              valueString: chatEvent.event_id
            }
          ]
        })
        .withLimit(1)
        .do();

      if (existingResult.data && existingResult.data.Get && existingResult.data.Get.ChatEvent && existingResult.data.Get.ChatEvent.length > 0) {
        // Reduce log verbosity for duplicates - only log occasionally to avoid spam
        // This is normal when dev consumer reads old messages already processed by prod
        if (Math.random() < 0.1) { // Log only 10% of duplicates
          console.log(`ℹ️  [Weaviate Consumer] ChatEvent ${chatEvent.event_id} already exists, skipping insert (this is normal when catching up on existing messages)`);
        }
        return false; // Event already exists, skip insert (idempotent) - return false to indicate skipped
      }

      // Insert the event - ensure all string fields are strings
      const builder = this.weaviateClient.data
        .creator()
        .withClassName('ChatEvent')
        .withTenant(tenant)
        .withProperties({
          conversation_id: String(chatEvent.conversation_id || ''),
          event_id: String(chatEvent.event_id || ''),
          event_type: String(chatEvent.event_type || ''),
          sender_type: String(chatEvent.sender_type || ''),
          sender_id: String(chatEvent.sender_id || ''),
          sender_display_name: chatEvent.sender_display_name ? String(chatEvent.sender_display_name) : null,
          sender_role_label: chatEvent.sender_role_label ? String(chatEvent.sender_role_label) : null,
          sender_avatar_url: chatEvent.sender_avatar_url ? String(chatEvent.sender_avatar_url) : null,
          participant_ids: Array.isArray(chatEvent.participant_ids) 
            ? chatEvent.participant_ids.map(p => String(p))
            : [],
          content: String(chatEvent.content || '[]'), // Formatted message content as JSON string
          sequence: typeof chatEvent.sequence === 'number' ? chatEvent.sequence : parseInt(chatEvent.sequence) || 0,
          created_at: String(chatEvent.created_at || new Date().toISOString()),
          visibility: String(chatEvent.visibility || 'visible')
        });

      if (eventUuid) {
        builder.withId(eventUuid);
      }

      // Add vector if provided
      if (embedding && Array.isArray(embedding)) {
        builder.withVector(embedding);
      }

      await builder.do();

      // Removed verbose success log - only log errors
      return true; // Successfully inserted
    } catch (error) {
      console.error('❌ Error inserting ChatEvent:', error);
      throw error;
    }
  }

  /**
   * Update Conversation state
   * 
   * @param {string} tenant - Tenant (agent_code)
   * @param {Object} updateData - Update data
   */
  async updateConversation(tenant, updateData) {
    try {
      // Ensure tenant exists first
      await this.ensureTenant(tenant);

      // Get current conversation with UUID
      const getResult = await this.weaviateClient.graphql
        .get()
        .withClassName('Conversation')
        .withFields('participant_ids client_id platform _additional { id }')
        .withTenant(tenant)
        .withWhere({
          path: ['conversation_id'],
          operator: 'Equal',
          valueString: updateData.conversation_id
        })
        .withLimit(1)
        .do();

      if (!getResult.data || !getResult.data.Get || !getResult.data.Get.Conversation || getResult.data.Get.Conversation.length === 0) {
        console.log(`⚠️  [Weaviate Consumer] Conversation ${updateData.conversation_id} not found for update`);
        return;
      }

      const conversationObj = getResult.data.Get.Conversation[0];
      const conversationUuid = conversationObj._additional?.id;
      
      if (!conversationUuid) {
        console.log(`⚠️  [Weaviate Consumer] Conversation ${updateData.conversation_id} found but no UUID available`);
        return;
      }

      // Merge participant_ids (union of old and new) - ensure all are strings
      const currentParticipants = (conversationObj.participant_ids || []).map(p => String(p));
      const newParticipants = (updateData.participant_ids || []).map(p => String(p));
      const mergedParticipants = Array.from(new Set([...currentParticipants, ...newParticipants]));

      // Build update properties - update client_id and platform if they're null in the existing conversation
      // Also update last event information
      const updateProperties = {
        last_event_at: updateData.last_event_at,
        participant_ids: mergedParticipants
      };

      // Update hashed_id if provided
      if (updateData.hashed_id) {
        updateProperties.hashed_id = String(updateData.hashed_id);
      }

      // Update last event information if provided
      if (updateData.last_event_id) {
        updateProperties.last_event_id = String(updateData.last_event_id);
      }
      if (updateData.last_event_type) {
        updateProperties.last_event_type = String(updateData.last_event_type);
      }
      if (updateData.last_event_content) {
        // Store last_event_content as JSON string (same format as ChatEvent.content)
        updateProperties.last_event_content = typeof updateData.last_event_content === 'string' 
          ? updateData.last_event_content 
          : JSON.stringify(updateData.last_event_content || []);
      }
      if (updateData.last_sender_type) {
        updateProperties.last_sender_type = String(updateData.last_sender_type);
      }
      if (updateData.last_sender_id) {
        updateProperties.last_sender_id = String(updateData.last_sender_id);
      }
      if (updateData.last_sender_display_name) {
        updateProperties.last_sender_display_name = String(updateData.last_sender_display_name);
      }
      // Explicitly handle null case for last_attention (released state)
      if ('last_attention' in updateData) {
        if (updateData.last_attention === null || updateData.last_attention === undefined) {
          // Released - clear the field by setting to empty string (Weaviate text fields use empty string for null)
          updateProperties.last_attention = '';
        } else {
          updateProperties.last_attention = typeof updateData.last_attention === 'string' 
            ? updateData.last_attention 
            : JSON.stringify(updateData.last_attention);
        }
      }

      // Update client_id and platform if they're missing (null) in the existing conversation
      const currentClientId = conversationObj.client_id;
      const currentPlatform = conversationObj.platform;
      
      // Update client_id and platform if they're missing (null) in the existing conversation
      if (updateData.client_id) {
        if (!currentClientId || currentClientId === null || currentClientId === 'null' || currentClientId === '') {
          updateProperties.client_id = String(updateData.client_id);
        }
      }
      if (updateData.platform) {
        if (!currentPlatform || currentPlatform === null || currentPlatform === 'null' || currentPlatform === '') {
          updateProperties.platform = String(updateData.platform);
        }
      }

      // Update conversation using merger with UUID
      await this.weaviateClient.data
        .merger()
        .withId(conversationUuid)
        .withClassName('Conversation')
        .withTenant(tenant)
        .withProperties(updateProperties)
        .do();

      // Removed verbose success log - only log errors
    } catch (error) {
      console.error('❌ Error updating conversation:', error);
      throw error;
    }
  }
}

module.exports = WeaviateConsumer;

