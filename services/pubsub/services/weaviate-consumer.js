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

      // Try to create consumer group (will fail if it already exists, which is fine)
      // Use '0' to read all messages from beginning (for initial setup)
      // Or '$' to start from new messages only (for production)
      // Note: Once created, startId can't be changed - only affects new consumer groups
      const startId = process.env.WEAVIATE_CONSUMER_START_ID || '0';
      let groupCreated = false;
      try {
        await this.streamService.createConsumerGroup(this.consumerGroupName, startId);
        console.log(`✅ Created consumer group: ${this.consumerGroupName} (startId: ${startId})`);
        groupCreated = true;
      } catch (error) {
        if (error.message && error.message.includes('BUSYGROUP')) {
          console.log(`ℹ️  Consumer group ${this.consumerGroupName} already exists`);
          // Check if we need to recreate it with different startId
          // If startId was '$' but we want '0', we need to delete and recreate
          if (startId === '0') {
            console.log(`ℹ️  Consumer group exists - will read new messages with '>' (messages after group creation)`);
            console.log(`⚠️  Note: Messages published before consumer group creation won't be read`);
          }
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
        
        if (groupCreated && streamLength > 0) {
          console.log(`⚠️  Consumer group was just created with ${streamLength} existing message(s)`);
          console.log(`   Will attempt to read from beginning on first read`);
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
              console.log(`📥 [Weaviate] Processing ${eventType} (entry: ${entry.id}, agentCode: ${agentCode})`);
              
              // Process the stream message
              await this.processStreamMessage(entry.id, eventData);
              
              // ACK only after successful ChatEvent insert
              await this.streamService.acknowledge(
                this.consumerGroupName,
                entry.id
              );
              
              console.log(`✅ [Weaviate] Processed ${eventType} (entry: ${entry.id})`);
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

    if (!eventData.agentCode) {
      console.log(`⚠️  [Weaviate Consumer] Event missing agentCode, skipping (entryId: ${entryId}, eventType: ${eventData.eventType})`);
      return; // Skip events without agentCode (no tenant)
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

    // Ensure Conversation exists
    await this.ensureConversation(tenant, {
      conversation_id: conversationId,
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
    await this.insertChatEvent(tenant, chatEvent, embedding, eventUuid);

    // Update Conversation state (also update client_id and platform if they're missing)
    // Extract client_id and platform from event data (clientId is already declared above)
    const clientIdValue = eventData.clientId || null;
    const platformValue = eventData.platform || null;
    
    // Reuse lastEventContentString from above for the update
    // The content is already a JSON string
    
    await this.updateConversation(tenant, {
      conversation_id: conversationId,
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
          // If content is a string, format it as a text message
          if (typeof eventData.content === 'string') {
            return JSON.stringify([{
              type: eventData.messageType || 'text',
              text: eventData.content
            }]);
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
        // Format incoming message as text type
        const content = eventData.content || '';
        return JSON.stringify([{
          type: 'text',
          text: String(content)
        }]);
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

      // Check if conversation exists by querying
      const checkResult = await this.weaviateClient.graphql
        .get()
        .withClassName('Conversation')
        .withFields('conversation_id')
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
        console.log(`ℹ️  [Weaviate Consumer] ChatEvent ${chatEvent.event_id} already exists, skipping insert`);
        return; // Event already exists, skip insert (idempotent)
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

