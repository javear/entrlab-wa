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
    this.consumerGroupName = process.env.OUTGOING_MESSAGE_CONSUMER_GROUP || 'outgoing-message-consumer';
    this.consumerName = process.env.OUTGOING_MESSAGE_CONSUMER_NAME || `wa-official-outgoing-consumer-${process.pid}`;
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

      // Start consumption loop
      this.isRunning = true;
      this.consumeLoopPromise = this.consumeLoop();

      console.log(`✅ WA-Official outgoing message consumer started (group: ${this.consumerGroupName}, consumer: ${this.consumerName})`);
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

      const startId = process.env.OUTGOING_MESSAGE_CONSUMER_START_ID || '$';
      try {
        await this.streamService.createConsumerGroup(this.consumerGroupName, startId);
        console.log(`✅ Created consumer group: ${this.consumerGroupName} (startId: ${startId})`);
      } catch (error) {
        if (error.message && error.message.includes('BUSYGROUP')) {
          console.log(`ℹ️  Consumer group ${this.consumerGroupName} already exists`);
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

        let entries;
        try {
          entries = await this.streamService.readGroup(
            this.consumerGroupName,
            this.consumerName,
            {
              count: 10,
              block: 1000
            }
          );
        } catch (readError) {
          if (!readError.message || !readError.message.includes('timeout')) {
            console.error(`❌ [WA-Official Outgoing Consumer] Error in readGroup:`, readError.message || readError);
          }
          entries = [];
        }

        if (entries && entries.length > 0) {
          for (const entry of entries) {
            try {
              const eventData = entry.data;
              
              // Only process "message:outgoing" events for wa-official platform
              if (eventData.eventType !== 'message:outgoing') {
                await this.streamService.acknowledge(this.consumerGroupName, entry.id);
                continue;
              }

              // Only process if platform is wa-official
              if (eventData.platform !== 'wa-official') {
                await this.streamService.acknowledge(this.consumerGroupName, entry.id);
                continue;
              }

              console.log(`📤 [WA-Official Outgoing Consumer] Processing outgoing message (entry: ${entry.id})`);

              await this.processOutgoingMessage(eventData);

              await this.streamService.acknowledge(this.consumerGroupName, entry.id);
              console.log(`✅ [WA-Official Outgoing Consumer] Processed outgoing message (entry: ${entry.id})`);
            } catch (error) {
              console.error(`❌ [WA-Official Outgoing Consumer] Error processing message ${entry.id}:`, error);
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
    const { clientId, userIdentifier: userIdentifierRaw, content, messageType = 'text', messageId } = eventData;

    // Ensure userIdentifier is a string
    const userIdentifier = typeof userIdentifierRaw === 'string' 
      ? userIdentifierRaw 
      : String(userIdentifierRaw || '');

    if (!clientId || !userIdentifier || !content) {
      console.error('❌ [WA-Official Outgoing Consumer] Missing required fields:', { clientId, userIdentifier, content });
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
      const apiUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
      const payload = {
        messaging_product: 'whatsapp',
        to: userIdentifier, // Phone number without @c.us
        type: messageType === 'text' ? 'text' : 'text', // Default to text for now
        text: {
          body: content
        }
      };

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
            messageId: sentMessageId || eventData.messageId,
            timestamp: new Date().toISOString()
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
