const StreamService = require('../../pubsub/services/stream.service.js');
const clientManager = require('./client-manager'); // Exported as singleton instance
const axios = require('axios');

/**
 * Outgoing Message Consumer Service for WA-Official
 * Consumes "message:outgoing" events from the stream and sends them via Meta WhatsApp Business API
 */
class OutgoingMessageConsumer {
  constructor() {
    this.streamService = null;
    this.isRunning = false;
    this.consumeLoopPromise = null;
    
    // Consumer group configuration
    // Use separate environment variable for WA-Official to avoid conflicts with WPP consumer
    // WA_OFFICIAL_OUTGOING_CONSUMER_GROUP takes precedence, falls back to OUTGOING_MESSAGE_CONSUMER_GROUP for backward compatibility
    this.consumerGroupName = process.env.WA_OFFICIAL_OUTGOING_CONSUMER_GROUP || process.env.OUTGOING_MESSAGE_CONSUMER_GROUP || 'outgoing-message-consumer-wa-official';
    this.consumerName = process.env.WA_OFFICIAL_OUTGOING_CONSUMER_NAME || process.env.OUTGOING_MESSAGE_CONSUMER_NAME || `wa-official-outgoing-consumer-${process.pid}`;
  }

  /**
   * Initialize and start consuming
   */
  async start() {
    if (this.isRunning) {
      console.log('⚠️  WA-Official outgoing message consumer is already running');
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
          console.log(`ℹ️  [WA-Official Outgoing Consumer] Consumer group status: lastDeliveredId=${groupInfo.lastDeliveredId}, pending=${groupInfo.pending}`);
          console.log(`   Will read: pending messages first (retries), then new messages (after lastDeliveredId)`);
        }
      } catch (error) {
        console.warn(`⚠️  [WA-Official Outgoing Consumer] Could not check consumer group info:`, error);
      }

      // Start consumption loop
      this.isRunning = true;
      this.consumeLoopPromise = this.consumeLoop();

      const streamName = this.streamService.config?.streamName || 'unknown';
      console.log(`✅ WA-Official outgoing message consumer started (group: ${this.consumerGroupName}, consumer: ${this.consumerName}, stream: ${streamName})`);
    } catch (error) {
      console.error('❌ Error starting WA-Official outgoing message consumer:', error);
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
    console.log('🛑 WA-Official outgoing message consumer stopped');
  }

  /**
   * Ensure consumer group exists
   */
  async ensureConsumerGroup() {
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
      } catch (error) {
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
  async consumeLoop() {
    while (this.isRunning) {
      try {
        const streamConnected = this.streamService.isConnected && 
                               this.streamService.client && 
                               this.streamService.client.isReady;
        if (!streamConnected) {
          console.log('⏳ [WA-Official Outgoing Consumer] Waiting for stream service to connect...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        // Debug: Check consumer group status occasionally
        if (Math.random() < 0.05) { // 5% chance to log group status
          try {
            const groupInfo = await this.streamService.getConsumerGroupInfo(this.consumerGroupName);
            if (groupInfo) {
              const streamName = this.streamService.config?.streamName || 'unknown';
              console.log(`🔍 [WA-Official Outgoing Consumer] Group status: lastDeliveredId=${groupInfo.lastDeliveredId}, pending=${groupInfo.pending}, stream=${streamName}`);
            }
          } catch (infoError) {
            // Ignore errors getting group info
          }
        }

        let entries;
        try {
          entries = await this.streamService.readGroup(
            this.consumerGroupName,
            this.consumerName,
            {
              count: 10, // Read up to 10 messages at a time
              block: 1000 // Block for 1 second if no messages
            }
          );
        } catch (readError) {
          if (!readError.message || !readError.message.includes('timeout')) {
            console.error(`❌ [WA-Official Outgoing Consumer] Error in readGroup:`, readError.message || readError);
          }
          entries = [];
        }

        // Debug: Log when we're polling and what we received
        const streamName = this.streamService.config?.streamName || 'unknown';
        if (entries && entries.length > 0) {
          console.log(`📥 [WA-Official Outgoing Consumer] Received ${entries.length} entry/entries from stream: ${streamName}`);
        } else {
          // Log polling status occasionally (every ~10 polls to avoid spam)
          if (Math.random() < 0.1) {
            console.log(`🔍 [WA-Official Outgoing Consumer] Polling stream: ${streamName} (group: ${this.consumerGroupName}, consumer: ${this.consumerName}) - no messages`);
          }
        }

        if (entries && entries.length > 0) {
          for (const entry of entries) {
            try {
              const eventData = entry.data; // Already parsed by readGroup
              
              // Debug: Log all event types we receive
              console.log(`📥 [WA-Official Outgoing Consumer] Received event: ${eventData.eventType} (entry: ${entry.id})`);
              
              // Only process "message:outgoing" events
              if (eventData.eventType !== 'message:outgoing') {
                // ACK non-outgoing messages to skip them
                console.log(`⏭️  [WA-Official Outgoing Consumer] Skipping non-outgoing event: ${eventData.eventType}`);
                await this.streamService.acknowledge(this.consumerGroupName, entry.id);
                continue;
              }

              // Only process if platform is wa-official
              const platform = eventData.platform || 'wpp';
              if (platform !== 'wa-official') {
                // This message is for WPP, not WA-Official
                // ACK it to prevent it from blocking the stream
                console.log(`⏭️  [WA-Official Outgoing Consumer] Skipping message for platform: ${platform} (this consumer handles 'wa-official' only)`);
                await this.streamService.acknowledge(this.consumerGroupName, entry.id);
                continue;
              }

              console.log(`📤 [WA-Official Outgoing Consumer] Processing outgoing message (entry: ${entry.id})`);

              try {
                // Process the outgoing message
                await this.processOutgoingMessage(eventData);
                console.log(`✅ [WA-Official Outgoing Consumer] Processed outgoing message (entry: ${entry.id})`);
              } catch (error) {
                console.error(`❌ [WA-Official Outgoing Consumer] Error processing message ${entry.id}:`, error);
                // Log error details for debugging
                if (error.response) {
                  const errorData = error.response.data?.error || {};
                  console.error(`❌ [WA-Official Outgoing Consumer] API Error Response:`, {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    errorCode: errorData.code,
                    errorType: errorData.type,
                    errorMessage: errorData.message,
                    errorSubcode: errorData.error_subcode,
                    fullData: error.response.data
                  });
                  
                  // Special handling for sticker/media errors
                  if (eventData.messageType === 'sticker' && errorData.code === 131053) {
                    console.error(`⚠️  [WA-Official Outgoing Consumer] Sticker media upload error (131053)`);
                    console.error(`   This usually means:`);
                    console.error(`   1. Sticker URL is not publicly accessible`);
                    console.error(`   2. Sticker doesn't meet requirements (512×512px, max 100KB static/500KB animated, .webp format)`);
                    console.error(`   3. Missing or incorrect Content-Type headers`);
                    console.error(`   4. Sticker URL: ${eventData.mediaUrl || 'N/A'}`);
                    console.error(`   Reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/sticker-messages`);
                  }
                }
                // Continue to ACK even on error - don't retry failed messages
              }

              // ACK after processing (both success and error) - don't retry failed messages
              await this.streamService.acknowledge(this.consumerGroupName, entry.id);
            } catch (error) {
              console.error(`❌ [WA-Official Outgoing Consumer] Error in message processing loop for entry ${entry.id}:`, error);
              // Try to ACK even if there's an error in the outer catch
              try {
                await this.streamService.acknowledge(this.consumerGroupName, entry.id);
              } catch (ackError) {
                console.error(`❌ [WA-Official Outgoing Consumer] Failed to ACK entry ${entry.id}:`, ackError);
              }
            }
          }
        }
      } catch (error) {
        if (error.message && error.message.includes('not connected')) {
          console.log('⏳ [WA-Official Outgoing Consumer] Stream service disconnected, waiting for reconnection...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          console.error('❌ [WA-Official Outgoing Consumer] Error in consume loop:', error.message || error);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  /**
   * Process outgoing message event for WA-Official
   */
  async processOutgoingMessage(eventData) {
    const { clientId, userIdentifier: userIdentifierRaw, content, messageType = 'text', messageId, mediaUrl, caption } = eventData;

    // Ensure userIdentifier is a string
    const userIdentifier = typeof userIdentifierRaw === 'string' 
      ? userIdentifierRaw 
      : String(userIdentifierRaw || '');

    // For text messages, content is required. For media messages, mediaUrl is required.
    const mediaTypes = ['image', 'video', 'audio', 'file', 'document', 'sticker'];
    const isMediaType = mediaTypes.includes(messageType);
    
    if (!clientId || !userIdentifier) {
      console.error('❌ [WA-Official Outgoing Consumer] Missing required fields:', { clientId, userIdentifier });
      return;
    }
    
    if (!isMediaType && (!content || content === '')) {
      console.error('❌ [WA-Official Outgoing Consumer] Missing content for text message:', { clientId, userIdentifier, messageType });
      return;
    }
    
    if (isMediaType && (!mediaUrl || mediaUrl === '')) {
      console.error('❌ [WA-Official Outgoing Consumer] Missing mediaUrl for media message:', { clientId, userIdentifier, messageType });
      return;
    }

    try {
      // Get client configuration from client manager (singleton instance)
      let accessToken;
      let phoneNumberId;
      
      try {
        // Initialize client manager if needed
        await clientManager.initialize();
        accessToken = await clientManager.getAccessToken(clientId);
        phoneNumberId = await clientManager.getPhoneNumberId(clientId);
      } catch (error) {
        console.error(`❌ [WA-Official Outgoing Consumer] Failed to get client config for ${clientId}:`, error);
        return;
      }

      if (!accessToken || !phoneNumberId) {
        console.error(`❌ [WA-Official Outgoing Consumer] Missing access_token or phone_number_id for ${clientId}`);
        return;
      }

      // Send message via Meta WhatsApp Business API
      const apiVersion = process.env.WA_API_VERSION || 'v24.0';
      const apiUrl = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
      
      // Build payload based on messageType
      let payload = {
        messaging_product: 'whatsapp',
        to: userIdentifier, // Phone number without @c.us
        type: messageType
      };
      
      // Add type-specific fields based on messageType
      switch (messageType) {
        case 'text':
          payload.text = {
            body: content
          };
          break;
        
        case 'image':
          payload.image = {
            link: mediaUrl
          };
          if (caption || content) {
            payload.image.caption = caption || content;
          }
          break;
        
        case 'document':
        case 'file':
          payload.document = {
            link: mediaUrl
          };
          if (caption || content) {
            payload.document.caption = caption || content;
          }
          // For documents, we can also specify filename if available
          // Note: Meta API will determine file type from URL or Content-Type header
          break;
        
        case 'video':
          payload.video = {
            link: mediaUrl
          };
          if (caption || content) {
            payload.video.caption = caption || content;
          }
          break;
        
        case 'audio':
          payload.audio = {
            link: mediaUrl
          };
          // Audio doesn't support caption in Meta API
          break;
        
        case 'sticker':
          // Stickers are supported in Meta API with type: "sticker"
          // Can use sticker.link (URL) or sticker.id (previously uploaded media ID)
          // Reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/sticker-messages
          // 
          // Requirements for stickers:
          // - Static stickers: 512×512 pixels, max 100 KB, .webp format, transparent background
          // - Animated stickers: 512×512 pixels, max 500 KB, .webp format, transparent background
          // - URL must be publicly accessible with proper Content-Type headers (image/webp)
          payload.type = 'sticker';
          payload.sticker = {
            link: mediaUrl
          };
          // Note: Stickers don't support captions
          // Note: Do NOT include recipient_type for stickers (not in Meta API docs)
          console.log(`📎 [WA-Official Outgoing Consumer] Sending sticker from URL: ${mediaUrl}`);
          console.log(`📎 [WA-Official Outgoing Consumer] Sticker payload:`, JSON.stringify(payload, null, 2));
          break;
        
        default:
          // Fallback to text for unknown types
          console.warn(`⚠️  [WA-Official Outgoing Consumer] Unknown messageType '${messageType}', falling back to text`);
          payload.type = 'text';
          payload.text = {
            body: content || ''
          };
      }

      // Log full payload for debugging (especially for stickers)
      if (messageType === 'sticker') {
        console.log(`📤 [WA-Official Outgoing Consumer] Full sticker request payload:`, JSON.stringify(payload, null, 2));
        console.log(`📤 [WA-Official Outgoing Consumer] Request URL: ${apiUrl}`);
      }

      const response = await axios.post(apiUrl, payload, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      const sentMessageId = response.data?.messages?.[0]?.id || eventData.messageId || `wa-official-${Date.now()}`;
      console.log(`✅ [WA-Official Outgoing Consumer] Sent message to ${userIdentifier} via WA-Official API (messageId: ${sentMessageId})`);

      // After sending, publish as agent:response event for Weaviate storage
      try {
        const { StreamProducer } = require('../../pubsub/client/producer.js');
        const producer = new StreamProducer();
        await producer.connect();
        
        await producer.publishAgentResponse({
          clientId,
          platform: 'wa-official',
          userIdentifier,
          agentCode: eventData.agentCode || null,
          messageId: sentMessageId || eventData.messageId, // Ensure messageId is passed
          requestMessage: '',
          response: {
            messages: [{
              type: messageType,
              text: content || '',
              url: mediaUrl || undefined,
              caption: caption || undefined
            }]
          },
          // Also include content, messageType, mediaUrl, and caption at top level for fallback extraction
          content: content || '',
          messageType: messageType,
          mediaUrl: mediaUrl || undefined,
          caption: caption || undefined,
          metadata: {
            source: 'api',
            postedBy: eventData.metadata?.postedBy || 'system',
            sender: eventData.metadata?.sender || null, // Pass sender info from JWT
            messageId: sentMessageId || eventData.messageId,
            timestamp: new Date().toISOString(),
            // Include clientMessageId from original message:outgoing event for idempotency matching
            clientMessageId: eventData.metadata?.clientMessageId || null
          }
        });
      } catch (streamError) {
        console.warn('⚠️ [WA-Official Outgoing Consumer] Failed to publish agent:response for Weaviate (message was still sent):', streamError);
      }

    } catch (error) {
      console.error(`❌ [WA-Official Outgoing Consumer] Error processing outgoing message:`, error);
      throw error;
    }
  }
}

module.exports = OutgoingMessageConsumer;
