import { WPPConnectWhatsAppService } from './whatsapp.service';

// Import JavaScript services (they're in services/pubsub)
const StreamService = require('../../services/pubsub/services/stream.service');

/**
 * Outgoing Message Consumer Service
 * Consumes "message:outgoing" events from the stream and sends them via WPP/WA-Official
 */
export class OutgoingMessageConsumerService {
  private streamService: any;
  private whatsappService: WPPConnectWhatsAppService;
  private isRunning: boolean = false;
  private consumeLoopPromise: Promise<void> | null = null;
  
  // Consumer group configuration
  private consumerGroupName = process.env.OUTGOING_MESSAGE_CONSUMER_GROUP || 'outgoing-message-consumer';
  private consumerName = process.env.OUTGOING_MESSAGE_CONSUMER_NAME || `outgoing-message-consumer-${process.pid}`;

  constructor(whatsappService: WPPConnectWhatsAppService) {
    this.whatsappService = whatsappService;
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

      // Start consumption loop
      this.isRunning = true;
      this.consumeLoopPromise = this.consumeLoop();

      console.log(`✅ Outgoing message consumer started (group: ${this.consumerGroupName}, consumer: ${this.consumerName})`);
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

      // Try to create consumer group (will fail if it already exists, which is fine)
      const startId = process.env.OUTGOING_MESSAGE_CONSUMER_START_ID || '$';
      try {
        await this.streamService.createConsumerGroup(this.consumerGroupName, startId);
        console.log(`✅ Created consumer group: ${this.consumerGroupName} (startId: ${startId})`);
      } catch (error: any) {
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
          entries = await this.streamService.readGroup(
            this.consumerGroupName,
            this.consumerName,
            {
              count: 10, // Read up to 10 messages at a time
              block: 1000 // Block for 1 second if no messages
            }
          );
        } catch (readError: any) {
          if (!readError.message || !readError.message.includes('timeout')) {
            console.error(`❌ [Outgoing Message Consumer] Error in readGroup:`, readError.message || readError);
          }
          entries = [];
        }

        if (entries && entries.length > 0) {
          for (const entry of entries) {
            try {
              const eventData = entry.data; // Already parsed by readGroup
              
              // Only process "message:outgoing" events
              if (eventData.eventType !== 'message:outgoing') {
                // ACK non-outgoing messages to skip them
                await this.streamService.acknowledge(this.consumerGroupName, entry.id);
                continue;
              }

              console.log(`📤 [Outgoing Message Consumer] Processing outgoing message (entry: ${entry.id})`);

              // Process the outgoing message
              await this.processOutgoingMessage(eventData);

              // ACK after successful processing
              await this.streamService.acknowledge(this.consumerGroupName, entry.id);
              console.log(`✅ [Outgoing Message Consumer] Processed outgoing message (entry: ${entry.id})`);
            } catch (error: any) {
              console.error(`❌ [Outgoing Message Consumer] Error processing message ${entry.id}:`, error);
              // Don't acknowledge on error - will retry
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

        // Format user ID
        const fullUserId = userIdentifier.includes('@') 
          ? userIdentifier 
          : `${userIdentifier}@c.us`;

        // Send message
        const result: any = await clientInfo.client.sendText(fullUserId, content);
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
              timestamp: new Date().toISOString()
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
      throw error; // Re-throw to prevent ACK
    }
  }
}
