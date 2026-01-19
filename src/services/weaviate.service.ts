import * as weaviateModule from 'weaviate-ts-client';
import axios from 'axios';
import { WPPConnectWhatsAppService } from './whatsapp.service';

// weaviate-ts-client exports default as an object with a client function
// Structure: weaviateModule.default.client is the function we need
const weaviateDefault = (weaviateModule as any).default || weaviateModule;
const weaviate = weaviateDefault.client || weaviateDefault;

/**
 * Weaviate Service
 * Handles queries to Weaviate for conversations and chat events
 */
export class WeaviateService {
  private client: any;
  private isInitialized: boolean = false;

  constructor(private whatsappService: WPPConnectWhatsAppService) {
    this.initializeClient();
  }

  /**
   * Initialize Weaviate client
   */
  private initializeClient() {
    try {
      const weaviateUrl = process.env.WEAVIATE_URL || 'http://localhost:8080';
      const weaviateApiKey = process.env.WEAVIATE_API_KEY || null;
      const openAiApiKey = process.env.OPENAI_API_KEY || null;

      let scheme = 'http';
      let host = '';
      let port = 8080;

      // Handle URL parsing
      if (weaviateUrl.startsWith('http://') || weaviateUrl.startsWith('https://')) {
        const url = new URL(weaviateUrl);
        scheme = url.protocol === 'https:' ? 'https' : 'http';
        host = url.hostname;
        port = url.port ? parseInt(url.port) : (scheme === 'https' ? 443 : 8080);
      } else {
        const parts = weaviateUrl.split(':');
        host = parts[0] || '';
        if (parts.length > 1 && parts[1]) {
          port = parseInt(parts[1]) || 8080;
        } else {
          if (weaviateUrl.includes('railway') || 
              weaviateUrl.includes('.up.') || 
              weaviateUrl.includes('.app') ||
              weaviateUrl.includes('heroku') ||
              weaviateUrl.includes('.cloud')) {
            scheme = 'https';
            port = 443;
          }
        }
      }

      const clientConfig: any = {
        scheme,
        host,
      };

      if ((scheme === 'http' && port !== 8080) || (scheme === 'https' && port !== 443)) {
        clientConfig.port = port;
      }

      if (weaviateApiKey || openAiApiKey) {
        clientConfig.headers = {};
        if (weaviateApiKey) {
          clientConfig.headers['Authorization'] = `Bearer ${weaviateApiKey}`;
        }
        if (openAiApiKey) {
          clientConfig.headers['X-OpenAI-Api-Key'] = openAiApiKey;
        }
      }

      // weaviate is the client function from weaviate-ts-client
      this.client = weaviate(clientConfig);
      this.isInitialized = true;
      console.log('✅ Weaviate service initialized');
    } catch (error) {
      console.error('❌ Error initializing Weaviate service:', error);
      this.isInitialized = false;
    }
  }

  /**
   * Get agent code for a user identifier
   * This determines the tenant for Weaviate queries
   */
  private async getAgentCodeForUser(userIdentifier: string, clientId?: string): Promise<string | null> {
    try {
      if (!clientId) {
        return null;
      }

      // Get client info to find agent assignment
      const clientInfo = this.whatsappService.getClient(clientId);
      if (!clientInfo) {
        return null;
      }

      // Check for private agent assignment first
      // This would require querying PlatformClientAgent from MongoDB
      // For now, use the client's ai_agent_code
      // TODO: Query MongoDB for privateAgentAssignment
      return clientInfo.ai_agent_code || null;
    } catch (error) {
      console.error('❌ Error getting agent code for user:', error);
      return null;
    }
  }

  /**
   * Get conversations for a user
   * @param userIdentifier - User identifier (phone number)
   * @param limit - Number of results to return
   * @param offset - Offset for pagination
   * @param agentCode - Agent code from JWT (tenant for Weaviate) - REQUIRED
   * @returns Array of conversations sorted by last_event_at (newest first)
   */
  async getUserConversations(
    userIdentifier: string,
    limit: number = 20,
    offset: number = 0,
    agentCode: string // Required - no fallback
  ): Promise<{
    conversations: any[];
    total: number;
    hasMore: boolean;
  }> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Weaviate service not initialized');
    }

    if (!agentCode) {
      throw new Error('agentCode is required');
    }

    try {
      const conversations: any[] = [];
      
      // Query only the specified tenant (agentCode from JWT)
      // participant_ids should be filterable after schema migration
      try {
        const result = await this.client.graphql
          .get()
          .withClassName('Conversation')
          .withTenant(agentCode)
          .withFields('conversation_id hashed_id client_id platform participant_ids created_at last_event_at last_event_type last_event_content last_sender_type last_sender_id last_sender_display_name status last_attention _additional { id }')
          .withWhere({
            path: ['participant_ids'],
            operator: 'ContainsAny',
            valueStringArray: [userIdentifier]
          })
          .withLimit(limit + offset) // Get more to handle offset
          .withSort([{
            path: ['last_event_at'],
            order: 'desc'
          }])
          .do();
        
        if (result.data?.Get?.Conversation) {
          conversations.push(...result.data.Get.Conversation);
        }
      } catch (error: any) {
        // Check if the error is about the schema not existing
        if (error.message?.includes('Cannot query field') || 
            error.message?.includes('GetObjectsObj') ||
            error.response?.errors?.some((e: any) => e.message?.includes('Cannot query field'))) {
          console.warn(`⚠️ Conversation schema does not exist yet. It will be created automatically when the weaviate-consumer service processes messages.`);
          // Return empty result - schema will be created when messages are processed
          return {
            conversations: [],
            total: 0,
            hasMore: false
          };
        }
        // If the error is about participant_ids not being filterable, provide helpful message
        if (error.message?.includes('participant_ids') && error.message?.includes('inverted index')) {
          console.error('❌ participant_ids is not filterable. Please run the migration script:');
          console.error('   node scripts/migrate-participant-ids-index.js --force');
          throw new Error('participant_ids property is not filterable. Please run migration script to fix the schema.');
        }
        console.warn(`⚠️ Error querying tenant ${agentCode}:`, error);
        // Return empty result if tenant doesn't exist
      }
      
      // Sort by last_event_at (newest first) and apply pagination
      conversations.sort((a, b) => {
        const dateA = new Date(a.last_event_at || a.created_at || 0).getTime();
        const dateB = new Date(b.last_event_at || b.created_at || 0).getTime();
        return dateB - dateA;
      });
      
      const total = conversations.length;
      const paginatedConversations = conversations.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      
      return {
        conversations: paginatedConversations,
        total,
        hasMore
      };
    } catch (error) {
      console.error('❌ Error getting user conversations:', error);
      throw error;
    }
  }

  /**
   * Get all conversations for an agentCode (tenant)
   * @param limit - Number of results to return
   * @param offset - Offset for pagination
   * @param agentCode - Agent code from JWT (tenant for Weaviate) - REQUIRED
   * @returns Array of all conversations for the tenant, sorted by last_event_at (newest first)
   */
  async getAllConversations(
    limit: number = 20,
    offset: number = 0,
    agentCode: string // Required - no fallback
  ): Promise<{
    conversations: any[];
    total: number;
    hasMore: boolean;
  }> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Weaviate service not initialized');
    }

    if (!agentCode) {
      throw new Error('agentCode is required');
    }

    try {
      const conversations: any[] = [];
      
      // Query all conversations for the specified tenant (agentCode from JWT)
      // No userIdentifier filter - get all conversations for this tenant
      try {
        const result = await this.client.graphql
          .get()
          .withClassName('Conversation')
          .withTenant(agentCode)
          .withFields('conversation_id hashed_id client_id platform participant_ids created_at last_event_at last_event_type last_event_content last_sender_type last_sender_id last_sender_display_name status last_attention _additional { id }')
          .withLimit(limit + offset) // Get more to handle offset
          .withSort([{
            path: ['last_event_at'],
            order: 'desc'
          }])
          .do();
        
        if (result.data?.Get?.Conversation) {
          conversations.push(...result.data.Get.Conversation);
        }
      } catch (error: any) {
        // Check if the error is about the schema not existing
        if (error.message?.includes('Cannot query field') || 
            error.message?.includes('GetObjectsObj') ||
            error.response?.errors?.some((e: any) => e.message?.includes('Cannot query field'))) {
          console.warn(`⚠️ Conversation schema does not exist yet. It will be created automatically when the weaviate-consumer service processes messages.`);
          // Return empty result - schema will be created when messages are processed
          return {
            conversations: [],
            total: 0,
            hasMore: false
          };
        }
        console.warn(`⚠️ Error querying tenant ${agentCode}:`, error);
        // Return empty result if tenant doesn't exist
      }
      
      // Sort by last_event_at (newest first) and apply pagination
      conversations.sort((a, b) => {
        const dateA = new Date(a.last_event_at || a.created_at || 0).getTime();
        const dateB = new Date(b.last_event_at || b.created_at || 0).getTime();
        return dateB - dateA;
      });
      
      const total = conversations.length;
      const paginatedConversations = conversations.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      
      return {
        conversations: paginatedConversations,
        total,
        hasMore
      };
    } catch (error) {
      console.error('❌ Error getting all conversations:', error);
      throw error;
    }
  }

  /**
   * Get conversation by hashed_id (universal ID across services) with fallback to Weaviate _id
   * @param conversationId - Hashed room ID (agentCode:clientId:userIdentifier) or Weaviate _id (UUID)
   * @param agentCode - Agent code from JWT (tenant for Weaviate) - REQUIRED
   * @returns Conversation object with clientId and userIdentifier
   */
  async getConversationById(
    conversationId: string,
    agentCode: string
  ): Promise<{
    conversation_id: string;
    hashed_id: string;
    client_id: string;
    participant_ids: string[];
    [key: string]: any;
  } | null> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Weaviate service not initialized');
    }

    if (!agentCode) {
      throw new Error('agentCode is required');
    }

    try {
      // First, try to find by hashed_id (universal ID across services)
      try {
        const hashedIdResult = await this.client.graphql
          .get()
          .withClassName('Conversation')
          .withTenant(agentCode)
          .withFields('conversation_id hashed_id client_id platform participant_ids created_at last_event_at status last_attention _additional { id }')
          .withWhere({
            path: ['hashed_id'],
            operator: 'Equal',
            valueString: conversationId
          })
          .withLimit(1)
          .do();
        
        if (hashedIdResult.data?.Get?.Conversation && hashedIdResult.data.Get.Conversation.length > 0) {
          const conversation = hashedIdResult.data.Get.Conversation[0];
          
          return {
            conversation_id: conversation.conversation_id,
            hashed_id: conversation.hashed_id,
            client_id: conversation.client_id,
            participant_ids: conversation.participant_ids || [],
            platform: conversation.platform,
            created_at: conversation.created_at,
            last_event_at: conversation.last_event_at,
            status: conversation.status
          };
        }
      } catch (hashedIdError) {
        console.warn('⚠️ GraphQL query by hashed_id failed:', hashedIdError);
      }

      // Fallback: If not found by hashed_id, try Weaviate _id (UUID format)
      // Check if conversationId looks like a UUID (Weaviate _id format)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRegex.test(conversationId)) {
        try {
          // Query all conversations and find by _id
          const allResult = await this.client.graphql
            .get()
            .withClassName('Conversation')
            .withTenant(agentCode)
            .withFields('conversation_id hashed_id client_id platform participant_ids created_at last_event_at status last_attention _additional { id }')
            .withLimit(1000) // Get a reasonable number to search through
            .do();
          
          if (allResult.data?.Get?.Conversation) {
            // Find the conversation with matching _id
            const conversation = allResult.data.Get.Conversation.find(
              (conv: any) => conv._additional?.id === conversationId
            );
            
            if (conversation) {
              return {
                conversation_id: conversation.conversation_id,
                hashed_id: conversation.hashed_id,
                client_id: conversation.client_id,
                participant_ids: conversation.participant_ids || [],
                platform: conversation.platform,
                created_at: conversation.created_at,
                last_event_at: conversation.last_event_at,
                status: conversation.status
              };
            }
          }
        } catch (uuidError) {
          console.warn('⚠️ GraphQL query by _id failed:', uuidError);
        }
      }
      
      // If not found by either method, return null
      return null;
    } catch (error) {
      console.error('❌ Error getting conversation by id:', error);
      throw error;
    }
  }

  /**
   * Get chat events for a conversation
   * @param conversationId - Hashed room ID (universal ID) or Weaviate _id (UUID) - will try hashed_id first, then fallback to _id
   * @param limit - Number of results to return
   * @param offset - Offset for pagination
   * @param agentCode - Agent code from JWT (tenant for Weaviate) - REQUIRED
   * @returns Array of chat events sorted by sequence (newest first)
   */
  async getConversationChats(
    conversationId: string,
    limit: number = 50,
    offset: number = 0,
    agentCode: string // Required - no fallback
  ): Promise<{
    chats: any[];
    total: number;
    hasMore: boolean;
  }> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Weaviate service not initialized');
    }

    if (!agentCode) {
      throw new Error('agentCode is required');
    }

    try {
      // First, get the conversation to find the conversation_id
      // This will try hashed_id first, then fallback to Weaviate _id if not found
      const conversation = await this.getConversationById(conversationId, agentCode);
      
      if (!conversation) {
        return {
          chats: [],
          total: 0,
          hasMore: false
        };
      }

      // Use agentCode from JWT as tenant (required)
      const tenant = agentCode;
      
      // Query chat events using conversation_id from the conversation record
      const result = await this.client.graphql
        .get()
        .withClassName('ChatEvent')
        .withTenant(tenant)
        .withFields('conversation_id event_id event_type sender_type sender_id sender_display_name sender_avatar_url content sequence created_at visibility')
        .withWhere({
          path: ['conversation_id'],
          operator: 'Equal',
          valueString: conversation.conversation_id
        })
        .withLimit(limit + offset) // Get more to handle offset
        .withSort([{
          path: ['sequence'],
          order: 'desc' // Newest first
        }])
        .do();
      
      if (!result.data?.Get?.ChatEvent) {
        return {
          chats: [],
          total: 0,
          hasMore: false
        };
      }
      
      const allChats = result.data.Get.ChatEvent;
      const total = allChats.length;
      const paginatedChats = allChats.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      
      return {
        chats: paginatedChats,
        total,
        hasMore
      };
    } catch (error) {
      console.error('❌ Error getting conversation chats:', error);
      throw error;
    }
  }
}
