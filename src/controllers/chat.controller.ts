import { Request, Response } from 'express';
import { WeaviateService } from '../services/weaviate.service';
import { WPPConnectWhatsAppService } from '../services/whatsapp.service';
import mongoose from 'mongoose';

// Stream Producer for publishing events
const { StreamProducer } = require('../../services/pubsub/client/producer');

// Import PlatformClientAgent model (reuse from platform.controller)
interface INeedAttentionHistory {
  userIdentifier: string;
  option: 'pause' | 'release' | 'block' | 'taken';
  previousOption?: string;
  from?: Date;
  to?: Date;
  reason?: string;
  changedAt: Date;
  changedBy?: {
    id: string;
    name: string;
    role: string;
    avatarUrl?: string;
  };
  taken?: {
    by: {
      id: string;
      name: string;
      role: string;
      avatarUrl?: string;
    };
  };
}

interface IPlatformClientAgent extends mongoose.Document {
  clientId: string;
  platform: 'wpp' | 'wa-official';
  ai_agent_code?: string;
  privateAgentAssignment?: Array<{
    userIdentifier: string;
    agentCode: string;
  }>;
  needAttention?: INeedAttention[];
  needAttentionHistory?: INeedAttentionHistory[];
}

let PlatformClientAgent: mongoose.Model<IPlatformClientAgent>;
try {
  PlatformClientAgent = mongoose.model<IPlatformClientAgent>('PlatformClientAgent');
} catch (error) {
  // Model will be created by platform.controller
  PlatformClientAgent = mongoose.model<IPlatformClientAgent>('PlatformClientAgent');
}

// NeedAttention interface (same as platform.controller)
interface INeedAttention {
  userIdentifier: string;
  option: 'pause' | 'release' | 'block' | 'taken';
  from?: Date;
  to?: Date;
  reason?: string;
  updatedAt?: Date;
  taken?: {
    by: {
      id: string;
      name: string;
      role: string;
      avatarUrl?: string;
    }
  };
}

/**
 * Chat Controller
 * Handles chat API endpoints for conversations and messages
 */
export class ChatController {
  constructor(
    private weaviateService: WeaviateService,
    private whatsappService: WPPConnectWhatsAppService
  ) {}

  /**
   * Get conversation room list for a user or all conversations for an agent
   * GET /api/v1/platform/chat/conversations
   * Query params: userIdentifier (optional), limit, offset
   * 
   * - If userIdentifier is provided: returns conversations for that user
   * - If userIdentifier is NOT provided: returns ALL conversations for the agentCode (tenant)
   * 
   * Tenant (agent_code) is REQUIRED and extracted from JWT token.
   * Only returns conversations for the agent specified in the JWT.
   */
  async getUserConversations(req: Request, res: Response): Promise<void> {
    try {
      const { userIdentifier } = req.query;
      const limit = parseInt(req.query.limit as string) || 20;
      const offset = parseInt(req.query.offset as string) || 0;

      // Validate limit and offset
      if (limit < 1 || limit > 100) {
        res.status(400).json({
          success: false,
          error: 'limit must be between 1 and 100'
        });
        return;
      }

      if (offset < 0) {
        res.status(400).json({
          success: false,
          error: 'offset must be >= 0'
        });
        return;
      }

      // Extract agentCode from JWT token (tenant for Weaviate) - REQUIRED
      const agentCode = (req as any).user?.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token. Please ensure your JWT token contains an agentCode field.'
        });
        return;
      }

      // If userIdentifier is provided, get conversations for that user
      // Otherwise, get all conversations for the agentCode (tenant)
      let result;
      if (userIdentifier && typeof userIdentifier === 'string') {
        result = await this.weaviateService.getUserConversations(
          userIdentifier as string,
          limit,
          offset,
          agentCode // Pass agentCode as tenant (required)
        );
      } else {
        result = await this.weaviateService.getAllConversations(
          limit,
          offset,
          agentCode // Pass agentCode as tenant (required)
        );
      }

      res.json({
        success: true,
        conversations: result.conversations.map(conv => ({
          conversationId: conv.hashed_id || conv._additional?.id || conv.conversation_id, // Use hashed_id as conversationId (universal ID)
          clientId: conv.client_id,
          platform: conv.platform,
          participantIds: conv.participant_ids || [],
          createdAt: conv.created_at,
          lastEventAt: conv.last_event_at,
          lastEventType: conv.last_event_type,
          lastEventContent: conv.last_event_content ? JSON.parse(conv.last_event_content) : null,
          lastSenderType: conv.last_sender_type,
          lastSenderId: conv.last_sender_id,
          lastSenderDisplayName: conv.last_sender_display_name,
          status: conv.status,
          lastAttention: conv.last_attention ? JSON.parse(conv.last_attention) : null
        })),
        pagination: {
          total: result.total,
          limit,
          offset,
          hasMore: result.hasMore
        }
      });
    } catch (error) {
      console.error('❌ Error getting user conversations:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get user conversations',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get chats in a conversation
   * GET /api/v1/platform/chat/conversations/:conversationId/chats
   * Query params: limit, offset
   * 
   * conversationId can be:
   * - hashed_id (universal ID, preferred): e.g., "mhSSVwWhku7HDR+5ukDJumRDin5Tx9BbZpsbkrDNapA="
   * - Weaviate _id (fallback): e.g., "32ca98f6-e414-5aaa-908f-763500c1a4ce"
   * 
   * Tenant (agent_code) is REQUIRED and extracted from JWT token.
   * Only returns chats for the agent specified in the JWT.
   */
  async getConversationChats(req: Request, res: Response): Promise<void> {
    try {
      const { conversationId } = req.params;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      if (!conversationId) {
        res.status(400).json({
          success: false,
          error: 'conversationId is required'
        });
        return;
      }

      // Validate limit and offset
      if (limit < 1 || limit > 100) {
        res.status(400).json({
          success: false,
          error: 'limit must be between 1 and 100'
        });
        return;
      }

      if (offset < 0) {
        res.status(400).json({
          success: false,
          error: 'offset must be >= 0'
        });
        return;
      }

      // Extract agentCode from JWT token (tenant for Weaviate) - REQUIRED
      const agentCode = (req as any).user?.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token. Please ensure your JWT token contains an agentCode field.'
        });
        return;
      }

      const result = await this.weaviateService.getConversationChats(
        conversationId,
        limit,
        offset,
        agentCode // Pass agentCode as tenant (required)
      );

      res.json({
        success: true,
        conversationId,
        chats: result.chats.map((chat: any) => ({
          eventId: chat.event_id,
          eventType: chat.event_type,
          senderType: chat.sender_type,
          senderId: chat.sender_id,
          senderDisplayName: chat.sender_display_name,
          senderAvatarUrl: chat.sender_avatar_url,
          content: chat.content ? JSON.parse(chat.content) : null,
          sequence: chat.sequence,
          createdAt: chat.created_at,
          visibility: chat.visibility
        })),
        pagination: {
          total: result.total,
          limit,
          offset,
          hasMore: result.hasMore
        }
      });
    } catch (error) {
      console.error('❌ Error getting conversation chats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get conversation chats',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Post a chat message to a conversation
   * POST /api/v1/platform/chat/conversations/:conversationId/messages
   * Body: { content: string, messageType?: string, mediaUrl?: string, caption?: string }
   * 
   * This will publish a message event to the stream, which will be forwarded
   * to WPP or WA Official to reply to the user
   * 
   * For media messages (image, video, file, document, sticker), mediaUrl is required.
   * Caption is optional for media messages (falls back to content if provided).
   */
  async postChatMessage(req: Request, res: Response): Promise<void> {
    try {
      const { conversationId } = req.params;
      const { content, messageType = 'text', mediaUrl, caption } = req.body;

      if (!conversationId) {
        res.status(400).json({
          success: false,
          error: 'conversationId is required'
        });
        return;
      }

      // Media types that require mediaUrl
      const mediaTypes = ['image', 'video', 'audio', 'file', 'document', 'sticker'];
      const isMediaType = mediaTypes.includes(messageType);
      
      // For text messages, content is required. For media messages, mediaUrl is required.
      if (!isMediaType && (!content || typeof content !== 'string')) {
        res.status(400).json({
          success: false,
          error: 'content is required and must be a string for text messages'
        });
        return;
      }
      
      if (isMediaType && (!mediaUrl || typeof mediaUrl !== 'string' || mediaUrl.trim() === '')) {
        res.status(400).json({
          success: false,
          error: `mediaUrl is required for media message type '${messageType}'`
        });
        return;
      }

      // Extract agentCode from JWT token (tenant for Weaviate) - REQUIRED
      const agentCode = (req as any).user?.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token. Please ensure your JWT token contains an agentCode field.'
        });
        return;
      }

      // Get conversation by hashed_id (universal ID) with fallback to Weaviate _id
      // This will try hashed_id first, then fallback to _id if not found
      const conversation = await this.weaviateService.getConversationById(conversationId, agentCode);
      
      if (!conversation) {
        res.status(404).json({
          success: false,
          error: `Conversation ${conversationId} not found`
        });
        return;
      }

      // Extract clientId and userIdentifier from conversation
      const clientId = conversation.client_id;
      const userIdentifier = conversation.participant_ids?.find((id: string) => 
        id !== clientId && id !== agentCode && !id.includes(':')
      ) || conversation.participant_ids?.[0] || null;

      if (!clientId || !userIdentifier) {
        res.status(400).json({
          success: false,
          error: 'Could not extract clientId and userIdentifier from conversation'
        });
        return;
      }

      // Check if client exists (either WPP or WA-Official)
      const clientInfo = this.whatsappService.getClient(clientId);
      const platformClient = await PlatformClientAgent.findOne({
        clientId,
        isActive: true
      });

      if (!clientInfo && !platformClient) {
        res.status(404).json({
          success: false,
          error: `Client ${clientId} not found`
        });
        return;
      }

      // Determine platform
      const platform = clientInfo ? 'wpp' : (platformClient?.platform || 'wpp');

      // Get agent code (check for private assignment first)
      // Use agentCode from JWT as base, but check for private assignment override
      let finalAgentCode = agentCode; // Start with JWT agentCode
      
      // Check for private agent assignment
      if (platformClient) {
        try {
          if (platformClient.privateAgentAssignment) {
            const privateAssignment = platformClient.privateAgentAssignment.find(
              (a: any) => a.userIdentifier === userIdentifier
            );
            if (privateAssignment) {
              finalAgentCode = privateAssignment.agentCode;
            }
          }
        } catch (error) {
          console.warn('⚠️ Could not check private agent assignment:', error);
        }
      }

      if (!finalAgentCode) {
        res.status(400).json({
          success: false,
          error: `No agent assigned to client ${clientId} for user ${userIdentifier}`
        });
        return;
      }

      // Generate a unique message ID
      const messageId = `api-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      // Extract sender information from JWT (if provided)
      const jwtUser = (req as any).user || {};
      const senderInfo = jwtUser.sender ? {
        senderId: jwtUser.sender.senderId || jwtUser.sender.id || jwtUser.agentCode || 'system',
        senderDisplayName: jwtUser.sender.senderDisplayName || jwtUser.sender.displayName || jwtUser.sender.name || null,
        senderRoleLabel: jwtUser.sender.senderRoleLabel || jwtUser.sender.roleLabel || 'agent',
        senderAvatarUrl: jwtUser.sender.senderAvatarUrl || jwtUser.sender.avatarUrl || null
      } : {
        senderId: jwtUser.agentCode || 'system',
        senderDisplayName: null,
        senderRoleLabel: 'agent',
        senderAvatarUrl: null
      };

      // Publish to stream first - consumers (WPP/WA-Official) will handle sending
      try {
        const { StreamProducer } = require('../../services/pubsub/client/producer');
        const producer = new StreamProducer();
        
        await producer.connect();
        
        // Publish as outgoing message event - consumers will send it
        // Platform is determined from client type (wpp or wa-official)
        // Note: hashed_id (conversationId) is included in metadata for reference,
        // but consumers use clientId and userIdentifier to send messages
        const messageData: any = {
          clientId,
          platform: platform, // 'wpp' or 'wa-official'
          userIdentifier,
          agentCode: finalAgentCode, // Use finalAgentCode (may be overridden by private assignment)
          messageId,
          messageType: messageType || 'text',
          content: content || '', // Allow empty for media messages
          metadata: {
            source: 'api',
            postedBy: jwtUser.agentCode || 'system',
            sender: senderInfo, // Include sender information from JWT
            conversationId: conversationId, // hashed_id (universal ID) for reference/tracking
            timestamp: new Date().toISOString()
          }
        };
        
        // Add mediaUrl and caption if provided (for media messages)
        if (mediaUrl) {
          messageData.mediaUrl = mediaUrl;
        }
        if (caption) {
          messageData.caption = caption;
        }
        
        const entryId = await producer.publishOutgoingMessage(messageData);

        console.log(`✅ Published outgoing message to stream: ${entryId} (conversationId: ${conversationId})`);

        // Return success response immediately
        // The message will be sent by the consumer (WPP/WA-Official)
        res.status(201).json({
          success: true,
          message: 'Chat message published to stream - will be sent by consumer',
          data: {
            conversationId,
            messageId,
            content: content || '',
            messageType,
            mediaUrl: mediaUrl || undefined,
            caption: caption || undefined,
            entryId,
            publishedAt: new Date().toISOString()
          }
        });
      } catch (streamError: any) {
        console.error('❌ Error publishing outgoing message to stream:', streamError);
        res.status(500).json({
          success: false,
          error: 'Failed to publish message to stream',
          details: streamError instanceof Error ? streamError.message : 'Unknown error'
        });
      }
    } catch (error) {
      console.error('❌ Error posting chat message:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to post chat message',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Set need attention status for a conversation by hashedId
   * PUT /api/v1/platform/chat/conversations/:hashedId/:action
   * Actions: block, pause, release, taken
   */
  async setConversationNeedAttention(req: Request, res: Response): Promise<void> {
    try {
      const { hashedId, action } = req.params;
      const { from, to, reason } = req.body;

      if (!hashedId) {
        res.status(400).json({
          success: false,
          message: 'hashedId is required'
        });
        return;
      }

      if (!action) {
        res.status(400).json({
          success: false,
          message: 'action is required (block, pause, release, or taken)'
        });
        return;
      }

      if (!['pause', 'release', 'block', 'taken'].includes(action)) {
        res.status(400).json({
          success: false,
          message: 'action must be one of: block, pause, release, taken'
        });
        return;
      }

      // Get agentCode from JWT
      const jwtUser = (req as any).user || {};
      const agentCode = jwtUser.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          message: 'agentCode is required in JWT token'
        });
        return;
      }

      // Get conversation by hashedId
      const conversation = await this.weaviateService.getConversationById(hashedId, agentCode);
      
      if (!conversation) {
        res.status(404).json({
          success: false,
          message: `Conversation with hashedId ${hashedId} not found`
        });
        return;
      }

      // Extract clientId and userIdentifier from conversation_id format: "clientId:userIdentifier"
      const conversationIdParts = conversation.conversation_id.split(':');
      if (conversationIdParts.length !== 2 || !conversationIdParts[0] || !conversationIdParts[1]) {
        res.status(400).json({
          success: false,
          message: 'Could not extract clientId and userIdentifier from conversation'
        });
        return;
      }

      const clientId = conversationIdParts[0];
      const userIdentifier = conversationIdParts[1];

      // Query MongoDB for needAttention
      const existingDoc = await PlatformClientAgent.findOne({ clientId, isActive: true }).lean() as IPlatformClientAgent | null;
      
      if (!existingDoc) {
        res.status(404).json({
          success: false,
          message: `Client ${clientId} not found in PlatformClientAgent collection.`
        });
        return;
      }

      const existingNeedAttention = (existingDoc.needAttention as INeedAttention[]) || [];
      const existingHistory = (existingDoc.needAttentionHistory as any[]) || [];
      let updatedNeedAttention: INeedAttention[];
      let previousOption: string | undefined;

      if (action === 'release') {
        // Find the previous option before release
        const existingItem = existingNeedAttention.find(
          (item: INeedAttention) => item.userIdentifier === userIdentifier
        );
        previousOption = existingItem?.option;

        // Remove the user from needAttention array
        updatedNeedAttention = existingNeedAttention.filter(
          (item: INeedAttention) => item.userIdentifier !== userIdentifier
        );
        console.log(`✅ Released user ${userIdentifier} from needAttention for client ${clientId}`);
      } else {
        // Upsert: update if exists, add if not
        const existingIndex = existingNeedAttention.findIndex(
          (item: INeedAttention) => item.userIdentifier === userIdentifier
        );

        // Get previous option if updating existing entry
        if (existingIndex >= 0 && existingNeedAttention[existingIndex]) {
          previousOption = existingNeedAttention[existingIndex].option;
        }

        const needAttentionItem: INeedAttention = {
          userIdentifier,
          option: action as 'pause' | 'block' | 'taken',
          updatedAt: new Date()
        };

        // Add optional fields if provided
        if (from) {
          needAttentionItem.from = new Date(from);
        }
        if (to) {
          needAttentionItem.to = new Date(to);
        }
        if (reason) {
          needAttentionItem.reason = reason;
        }

        // Extract sender information from JWT for 'taken' action
        if (action === 'taken') {
          const sender = jwtUser.sender || {};
          
          if (!sender.senderId && !sender.id) {
            res.status(400).json({
              success: false,
              message: 'sender information is required in JWT for "taken" action'
            });
            return;
          }
          
          needAttentionItem.taken = {
            by: {
              id: sender.senderId || sender.id || '',
              name: sender.senderDisplayName || sender.displayName || '',
              role: sender.senderRoleLabel || sender.roleLabel || 'agent',
              avatarUrl: sender.senderAvatarUrl || sender.avatarUrl || null
            }
          };
        }

        if (existingIndex >= 0) {
          // Update existing entry
          existingNeedAttention[existingIndex] = needAttentionItem;
          updatedNeedAttention = existingNeedAttention;
          console.log(`✅ Updated needAttention for userIdentifier ${userIdentifier} to action ${action}`);
        } else {
          // Add new entry
          existingNeedAttention.push(needAttentionItem);
          updatedNeedAttention = existingNeedAttention;
          console.log(`✅ Added needAttention for userIdentifier ${userIdentifier} with action ${action}`);
        }
      }

      // Create history entry
      const historyEntry: any = {
        userIdentifier,
        option: action as 'pause' | 'release' | 'block' | 'taken',
        changedAt: new Date()
      };

      if (previousOption) {
        historyEntry.previousOption = previousOption;
      }

      // Add optional fields to history
      if (from) {
        historyEntry.from = new Date(from);
      }
      if (to) {
        historyEntry.to = new Date(to);
      }
      if (reason) {
        historyEntry.reason = reason;
      }

      // Add changedBy if sender info is available
      const sender = jwtUser.sender || {};
      if (sender.senderId || sender.id) {
        historyEntry.changedBy = {
          id: sender.senderId || sender.id || '',
          name: sender.senderDisplayName || sender.displayName || '',
          role: sender.senderRoleLabel || sender.roleLabel || 'agent',
          avatarUrl: sender.senderAvatarUrl || sender.avatarUrl || null
        };
      }

      // Add taken info to history if present
      const updatedItem = updatedNeedAttention.find(item => item.userIdentifier === userIdentifier);
      if (updatedItem?.taken) {
        historyEntry.taken = updatedItem.taken;
      }

      // Add history entry to array
      const updatedHistory = [...existingHistory, historyEntry];

      // Update the document
      const updatedClient = await PlatformClientAgent.findOneAndUpdate(
        { clientId, isActive: true },
        { 
          $set: { 
            needAttention: updatedNeedAttention,
            needAttentionHistory: updatedHistory,
            updatedAt: new Date()
          }
        },
        { new: true, runValidators: false, strict: false }
      );

      if (!updatedClient) {
        res.status(404).json({
          success: false,
          message: `Failed to update client ${clientId}`
        });
        return;
      }

      // Publish needattention:changed event to stream
      try {
        const producer = new StreamProducer();
        await producer.connect();

        // Get the needAttention item that was updated (for taken object if action === 'taken')
        const updatedItem = action === 'release' 
          ? null 
          : updatedNeedAttention.find((item: INeedAttention) => item.userIdentifier === userIdentifier);

        const attentionData: any = {
          clientId,
          platform: existingDoc.platform || 'wpp',
          userIdentifier,
          agentCode,
          option: action === 'release' ? null : action, // null means released
          reason: updatedItem?.reason || reason || null,
          from: updatedItem?.from ? updatedItem.from.toISOString() : (from || null),
          to: updatedItem?.to ? updatedItem.to.toISOString() : (to || null),
          taken: updatedItem?.taken || null,
          hashedId // Include hashedId in event
        };

        await producer.publishNeedAttentionChanged(attentionData);
        console.log(`✅ Published needattention:changed event to stream for ${userIdentifier}`);
      } catch (streamError) {
        // Log error but don't fail API response (MongoDB update succeeded)
        console.error('❌ Error publishing needattention:changed event to stream:', streamError);
      }

      const responseMessage = action === 'release' 
        ? `User ${userIdentifier} released from needAttention successfully`
        : `Need attention status for user ${userIdentifier} updated successfully (action: ${action})`;

      const responseData: any = {
        success: true,
        message: responseMessage,
        conversationId: hashedId
      };

      // Only include needAttention in response if it's not release (since release removes it)
      if (action !== 'release') {
        responseData.needAttention = updatedNeedAttention.find(item => item.userIdentifier === userIdentifier) || null;
      }

      res.json(responseData);
    } catch (error) {
      console.error('❌ Error setting conversation need attention:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to set need attention status',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
