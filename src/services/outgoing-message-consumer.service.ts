import { WPPConnectWhatsAppService } from './whatsapp.service';
import { WPPConnectMessageHandler } from '../core/message-handler';

// Import JavaScript services (they're in services/pubsub)
const StreamService = require('../../services/pubsub/services/stream.service');

/**
 * Outgoing Message Consumer Service
 * Consumes "message:outgoing" events from the stream and sends them via WPP/WA-Official
 */
export class OutgoingMessageConsumerService {
  private streamService: any;
  private whatsappService: WPPConnectWhatsAppService;
  private messageHandler: WPPConnectMessageHandler | null;
  private isRunning: boolean = false;
  private consumeLoopPromise: Promise<void> | null = null;
  
  // Consumer group configuration
  // Use separate environment variable for WPP to avoid conflicts with WA-Official consumer
  // WPP_OUTGOING_CONSUMER_GROUP takes precedence, falls back to OUTGOING_MESSAGE_CONSUMER_GROUP for backward compatibility
  private consumerGroupName = process.env.WPP_OUTGOING_CONSUMER_GROUP || process.env.OUTGOING_MESSAGE_CONSUMER_GROUP || 'outgoing-message-consumer-wpp';
  private consumerName = process.env.WPP_OUTGOING_CONSUMER_NAME || process.env.OUTGOING_MESSAGE_CONSUMER_NAME || `outgoing-message-consumer-wpp-${process.pid}`;

  constructor(whatsappService: WPPConnectWhatsAppService, messageHandler?: WPPConnectMessageHandler | null) {
    this.whatsappService = whatsappService;
    this.messageHandler = messageHandler || null;
  }

  /**
   * Initialize and start consuming
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️  Outgoing message consumer is already running');
      return;
    }

    try {
      // Initialize stream service
      this.streamService = new StreamService();
      await this.streamService.connect();

      // Ensure consumer group exists
      await this.ensureConsumerGroup();

      // Log consumer group status for debugging
      try {
        const groupInfo = await this.streamService.getConsumerGroupInfo(this.consumerGroupName);
        if (groupInfo) {
          console.log(`ℹ️  [Outgoing Message Consumer] Consumer group status: lastDeliveredId=${groupInfo.lastDeliveredId}, pending=${groupInfo.pending}`);
          console.log(`   Will read: pending messages first (retries), then new messages (after lastDeliveredId)`);
        }
      } catch (error) {
        console.warn(`⚠️  [Outgoing Message Consumer] Could not check consumer group info:`, error);
      }

      // Start consumption loop
      this.isRunning = true;
      this.consumeLoopPromise = this.consumeLoop();

      const streamName = this.streamService.config?.streamName || 'unknown';
      console.log(`✅ Outgoing message consumer started (group: ${this.consumerGroupName}, consumer: ${this.consumerName}, stream: ${streamName})`);
    } catch (error) {
      console.error('❌ Error starting outgoing message consumer:', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop consuming
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.consumeLoopPromise) {
      await this.consumeLoopPromise;
    }
    console.log('🛑 Outgoing message consumer stopped');
  }

  /**
   * Ensure consumer group exists
   */
  private async ensureConsumerGroup(): Promise<void> {
    try {
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
      // If you need to process historical messages, set OUTGOING_MESSAGE_CONSUMER_START_ID='0' before first run
      const startId = process.env.OUTGOING_MESSAGE_CONSUMER_START_ID || '$';
      try {
        await this.streamService.createConsumerGroup(this.consumerGroupName, startId);
        console.log(`✅ Created consumer group: ${this.consumerGroupName} (startId: ${startId === '$' ? 'new messages only' : 'from beginning'})`);
      } catch (error: any) {
        if (error.message && error.message.includes('BUSYGROUP')) {
          console.log(`ℹ️  Consumer group ${this.consumerGroupName} already exists`);
          // If consumer group already exists, it will use its current position
          // readGroup will handle: pending messages first, then new messages with '>'
          try {
            const groupInfo = await this.streamService.getConsumerGroupInfo(this.consumerGroupName);
            if (groupInfo) {
              console.log(`ℹ️  Consumer group info: lastDeliveredId=${groupInfo.lastDeliveredId}, pending=${groupInfo.pending}`);
              console.log(`   Will read: pending messages first (retries), then new messages (after lastDeliveredId)`);
            }
          } catch (infoError) {
            // Ignore errors getting group info
          }
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error('❌ Error ensuring consumer group:', error);
      throw error;
    }
  }

  /**
   * Main consumption loop
   */
  private async consumeLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        // Check connection
        const streamConnected = this.streamService.isConnected && 
                               this.streamService.client && 
                               this.streamService.client.isReady;
        if (!streamConnected) {
          console.log('⏳ [Outgoing Message Consumer] Waiting for stream service to connect...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        // Read messages from stream
        let entries;
        try {
          // Debug: Check consumer group status occasionally
          if (Math.random() < 0.05) { // 5% chance to log group status
            try {
              const groupInfo = await this.streamService.getConsumerGroupInfo(this.consumerGroupName);
              if (groupInfo) {
                const streamName = this.streamService.config?.streamName || 'unknown';
                console.log(`🔍 [Outgoing Message Consumer] Group status: lastDeliveredId=${groupInfo.lastDeliveredId}, pending=${groupInfo.pending}, stream=${streamName}`);
              }
            } catch (infoError) {
              // Ignore errors getting group info
            }
          }
          
          // Check for pending messages before reading (only log if there are pending)
          try {
            const groupInfo = await this.streamService.getConsumerGroupInfo(this.consumerGroupName);
            if (groupInfo && groupInfo.pending > 0) {
              console.log(`⚠️  [Outgoing Message Consumer] WARNING: ${groupInfo.pending} pending message(s) - these need to be processed first (lastDeliveredId: ${groupInfo.lastDeliveredId})`);
            }
          } catch (infoError) {
            // Ignore errors getting group info
          }
          
          entries = await this.streamService.readGroup(
            this.consumerGroupName,
            this.consumerName,
            {
              count: 10, // Read up to 10 messages at a time
              block: 1000 // Block for 1 second if no messages
            }
          );
          
          // Only log if we received messages
          if (entries && entries.length > 0) {
            console.log(`📥 [Outgoing Message Consumer] Received ${entries.length} entry/entries from stream`);
          }
        } catch (readError: any) {
          if (!readError.message || !readError.message.includes('timeout')) {
            console.error(`❌ [Outgoing Message Consumer] Error in readGroup:`, readError.message || readError);
          }
          entries = [];
        }

        // Debug: Log when we're polling and what we received
        const streamName = this.streamService.config?.streamName || 'unknown';
        if (entries && entries.length > 0) {
          console.log(`📥 [Outgoing Message Consumer] Received ${entries.length} entry/entries from stream: ${streamName}`);
        } else {
          // Log polling status occasionally (every ~10 polls to avoid spam)
          if (Math.random() < 0.1) {
            console.log(`🔍 [Outgoing Message Consumer] Polling stream: ${streamName} (group: ${this.consumerGroupName}, consumer: ${this.consumerName}) - no messages`);
          }
        }

        if (entries && entries.length > 0) {
          console.log(`📥 [Outgoing Message Consumer] Processing ${entries.length} entry/entries`);
          for (const entry of entries) {
            try {
              const eventData = entry.data; // Already parsed by readGroup
              
              // Debug: Log all event types we receive with full details
              console.log(`📥 [Outgoing Message Consumer] Received event: ${eventData.eventType} (entry: ${entry.id})`);
              console.log(`   Full event data:`, JSON.stringify({
                eventType: eventData.eventType,
                platform: eventData.platform,
                clientId: eventData.clientId,
                userIdentifier: eventData.userIdentifier,
                hasContent: !!eventData.content
              }, null, 2));
              
              // Only process "message:outgoing" events
              if (eventData.eventType !== 'message:outgoing') {
                // ACK non-outgoing messages to skip them
                console.log(`⏭️  [Outgoing Message Consumer] Skipping non-outgoing event: ${eventData.eventType}`);
                await this.streamService.acknowledge(this.consumerGroupName, entry.id);
                continue;
              }

              // Check if this message is for WPP platform (this consumer only handles WPP)
              const platform = eventData.platform || 'wpp';
              console.log(`🔍 [Outgoing Message Consumer] Checking platform: ${platform} (expected: wpp)`);
              if (platform !== 'wpp') {
                // This message is for WA-Official, not WPP
                // Don't ACK it - let the WA-Official consumer handle it
                // But we need to ACK it to prevent it from blocking the stream
                // The WA-Official consumer should be reading from the same group
                console.log(`⏭️  [Outgoing Message Consumer] Skipping message for platform: ${platform} (this consumer handles 'wpp' only)`);
                await this.streamService.acknowledge(this.consumerGroupName, entry.id);
                continue;
              }
              
              console.log(`✅ [Outgoing Message Consumer] Message passed platform check, will process`);

              console.log(`📤 [Outgoing Message Consumer] Processing outgoing message (entry: ${entry.id})`);
              console.log(`📤 [Outgoing Message Consumer] Event data:`, JSON.stringify(eventData, null, 2));

              // Process the outgoing message
              try {
                await this.processOutgoingMessage(eventData);
                // ACK after successful processing
                await this.streamService.acknowledge(this.consumerGroupName, entry.id);
                console.log(`✅ [Outgoing Message Consumer] Processed outgoing message (entry: ${entry.id})`);
              } catch (error: any) {
                // ACK even on error to prevent unlimited retries
                // Errors like "No LID for user" won't be fixed by retrying
                console.error(`❌ [Outgoing Message Consumer] Error processing message ${entry.id}:`, error);
                console.error(`   Error message: ${error.message || 'Unknown error'}`);
                console.warn(`⚠️  [Outgoing Message Consumer] ACKing message despite error to prevent unlimited retries`);
                await this.streamService.acknowledge(this.consumerGroupName, entry.id);
                console.log(`✅ [Outgoing Message Consumer] ACKed message ${entry.id} (error logged, no retry)`);
              }
            } catch (error: any) {
              // Outer catch for any errors in the try block (including ACK errors)
              console.error(`❌ [Outgoing Message Consumer] Unexpected error processing message ${entry.id}:`, error);
              // Try to ACK anyway to prevent blocking
              try {
                await this.streamService.acknowledge(this.consumerGroupName, entry.id);
                console.log(`✅ [Outgoing Message Consumer] ACKed message ${entry.id} after unexpected error`);
              } catch (ackError) {
                console.error(`❌ [Outgoing Message Consumer] Failed to ACK message ${entry.id}:`, ackError);
              }
            }
          }
        }
      } catch (error: any) {
        if (error.message && error.message.includes('not connected')) {
          console.log('⏳ [Outgoing Message Consumer] Stream service disconnected, waiting for reconnection...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          console.error('❌ [Outgoing Message Consumer] Error in consume loop:', error.message || error);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  /**
   * Process outgoing message event
   */
  private async processOutgoingMessage(eventData: any): Promise<void> {
    const { clientId, platform, userIdentifier: userIdentifierRaw, content, messageType = 'text', messageId } = eventData;

    // Ensure userIdentifier is a string
    const userIdentifier = typeof userIdentifierRaw === 'string' 
      ? userIdentifierRaw 
      : String(userIdentifierRaw || '');

    if (!clientId || !userIdentifier || !content) {
      console.error('❌ [Outgoing Message Consumer] Missing required fields:', { clientId, userIdentifier, content });
      return;
    }

    try {
      if (platform === 'wpp') {
        // Send via WPP client
        const clientInfo = this.whatsappService.getClient(clientId);
        if (!clientInfo || !clientInfo.client) {
          console.error(`❌ [Outgoing Message Consumer] WPP client ${clientId} not found or not ready`);
          return;
        }

        if (typeof clientInfo.client.sendText !== 'function') {
          console.error(`❌ [Outgoing Message Consumer] WPP client ${clientId} does not support sendText`);
          return;
        }

        // Format user ID - use stored full ID from message handler (same as AI replies)
        // This ensures we use the same format that works for AI responses
        let fullUserId: string;
        if (userIdentifier.includes('@')) {
          // Already has suffix, use as-is
          fullUserId = userIdentifier;
        } else {
          // Try to get stored full ID from message handler (same method used by AI replies)
          const phoneNumber = userIdentifier.replace(/@.*$/, ''); // Remove any existing suffix
          const storedFullId = this.messageHandler?.getStoredFullId(clientId, phoneNumber);
          
          if (storedFullId) {
            // Use stored full ID (with correct suffix like @lid, @c.us, etc.)
            fullUserId = storedFullId;
            console.log(`ℹ️  [Outgoing Message Consumer] Using stored full ID: ${fullUserId} (from message handler)`);
          } else {
            // Fallback: determine format based on identifier pattern
            // Phone numbers typically: 8-15 digits total, often start with country codes
            // LID/group IDs: usually 15+ digits, don't follow phone number patterns
            // Very long numeric IDs (15+ digits) are likely LIDs, try @lid first
            const numericId = /^\d+$/.test(userIdentifier);
            const idLength = userIdentifier.length;
            
            if (numericId && idLength >= 15) {
              // Very long numeric ID (15+ digits) - likely LID, try @lid first
              fullUserId = `${userIdentifier}@lid`;
              console.log(`ℹ️  [Outgoing Message Consumer] No stored full ID found, using @lid format for long numeric ID (${idLength} digits): ${fullUserId}`);
            } else if (numericId && idLength >= 8 && idLength <= 14) {
              // Medium length (8-14 digits) - likely phone number, try @c.us first
              fullUserId = `${userIdentifier}@c.us`;
              console.log(`ℹ️  [Outgoing Message Consumer] No stored full ID found, using @c.us format for phone number (${idLength} digits): ${fullUserId}`);
            } else if (numericId) {
              // Short numeric ID (< 8 digits) - try @c.us first
              fullUserId = `${userIdentifier}@c.us`;
              console.log(`ℹ️  [Outgoing Message Consumer] No stored full ID found, using @c.us format for short numeric ID (${idLength} digits): ${fullUserId}`);
            } else {
              // Non-numeric - try @c.us first
              fullUserId = `${userIdentifier}@c.us`;
              console.log(`ℹ️  [Outgoing Message Consumer] No stored full ID found, using @c.us format for non-numeric ID: ${fullUserId}`);
            }
          }
        }

        // Send message with retry on format error
        let result: any;
        let sendError: any = null;
        try {
          result = await clientInfo.client.sendText(fullUserId, content);
        } catch (error: any) {
          sendError = error;
          const errorMessage = error?.message || '';
          
          // Handle "No LID for user" error - try alternative format
          if (errorMessage.includes('No LID for user')) {
            if (fullUserId.endsWith('@lid')) {
              // Tried @lid, retry with @c.us
              console.warn(`⚠️  [Outgoing Message Consumer] No LID for user with @lid format, retrying with @c.us`);
              const alternativeFormat = `${userIdentifier}@c.us`;
              try {
                result = await clientInfo.client.sendText(alternativeFormat, content);
                fullUserId = alternativeFormat; // Update for logging
                sendError = null; // Clear error
                console.log(`✅ [Outgoing Message Consumer] Successfully sent with @c.us format after @lid failed`);
              } catch (retryError: any) {
                // Both formats failed, keep original error
                sendError = error;
              }
            } else if (fullUserId.endsWith('@c.us')) {
              // Tried @c.us but got "No LID for user" - this means it needs @lid format
              console.warn(`⚠️  [Outgoing Message Consumer] No LID for user with @c.us format, retrying with @lid`);
              const alternativeFormat = `${userIdentifier}@lid`;
              try {
                result = await clientInfo.client.sendText(alternativeFormat, content);
                fullUserId = alternativeFormat; // Update for logging
                sendError = null; // Clear error
                console.log(`✅ [Outgoing Message Consumer] Successfully sent with @lid format after @c.us failed`);
              } catch (retryError: any) {
                // Both formats failed, keep original error
                sendError = error;
              }
            }
          }
          // If invalid number error and we tried @c.us, retry with @lid
          else if ((errorMessage.includes('invalid') || errorMessage.includes('Invalid')) && fullUserId.endsWith('@c.us')) {
            console.warn(`⚠️  [Outgoing Message Consumer] Invalid number with @c.us, retrying with @lid format`);
            const alternativeFormat = `${userIdentifier}@lid`;
            try {
              result = await clientInfo.client.sendText(alternativeFormat, content);
              fullUserId = alternativeFormat; // Update for logging
              sendError = null; // Clear error
              console.log(`✅ [Outgoing Message Consumer] Successfully sent with @lid format after @c.us failed`);
            } catch (retryError: any) {
              // Both formats failed, keep original error
              sendError = error;
            }
          }
          
          // If still has error, throw it
          if (sendError) {
            throw sendError;
          }
        }
        const messageId = (result && typeof result === 'object' && result.id?.id) 
          ? result.id.id 
          : eventData.messageId || `outgoing-${Date.now()}`;

        console.log(`✅ [Outgoing Message Consumer] Sent message to ${userIdentifier} via WPP client ${clientId} (messageId: ${messageId})`);

        // After sending, publish as ai:response event for Weaviate storage
        // This ensures the message appears in chat history
        try {
          const { StreamProducer } = require('../../services/pubsub/client/producer');
          const producer = new StreamProducer();
          await producer.connect();
          
          await producer.publishAgentResponse({
            clientId,
            platform: 'wpp',
            userIdentifier,
            agentCode: eventData.agentCode || null,
            messageId: messageId || eventData.messageId, // Ensure messageId is passed
            requestMessage: '', // No request message for API-initiated messages
            response: {
              messages: [{
                type: messageType,
                text: content
              }]
            },
            // Also include content and messageType at top level for fallback extraction
            content: content,
            messageType: messageType,
            metadata: {
              source: 'api',
              postedBy: eventData.metadata?.postedBy || 'system',
              sender: eventData.metadata?.sender || null, // Pass sender info from JWT
              messageId: messageId || eventData.messageId,
              timestamp: new Date().toISOString(),
              // Include clientMessageId from original message:outgoing event for idempotency matching
              clientMessageId: eventData.metadata?.clientMessageId || null
            }
          });
        } catch (streamError: any) {
          console.warn('⚠️ [Outgoing Message Consumer] Failed to publish agent:response for Weaviate (message was still sent):', streamError);
        }

      } else if (platform === 'wa-official') {
        // For WA-Official, we need to use the Meta API
        // This would require the whatsapp-official service to handle it
        // For now, log that it's not yet implemented
        console.warn(`⚠️ [Outgoing Message Consumer] WA-Official platform not yet supported for outgoing messages (clientId: ${clientId})`);
        // TODO: Implement WA-Official message sending
        // This would require calling the Meta WhatsApp Business API
      } else {
        console.error(`❌ [Outgoing Message Consumer] Unknown platform: ${platform}`);
      }
    } catch (error: any) {
      console.error(`❌ [Outgoing Message Consumer] Error processing outgoing message:`, error);
      console.error(`   Error details: ${error.message || 'Unknown error'}`);
      // Check for specific errors that shouldn't be retried
      const errorMessage = error.message || '';
      if (errorMessage.includes('No LID for user') || 
          errorMessage.includes('not found') ||
          errorMessage.includes('does not exist')) {
        console.warn(`⚠️  [Outgoing Message Consumer] Non-retryable error detected - will ACK message`);
      }
      throw error; // Re-throw - caller will ACK even on error
    }
  }
}
